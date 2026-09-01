//! Production Morphz adapter used by the ME-07 STATE-Bench system comparison.
//!
//! The Python benchmark owns the simulated enterprise environment.  Its tool
//! handlers are exposed through a loopback bridge, while Morphz owns the full
//! model/Context/tool loop.  Registering the bridged tools through
//! `MorphzRuntimeBuilder::extra_tool` deliberately sends every domain action
//! through the ordinary durable `Tool -> ExecutionJob` path.

use async_trait::async_trait;
use morphz::config;
use morphz::harness::ExactHarnessRef;
use morphz::harness_package::HarnessPackage;
use morphz::llm::{
    Client, Message, ModelRequestContext, ReasoningEffort, Response, ToolCallRepr, ToolDefinition,
};
use morphz::memory::{NewAgent, NewCognitiveContext, NewSession, QueryFilter, SessionMountKind};
use morphz::permission::PermissionMode;
use morphz::provider::build_configured_client;
use morphz::runtime::{MorphzRuntime, RuntimeIdentity, RuntimeToolPolicy};
use morphz::tool::Tool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const PROTOCOL_ID: &str = "ME-07-STATE-Bench-public-agent-systems-v2";
const MODEL: &str = "gpt-5.6-sol";
const PROVIDER: &str = "custom";

pub type StateBenchError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateBenchToolManifest {
    pub protocol_id: String,
    pub domain: String,
    pub task_id: String,
    pub system_prompt: String,
    #[serde(default)]
    pub learning: bool,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateBenchAgentConfig {
    pub database_path: PathBuf,
    pub workspace_root: PathBuf,
    pub artifact_root: PathBuf,
    pub tool_manifest_path: PathBuf,
    pub bridge_url: String,
    pub bridge_token: String,
    pub profile: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub principal_id: String,
    pub reply_timeout_seconds: u64,
    #[serde(default)]
    pub deterministic_fake_client: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateBenchTurnRequest {
    pub request_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StateBenchUsageTotals {
    pub model_calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateBenchTurnResponse {
    pub protocol_id: String,
    pub request_id: String,
    pub text: String,
    pub duplicate: bool,
    pub mind_version: u64,
    pub context_tx_commits: usize,
    pub usage: StateBenchUsageTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateBenchReady {
    pub r#type: String,
    pub protocol_id: String,
    pub domain: String,
    pub task_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub harness_id: String,
    pub harness_version: String,
    pub harness_artifact_hash: String,
    pub tool_names: Vec<String>,
    pub physical_tool_names: Vec<String>,
    pub requested_model: String,
    pub physical_model: String,
    pub provider_instance_id: String,
    pub provider_protocol: String,
    pub reasoning_effort: String,
    pub fallback: bool,
    pub initial_mind_version: u64,
    pub initial_context_tx_commits: usize,
    pub deterministic_fake_not_reportable: bool,
}

#[derive(Debug, Serialize)]
struct BridgeToolRequest<'a> {
    protocol_id: &'static str,
    tool_name: &'a str,
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct BridgeToolResponse {
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Clone)]
pub struct StateBenchBridgeTool {
    definition: ToolDefinition,
    bridge_url: String,
    bridge_token: String,
    client: reqwest::Client,
}

impl StateBenchBridgeTool {
    pub fn new(
        definition: ToolDefinition,
        bridge_url: impl Into<String>,
        bridge_token: impl Into<String>,
    ) -> Result<Self, StateBenchError> {
        validate_tool_definition(&definition)?;
        let bridge_url = bridge_url.into();
        let parsed = reqwest::Url::parse(&bridge_url)?;
        let host = parsed.host_str().unwrap_or_default();
        if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
            return Err("ME-07 tool bridge must be loopback-only".into());
        }
        let bridge_token = bridge_token.into();
        if bridge_token.trim().is_empty() {
            return Err("ME-07 tool bridge token must not be empty".into());
        }
        Ok(Self {
            definition,
            bridge_url,
            bridge_token,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()?,
        })
    }
}

#[async_trait]
impl Tool for StateBenchBridgeTool {
    fn name(&self) -> &str {
        &self.definition.name
    }

    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    async fn execute(&self, arguments: &str) -> Result<String, StateBenchError> {
        let mut arguments: Value = serde_json::from_str(arguments)?;
        if let Some(object) = arguments.as_object_mut() {
            // `target` is a Runtime routing hint added to physical tool
            // definitions, not a STATE-Bench domain parameter.
            object.remove("target");
        }
        let response = self
            .client
            .post(&self.bridge_url)
            .header("x-me07-bridge-token", &self.bridge_token)
            .json(&BridgeToolRequest {
                protocol_id: PROTOCOL_ID,
                tool_name: self.name(),
                arguments,
            })
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(format!("STATE-Bench bridge returned HTTP {}", response.status()).into());
        }
        let envelope: BridgeToolResponse = response.json().await?;
        if !envelope.ok {
            return Err(envelope
                .error
                .unwrap_or_else(|| "STATE-Bench domain tool failed".to_string())
                .into());
        }
        Ok(serde_json::to_string(&envelope.result)?)
    }
}

fn validate_tool_definition(definition: &ToolDefinition) -> Result<(), StateBenchError> {
    let name = definition.name.trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(format!("invalid STATE-Bench tool name: {:?}", definition.name).into());
    }
    if !definition.parameters.is_object() {
        return Err(format!("tool {name} parameters must be a JSON object").into());
    }
    Ok(())
}

pub fn load_and_validate_manifest(path: &Path) -> Result<StateBenchToolManifest, StateBenchError> {
    let manifest: StateBenchToolManifest = serde_json::from_slice(&std::fs::read(path)?)?;
    if manifest.protocol_id != PROTOCOL_ID {
        return Err("ME-07 tool manifest protocol mismatch".into());
    }
    if manifest.domain.trim().is_empty()
        || manifest.task_id.trim().is_empty()
        || manifest.system_prompt.trim().is_empty()
        || (!manifest.learning && manifest.tools.is_empty())
    {
        return Err("ME-07 tool manifest is incomplete".into());
    }
    let mut names = BTreeSet::new();
    for definition in &manifest.tools {
        validate_tool_definition(definition)?;
        if !names.insert(definition.name.clone()) {
            return Err(format!("duplicate STATE-Bench tool: {}", definition.name).into());
        }
    }
    Ok(manifest)
}

fn sexpr_string(value: &str) -> Result<String, StateBenchError> {
    Ok(serde_json::to_string(value)?)
}

pub fn render_state_bench_harness(
    manifest: &StateBenchToolManifest,
) -> Result<String, StateBenchError> {
    let mut tool_names = manifest
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    tool_names.sort_unstable();
    let declared = std::iter::once("context_tx")
        .chain(tool_names.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    let task_component = manifest
        .task_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let (title, scope, task) = if manifest.learning {
        (
            "ME-07 STATE-Bench offline learning policy",
            "This content-addressed Harness admits only canonical completed training trajectories. It forbids held-out task data, oracle requirements, episode-specific facts presented as current truth, and externally written lesson summaries.",
            "Study the supplied canonical completed training episode. Use context_tx to form or revise reusable, evidence-grounded procedural Mind Frames when warranted. Preserve source provenance, do not memorize transient record values as current truth, and reply exactly TRAINING_EPISODE_INGESTED after the transaction is complete.",
        )
    } else {
        (
            "ME-07 STATE-Bench task policy",
            "This content-addressed Harness transports the benchmark's authoritative domain policy into the production Morphz Evaluation. It does not add an answer, hidden oracle, task-specific tactic, or scoring hint.",
            "Respond to the current STATE-Bench user through the available domain tools. Preserve relevant learned Mind Frames, obey the authoritative domain policy, and return a user-facing answer.",
        )
    };
    let source = format!(
        "(manifest\n  (id me07-state-bench-{task_component})\n  (version \"1.0.0\")\n  (title {})\n  (capabilities (tools {declared})))\n\n(contract\n  (version \"1.0.0\")\n  (scope {})\n  (authoritative-domain-policy {}))\n\n(infer\n  (requires (tools {declared}))\n  (returns String)\n  {})\n",
        sexpr_string(title)?,
        sexpr_string(scope)?,
        sexpr_string(&manifest.system_prompt)?,
        sexpr_string(task)?,
    );
    // Parsing here is part of the pre-model contract Gate, not deferred until
    // the first paid request.
    HarnessPackage::from_source("me07-state-bench.hns", &source)?;
    Ok(source)
}

struct DeterministicStateBenchClient {
    tool_name: String,
    calls: AtomicUsize,
}

fn observation_ref_before<'a>(prompt: &'a str, marker: &str) -> Option<&'a str> {
    let marker_index = prompt.find(marker)?;
    let prefix = &prompt[..marker_index];
    let start = prefix.rfind("@e")?;
    let end = prefix[start + 2..]
        .find(|character: char| !character.is_ascii_digit())
        .map(|offset| start + 2 + offset)
        .unwrap_or(prefix.len());
    (end > start + 2).then_some(&prefix[start..end])
}

fn kernel_context_version(prompt: &str) -> Option<u64> {
    let kernel = prompt.rfind("(kernel")?;
    let suffix = &prompt[kernel..];
    let version = suffix.find("(version ")? + "(version ".len();
    let digits = suffix[version..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
}

#[async_trait]
impl Client for DeterministicStateBenchClient {
    async fn create_completion(
        &self,
        messages: Vec<Message>,
        tools: Vec<ToolDefinition>,
    ) -> Result<Response, StateBenchError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let prompt = messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if call == 0 {
            if !tools.iter().any(|tool| tool.name == self.tool_name)
                || !tools.iter().any(|tool| tool.name == "context_tx")
            {
                return Err("deterministic Gate did not see domain tool + context_tx".into());
            }
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "me07-gate-domain-tool".to_string(),
                    r#type: "function".to_string(),
                    func_name: self.tool_name.clone(),
                    arguments: "{}".to_string(),
                }],
            });
        }
        if !prompt.contains("gate-ok") {
            return Err("deterministic Gate did not receive bridge result".into());
        }
        if call == 1 {
            let version = kernel_context_version(&prompt)
                .ok_or("deterministic Gate could not read the Context version")?;
            let source_ref = observation_ref_before(&prompt, "Run the gate.")
                .ok_or("deterministic Gate could not read the current observation ref")?;
            let transaction = format!(
                "(context-tx (base-version {version}) (reason \"ME-07 deterministic ContextStore gate\") (derive me07-deterministic-context-store-gate (from {source_ref}) (state (status gate-ok))))"
            );
            return Ok(Response {
                content: String::new(),
                tool_calls: vec![ToolCallRepr {
                    id: "me07-gate-context-tx".to_string(),
                    r#type: "function".to_string(),
                    func_name: "context_tx".to_string(),
                    arguments: serde_json::json!({"transaction": transaction}).to_string(),
                }],
            });
        }
        if !prompt.contains("me07-deterministic-context-store-gate") {
            return Err("deterministic Gate did not observe its Context mutation".into());
        }
        Ok(Response {
            content: "me07-deterministic-gate-complete".to_string(),
            tool_calls: Vec::new(),
        })
    }
}

async fn build_client(
    config: &StateBenchAgentConfig,
    manifest: &StateBenchToolManifest,
) -> Result<
    (
        Arc<dyn Client>,
        config::AppConfig,
        String,
        String,
        String,
        bool,
    ),
    StateBenchError,
> {
    if config.deterministic_fake_client {
        let mut app = config::AppConfig::default();
        app.apply_runtime_env_overrides()
            .map_err(|error| -> StateBenchError { error.into() })?;
        app.llm.model = "deterministic-me07-gate".to_string();
        app.orchestrator.context_transactions_enabled = true;
        return Ok((
            Arc::new(DeterministicStateBenchClient {
                tool_name: manifest.tools[0].name.clone(),
                calls: AtomicUsize::new(0),
            }),
            app,
            "deterministic-me07-gate".to_string(),
            "deterministic".to_string(),
            "in-process".to_string(),
            false,
        ));
    }
    if let Some(path) = config::host_env_path() {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to load Morphz host environment: {error}").into());
            }
        }
    }
    let cwd = std::env::current_dir()?;
    let mut resolved = config::resolve_config(&cwd, None, Some(&config.profile))?;
    resolved.config.apply_runtime_env_overrides()?;
    let fallback = {
        let route = resolved
            .config
            .model_routes
            .get(MODEL)
            .ok_or("ME-07 exact gpt-5.6-sol route is not configured")?;
        if route.fallback || route.candidates.len() != 1 {
            return Err("ME-07 requires one gpt-5.6-sol candidate and fallback=false".into());
        }
        let candidate = &route.candidates[0];
        if candidate.provider != PROVIDER || candidate.model != MODEL {
            return Err("ME-07 profile is not bound to custom/gpt-5.6-sol".into());
        }
        route.fallback
    };
    resolved.config.llm.model = MODEL.to_string();
    resolved.config.llm.reasoning_effort = Some(ReasoningEffort::Max);
    resolved.config.orchestrator.context_transactions_enabled = true;
    let (client, selected) = build_configured_client(&resolved.config, None, Some(MODEL))?;
    if selected.id != PROVIDER || selected.model != MODEL {
        return Err("ME-07 configured client selected a different model/provider".into());
    }
    client.set_reasoning_effort(Some(ReasoningEffort::Max))?;
    if client.reasoning_effort() != Some(ReasoningEffort::Max) {
        return Err("ME-07 client did not retain reasoning=max".into());
    }
    let binding = client
        .bind_model_attempt(&ModelRequestContext {
            context_id: config.context_id.clone(),
            session_id: config.session_id.clone(),
            attempt_id: "me07-provider-preflight".to_string(),
            objective_id: None,
            required_capabilities: Vec::new(),
        })
        .await?;
    if binding.requested_alias != MODEL
        || binding.physical_model != MODEL
        || binding.provider_instance_id != PROVIDER
        || binding.protocol != "openai-responses"
    {
        return Err("ME-07 exact model binding preflight failed".into());
    }
    Ok((
        client,
        resolved.config,
        binding.physical_model,
        binding.provider_instance_id,
        binding.protocol,
        fallback,
    ))
}

async fn usage_totals(runtime: &MorphzRuntime) -> Result<StateBenchUsageTotals, StateBenchError> {
    let events = runtime.query_events(QueryFilter::default()).await?;
    let mut totals = StateBenchUsageTotals::default();
    for event in events {
        if event.topic != "runtime/model_usage" {
            continue;
        }
        let usage = event.payload.get("usage").and_then(Value::as_object);
        totals.model_calls += 1;
        let read = |name: &str| {
            usage
                .and_then(|usage| usage.get(name))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        totals.input_tokens += read("input_tokens");
        totals.output_tokens += read("output_tokens");
        totals.reasoning_tokens += read("reasoning_tokens");
        totals.total_tokens += read("total_tokens");
    }
    Ok(totals)
}

async fn context_tx_commit_count(runtime: &MorphzRuntime) -> Result<usize, StateBenchError> {
    Ok(runtime
        .query_events(QueryFilter::default())
        .await?
        .iter()
        .filter(|event| event.topic == "chat/context_tx_committed")
        .count())
}

async fn wait_for_reply(
    runtime: &MorphzRuntime,
    session_id: &str,
    root_turn_id: &str,
    timeout: Duration,
) -> Result<String, StateBenchError> {
    let reply = runtime
        .wait_for_turn_reply(session_id, root_turn_id, timeout)
        .await
        .map_err(|error| -> StateBenchError {
            format!("ME-07 Morphz Runtime reply failed: {error}").into()
        })?;
    reply
        .payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "ME-07 Morphz Runtime reply has no text".into())
}

pub async fn run_state_bench_agent(config: StateBenchAgentConfig) -> Result<(), StateBenchError> {
    let manifest = load_and_validate_manifest(&config.tool_manifest_path)?;
    std::fs::create_dir_all(&config.workspace_root)?;
    std::fs::create_dir_all(&config.artifact_root)?;
    if let Some(parent) = config.database_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let harness_source = render_state_bench_harness(&manifest)?;
    let harness = HarnessPackage::from_source("me07-state-bench.hns", &harness_source)?;
    let harness_ref = ExactHarnessRef {
        id: harness.manifest.id.clone(),
        version: harness.manifest.version.clone(),
    };
    let harness_hash = harness.artifact_hash.clone();
    let (client, mut app, physical_model, provider_instance_id, provider_protocol, fallback) =
        build_client(&config, &manifest).await?;
    app.permissions.mode = PermissionMode::FullAccess;
    app.permissions.workspace_root = config.workspace_root.to_string_lossy().to_string();
    app.background_task.artifact_dir = config.artifact_root.to_string_lossy().to_string();
    app.orchestrator.context_transactions_enabled = true;
    let identity = RuntimeIdentity {
        agent_id: config.agent_id.clone(),
        context_id: config.context_id.clone(),
        principal_id: config.principal_id.clone(),
    };
    let mut builder = MorphzRuntime::builder(app, Arc::clone(&client))
        .database_path(config.database_path.to_string_lossy())
        .identity(identity.clone())
        .tool_policy(RuntimeToolPolicy {
            context_only: true,
            coding_eval: true,
        })
        .harness_package(harness);
    for definition in &manifest.tools {
        builder = builder.extra_tool(Arc::new(StateBenchBridgeTool::new(
            definition.clone(),
            config.bridge_url.clone(),
            config.bridge_token.clone(),
        )?));
    }
    let runtime = builder.build().await?;
    runtime.start().await?;
    if runtime.get_agent(&config.agent_id).await?.is_none() {
        runtime
            .ensure_agent(NewAgent {
                id: config.agent_id.clone(),
                title: format!("ME-07 {} Agent", manifest.domain),
                root_context_id: config.context_id.clone(),
            })
            .await?;
    }
    if runtime.get_context(&config.context_id).await?.is_none() {
        runtime
            .ensure_context(NewCognitiveContext {
                id: config.context_id.clone(),
                agent_id: config.agent_id.clone(),
                title: format!("ME-07 {} learned Context", manifest.domain),
            })
            .await?;
    }
    runtime
        .ensure_session(NewSession {
            id: config.session_id.clone(),
            agent_id: config.agent_id.clone(),
            context_id: config.context_id.clone(),
            parent_session_id: None,
            title: format!("STATE-Bench {}", manifest.task_id),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;
    let ready = StateBenchReady {
        r#type: "ready".to_string(),
        protocol_id: PROTOCOL_ID.to_string(),
        domain: manifest.domain.clone(),
        task_id: manifest.task_id.clone(),
        agent_id: config.agent_id.clone(),
        context_id: config.context_id.clone(),
        session_id: config.session_id.clone(),
        harness_id: harness_ref.id.clone(),
        harness_version: harness_ref.version.clone(),
        harness_artifact_hash: harness_hash,
        tool_names: std::iter::once("context_tx".to_string())
            .chain(manifest.tools.iter().map(|tool| tool.name.clone()))
            .collect(),
        physical_tool_names: runtime.physical_tool_names(),
        requested_model: if config.deterministic_fake_client {
            "deterministic-me07-gate".to_string()
        } else {
            MODEL.to_string()
        },
        physical_model,
        provider_instance_id,
        provider_protocol,
        reasoning_effort: if config.deterministic_fake_client {
            "none".to_string()
        } else {
            "max".to_string()
        },
        fallback,
        initial_mind_version: runtime.mind_version(&config.context_id).await?,
        initial_context_tx_commits: context_tx_commit_count(&runtime).await?,
        deterministic_fake_not_reportable: config.deterministic_fake_client,
    };
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    writeln!(output, "{}", serde_json::to_string(&ready)?)?;
    output.flush()?;

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: StateBenchTurnRequest = serde_json::from_str(&line)?;
        if request.request_id.trim().is_empty() || request.text.trim().is_empty() {
            return Err("ME-07 turn request must contain request_id and text".into());
        }
        let receipt = runtime
            .session(config.session_id.clone())
            .send_as_principal_with_harness(
                request.text,
                "STATE-Bench-User",
                config.principal_id.clone(),
                Some(request.request_id.clone()),
                Some(harness_ref.clone()),
            )
            .await?;
        let text = wait_for_reply(
            &runtime,
            &config.session_id,
            &receipt.event_id,
            Duration::from_secs(config.reply_timeout_seconds.max(1)),
        )
        .await?;
        let response = StateBenchTurnResponse {
            protocol_id: PROTOCOL_ID.to_string(),
            request_id: request.request_id,
            text,
            duplicate: receipt.duplicate,
            mind_version: runtime.mind_version(&config.context_id).await?,
            context_tx_commits: context_tx_commit_count(&runtime).await?,
            usage: usage_totals(&runtime).await?,
        };
        writeln!(output, "{}", serde_json::to_string(&response)?)?;
        output.flush()?;
    }
    Ok(())
}

pub fn parse_agent_config(arguments: &[String]) -> Result<StateBenchAgentConfig, StateBenchError> {
    let mut values = BTreeMap::new();
    let mut deterministic_fake_client = false;
    for argument in arguments {
        if argument == "--deterministic-fake-client" {
            deterministic_fake_client = true;
            continue;
        }
        let (key, value) = argument
            .strip_prefix("--")
            .and_then(|value| value.split_once('='))
            .ok_or_else(|| format!("invalid ME-07 argument: {argument}"))?;
        values.insert(key.to_string(), value.to_string());
    }
    let required = |name: &str| -> Result<String, StateBenchError> {
        values
            .get(name)
            .cloned()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("missing --{name}=...").into())
    };
    let bridge_token_path = PathBuf::from(required("bridge-token-file")?);
    let bridge_token = std::fs::read_to_string(&bridge_token_path)
        .map_err(|error| format!("failed to read ME-07 bridge token file: {error}"))?
        .trim()
        .to_string();
    if bridge_token.is_empty() {
        return Err("ME-07 bridge token file must not be empty".into());
    }
    Ok(StateBenchAgentConfig {
        database_path: PathBuf::from(required("database")?),
        workspace_root: PathBuf::from(required("workspace-root")?),
        artifact_root: PathBuf::from(required("artifact-root")?),
        tool_manifest_path: PathBuf::from(required("tool-manifest")?),
        bridge_url: required("bridge-url")?,
        bridge_token,
        profile: required("profile")?,
        agent_id: required("agent-id")?,
        context_id: required("context-id")?,
        session_id: required("session-id")?,
        principal_id: required("principal-id")?,
        reply_timeout_seconds: values
            .get("reply-timeout-seconds")
            .map(|value| value.parse())
            .transpose()?
            .unwrap_or(1800),
        deterministic_fake_client,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> StateBenchToolManifest {
        StateBenchToolManifest {
            protocol_id: PROTOCOL_ID.to_string(),
            domain: "travel".to_string(),
            task_id: "travel-task-1".to_string(),
            system_prompt: "Follow the authoritative travel policy.".to_string(),
            learning: false,
            tools: vec![ToolDefinition {
                name: "get_booking".to_string(),
                description: "Get a booking".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {"booking_id": {"type": "string"}},
                    "required": ["booking_id"],
                    "additionalProperties": false
                }),
            }],
        }
    }

    #[test]
    fn harness_is_typed_and_declares_domain_tool_plus_context_tx() {
        let source = render_state_bench_harness(&manifest()).unwrap();
        let package = HarnessPackage::from_source("me07-state-bench.hns", &source).unwrap();
        assert_eq!(
            package.entry.declared_tools.unwrap(),
            vec!["context_tx".to_string(), "get_booking".to_string()]
        );
        assert!(source.contains("authoritative-domain-policy"));
        assert!(source.contains("Follow the authoritative travel policy"));
    }

    #[test]
    fn learning_harness_allows_context_tx_without_domain_tools() {
        let mut manifest = manifest();
        manifest.task_id = "travel-offline-learning".to_string();
        manifest.learning = true;
        manifest.tools.clear();
        let source = render_state_bench_harness(&manifest).unwrap();
        let package = HarnessPackage::from_source("me07-learning.hns", &source).unwrap();
        assert_eq!(package.entry.declared_tools.unwrap(), vec!["context_tx"]);
        assert!(source.contains("TRAINING_EPISODE_INGESTED"));
    }

    #[test]
    fn bridge_rejects_non_loopback_endpoints() {
        let error = StateBenchBridgeTool::new(
            manifest().tools[0].clone(),
            "https://example.com/tool",
            "test-token",
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("loopback-only"));
    }

    #[test]
    fn parser_requires_explicit_artifact_and_identity_boundaries() {
        let error = parse_agent_config(&["--database=/tmp/test.db".to_string()]).unwrap_err();
        assert!(error.to_string().contains("bridge-token-file"));
    }

    #[test]
    fn parser_reads_bridge_token_from_file_not_process_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let token = temp.path().join("bridge.token");
        std::fs::write(&token, "gate-token\n").unwrap();
        let arguments = vec![
            "--database=/tmp/test.db".to_string(),
            format!("--bridge-token-file={}", token.display()),
        ];
        let error = parse_agent_config(&arguments).unwrap_err();
        assert!(error.to_string().contains("workspace-root"));
    }
}
