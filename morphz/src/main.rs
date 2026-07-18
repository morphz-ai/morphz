use chrono::Utc;
use morphz::approval::ApprovalDecision;
use morphz::cli::{morphz_command_line_parser, Invocation};
use morphz::config;
use morphz::event::Event;
use morphz::llm::{Client, Message, ReasoningEffort, Response, ToolDefinition};
use morphz::memory::{
    NewAgent, NewCognitiveContext, NewObjective, NewSession, ObjectiveMutation, ObjectiveStatus,
    SessionMountKind, SessionRecord, SessionStatus,
};
use morphz::permission::{ApprovalPolicy, PermissionMode, ReviewerKind, SandboxMode};
use morphz::provider::build_configured_client;
use morphz::provider::{list_provider_models, probe_provider};
use morphz::runtime::{
    MorphzRuntime, RuntimeEventStream, RuntimeIdentity, SchedulerQuery, SessionHandle,
};
use morphz::web::{Server, ServerDefaults};
use std::io::IsTerminal;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing_subscriber::{fmt, EnvFilter};

type AppError = Box<dyn std::error::Error + Send + Sync>;

const HELP: &str = r#"Morphz — an Agent runtime with Context-owned Sessions

USAGE:
  morphz [OPTIONS] [PROMPT...]
  morphz exec [OPTIONS] PROMPT...
  morphz serve [OPTIONS]
  morphz dashboard [OPTIONS]
  morphz <context|session|agent|objective|scheduler|job|config> <COMMAND> [ARGS...]

SESSION SEMANTICS:
  A bare invocation creates a new Session mounted in the selected shared Context.
  `resume`, --session=ID and `session resume` reattach the same Session identity.

CORE COMMANDS:
  exec PROMPT...                 Run one prompt and print the final reply
  resume [ID] [PROMPT...]        Reattach ID, or the most recently active Session when omitted
  serve                          Start the HTTP/WebSocket server
  dashboard                      Start Dashboard with a temporary Token and open a browser
  setup                          Configure a model Provider interactively
  provider list|test             Inspect and verify model Providers
  model list|use                 Discover or select models
  profile list|show|use          Inspect or select configuration Profiles
  context list|show|status|audit Inspect Cognitive Contexts and verify Mind Projection
  scheduler show                Inspect the authoritative Scheduler snapshot
  session list|show|create       Manage Sessions
  session resume [ID] [PROMPT...] Reattach ID, or the most recently active Session when omitted
  agent list|show|create         Manage Agents
  objective list|show            Inspect persistent Objectives
  objective create GOAL...       Create and run a long-lived Objective
  objective edit ID GOAL...      Revise an Objective with CAS protection
  objective pause|resume|cancel  Control an Objective lifecycle
  job list|cancel                Inspect or cancel Sub Agent jobs
  config show|check|path|explain Inspect configuration and value sources
  doctor                         Check the local Runtime setup

GLOBAL OPTIONS:
  -C, --cwd=DIR                  Change working directory before loading config
      --config-file=FILE         Load an explicit trusted config file
  -m, --model=MODEL              Override the configured model
      --reasoning-effort=LEVEL   default | none | low | medium | high | max
      --agent=ID                 Select an Agent
      --context=ID               Select or mount a Cognitive Context
      --session=ID               Reattach an existing Session
  -s, --sandbox=MODE             workspace-write | full-access
  -a, --approval=MODE            human | auto | never
      --add-dir=DIR              Add a readable and writable directory
      --network[=BOOL]           Allow sandboxed command network access
      --bind=ADDR                Override server bind address
      --format=human|json        Management-command output format
      --token-budget=N           Optional Objective token budget
      --include-terminal         Include terminal Threads and Jobs in scheduler reads
      --limit=N                  Bound scheduler history (1..=2000)
      --reason=TEXT              Auditable lifecycle-control reason
      --log-level=LEVEL          Override the tracing filter
      --theme=THEME              system | mono | iris | cyan | coral | no-color
      --tui                      Force the fullscreen terminal UI
      --plain                    Use the classic line-oriented terminal
  -h, --help                     Print help
  -V, --version                  Print version

Use `--` to force every remaining argv token to be prompt text.
Options that take values support --name=value; this form also removes command/value ambiguity.
"#;

const SERVE_HELP: &str = r#"Morphz Dashboard Server

USAGE:
  morphz serve [OPTIONS]

DESCRIPTION:
  Start the HTTP/WebSocket Runtime service and serve the embedded Dashboard.
  The Dashboard is available at the server root path `/`; no external web
  directory, Node.js process, or static-file server is required.

OPTIONS:
      --bind=ADDR                Listen address, for example 127.0.0.1:8080
      --reasoning-effort=LEVEL   default | none | low | medium | high | max
      --config-file=FILE         Load an explicit trusted config file
  -p, --profile=NAME             Load a named configuration Profile
      --log-level=LEVEL          Override the tracing filter
  -h, --help                     Print this help

NETWORK SAFETY:
  Loopback addresses may run without Dashboard authentication. Binding to a
  non-loopback address such as 0.0.0.0 requires MORPHZ_DASHBOARD_TOKEN; the
  same token authenticates HTTP API requests and WebSocket connections.

EXAMPLES:
  morphz serve
  morphz serve --bind=127.0.0.1:9090
  MORPHZ_DASHBOARD_TOKEN=replace-with-a-secret \
    morphz serve --bind=0.0.0.0:8080
"#;

const DASHBOARD_HELP: &str = r#"Morphz Dashboard

USAGE:
  morphz dashboard [OPTIONS]

DESCRIPTION:
  Generate a cryptographically random Token for this process, start the
  embedded Dashboard server, and open it in the operating system's default
  browser. The generated Token is not written to configuration or storage.

OPTIONS:
      --bind=ADDR                Listen address, for example 127.0.0.1:8080
      --reasoning-effort=LEVEL   default | none | low | medium | high | max
      --config-file=FILE         Load an explicit trusted config file
  -p, --profile=NAME             Load a named configuration Profile
      --log-level=LEVEL          Override the tracing filter
  -h, --help                     Print this help

EXAMPLES:
  morphz dashboard
  morphz dashboard --bind=0.0.0.0:8080

When ADDR is 0.0.0.0 or [::], the local browser is opened through the
corresponding loopback address while the server remains reachable on every
network interface. Remote clients need the generated Token URL.
"#;

fn help_for(invocation: &Invocation) -> &'static str {
    match invocation.command_path() {
        [command] if command == "serve" => SERVE_HELP,
        [command] if command == "dashboard" => DASHBOARD_HELP,
        _ => HELP,
    }
}

fn init_logging(log_level: Option<&str>, tui_mode: bool) -> Result<(), AppError> {
    let filter = match log_level {
        Some(level) => EnvFilter::try_new(level)?,
        None => EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,morphz=debug")),
    };

    if tui_mode {
        fmt()
            .with_env_filter(filter)
            .with_target(true)
            .with_timer(fmt::time::UtcTime::rfc_3339())
            .with_writer(std::io::sink)
            .try_init()?;
    } else {
        fmt()
            .with_env_filter(filter)
            .with_target(true)
            .with_timer(fmt::time::UtcTime::rfc_3339())
            .try_init()?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), AppError> {
    let invocation = morphz_command_line_parser().parse(std::env::args().skip(1))?;
    let tui_mode = should_use_tui(&invocation)?;
    // Resolve the host-owned environment file before `--cwd` changes the
    // process directory. A project `.env` must never be able to redirect an
    // already-exported host credential to a project-controlled endpoint.
    let host_env_path = config::host_env_path().map(|path| absolute_path(&path));
    if let Some(cwd) = option_value(&invocation, "cwd") {
        std::env::set_current_dir(cwd)
            .map_err(|error| format!("无法切换工作目录到 '{cwd}': {error}"))?;
    }
    init_logging(option_value(&invocation, "log-level"), tui_mode)?;

    if invocation.has_option("help") || invocation.command_path() == ["help"] {
        print!("{}", help_for(&invocation));
        return Ok(());
    }
    if invocation.has_option("version") || invocation.command_path() == ["version"] {
        println!("morphz {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    if let Some(path) = host_env_path {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, path = %path.display(), "无法加载用户级 Morphz 环境文件");
            }
        } else {
            tracing::debug!(path = %path.display(), "已加载用户级 Morphz 环境文件");
        }
    }

    reject_unimplemented_options(&invocation)?;
    let cwd = std::env::current_dir()?;
    let explicit_config_path = selected_config_path(&invocation);
    let active_profile = if invocation.has_option("profile") {
        None
    } else {
        config::active_profile()?
    };
    let selected_profile = option_value(&invocation, "profile").or(active_profile.as_deref());
    let mut resolved = resolve_invocation_config(
        &invocation,
        &cwd,
        explicit_config_path.as_deref(),
        selected_profile,
    )?;

    // Setup is a host-side control-plane action. It must be available before
    // database/runtime initialization and, most importantly, before a model
    // credential exists.
    if invocation.command_path() == ["setup"] {
        morphz::setup::run_interactive_setup().await?;
        return Ok(());
    }

    let interactive_terminal = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    if should_run_first_time_setup_with_terminal(
        &invocation,
        &resolved.config,
        interactive_terminal,
    ) {
        println!(
            "尚未配置模型 Provider，正在进入首次启动设置。\n\
             （Morphz 不会自动读取工作目录中的 .env；凭证将保存到用户级配置。）\n"
        );
        morphz::setup::run_interactive_setup().await?;
        // The setup wizard writes the managed user layer. Re-resolve all
        // layers so this very invocation can continue into the TUI without a
        // restart, while preserving Profile/project/CLI precedence.
        resolved = resolve_invocation_config(
            &invocation,
            &cwd,
            explicit_config_path.as_deref(),
            selected_profile,
        )?;
    }
    if dispatch_config_command(&invocation, &resolved)? {
        return Ok(());
    }
    let protected_config_paths = resolved
        .loaded_paths()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    let mut app_config = resolved.config;
    protect_runtime_files(&mut app_config, &protected_config_paths);

    let default_agent_id =
        std::env::var("MORPHZ_AGENT_ID").unwrap_or_else(|_| "default-agent".to_string());
    let default_context_id =
        std::env::var("MORPHZ_CONTEXT_ID").unwrap_or_else(|_| "context-default".to_string());
    let identity = RuntimeIdentity {
        agent_id: default_agent_id.clone(),
        context_id: default_context_id.clone(),
    };
    let needs_workers = command_needs_llm(&invocation);
    let client = build_client(&invocation, &app_config, needs_workers)?;
    let database_path =
        std::env::var("MORPHZ_DB_PATH").unwrap_or_else(|_| app_config.server.database_path.clone());
    let runtime = MorphzRuntime::builder(app_config.clone(), client)
        .database_path(database_path)
        .identity(identity)
        .build()
        .await?;
    if needs_workers {
        runtime.start().await?;
    } else {
        // Read-only and registry-management commands do not need Event Bus
        // subscribers or model evaluation. Initializing only the identity records
        // keeps the lack of an API key harmless and avoids background workers.
        ensure_cli_identity_records(&runtime, &default_agent_id, &default_context_id).await?;
    }

    dispatch_runtime_command(
        invocation,
        runtime,
        app_config,
        default_agent_id,
        default_context_id,
        tui_mode,
    )
    .await
}

async fn ensure_cli_identity_records(
    runtime: &MorphzRuntime,
    agent_id: &str,
    active_context_id: &str,
) -> Result<(), AppError> {
    let root_context_id = runtime
        .get_agent(agent_id)
        .await?
        .map(|agent| agent.root_context_id)
        .unwrap_or_else(|| active_context_id.to_string());
    runtime
        .ensure_agent(NewAgent {
            id: agent_id.to_string(),
            title: "默认 Agent".to_string(),
            root_context_id,
        })
        .await?;
    runtime
        .ensure_context(NewCognitiveContext {
            id: active_context_id.to_string(),
            agent_id: agent_id.to_string(),
            title: "默认认知 Context".to_string(),
        })
        .await?;
    Ok(())
}

fn option_value<'a>(invocation: &'a Invocation, name: &str) -> Option<&'a str> {
    invocation
        .option(name)
        .and_then(|option| option.last_value())
}

fn switch_enabled(invocation: &Invocation, name: &str) -> Result<bool, AppError> {
    let Some(option) = invocation.option(name) else {
        return Ok(false);
    };
    match option.last_value() {
        None => Ok(true),
        Some(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(format!("--{name} 需要布尔值 true/false").into()),
        },
    }
}

fn should_use_tui(invocation: &Invocation) -> Result<bool, AppError> {
    should_use_tui_with_terminal(
        invocation,
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
    )
}

fn should_use_tui_with_terminal(
    invocation: &Invocation,
    interactive_terminal: bool,
) -> Result<bool, AppError> {
    let force_tui = switch_enabled(invocation, "tui")?;
    let force_plain = switch_enabled(invocation, "plain")?;
    if force_tui && force_plain {
        return Err("--tui 与 --plain 不能同时使用".into());
    }
    let command = invocation.command_path().join(" ");
    let conversational = matches!(command.as_str(), "" | "resume" | "session resume");
    Ok(conversational && !force_plain && (force_tui || interactive_terminal))
}

fn selected_config_path(invocation: &Invocation) -> Option<PathBuf> {
    option_value(invocation, "config-file")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("MORPHZ_CONFIG_PATH").map(PathBuf::from))
}

fn reject_unimplemented_options(invocation: &Invocation) -> Result<(), AppError> {
    for (name, explanation) in [
        ("output", "输出文件写入尚未接入，请使用 Shell 重定向"),
        ("schema", "结构化输出 Schema 尚未接入"),
    ] {
        if invocation.has_option(name) {
            return Err(format!("--{name} 当前不可用：{explanation}").into());
        }
    }
    Ok(())
}

fn resolve_invocation_config(
    invocation: &Invocation,
    cwd: &Path,
    explicit_config_path: Option<&Path>,
    selected_profile: Option<&str>,
) -> Result<config::ResolvedConfig, AppError> {
    let mut resolved = config::resolve_config(cwd, explicit_config_path, selected_profile)?;
    for warning in &resolved.warnings {
        tracing::warn!("{warning}");
    }
    resolved.config.apply_runtime_env_overrides()?;
    mark_environment_config_sources(&mut resolved);
    let set_overrides: Vec<String> = invocation
        .option("set")
        .map(|option| option.occurrences().iter().flatten().cloned().collect())
        .unwrap_or_default();
    resolved.apply_cli_set_overrides(&set_overrides)?;
    apply_cli_config(invocation, &mut resolved.config)?;
    mark_cli_config_sources(invocation, &mut resolved);
    Ok(resolved)
}

fn should_run_first_time_setup_with_terminal(
    invocation: &Invocation,
    app_config: &config::AppConfig,
    interactive_terminal: bool,
) -> bool {
    if !interactive_terminal {
        return false;
    }
    let command = invocation.command_path().join(" ");
    let interactive_conversation = matches!(command.as_str(), "" | "resume" | "session resume");
    interactive_conversation
        && option_value(invocation, "provider").is_none()
        && app_config.llm.provider.is_none()
}

fn dispatch_config_command(
    invocation: &Invocation,
    resolved: &config::ResolvedConfig,
) -> Result<bool, AppError> {
    let command = invocation.command_path().join(" ");
    if !matches!(
        command.as_str(),
        "config" | "config show" | "config check" | "config path" | "config explain"
    ) {
        return Ok(false);
    }
    if command == "config path" {
        if resolved.layers.is_empty() {
            println!("未加载配置文件；当前仅使用内置默认值");
        } else {
            for layer in &resolved.layers {
                println!("{}\t{}", layer.kind.as_str(), layer.path.display());
            }
        }
        return Ok(true);
    }
    if command == "config check" {
        println!("配置有效：{} 个文件层", resolved.layers.len());
        for warning in &resolved.warnings {
            println!("警告：{warning}");
        }
    } else if command == "config explain" {
        let rows = config_explain_rows(resolved)?;
        if json_output(invocation) {
            println!("{}", serde_json::to_string_pretty(&rows)?);
        } else {
            for row in rows {
                println!(
                    "{} = {}\tsource={}\tchain={}",
                    row["key"].as_str().unwrap_or_default(),
                    row["value"].as_str().unwrap_or_default(),
                    row["source"].as_str().unwrap_or_default(),
                    row["chain"].as_str().unwrap_or_default()
                );
            }
        }
    } else {
        println!("{:#?}", resolved.config);
    }
    Ok(true)
}

fn config_explain_rows(
    resolved: &config::ResolvedConfig,
) -> Result<Vec<serde_json::Value>, AppError> {
    let value = toml::Value::try_from(&resolved.config)?;
    let mut leaves = Vec::new();
    collect_config_leaves(&value, "", &mut leaves);
    Ok(leaves
        .into_iter()
        .map(|(key, value)| {
            let source = resolved.source_for(&key);
            let chain = resolved.source_history_for(&key).join(" -> ");
            serde_json::json!({
                "key": key,
                "value": display_config_value(&key, &value),
                "source": source,
                "chain": chain,
            })
        })
        .collect())
}

fn collect_config_leaves(
    value: &toml::Value,
    prefix: &str,
    output: &mut Vec<(String, toml::Value)>,
) {
    match value {
        toml::Value::Table(table) if !table.is_empty() => {
            for (key, value) in table {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                collect_config_leaves(value, &path, output);
            }
        }
        _ if !prefix.is_empty() => output.push((prefix.to_string(), value.clone())),
        _ => {}
    }
}

fn display_config_value(key: &str, value: &toml::Value) -> String {
    let lowered = key.to_ascii_lowercase();
    if lowered.contains("api_key")
        || lowered.contains("password")
        || lowered.contains("secret")
        || lowered.contains(".headers.")
        || lowered.ends_with(".command")
    {
        return "<redacted>".to_string();
    }
    value.to_string()
}

fn mark_environment_config_sources(resolved: &mut config::ResolvedConfig) {
    for (variable, key) in [
        ("MORPHZ_LLM_MODEL", "llm.model"),
        ("MORPHZ_LLM_PROVIDER", "llm.provider"),
        ("MORPHZ_WORKSPACE_ROOT", "permissions.workspace_root"),
        ("MORPHZ_ARTIFACT_DIR", "background_task.artifact_dir"),
        ("MORPHZ_EXEC_NETWORK", "permissions.network"),
        ("MORPHZ_PERMISSION_MODE", "permissions.mode"),
        (
            "MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT",
            "orchestrator.context_soft_token_limit",
        ),
        (
            "MORPHZ_CONTEXT_HARD_TOKEN_LIMIT",
            "orchestrator.context_hard_token_limit",
        ),
        (
            "MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS",
            "orchestrator.context_maintenance_reserve_tokens",
        ),
        (
            "MORPHZ_LLM_REQUEST_TIMEOUT_SECS",
            "llm.request_timeout_secs",
        ),
        ("MORPHZ_LLM_MAX_OUTPUT_TOKENS", "llm.max_output_tokens"),
        ("MORPHZ_LLM_REASONING_EFFORT", "llm.reasoning_effort"),
    ] {
        if std::env::var_os(variable).is_some() {
            resolved.mark_source(key, format!("environment:{variable}"));
        }
    }
}

fn mark_cli_config_sources(invocation: &Invocation, resolved: &mut config::ResolvedConfig) {
    for (option, key) in [
        ("model", "llm.model"),
        ("reasoning-effort", "llm.reasoning_effort"),
        ("bind", "server.bind"),
        ("sandbox", "permissions.sandbox_mode"),
        ("approval", "permissions.approval_policy"),
        ("theme", "tui.theme"),
        ("network", "permissions.network"),
        ("add-dir", "permissions.read_roots/write_roots"),
    ] {
        if invocation.has_option(option) {
            resolved.mark_source(key, format!("cli:--{option}"));
        }
    }
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn make_permissions_custom(config: &mut config::AppConfig) {
    if config.permissions.mode != PermissionMode::Custom {
        let (sandbox, approval, reviewer) = config.permissions.preset();
        config.permissions.sandbox_mode = sandbox;
        config.permissions.approval_policy = approval;
        config.permissions.reviewer = reviewer;
        config.permissions.mode = PermissionMode::Custom;
    }
}

fn apply_cli_config(
    invocation: &Invocation,
    app_config: &mut config::AppConfig,
) -> Result<(), AppError> {
    if let Some(model) = option_value(invocation, "model") {
        if model.trim().is_empty() {
            return Err("--model 不能为空".into());
        }
        app_config.llm.model = model.to_string();
    }
    if let Some(effort) = option_value(invocation, "reasoning-effort") {
        app_config.llm.reasoning_effort = match effort.trim().to_ascii_lowercase().as_str() {
            "default" | "auto" => None,
            value => Some(ReasoningEffort::parse(value).ok_or_else(|| {
                format!("未知推理深度 '{effort}'；可用 default、none、low、medium、high、max")
            })?),
        };
    }
    if let Some(bind) = option_value(invocation, "bind") {
        app_config.server.bind = bind.to_string();
    }
    if let Some(theme) = option_value(invocation, "theme") {
        app_config.tui.theme = config::TuiTheme::parse(theme).ok_or_else(|| {
            format!("未知 TUI 主题 '{theme}'；可用 system、mono、iris、cyan、coral、no-color")
        })?;
    }
    if let Some(sandbox) = option_value(invocation, "sandbox") {
        make_permissions_custom(app_config);
        app_config.permissions.sandbox_mode = match sandbox {
            "workspace-write" => SandboxMode::WorkspaceWrite,
            "full-access" | "danger-full-access" => SandboxMode::DangerFullAccess,
            "read-only" => {
                return Err(
                    "read-only Sandbox 尚无真实 Backend；为避免虚假安全语义，本版本拒绝启用".into(),
                )
            }
            _ => return Err(format!("未知 Sandbox 模式 '{sandbox}'").into()),
        };
    }
    if let Some(approval) = option_value(invocation, "approval") {
        make_permissions_custom(app_config);
        match approval {
            "human" | "ask" => {
                app_config.permissions.approval_policy = ApprovalPolicy::OnRequest;
                app_config.permissions.reviewer = ReviewerKind::User;
            }
            "auto" | "auto-review" => {
                app_config.permissions.approval_policy = ApprovalPolicy::OnRequest;
                app_config.permissions.reviewer = ReviewerKind::AutoReview;
            }
            "never" | "deny" => {
                app_config.permissions.approval_policy = ApprovalPolicy::Never;
                app_config.permissions.reviewer = ReviewerKind::Deny;
            }
            _ => return Err(format!("未知审批模式 '{approval}'").into()),
        }
    }
    if invocation.has_option("network") {
        app_config.permissions.network = switch_enabled(invocation, "network")?;
    }
    if let Some(add_dirs) = invocation.option("add-dir") {
        for value in add_dirs.occurrences().iter().flatten() {
            app_config.permissions.read_roots.push(value.clone());
            app_config.permissions.write_roots.push(value.clone());
        }
    }
    if let Some(format) = option_value(invocation, "format") {
        if !matches!(format, "human" | "json") {
            return Err("--format 只支持 human 或 json".into());
        }
    }
    Ok(())
}

fn protect_runtime_files(app_config: &mut config::AppConfig, config_paths: &[PathBuf]) {
    for path in config_paths
        .iter()
        .cloned()
        .chain(std::env::current_exe().ok())
    {
        let protected = path.to_string_lossy().into_owned();
        if !app_config.permissions.protected_paths.contains(&protected) {
            app_config.permissions.protected_paths.push(protected);
        }
    }
}

fn command_needs_llm(invocation: &Invocation) -> bool {
    matches!(
        invocation.command_path().join(" ").as_str(),
        "" | "exec"
            | "resume"
            | "serve"
            | "dashboard"
            | "session resume"
            | "objective create"
            | "objective resume"
    )
}

fn build_client(
    invocation: &Invocation,
    app_config: &config::AppConfig,
    required: bool,
) -> Result<Arc<dyn Client>, AppError> {
    if !required {
        return Ok(Arc::new(OfflineClient));
    }
    let (client, selected) = build_configured_client(
        app_config,
        option_value(invocation, "provider"),
        option_value(invocation, "model"),
    )?;
    tracing::info!(
        provider = %selected.id,
        protocol = selected.protocol.as_str(),
        model = %selected.model,
        base_url = %selected.base_url,
        "当前使用已配置 Provider"
    );
    Ok(client)
}

struct OfflineClient;

#[async_trait::async_trait]
impl Client for OfflineClient {
    async fn create_completion(
        &self,
        _messages: Vec<Message>,
        _tools: Vec<ToolDefinition>,
    ) -> Result<Response, AppError> {
        Err("该管理命令以离线 Client 启动，不能执行模型求值".into())
    }
}

async fn dispatch_runtime_command(
    invocation: Invocation,
    runtime: MorphzRuntime,
    app_config: config::AppConfig,
    default_agent_id: String,
    default_context_id: String,
    tui_mode: bool,
) -> Result<(), AppError> {
    let command = invocation.command_path().join(" ");
    match command.as_str() {
        "" => {
            let session = select_or_create_console_session(
                &runtime,
                &invocation,
                &default_agent_id,
                &default_context_id,
            )
            .await?;
            let prompt = nonempty_prompt(invocation.prompt());
            if tui_mode {
                morphz::tui::run(runtime, session, prompt).await
            } else {
                run_interactive(
                    runtime,
                    session,
                    prompt,
                    app_config.orchestrator.reply_wait_notice_secs,
                )
                .await
            }
        }
        "exec" => {
            let prompt = nonempty_prompt(invocation.prompt())
                .ok_or("morphz exec 需要 PROMPT；可用 -- 强制后续参数作为提示词")?;
            let session = select_or_create_console_session(
                &runtime,
                &invocation,
                &default_agent_id,
                &default_context_id,
            )
            .await?;
            run_once(runtime, session, prompt).await
        }
        "serve" => {
            let server = Arc::new(Server::new_with_capacity(
                runtime,
                ServerDefaults {
                    agent_id: default_agent_id,
                    context_id: default_context_id,
                },
                app_config.server.broadcast_capacity,
            ));
            server.start(&app_config.server.bind).await?;
            tracing::info!(bind = %app_config.server.bind, "Morphz Server 已启动");
            shutdown_signal().await;
            Ok(())
        }
        "dashboard" => {
            let token = generate_dashboard_token()?;
            let browser_url = dashboard_browser_url(&app_config.server.bind, &token)?;
            let server = Arc::new(Server::new_with_capacity(
                runtime,
                ServerDefaults {
                    agent_id: default_agent_id,
                    context_id: default_context_id,
                },
                app_config.server.broadcast_capacity,
            ));
            server
                .start_with_dashboard_token(&app_config.server.bind, Some(token))
                .await?;
            println!("Dashboard: {browser_url}");
            if let Err(error) = open_dashboard_browser(&browser_url) {
                tracing::warn!(%error, "无法自动打开默认浏览器；请手动访问上面的 Dashboard 地址");
            }
            tracing::info!(bind = %app_config.server.bind, "Morphz Dashboard 已启动");
            shutdown_signal().await;
            Ok(())
        }
        "provider" | "provider list" => list_providers(&app_config, &invocation),
        "provider test" => test_provider(&app_config, &invocation).await,
        "model" | "model list" => list_models(&app_config, &invocation).await,
        "model use" => use_model(&app_config, &invocation),
        "profile" | "profile list" => list_profiles(&invocation),
        "profile show" => show_profile(&invocation),
        "profile use" => use_profile(&invocation),
        "resume" | "session resume" => {
            let (session, prompt) = resolve_resumed_session(&runtime, &invocation).await?;
            if tui_mode {
                morphz::tui::run(runtime, session, nonempty_prompt(prompt)).await
            } else {
                run_interactive(
                    runtime,
                    session,
                    nonempty_prompt(prompt),
                    app_config.orchestrator.reply_wait_notice_secs,
                )
                .await
            }
        }
        "context" | "context list" => list_contexts(&runtime, &invocation).await,
        "context show" => show_context(&runtime, &invocation, &default_context_id, false).await,
        "context status" => show_context(&runtime, &invocation, &default_context_id, true).await,
        "context audit" => audit_context(&runtime, &invocation, &default_context_id).await,
        "scheduler" | "scheduler show" => {
            show_scheduler(&runtime, &invocation, &default_context_id).await
        }
        "session" | "session list" => list_sessions(&runtime, &invocation).await,
        "session show" => show_session(&runtime, &invocation).await,
        "session create" => {
            create_session_command(
                &runtime,
                &invocation,
                &default_agent_id,
                &default_context_id,
            )
            .await
        }
        "agent" | "agent list" => list_agents(&runtime, &invocation).await,
        "agent show" => show_agent(&runtime, &invocation, &default_agent_id).await,
        "agent create" => create_agent_command(&runtime, &invocation).await,
        "objective" | "objective list" => {
            list_objectives(&runtime, &invocation, &default_context_id).await
        }
        "objective show" => show_objective(&runtime, &invocation).await,
        "objective create" => {
            create_objective_command(&runtime, &invocation, &default_context_id).await
        }
        "objective edit" => edit_objective_command(&runtime, &invocation).await,
        "objective pause" => pause_objective_command(&runtime, &invocation).await,
        "objective resume" => resume_objective_command(&runtime, &invocation).await,
        "objective cancel" => cancel_objective_command(&runtime, &invocation).await,
        "job" | "job list" => list_jobs(&runtime, &invocation).await,
        "job cancel" => cancel_job(&runtime, &invocation).await,
        "doctor" => doctor(&runtime, &app_config),
        "completion" => Err("Shell completion 生成器尚未实现".into()),
        command => Err(format!("命令尚未实现: {command}").into()),
    }
}

fn selected_provider_id<'a>(
    app_config: &'a config::AppConfig,
    invocation: &'a Invocation,
) -> Result<&'a str, AppError> {
    option_value(invocation, "provider")
        .or_else(|| invocation.prompt_args().first().map(String::as_str))
        .or(app_config.llm.provider.as_deref())
        .ok_or_else(|| "尚未选择 Provider；请先运行 `morphz setup`".into())
}

fn list_providers(app_config: &config::AppConfig, invocation: &Invocation) -> Result<(), AppError> {
    let mut providers = morphz::provider::builtin_provider_catalog()
        .into_iter()
        .map(|(id, provider)| (id, (provider, false)))
        .collect::<std::collections::BTreeMap<_, _>>();
    for (id, provider) in &app_config.providers {
        providers.insert(id.clone(), (provider.clone(), true));
    }
    if json_output(invocation) {
        let rows = providers
            .iter()
            .map(|(id, (provider, configured))| {
                serde_json::json!({
                    "id": id,
                    "protocol": provider.protocol.as_str(),
                    "base_url": provider.base_url,
                    "credential": provider.credential,
                    "configured": configured,
                    "selected": app_config.llm.provider.as_deref() == Some(id),
                })
            })
            .collect::<Vec<_>>();
        println!("{}", serde_json::to_string_pretty(&rows)?);
    } else {
        for (id, (provider, configured)) in providers {
            let selected = if app_config.llm.provider.as_deref() == Some(id.as_str()) {
                "*"
            } else {
                " "
            };
            println!(
                "{selected} {id}\t{}\t{}\t{}",
                provider.protocol.as_str(),
                provider.base_url,
                if configured { "configured" } else { "catalog" }
            );
        }
        if app_config.providers.is_empty() {
            println!("尚未配置 Provider；运行 `morphz setup` 从 Catalog 开始配置。");
        }
    }
    Ok(())
}

async fn test_provider(
    app_config: &config::AppConfig,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let provider_id = selected_provider_id(app_config, invocation)?;
    let probe = probe_provider(app_config, provider_id, Some(&app_config.llm.model)).await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&probe)?);
    } else {
        println!(
            "Provider '{}' 测试完成：protocol={}，models={}，当前模型可用={}，流式正文={}，工具调用={}",
            probe.provider,
            probe.protocol,
            probe.models_discovered,
            probe
                .selected_model_available
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            probe.completion_stream_verified,
            probe.tool_call_verified,
        );
        if let Some(error) = &probe.catalog_error {
            println!("模型目录不可用（不影响已通过的请求握手）：{error}");
        }
    }
    Ok(())
}

async fn list_models(
    app_config: &config::AppConfig,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let provider_id = selected_provider_id(app_config, invocation)?;
    let models = list_provider_models(app_config, provider_id).await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&models)?);
    } else {
        for model in models {
            let selected = if app_config.llm.provider.as_deref() == Some(provider_id)
                && app_config.llm.model == model
            {
                "*"
            } else {
                " "
            };
            println!("{selected} {provider_id}/{model}");
        }
    }
    Ok(())
}

fn use_model(app_config: &config::AppConfig, invocation: &Invocation) -> Result<(), AppError> {
    let value = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz model use [provider/]model")?;
    let (provider, model) = value
        .split_once('/')
        .filter(|(provider, _)| app_config.providers.contains_key(*provider))
        .map(|(provider, model)| (provider.to_string(), model.to_string()))
        .unwrap_or_else(|| {
            (
                app_config.llm.provider.clone().unwrap_or_default(),
                value.clone(),
            )
        });
    if provider.is_empty() {
        return Err("模型没有 Provider 前缀，且当前没有默认 Provider".into());
    }
    if !app_config.providers.contains_key(&provider) {
        return Err(format!("Provider '{provider}' 未定义").into());
    }
    let path = config::save_managed_model(&provider, &model)?;
    println!(
        "已将默认模型设为 {provider}/{model}；配置将在下一次求值或重启后生效。\n{}",
        path.display()
    );
    Ok(())
}

fn list_profiles(invocation: &Invocation) -> Result<(), AppError> {
    let profiles = config::list_profiles()?;
    let active = config::active_profile()?;
    if json_output(invocation) {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "active": active,
                "profiles": profiles,
            }))?
        );
    } else if profiles.is_empty() {
        println!("尚未创建 Profile；可在 Morphz 用户配置目录的 profiles/ 中添加 TOML 文件。");
    } else {
        for profile in profiles {
            let selected = if active.as_deref() == Some(&profile) {
                "*"
            } else {
                " "
            };
            println!("{selected} {profile}");
        }
    }
    Ok(())
}

fn show_profile(invocation: &Invocation) -> Result<(), AppError> {
    let profile = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz profile show <NAME>")?;
    let cwd = std::env::current_dir()?;
    let resolved = config::resolve_config(
        &cwd,
        selected_config_path(invocation).as_deref(),
        Some(profile),
    )?;
    println!("{:#?}", resolved.config);
    Ok(())
}

fn use_profile(invocation: &Invocation) -> Result<(), AppError> {
    let profile = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz profile use <NAME>")?;
    let path = config::select_active_profile(profile)?;
    println!("已将默认 Profile 设为 '{profile}'。\n{}", path.display());
    Ok(())
}

fn nonempty_prompt(prompt: String) -> Option<String> {
    (!prompt.trim().is_empty()).then_some(prompt)
}

fn generated_id(prefix: &str) -> String {
    format!(
        "{}_{}_{}",
        prefix,
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        std::process::id()
    )
}

fn validate_identifier(kind: &str, value: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
    {
        return Err(
            format!("{kind} 必须为 1..=128 个 ASCII 字母、数字、点、横线、下划线或冒号").into(),
        );
    }
    Ok(())
}

async fn selected_context(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<morphz::memory::CognitiveContextRecord, AppError> {
    let context_id = if let Some(context) = option_value(invocation, "context") {
        context.to_string()
    } else if let Some(agent_id) = option_value(invocation, "agent") {
        runtime
            .get_agent(agent_id)
            .await?
            .ok_or_else(|| format!("Agent '{agent_id}' 不存在"))?
            .root_context_id
    } else {
        default_context_id.to_string()
    };
    let context = runtime
        .get_context(&context_id)
        .await?
        .ok_or_else(|| format!("Context '{context_id}' 不存在"))?;
    if let Some(agent_id) = option_value(invocation, "agent") {
        if context.agent_id != agent_id {
            return Err(format!(
                "Context '{}' 属于 Agent '{}'，与 --agent={} 不一致",
                context.id, context.agent_id, agent_id
            )
            .into());
        }
    }
    Ok(context)
}

async fn select_or_create_console_session(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    _default_agent_id: &str,
    default_context_id: &str,
) -> Result<SessionHandle, AppError> {
    if let Some(session_id) = option_value(invocation, "session") {
        let record = runtime.get_session(session_id).await?.ok_or_else(|| {
            format!("Session '{session_id}' 不存在；--session 只用于恢复现有会话")
        })?;
        ensure_active_session(&record)?;
        if option_value(invocation, "context")
            .is_some_and(|context_id| context_id != record.context_id)
        {
            return Err(format!(
                "Session '{}' 挂载在 Context '{}'，与 --context 不一致",
                record.id, record.context_id
            )
            .into());
        }
        if option_value(invocation, "agent").is_some_and(|agent_id| agent_id != record.agent_id) {
            return Err(format!(
                "Session '{}' 属于 Agent '{}'，与 --agent 不一致",
                record.id, record.agent_id
            )
            .into());
        }
        return Ok(runtime.session(session_id));
    }

    let context = selected_context(runtime, invocation, default_context_id).await?;
    if let Ok(session_id) = std::env::var("MORPHZ_SESSION_ID") {
        if !session_id.trim().is_empty() {
            validate_identifier("session_id", &session_id)?;
            if let Some(record) = runtime.get_session(&session_id).await? {
                ensure_active_session(&record)?;
                return Ok(runtime.session(session_id));
            }
            return runtime
                .ensure_session(NewSession {
                    id: session_id,
                    agent_id: context.agent_id,
                    context_id: context.id,
                    parent_session_id: None,
                    title: "环境指定终端 Session".to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await;
        }
    }

    let session_id = generated_id("session");
    runtime
        .create_session(NewSession {
            id: session_id.clone(),
            agent_id: context.agent_id,
            context_id: context.id,
            parent_session_id: None,
            title: "本地终端".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;
    Ok(runtime.session(session_id))
}

fn ensure_active_session(session: &SessionRecord) -> Result<(), AppError> {
    if session.status == SessionStatus::Archived {
        Err(format!("Session '{}' 已归档，不能恢复", session.id).into())
    } else {
        Ok(())
    }
}

async fn resolve_resumed_session(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(SessionHandle, String), AppError> {
    let mut prompt_args = invocation.prompt_args().to_vec();
    let use_last = switch_enabled(invocation, "last")?;
    if use_last && option_value(invocation, "session").is_some() {
        return Err("resume 不能同时使用 --last 和 --session".into());
    }
    let session_id =
        if use_last || (option_value(invocation, "session").is_none() && prompt_args.is_empty()) {
            runtime
                .list_sessions(false)
                .await?
                .into_iter()
                .find(|session| {
                    option_value(invocation, "context")
                        .is_none_or(|context| session.context_id == context)
                        && option_value(invocation, "agent")
                            .is_none_or(|agent| session.agent_id == agent)
                })
                .map(|session| session.id)
                .ok_or("没有可恢复的活跃 Session")?
        } else if let Some(session_id) = option_value(invocation, "session") {
            session_id.to_string()
        } else if !prompt_args.is_empty() {
            prompt_args.remove(0)
        } else {
            unreachable!("无位置参数时已按最近 Session 处理")
        };
    let record = runtime
        .get_session(&session_id)
        .await?
        .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;
    ensure_active_session(&record)?;
    Ok((runtime.session(session_id), prompt_args.join(" ")))
}

fn json_output(invocation: &Invocation) -> bool {
    option_value(invocation, "format") == Some("json")
}

async fn list_contexts(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let records = runtime
        .list_contexts(switch_enabled(invocation, "include-archived")?)
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&records)?);
    } else {
        for record in records {
            println!(
                "{}  [{}]  agent={}  {}",
                record.id,
                record.status.as_str(),
                record.agent_id,
                record.title
            );
        }
    }
    Ok(())
}

async fn show_context(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
    status: bool,
) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .map(String::as_str)
        .or_else(|| option_value(invocation, "context"))
        .unwrap_or(default_context_id);
    let record = runtime
        .get_context(id)
        .await?
        .ok_or_else(|| format!("Context '{id}' 不存在"))?;
    if status {
        let version = runtime.mind_version(id).await?;
        let sessions = runtime.list_context_sessions(id, false).await?;
        let retired = sessions
            .iter()
            .filter(|session| {
                session.attention_state == morphz::memory::SessionAttentionState::Retired
            })
            .count();
        let activations = runtime.active_thread_activations(id).await?;
        let active_session = sessions.iter().max_by(|left, right| {
            left.last_activity_at
                .cmp(&right.last_activity_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        if let Some(active_session) = active_session {
            let view = runtime.context_encoding(id, &active_session.id).await?;
            println!(
                "{}  [{}]  mind_version={}  sessions={} retired={} full={} metadata={} activations={} pressure={}/{}tok  agent={}  {}",
                record.id,
                record.status.as_str(),
                version,
                sessions.len(),
                retired,
                view.session_working_set.full_session_ids.len(),
                view.session_working_set.metadata_only_session_ids.len(),
                activations.len(),
                view.pressure.level,
                view.pressure.estimated_tokens,
                record.agent_id,
                record.title
            );
        } else {
            println!(
                "{}  [{}]  mind_version={}  sessions=0 retired=0 activations={}  agent={}  {}",
                record.id,
                record.status.as_str(),
                version,
                activations.len(),
                record.agent_id,
                record.title
            );
        }
    } else {
        println!("{}", serde_json::to_string_pretty(&record)?);
    }
    Ok(())
}

async fn audit_context(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .map(String::as_str)
        .or_else(|| option_value(invocation, "context"))
        .unwrap_or(default_context_id);
    let audit = runtime.audit_mind_projection(id).await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&audit)?);
    } else {
        println!(
            "{}  matches={}  ledger=r{}:{}  projection={}:{}  events_scanned={}",
            audit.context_id,
            audit.matches,
            audit.ledger_revision,
            audit.ledger_hash,
            audit
                .projection_revision
                .map(|revision| format!("r{revision}"))
                .unwrap_or_else(|| "missing".to_string()),
            audit.projection_hash.as_deref().unwrap_or("missing"),
            audit.events_scanned
        );
    }
    if !audit.matches {
        return Err(format!("Context '{id}' 的 Mind Projection 与 Ledger 不一致").into());
    }
    Ok(())
}

async fn show_scheduler(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let context_id = option_value(invocation, "context").unwrap_or(default_context_id);
    let limit = option_value(invocation, "limit")
        .map(str::parse::<usize>)
        .transpose()
        .map_err(|_| "--limit 必须是正整数")?
        .unwrap_or(200);
    if limit == 0 || limit > 2_000 {
        return Err("--limit 必须在 1..=2000 之间".into());
    }
    let snapshot = runtime
        .scheduler_snapshot(
            context_id,
            SchedulerQuery {
                include_terminal: switch_enabled(invocation, "include-terminal")?,
                limit,
            },
        )
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&snapshot)?);
        return Ok(());
    }

    println!(
        "Scheduler context={} threads={} signals={} activations={}/{} jobs={} approvals={} schedules={}",
        snapshot.context_id,
        snapshot.summary.open_threads,
        snapshot.summary.pending_signals,
        snapshot.summary.running_activations,
        snapshot.summary.queued_activations,
        snapshot.summary.active_jobs,
        snapshot.summary.pending_approvals,
        snapshot.summary.active_schedules,
    );
    for item in snapshot.threads {
        println!(
            "{}  kind={} lifecycle={} phase={} activations={} jobs={} signals={} schedules={}",
            item.thread.id,
            item.thread.kind.as_str(),
            item.thread.lifecycle.as_str(),
            item.phase.as_str(),
            item.activations.len(),
            item.activations
                .iter()
                .map(|value| value.jobs.len())
                .sum::<usize>(),
            item.pending_signals.len(),
            item.schedules.len(),
        );
    }
    Ok(())
}

async fn list_sessions(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let mut records = runtime
        .list_sessions(switch_enabled(invocation, "include-archived")?)
        .await?;
    if let Some(context) = option_value(invocation, "context") {
        records.retain(|record| record.context_id == context);
    }
    if let Some(agent) = option_value(invocation, "agent") {
        records.retain(|record| record.agent_id == agent);
    }
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&records)?);
    } else {
        for record in records {
            println!(
                "{}  [{}; attention={}]  context={}  last={}  {}",
                record.id,
                record.status.as_str(),
                record.attention_state.as_str(),
                record.context_id,
                record.last_activity_at.to_rfc3339(),
                record.title
            );
        }
    }
    Ok(())
}

async fn show_session(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .map(String::as_str)
        .or_else(|| option_value(invocation, "session"))
        .ok_or("用法: morphz session show <ID>")?;
    let record = runtime
        .get_session(id)
        .await?
        .ok_or_else(|| format!("Session '{id}' 不存在"))?;
    println!("{}", serde_json::to_string_pretty(&record)?);
    Ok(())
}

async fn create_session_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    _default_agent_id: &str,
    default_context_id: &str,
) -> Result<(), AppError> {
    let session_id = option_value(invocation, "id")
        .map(str::to_string)
        .unwrap_or_else(|| generated_id("session"));
    validate_identifier("session_id", &session_id)?;
    let source = selected_context(runtime, invocation, default_context_id).await?;
    let (context_id, mount_kind) = if switch_enabled(invocation, "independent")? {
        let context_id = generated_id("context");
        runtime
            .create_context(NewCognitiveContext {
                id: context_id.clone(),
                agent_id: source.agent_id.clone(),
                title: format!("{} 的独立认知副本", source.title),
            })
            .await?;
        if let Err(error) = runtime
            .seed_context_from_mind(&source.id, None, &context_id)
            .await
        {
            return Err(format!(
                "独立 Context '{}' 已创建，但从 '{}' 复制 Mind 失败: {error}",
                context_id, source.id
            )
            .into());
        }
        (context_id, SessionMountKind::NewContextFromMind)
    } else {
        (source.id, SessionMountKind::ExistingContext)
    };
    let record = runtime
        .create_session(NewSession {
            id: session_id,
            agent_id: source.agent_id,
            context_id,
            parent_session_id: None,
            title: option_value(invocation, "title")
                .unwrap_or("新 Session")
                .chars()
                .take(200)
                .collect(),
            mount_kind,
        })
        .await?;
    println!("{}", serde_json::to_string_pretty(&record)?);
    Ok(())
}

async fn list_agents(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let records = runtime
        .list_agents(switch_enabled(invocation, "include-archived")?)
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&records)?);
    } else {
        for record in records {
            println!(
                "{}  [{}]  root_context={}  {}",
                record.id,
                record.status.as_str(),
                record.root_context_id,
                record.title
            );
        }
    }
    Ok(())
}

async fn show_agent(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_agent_id: &str,
) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .map(String::as_str)
        .or_else(|| option_value(invocation, "agent"))
        .unwrap_or(default_agent_id);
    let record = runtime
        .get_agent(id)
        .await?
        .ok_or_else(|| format!("Agent '{id}' 不存在"))?;
    println!("{}", serde_json::to_string_pretty(&record)?);
    Ok(())
}

async fn create_agent_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let agent_id = option_value(invocation, "id")
        .map(str::to_string)
        .unwrap_or_else(|| generated_id("agent"));
    validate_identifier("agent_id", &agent_id)?;
    let context_id = generated_id("context");
    let session_id = generated_id("session");
    let title = option_value(invocation, "title").unwrap_or("新 Agent");
    let bundle = runtime
        .create_agent_bundle(
            NewAgent {
                id: agent_id.clone(),
                title: title.chars().take(200).collect(),
                root_context_id: context_id.clone(),
            },
            NewCognitiveContext {
                id: context_id.clone(),
                agent_id: agent_id.clone(),
                title: format!("{title} 的根 Context"),
            },
            NewSession {
                id: session_id,
                agent_id,
                context_id,
                parent_session_id: None,
                title: "初始 Session".to_string(),
                mount_kind: SessionMountKind::NewBlankContext,
            },
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&bundle)?);
    Ok(())
}

async fn list_objectives(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let context_id = option_value(invocation, "context").unwrap_or(default_context_id);
    let records = runtime
        .list_context_objectives(context_id, switch_enabled(invocation, "include-terminal")?)
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&records)?);
    } else {
        for record in records {
            let wait = record
                .wait_condition
                .as_ref()
                .map(|wait| serde_json::to_string(wait).unwrap_or_else(|_| "invalid".to_string()))
                .unwrap_or_else(|| "none".to_string());
            println!(
                "{}  [{}]  rev={}  session={}  wait={}  {}",
                record.id,
                record.status.as_str(),
                record.revision,
                record.coordinator_session_id,
                wait,
                record
                    .stated_objective
                    .replace('\n', " ")
                    .chars()
                    .take(120)
                    .collect::<String>()
            );
        }
    }
    Ok(())
}

async fn show_objective(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz objective show <ID>")?;
    let record = runtime
        .get_objective(id)
        .await?
        .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
    println!("{}", serde_json::to_string_pretty(&record)?);
    Ok(())
}

async fn objective_session(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    context_id: &str,
) -> Result<SessionRecord, AppError> {
    if let Some(session_id) = option_value(invocation, "session") {
        let session = runtime
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;
        ensure_active_session(&session)?;
        if session.context_id != context_id {
            return Err(format!(
                "Session '{}' 挂载在 Context '{}'，不是 Objective Context '{}'",
                session.id, session.context_id, context_id
            )
            .into());
        }
        return Ok(session);
    }
    if let Some(session) = runtime
        .list_context_sessions(context_id, false)
        .await?
        .into_iter()
        .next()
    {
        return Ok(session);
    }
    let context = runtime
        .get_context(context_id)
        .await?
        .ok_or_else(|| format!("Context '{context_id}' 不存在"))?;
    runtime
        .create_session(NewSession {
            id: generated_id("session"),
            agent_id: context.agent_id,
            context_id: context.id,
            parent_session_id: None,
            title: "Objective Coordinator".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await
}

async fn create_objective_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let stated_objective = invocation.prompt();
    if stated_objective.trim().is_empty() {
        return Err("用法: morphz objective create [--session=ID] GOAL...".into());
    }
    let context_id = option_value(invocation, "context").unwrap_or(default_context_id);
    let context = runtime
        .get_context(context_id)
        .await?
        .ok_or_else(|| format!("Context '{context_id}' 不存在"))?;
    let session = objective_session(runtime, invocation, context_id).await?;
    if session.agent_id != context.agent_id {
        return Err("Objective coordinator Session 与 Context 的 Agent 不一致".into());
    }
    let objective_id = option_value(invocation, "id")
        .map(str::to_string)
        .unwrap_or_else(|| generated_id("objective"));
    validate_identifier("objective_id", &objective_id)?;
    let token_budget = option_value(invocation, "token-budget")
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| "--token-budget 必须是正整数")
                .and_then(|value| {
                    (value > 0)
                        .then_some(value)
                        .ok_or("--token-budget 必须大于 0")
                })
        })
        .transpose()?;
    let mut events = runtime.subscribe("*", 256);
    let source_event_id = generated_id("objective_request");
    runtime
        .publish(Event::new(
            source_event_id.clone(),
            "User-CLI".to_string(),
            "objective_request".to_string(),
            "objective/requested".to_string(),
            vec![
                ("context_id".to_string(), serde_json::json!(context.id)),
                ("session_id".to_string(), serde_json::json!(session.id)),
                (
                    "requested_objective_id".to_string(),
                    serde_json::json!(objective_id),
                ),
                ("text".to_string(), serde_json::json!(stated_objective)),
            ]
            .into_iter()
            .collect(),
        ))
        .await?;
    let objective = runtime
        .create_objective(NewObjective {
            id: objective_id,
            agent_id: context.agent_id,
            context_id: context.id,
            coordinator_session_id: session.id.clone(),
            delivery_session_id: session.id.clone(),
            parent_objective_id: None,
            source_event_id,
            stated_objective,
            token_budget,
        })
        .await?;
    eprintln!(
        "[Objective 已启动] {}  session={}  revision={}",
        objective.id, objective.coordinator_session_id, objective.revision
    );
    monitor_objective(runtime, &objective.id, &session.id, &mut events).await
}

async fn edit_objective_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz objective edit <ID> NEW_GOAL...")?;
    let stated_objective = invocation.prompt_args()[1..].join(" ");
    if stated_objective.trim().is_empty() {
        return Err("objective edit 缺少 NEW_GOAL".into());
    }
    let current = runtime
        .get_objective(id)
        .await?
        .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
    print_objective_mutation(
        runtime
            .edit_objective(id, current.revision, &stated_objective)
            .await?,
    )
}

fn lifecycle_reason(invocation: &Invocation, fallback: &str) -> String {
    option_value(invocation, "reason")
        .map(str::to_string)
        .or_else(|| {
            (invocation.prompt_args().len() > 1).then(|| invocation.prompt_args()[1..].join(" "))
        })
        .filter(|reason| !reason.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

async fn pause_objective_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz objective pause <ID> [--reason=TEXT]")?;
    let current = runtime
        .get_objective(id)
        .await?
        .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
    print_objective_mutation(
        runtime
            .pause_objective(
                id,
                current.revision,
                &lifecycle_reason(invocation, "用户通过 CLI 暂停"),
            )
            .await?,
    )
}

async fn resume_objective_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz objective resume <ID> [--reason=TEXT]")?;
    let current = runtime
        .get_objective(id)
        .await?
        .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
    let mut events = runtime.subscribe("*", 256);
    let mutation = runtime
        .resume_objective(
            id,
            current.revision,
            &lifecycle_reason(invocation, "用户通过 CLI 恢复"),
        )
        .await?;
    let updated = mutation_updated(mutation)?;
    eprintln!(
        "[Objective 已恢复] {}  revision={}",
        updated.id, updated.revision
    );
    monitor_objective(
        runtime,
        &updated.id,
        &updated.delivery_session_id,
        &mut events,
    )
    .await
}

async fn cancel_objective_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz objective cancel <ID> [--reason=TEXT]")?;
    let current = runtime
        .get_objective(id)
        .await?
        .ok_or_else(|| format!("Objective '{id}' 不存在"))?;
    print_objective_mutation(
        runtime
            .cancel_objective(
                id,
                current.revision,
                &lifecycle_reason(invocation, "用户通过 CLI 取消"),
            )
            .await?,
    )
}

fn mutation_updated(
    mutation: ObjectiveMutation,
) -> Result<morphz::memory::ObjectiveRecord, AppError> {
    match mutation {
        ObjectiveMutation::Updated(updated) => Ok(updated),
        ObjectiveMutation::Conflict { current } => Err(format!(
            "Objective revision 冲突；当前 revision={} status={}",
            current.revision,
            current.status.as_str()
        )
        .into()),
        ObjectiveMutation::NotFound => Err("Objective 不存在".into()),
    }
}

fn print_objective_mutation(mutation: ObjectiveMutation) -> Result<(), AppError> {
    let updated = mutation_updated(mutation)?;
    println!("{}", serde_json::to_string_pretty(&updated)?);
    Ok(())
}

async fn monitor_objective(
    runtime: &MorphzRuntime,
    objective_id: &str,
    delivery_session_id: &str,
    events: &mut RuntimeEventStream,
) -> Result<(), AppError> {
    while let Some(event) = events.recv().await {
        let Some((event_session, text, kind)) = console_message_from_event(&event) else {
            continue;
        };
        if event_session != delivery_session_id {
            continue;
        }
        match kind {
            ConsoleMessageKind::Final => {
                if !text.trim().is_empty() {
                    println!("{text}");
                }
            }
            ConsoleMessageKind::NoReply => {}
            ConsoleMessageKind::Message => {
                if !text.trim().is_empty() {
                    println!("{text}");
                }
            }
            ConsoleMessageKind::Progress => {
                if !text.trim().is_empty() {
                    eprintln!("[Agent 进度] {text}");
                }
            }
            ConsoleMessageKind::ToolCall => eprintln!("{text}"),
            ConsoleMessageKind::Approval => {
                let mut stdin = std::io::stdin().lock();
                let mut stderr = std::io::stderr();
                prompt_for_human_approval(&text, runtime, &mut stdin, &mut stderr)
                    .await
                    .map_err(|error| format!("审批失败: {error}"))?;
            }
        }
        if matches!(
            kind,
            ConsoleMessageKind::Final | ConsoleMessageKind::NoReply
        ) {
            let objective = runtime
                .get_objective(objective_id)
                .await?
                .ok_or_else(|| format!("Objective '{objective_id}' 在运行中丢失"))?;
            if objective.status.is_terminal()
                || matches!(
                    objective.status,
                    ObjectiveStatus::Paused | ObjectiveStatus::Blocked
                )
            {
                eprintln!(
                    "[Objective 结束监控] {}  status={}  revision={}",
                    objective.id,
                    objective.status.as_str(),
                    objective.revision
                );
                return Ok(());
            }
        }
    }
    Err("Objective 事件通道已关闭".into())
}

async fn list_jobs(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let jobs = runtime.list_delegations().await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&jobs)?);
    } else {
        for job in jobs {
            println!(
                "{}  [{}]  {} -> {}  {}",
                job.id,
                job.status.as_str(),
                job.parent_session_id,
                job.child_session_id,
                job.task
                    .replace('\n', " ")
                    .chars()
                    .take(100)
                    .collect::<String>()
            );
        }
    }
    Ok(())
}

async fn cancel_job(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz job cancel <ID>")?;
    let cancelled = runtime.cancel_delegation_tree(id).await?;
    println!("已取消 {} 个任务（包含递归子任务）。", cancelled.len());
    Ok(())
}

fn doctor(runtime: &MorphzRuntime, app_config: &config::AppConfig) -> Result<(), AppError> {
    let workspace = std::fs::canonicalize(&app_config.permissions.workspace_root)?;
    println!("[ok] database: {}", runtime.database_path());
    println!("[ok] workspace: {}", workspace.display());
    println!(
        "[ok] sandbox: {:?}, approval: {:?}",
        app_config.permissions.preset().0,
        app_config.permissions.preset().1
    );
    if let Some(provider) = app_config.llm.provider.as_deref() {
        match build_configured_client(app_config, Some(provider), None) {
            Ok((_, selected)) => println!(
                "[ok] provider: {}/{} ({})",
                selected.id,
                selected.model,
                selected.protocol.as_str()
            ),
            Err(error) => println!("[error] provider: {provider}: {error}"),
        }
    } else {
        println!("[missing] provider: run `morphz setup`");
    }
    println!("[ok] tools: {}", runtime.tool_names().join(", "));
    Ok(())
}

async fn run_once(
    runtime: MorphzRuntime,
    session: SessionHandle,
    prompt: String,
) -> Result<(), AppError> {
    let session_id = session.id().to_string();
    let mut events = runtime.subscribe("*", 256);
    session
        .send(prompt, "User", Some(generated_id("cli")))
        .await?;
    while let Some(event) = events.recv().await {
        let Some((event_session, text, kind)) = console_message_from_event(&event) else {
            continue;
        };
        if event_session != session_id {
            continue;
        }
        match kind {
            ConsoleMessageKind::Final => {
                println!("{text}");
                return Ok(());
            }
            ConsoleMessageKind::NoReply => return Ok(()),
            ConsoleMessageKind::Message => print_agent_message(&text),
            ConsoleMessageKind::Progress => {
                if !text.trim().is_empty() {
                    eprintln!("[Agent 进度] {text}");
                }
            }
            ConsoleMessageKind::ToolCall => eprintln!("{text}"),
            ConsoleMessageKind::Approval => {
                let mut stdin = std::io::stdin().lock();
                let mut stderr = std::io::stderr();
                prompt_for_human_approval(&text, &runtime, &mut stdin, &mut stderr)
                    .await
                    .map_err(|error| format!("审批失败: {error}"))?;
            }
        }
    }
    Err("Agent 回复通道已关闭".into())
}

async fn run_interactive(
    runtime: MorphzRuntime,
    session: SessionHandle,
    initial_prompt: Option<String>,
    reply_wait_notice_secs: u64,
) -> Result<(), AppError> {
    tracing::info!(session_id = session.id(), "Morphz 交互终端已启动");
    tracing::info!(tools = %runtime.tool_names().join(", "), "已注册工具");
    tracing::info!("多行输入：/multi 开始，/send 发送，/cancel 取消；exit 退出");

    let session_id = session.id().to_string();
    let session_id_clone = session_id.clone();

    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel::<ConsoleMessage>();
    let waiting_for_reply = Arc::new(std::sync::Mutex::new(false));
    let event_waiting_for_reply = Arc::clone(&waiting_for_reply);
    let event_session_id = session_id.clone();
    let mut console_events = runtime.subscribe("*", 256);
    tokio::spawn(async move {
        while let Some(event) = console_events.recv().await {
            if let Some(message) = console_message_from_event(&event) {
                if message.0 != event_session_id {
                    continue;
                }
                let waiting = event_waiting_for_reply
                    .lock()
                    .map(|waiting| *waiting)
                    .unwrap_or(true);
                if waiting {
                    if reply_tx.send(message).is_err() {
                        break;
                    }
                } else {
                    print_idle_console_message(&message);
                }
            }
        }
    });

    // 在阻塞线程中同步监听 stdin
    let console_runtime = runtime.clone();
    let console_session = session;
    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        let mut msg_counter = 0;
        let mut initial_prompt = initial_prompt;
        let stdin = std::io::stdin();
        let mut stdin = stdin.lock();
        // Do not keep a StdoutLock alive while waiting for the Agent. Tracing and
        // tool execution may also write to the process output; retaining the lock
        // across `rt.block_on` can deadlock the attempt that is supposed to
        // produce the reply we are waiting for. `Stdout` locks only per write.
        let mut stdout = std::io::stdout();
        loop {
            let from_argv = initial_prompt.is_some();
            let console_input = if let Some(prompt) = initial_prompt.take() {
                ConsoleInput::SingleLine(prompt)
            } else {
                let _ = write!(stdout, "> ");
                let _ = stdout.flush();
                match read_console_input(&mut stdin, &mut stdout) {
                    Ok(input) => input,
                    Err(e) => {
                        let _ = writeln!(stdout, "\n[stdin 错误] {}，退出 Morphz。", e);
                        std::process::exit(1);
                    }
                }
            };

            let (text, commands_allowed) = match console_input {
                ConsoleInput::Eof => {
                    let _ = writeln!(stdout, "\n[EOF] 退出 Morphz。");
                    std::process::exit(0);
                }
                ConsoleInput::Empty | ConsoleInput::Cancelled => continue,
                ConsoleInput::SingleLine(text) => (text, !from_argv),
                ConsoleInput::Multiline(text) => (text, false),
            };

            if commands_allowed && (text == "exit" || text == "quit") {
                let _ = writeln!(stdout, "退出 Morphz。");
                std::process::exit(0);
            }

            let parts: Vec<&str> = text.split_whitespace().collect();
            if commands_allowed && !parts.is_empty() && parts[0] == "ctx" {
                let sess_id = if parts.len() > 1 {
                    parts[1].to_string()
                } else {
                    session_id_clone.clone()
                };

                let runtime = console_runtime.clone();
                let sess_id_label = sess_id.clone();
                let context_result =
                    rt.block_on(async move { runtime.inspect_session_context(&sess_id).await });
                match context_result {
                    Ok(ctx_state) => {
                        let _ = writeln!(
                            stdout,
                            "--- 动态求值 Context SExpr 状态 (Session: {}) ---",
                            sess_id_label
                        );
                        let _ = writeln!(stdout, "{}", ctx_state);
                        let _ =
                            writeln!(stdout, "--------------------------------------------------");
                    }
                    Err(e) => {
                        let _ = writeln!(stdout, "无法获取 Context: {:?}", e);
                    }
                }
                continue;
            }
            if commands_allowed && parts.first() == Some(&"jobs") {
                match rt.block_on(console_runtime.list_delegations()) {
                    Ok(delegations) if delegations.is_empty() => {
                        let _ = writeln!(stdout, "当前没有 Sub Agent 任务。");
                    }
                    Ok(delegations) => {
                        let _ = writeln!(stdout, "--- Sub Agent 任务 ---");
                        for delegation in delegations {
                            let task = delegation.task.replace('\n', " ");
                            let task_preview = task.chars().take(100).collect::<String>();
                            let _ = writeln!(
                                stdout,
                                "{}  [{}]  {} -> {}  {}",
                                delegation.id,
                                delegation.status.as_str(),
                                delegation.parent_session_id,
                                delegation.child_session_id,
                                task_preview
                            );
                        }
                    }
                    Err(error) => {
                        let _ = writeln!(stdout, "无法读取 Sub Agent 任务: {error}");
                    }
                }
                continue;
            }
            if commands_allowed && parts.first() == Some(&"cancel-job") {
                let Some(delegation_id) = parts.get(1) else {
                    let _ = writeln!(stdout, "用法: cancel-job <delegation_id>");
                    continue;
                };
                match rt.block_on(console_runtime.cancel_delegation_tree(delegation_id)) {
                    Ok(cancelled) => {
                        let _ = writeln!(
                            stdout,
                            "已取消 {} 个 Sub Agent 任务（包括递归子任务）。",
                            cancelled.len()
                        );
                    }
                    Err(error) => {
                        let _ = writeln!(stdout, "取消 Sub Agent 失败: {error}");
                    }
                }
                continue;
            }

            msg_counter += 1;

            let Ok(mut waiting) = waiting_for_reply.lock() else {
                let _ = writeln!(stdout, "Console 状态锁已损坏，退出 Morphz。");
                std::process::exit(1);
            };
            while let Ok(message) = reply_rx.try_recv() {
                print_console_notification(&message);
            }
            *waiting = true;
            drop(waiting);

            let client_message_id = format!(
                "cli_{}_{}",
                Utc::now().timestamp_nanos_opt().unwrap_or(0),
                msg_counter
            );
            if let Err(error) =
                rt.block_on(console_session.send(text, "User-Shafreeck", Some(client_message_id)))
            {
                if let Ok(mut waiting) = waiting_for_reply.lock() {
                    *waiting = false;
                }
                let _ = writeln!(stdout, "发送消息失败: {error}");
                continue;
            }

            // 等待回复完成再继续下一次循环。进度提示只是提示，不是任务超时；
            // 用户可随时用 Ctrl+C 主动中断整个进程。
            let sess_id_to_wait = session_id_clone.clone();
            let notice_interval = (reply_wait_notice_secs > 0)
                .then(|| std::time::Duration::from_secs(reply_wait_notice_secs));
            loop {
                match rt.block_on(wait_for_session_activity(
                    &mut reply_rx,
                    &sess_id_to_wait,
                    notice_interval,
                )) {
                    Some(ConsoleWaitOutcome::Final(reply)) => {
                        let _ = writeln!(stdout, "\n{}\n", reply);
                        break;
                    }
                    Some(ConsoleWaitOutcome::NoReply) => break,
                    Some(ConsoleWaitOutcome::Approval(payload)) => {
                        if let Err(error) = rt.block_on(prompt_for_human_approval(
                            &payload,
                            &console_runtime,
                            &mut stdin,
                            &mut stdout,
                        )) {
                            let _ = writeln!(stdout, "[审批失败] {error}");
                        }
                    }
                    None => {
                        let _ = writeln!(stdout, "Agent 回复通道已关闭。");
                        break;
                    }
                }
            }

            if let Ok(mut waiting) = waiting_for_reply.lock() {
                *waiting = false;
                while let Ok(message) = reply_rx.try_recv() {
                    match message.2 {
                        ConsoleMessageKind::Approval => {
                            if let Err(error) = rt.block_on(prompt_for_human_approval(
                                &message.1,
                                &console_runtime,
                                &mut stdin,
                                &mut stdout,
                            )) {
                                let _ = writeln!(stdout, "[审批失败] {error}");
                            }
                        }
                        _ => print_console_notification(&message),
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    });

    tokio::select! {
        _ = shutdown_signal() => {
            tracing::info!("收到关闭信号，强制退出 Morphz");
            // 重要：因为 stdin 阻塞读取线程是 uninterruptible 系统调用，
            // tokio runtime drop 会卡住等待该线程，必须用 process::exit 直接终结进程。
            std::process::exit(0);
        }
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum ConsoleInput {
    Eof,
    Empty,
    Cancelled,
    SingleLine(String),
    Multiline(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConsoleMessageKind {
    Final,
    NoReply,
    Message,
    Progress,
    ToolCall,
    Approval,
}

type ConsoleMessage = (String, String, ConsoleMessageKind);

#[derive(Debug, PartialEq, Eq)]
enum ConsoleWaitOutcome {
    Final(String),
    NoReply,
    Approval(String),
}

fn console_message_from_event(event: &morphz::event::Event) -> Option<ConsoleMessage> {
    let session_id = event
        .payload
        .get("session_id")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    match event.topic.as_str() {
        "chat/reply" => Some((
            session_id,
            event
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            ConsoleMessageKind::Final,
        )),
        "chat/no_reply" => Some((session_id, String::new(), ConsoleMessageKind::NoReply)),
        "chat/outbound_message" => Some((
            session_id,
            event
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            ConsoleMessageKind::Message,
        )),
        "chat/progress" => Some((
            session_id,
            event
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            ConsoleMessageKind::Progress,
        )),
        "runtime/tool_calls_selected" => format_tool_call_activity(&event.payload)
            .map(|text| (session_id, text, ConsoleMessageKind::ToolCall)),
        "runtime/approval_requested" => {
            let approval_id = event
                .payload
                .get("approval_id")
                .and_then(serde_json::Value::as_str)?;
            let text = event
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("权限请求需要用户决定");
            Some((
                session_id,
                serde_json::json!({
                    "approval_id": approval_id,
                    "text": text,
                })
                .to_string(),
                ConsoleMessageKind::Approval,
            ))
        }
        _ => None,
    }
}

async fn wait_for_session_activity(
    reply_rx: &mut tokio::sync::mpsc::UnboundedReceiver<ConsoleMessage>,
    session_id: &str,
    notice_interval: Option<std::time::Duration>,
) -> Option<ConsoleWaitOutcome> {
    if notice_interval.is_none() {
        while let Some((sess, text, kind)) = reply_rx.recv().await {
            if sess != session_id {
                continue;
            }
            match kind {
                ConsoleMessageKind::Final => return Some(ConsoleWaitOutcome::Final(text)),
                ConsoleMessageKind::NoReply => return Some(ConsoleWaitOutcome::NoReply),
                ConsoleMessageKind::Approval => return Some(ConsoleWaitOutcome::Approval(text)),
                ConsoleMessageKind::Message => print_agent_message(&text),
                ConsoleMessageKind::Progress => print_agent_progress(&text),
                ConsoleMessageKind::ToolCall => print_tool_call_activity(&text),
            }
        }
        return None;
    }

    let notice_interval = notice_interval.expect("checked above");
    let mut notice = tokio::time::interval(notice_interval);
    notice.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    notice.tick().await;
    loop {
        tokio::select! {
            item = reply_rx.recv() => {
                let (sess, text, kind) = item?;
                if sess != session_id {
                    continue;
                }
                match kind {
                    ConsoleMessageKind::Final => return Some(ConsoleWaitOutcome::Final(text)),
                    ConsoleMessageKind::NoReply => return Some(ConsoleWaitOutcome::NoReply),
                    ConsoleMessageKind::Approval => return Some(ConsoleWaitOutcome::Approval(text)),
                    ConsoleMessageKind::Message => print_agent_message(&text),
                    ConsoleMessageKind::Progress => print_agent_progress(&text),
                    ConsoleMessageKind::ToolCall => print_tool_call_activity(&text),
                }
            }
            _ = notice.tick() => {
                let mut stdout = std::io::stdout();
                let _ = writeln!(
                    stdout,
                    "\n[仍在等待 Agent 或后台任务] 本次已等待约 {} 秒；可按 Ctrl+C 中断。",
                    notice_interval.as_secs()
                );
                let _ = stdout.flush();
            }
        }
    }
}

#[cfg(test)]
async fn wait_for_session_reply(
    reply_rx: &mut tokio::sync::mpsc::UnboundedReceiver<ConsoleMessage>,
    session_id: &str,
    notice_interval: Option<std::time::Duration>,
) -> Option<String> {
    loop {
        match wait_for_session_activity(reply_rx, session_id, notice_interval).await? {
            ConsoleWaitOutcome::Final(text) => return Some(text),
            ConsoleWaitOutcome::NoReply => return Some(String::new()),
            ConsoleWaitOutcome::Approval(_) => continue,
        }
    }
}

async fn prompt_for_human_approval<R: BufRead, W: Write>(
    payload: &str,
    runtime: &MorphzRuntime,
    reader: &mut R,
    output: &mut W,
) -> Result<(), String> {
    let payload: serde_json::Value =
        serde_json::from_str(payload).map_err(|error| format!("无法解析审批请求: {error}"))?;
    let approval_id = payload
        .get("approval_id")
        .and_then(serde_json::Value::as_str)
        .ok_or("审批请求缺少 approval_id")?;
    let text = payload
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("权限请求需要用户决定");
    writeln!(output, "\n[需要审批]\n{text}")
        .map_err(|error| format!("无法显示审批请求: {error}"))?;
    loop {
        write!(output, "允许本次操作？[y/n] ")
            .map_err(|error| format!("无法显示审批提示: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("无法刷新审批提示: {error}"))?;
        let mut line = String::new();
        if reader
            .read_line(&mut line)
            .map_err(|error| format!("无法读取审批决定: {error}"))?
            == 0
        {
            return Err("审批输入通道已关闭".to_string());
        }
        let decision = match parse_terminal_approval_input(&line) {
            Ok(Some(decision)) => decision,
            Ok(None) => {
                writeln!(output, "审批仍在等待；请明确输入 y/yes 或 n/no。")
                    .map_err(|error| format!("无法显示审批提示: {error}"))?;
                continue;
            }
            Err(()) => {
                writeln!(output, "请输入 y/yes 或 n/no。")
                    .map_err(|error| format!("无法显示审批提示: {error}"))?;
                continue;
            }
        };
        return runtime.decide_approval(approval_id, decision).await;
    }
}

fn parse_terminal_approval_input(input: &str) -> Result<Option<ApprovalDecision>, ()> {
    match input.trim().to_ascii_lowercase().as_str() {
        "" => Ok(None),
        "y" | "yes" | "allow" | "approve" => Ok(Some(ApprovalDecision::AllowOnce {
            rationale: "用户通过本地终端允许本次操作".to_string(),
            risk_tags: vec!["human-approved".to_string()],
        })),
        "n" | "no" | "deny" | "reject" => Ok(Some(ApprovalDecision::Deny {
            rationale: "用户通过本地终端拒绝本次操作".to_string(),
            risk_tags: vec!["human-denied".to_string()],
        })),
        _ => Err(()),
    }
}

fn print_agent_progress(text: &str) {
    if !text.trim().is_empty() {
        let mut stdout = std::io::stdout();
        let _ = writeln!(stdout, "\n[Agent 进度] {}", text);
        let _ = stdout.flush();
    }
}

fn print_agent_message(text: &str) {
    if !text.trim().is_empty() {
        let mut stdout = std::io::stdout();
        let _ = writeln!(stdout, "\n{}", text);
        let _ = stdout.flush();
    }
}

fn print_console_notification(message: &ConsoleMessage) {
    match message.2 {
        ConsoleMessageKind::Final | ConsoleMessageKind::Message => print_agent_message(&message.1),
        ConsoleMessageKind::NoReply => {}
        ConsoleMessageKind::Progress => print_agent_progress(&message.1),
        ConsoleMessageKind::ToolCall => print_tool_call_activity(&message.1),
        ConsoleMessageKind::Approval => {
            let mut stdout = std::io::stdout();
            let _ = writeln!(stdout, "\n[需要审批] {}", message.1);
            let _ = stdout.flush();
        }
    }
}

fn print_idle_console_message(message: &ConsoleMessage) {
    print_console_notification(message);
    if !matches!(message.2, ConsoleMessageKind::NoReply) {
        let mut stdout = std::io::stdout();
        let _ = write!(stdout, "> ");
        let _ = stdout.flush();
    }
}

fn print_tool_call_activity(text: &str) {
    if !text.trim().is_empty() {
        let mut stdout = std::io::stdout();
        let _ = writeln!(stdout, "\n{}", text);
        let _ = stdout.flush();
    }
}

fn format_tool_call_activity(
    payload: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    let calls = payload
        .get("calls")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let deduplicated = payload
        .get("deduplicated_count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let rejected = payload
        .get("rejected_count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if calls.is_empty() && deduplicated == 0 && rejected == 0 {
        return None;
    }

    let mut sections = Vec::new();
    for (index, call) in calls.iter().enumerate() {
        let name = call
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<unknown>");
        let id = call
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>");
        let arguments = call
            .get("arguments")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("{}");
        sections.push(format!(
            "[工具调用 {}/{}] {}  (call_id={})\n参数:\n{}",
            index + 1,
            calls.len(),
            name,
            id,
            arguments
        ));
    }

    if deduplicated > 0 {
        sections.push(format!(
            "[Runtime] 已去重 {} 个重复的 context_tx 调用。",
            deduplicated
        ));
    }
    if rejected > 0 {
        let status = payload
            .get("rejection_status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("rejected");
        sections.push(format!(
            "[Runtime] 已拒绝 {} 个未执行的 context_tx 调用（{}）。",
            rejected, status
        ));
    }
    Some(sections.join("\n\n"))
}

fn read_console_input<R: BufRead, W: Write>(
    reader: &mut R,
    output: &mut W,
) -> std::io::Result<ConsoleInput> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(ConsoleInput::Eof);
    }

    let line = trim_line_ending(&line);
    if line.trim() != "/multi" {
        let text = line.trim();
        return Ok(if text.is_empty() {
            ConsoleInput::Empty
        } else {
            ConsoleInput::SingleLine(text.to_string())
        });
    }

    writeln!(
        output,
        "[多行模式] 单独输入 /send 发送，或输入 /cancel 取消。"
    )?;
    let mut lines = Vec::new();
    loop {
        write!(output, "... ")?;
        output.flush()?;

        let mut next = String::new();
        if reader.read_line(&mut next)? == 0 {
            return Ok(ConsoleInput::Eof);
        }
        let next = trim_line_ending(&next);
        match next.trim() {
            "/send" => {
                let text = lines.join("\n");
                return Ok(if text.trim().is_empty() {
                    ConsoleInput::Empty
                } else {
                    ConsoleInput::Multiline(text)
                });
            }
            "/cancel" => {
                writeln!(output, "[多行模式] 已取消。")?;
                return Ok(ConsoleInput::Cancelled);
            }
            _ => lines.push(next.to_string()),
        }
    }
}

fn trim_line_ending(line: &str) -> &str {
    line.strip_suffix("\r\n")
        .or_else(|| line.strip_suffix('\n'))
        .unwrap_or(line)
}

/// 等待 Ctrl+C 或 SIGTERM 信号
fn generate_dashboard_token() -> Result<String, AppError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("操作系统随机数生成失败: {error}"))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        token.push(HEX[usize::from(byte >> 4)] as char);
        token.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Ok(token)
}

fn dashboard_browser_url(bind: &str, token: &str) -> Result<String, AppError> {
    let address: std::net::SocketAddr = bind.parse()?;
    let host = match address.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => "127.0.0.1".to_string(),
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => "[::1]".to_string(),
        std::net::IpAddr::V6(ip) => format!("[{ip}]"),
    };
    Ok(format!("http://{host}:{}/#token={token}", address.port()))
}

fn open_dashboard_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]).arg(url);
        command
    };

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "当前平台没有默认浏览器启动适配器",
    ));

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    {
        command.spawn().map(|_| ())
    }
}

async fn shutdown_signal() {
    use tokio::signal;

    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_cli_config, command_needs_llm, console_message_from_event, create_session_command,
        dashboard_browser_url, ensure_cli_identity_records, format_tool_call_activity,
        generate_dashboard_token, help_for, parse_terminal_approval_input, read_console_input,
        resolve_resumed_session, select_or_create_console_session,
        should_run_first_time_setup_with_terminal, should_use_tui_with_terminal,
        wait_for_session_reply, ConsoleInput, ConsoleMessageKind, OfflineClient,
    };
    use morphz::approval::ApprovalDecision;
    use morphz::cli::morphz_command_line_parser;
    use morphz::config::{AppConfig, TuiTheme};
    use morphz::event::Event;
    use morphz::llm::{Client, ReasoningEffort};
    use morphz::memory::{NewAgent, NewCognitiveContext, NewSession, SessionMountKind};
    use morphz::permission::{ApprovalPolicy, PermissionMode, ReviewerKind, SandboxMode};
    use morphz::runtime::{MorphzRuntime, RuntimeIdentity};
    use std::io::Cursor;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn tui_is_default_only_for_interactive_conversations_and_can_be_overridden() {
        let parser = morphz_command_line_parser();
        assert!(should_use_tui_with_terminal(&parser.parse(["hello"]).unwrap(), true).unwrap());
        assert!(!should_use_tui_with_terminal(&parser.parse(["hello"]).unwrap(), false).unwrap());
        assert!(
            should_use_tui_with_terminal(&parser.parse(["--tui", "hello"]).unwrap(), false)
                .unwrap()
        );
        assert!(
            !should_use_tui_with_terminal(&parser.parse(["--plain", "hello"]).unwrap(), true)
                .unwrap()
        );
        assert!(
            !should_use_tui_with_terminal(&parser.parse(["exec", "hello"]).unwrap(), true).unwrap()
        );
        assert!(
            should_use_tui_with_terminal(&parser.parse(["--tui", "--plain"]).unwrap(), true)
                .is_err()
        );
    }

    #[test]
    fn first_interactive_conversation_enters_setup_only_without_any_model_selection() {
        let parser = morphz_command_line_parser();
        let bare = parser.parse(std::iter::empty::<&str>()).unwrap();
        let resume = parser.parse(["resume"]).unwrap();
        let exec = parser.parse(["exec", "hello"]).unwrap();
        let mut config = AppConfig::default();

        assert!(should_run_first_time_setup_with_terminal(
            &bare, &config, true
        ));
        assert!(should_run_first_time_setup_with_terminal(
            &resume, &config, true
        ));
        assert!(!should_run_first_time_setup_with_terminal(
            &bare, &config, false
        ));
        assert!(!should_run_first_time_setup_with_terminal(
            &exec, &config, true
        ));

        config.llm.provider = Some("configured".to_string());
        assert!(!should_run_first_time_setup_with_terminal(
            &bare, &config, true
        ));

        let provider_override = parser.parse(["--provider=custom"]).unwrap();
        config.llm.provider = None;
        assert!(!should_run_first_time_setup_with_terminal(
            &provider_override,
            &config,
            true,
        ));
    }

    #[test]
    fn single_line_input_preserves_prompt_text() {
        let mut input = Cursor::new("  hello Morphz  \n");
        let mut output = Vec::new();

        assert_eq!(
            read_console_input(&mut input, &mut output).unwrap(),
            ConsoleInput::SingleLine("hello Morphz".to_string())
        );
    }

    #[test]
    fn multiline_input_is_returned_as_one_message_with_newlines_preserved() {
        let mut input = Cursor::new(
            "/multi\nBuild a news collector.\n\nRequirements:\n- RSS\n- JSON Feed\n/send\n",
        );
        let mut output = Vec::new();

        assert_eq!(
            read_console_input(&mut input, &mut output).unwrap(),
            ConsoleInput::Multiline(
                "Build a news collector.\n\nRequirements:\n- RSS\n- JSON Feed".to_string()
            )
        );
        assert!(String::from_utf8(output).unwrap().contains("/send"));
    }

    #[test]
    fn multiline_commands_are_preserved_as_message_content() {
        let mut input = Cursor::new("/multi\nctx\nexit\n/send\n");
        let mut output = Vec::new();

        assert_eq!(
            read_console_input(&mut input, &mut output).unwrap(),
            ConsoleInput::Multiline("ctx\nexit".to_string())
        );
    }

    #[test]
    fn multiline_input_can_be_cancelled_or_aborted_by_eof() {
        let mut cancelled = Cursor::new("/multi\nignored\n/cancel\n");
        let mut output = Vec::new();
        assert_eq!(
            read_console_input(&mut cancelled, &mut output).unwrap(),
            ConsoleInput::Cancelled
        );

        let mut eof = Cursor::new("/multi\nincomplete");
        assert_eq!(
            read_console_input(&mut eof, &mut Vec::new()).unwrap(),
            ConsoleInput::Eof
        );
    }

    #[tokio::test]
    async fn wait_notice_never_becomes_a_reply_timeout() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(35)).await;
            tx.send((
                "session-a".to_string(),
                "late reply".to_string(),
                ConsoleMessageKind::Final,
            ))
            .unwrap();
        });

        let reply = tokio::time::timeout(
            Duration::from_millis(250),
            wait_for_session_reply(&mut rx, "session-a", Some(Duration::from_millis(10))),
        )
        .await
        .expect("waiter should remain alive after multiple notice ticks");

        assert_eq!(reply.as_deref(), Some("late reply"));
    }

    #[tokio::test]
    async fn no_reply_ends_cli_wait_even_when_background_tasks_remain() {
        let event = |active_background_tasks| {
            Event::new(
                format!("no-reply-{active_background_tasks}"),
                "Agent-Morphz".to_string(),
                "agent_call".to_string(),
                "chat/no_reply".to_string(),
                serde_json::Map::from_iter([
                    ("session_id".to_string(), serde_json::json!("session-a")),
                    (
                        "active_background_tasks".to_string(),
                        serde_json::json!(active_background_tasks),
                    ),
                ]),
            )
        };

        let terminal = console_message_from_event(&event(0)).unwrap();
        assert_eq!(terminal.2, ConsoleMessageKind::NoReply);
        assert_eq!(
            console_message_from_event(&event(1)).unwrap().2,
            ConsoleMessageKind::NoReply
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(terminal).unwrap();
        let reply = wait_for_session_reply(&mut rx, "session-a", None).await;
        assert_eq!(reply.as_deref(), Some(""));
    }

    #[test]
    fn tool_call_activity_renders_names_arguments_and_runtime_decisions() {
        let payload = serde_json::json!({
            "calls": [
                {
                    "id": "read-1",
                    "name": "read",
                    "arguments": "{\n  \"path\": \"src/lib.rs\"\n}",
                    "arguments_chars": 21,
                    "truncated": false
                }
            ],
            "deduplicated_count": 2,
            "rejected_count": 1,
            "rejection_status": "multiple-distinct"
        });
        let rendered = format_tool_call_activity(payload.as_object().unwrap()).unwrap();

        assert!(rendered.contains("[工具调用 1/1] read"));
        assert!(rendered.contains("src/lib.rs"));
        assert!(rendered.contains("已去重 2 个"));
        assert!(rendered.contains("已拒绝 1 个"));
        assert!(rendered.contains("multiple-distinct"));
    }

    #[test]
    fn cli_permission_overrides_remain_orthogonal() {
        let invocation = morphz_command_line_parser()
            .parse([
                "--sandbox=full-access",
                "--approval=human",
                "--network=false",
            ])
            .unwrap();
        let mut config = AppConfig::default();

        apply_cli_config(&invocation, &mut config).unwrap();

        assert_eq!(config.permissions.mode, PermissionMode::Custom);
        assert_eq!(
            config.permissions.sandbox_mode,
            SandboxMode::DangerFullAccess
        );
        assert_eq!(
            config.permissions.approval_policy,
            ApprovalPolicy::OnRequest
        );
        assert_eq!(config.permissions.reviewer, ReviewerKind::User);
        assert!(!config.permissions.network);
    }

    #[test]
    fn cli_theme_override_uses_the_same_strict_theme_names() {
        let invocation = morphz_command_line_parser()
            .parse(["--theme=cyan"])
            .unwrap();
        let mut config = AppConfig::default();
        apply_cli_config(&invocation, &mut config).unwrap();
        assert_eq!(config.tui.theme, TuiTheme::Cyan);

        let invalid = morphz_command_line_parser()
            .parse(["--theme=ultraviolet"])
            .unwrap();
        assert!(apply_cli_config(&invalid, &mut config).is_err());
    }

    #[test]
    fn cli_reasoning_effort_is_explicit_and_can_return_to_provider_default() {
        let high = morphz_command_line_parser()
            .parse(["--reasoning-effort=high"])
            .unwrap();
        let mut config = AppConfig::default();
        apply_cli_config(&high, &mut config).unwrap();
        assert_eq!(config.llm.reasoning_effort, Some(ReasoningEffort::High));

        let off = morphz_command_line_parser()
            .parse(["--reasoning-effort=none"])
            .unwrap();
        apply_cli_config(&off, &mut config).unwrap();
        assert_eq!(config.llm.reasoning_effort, Some(ReasoningEffort::Off));

        let max = morphz_command_line_parser()
            .parse(["--reasoning-effort=max"])
            .unwrap();
        apply_cli_config(&max, &mut config).unwrap();
        assert_eq!(config.llm.reasoning_effort, Some(ReasoningEffort::Max));

        let provider_default = morphz_command_line_parser()
            .parse(["--reasoning-effort=default"])
            .unwrap();
        apply_cli_config(&provider_default, &mut config).unwrap();
        assert_eq!(config.llm.reasoning_effort, None);

        let invalid = morphz_command_line_parser()
            .parse(["--reasoning-effort=ultra"])
            .unwrap();
        assert!(apply_cli_config(&invalid, &mut config).is_err());
    }

    #[test]
    fn terminal_approval_requires_an_explicit_answer() {
        assert!(matches!(parse_terminal_approval_input("\n"), Ok(None)));
        assert!(matches!(
            parse_terminal_approval_input("yes"),
            Ok(Some(ApprovalDecision::AllowOnce { .. }))
        ));
        assert!(matches!(
            parse_terminal_approval_input("no"),
            Ok(Some(ApprovalDecision::Deny { .. }))
        ));
        assert!(parse_terminal_approval_input("maybe").is_err());
    }

    #[test]
    fn serve_help_describes_binding_dashboard_and_non_loopback_authentication() {
        let invocation = morphz_command_line_parser()
            .parse(["serve", "--help"])
            .unwrap();
        let help = help_for(&invocation);
        assert!(help.contains("morphz serve [OPTIONS]"));
        assert!(help.contains("--bind=ADDR"));
        assert!(help.contains("MORPHZ_DASHBOARD_TOKEN"));
        assert!(help.contains("0.0.0.0:8080"));
        assert!(!help.contains("CORE COMMANDS:"));
    }

    #[test]
    fn dashboard_command_uses_ephemeral_random_token_and_loopback_browser_url() {
        let first = generate_dashboard_token().unwrap();
        let second = generate_dashboard_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
        assert_eq!(
            dashboard_browser_url("0.0.0.0:8080", &first).unwrap(),
            format!("http://127.0.0.1:8080/#token={first}")
        );
        assert_eq!(
            dashboard_browser_url("[::]:9090", &first).unwrap(),
            format!("http://[::1]:9090/#token={first}")
        );

        let invocation = morphz_command_line_parser()
            .parse(["dashboard", "--help"])
            .unwrap();
        let help = help_for(&invocation);
        assert!(help.contains("cryptographically random Token"));
        assert!(help.contains("morphz dashboard --bind=0.0.0.0:8080"));
    }

    #[test]
    fn only_evaluation_commands_require_an_llm_client() {
        let parser = morphz_command_line_parser();
        assert!(command_needs_llm(&parser.parse(["hello"]).unwrap()));
        assert!(command_needs_llm(
            &parser.parse(["session", "resume", "s1"]).unwrap()
        ));
        assert!(command_needs_llm(&parser.parse(["resume"]).unwrap()));
        assert!(command_needs_llm(&parser.parse(["dashboard"]).unwrap()));
        assert!(!command_needs_llm(
            &parser.parse(["session", "list"]).unwrap()
        ));
        assert!(!command_needs_llm(
            &parser.parse(["agent", "create", "--id=a1"]).unwrap()
        ));
    }

    #[tokio::test]
    async fn cli_preserves_an_existing_agents_root_without_switching_context() {
        let workspace = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
        let database_path = workspace.path().join("morphz.db");
        let persisted_context_id = "session_1782276906";

        let seed_runtime =
            MorphzRuntime::builder(config.clone(), Arc::new(OfflineClient) as Arc<dyn Client>)
                .database_path(database_path.to_string_lossy())
                .identity(RuntimeIdentity {
                    agent_id: "default-agent".to_string(),
                    context_id: persisted_context_id.to_string(),
                })
                .build()
                .await
                .unwrap();
        seed_runtime
            .ensure_agent(NewAgent {
                id: "default-agent".to_string(),
                title: "默认 Agent".to_string(),
                root_context_id: persisted_context_id.to_string(),
            })
            .await
            .unwrap();
        seed_runtime
            .ensure_context(NewCognitiveContext {
                id: persisted_context_id.to_string(),
                agent_id: "default-agent".to_string(),
                title: "既有 Root Context".to_string(),
            })
            .await
            .unwrap();
        seed_runtime
            .ensure_session(NewSession {
                id: "session-visible".to_string(),
                agent_id: "default-agent".to_string(),
                context_id: persisted_context_id.to_string(),
                parent_session_id: None,
                title: "Visible Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        drop(seed_runtime);

        let runtime = MorphzRuntime::builder(config, Arc::new(OfflineClient) as Arc<dyn Client>)
            .database_path(database_path.to_string_lossy())
            .identity(RuntimeIdentity {
                agent_id: "default-agent".to_string(),
                context_id: "context-default".to_string(),
            })
            .build()
            .await
            .unwrap();

        assert_eq!(runtime.identity().context_id, "context-default");
        ensure_cli_identity_records(
            &runtime,
            &runtime.identity().agent_id,
            &runtime.identity().context_id,
        )
        .await
        .unwrap();
        assert_eq!(
            runtime
                .get_agent("default-agent")
                .await
                .unwrap()
                .unwrap()
                .root_context_id,
            persisted_context_id
        );
        assert!(runtime
            .get_context("context-default")
            .await
            .unwrap()
            .is_some());
        let sessions = runtime.list_sessions(false).await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "session-visible");
    }

    #[tokio::test]
    async fn new_sessions_share_context_while_independent_sessions_copy_the_mind() {
        let workspace = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.permissions.workspace_root = workspace.path().to_string_lossy().into_owned();
        let database_path = workspace.path().join("morphz.db");
        let runtime = MorphzRuntime::builder(config, Arc::new(OfflineClient) as Arc<dyn Client>)
            .database_path(database_path.to_string_lossy())
            .identity(RuntimeIdentity::default())
            .build()
            .await
            .unwrap();
        runtime.start().await.unwrap();
        let parser = morphz_command_line_parser();

        let first = select_or_create_console_session(
            &runtime,
            &parser.parse(std::iter::empty::<&str>()).unwrap(),
            "default-agent",
            "context-default",
        )
        .await
        .unwrap();
        let first_record = first.record().await.unwrap().unwrap();
        assert_eq!(first_record.context_id, "context-default");

        let (latest, prompt) =
            resolve_resumed_session(&runtime, &parser.parse(["resume"]).unwrap())
                .await
                .unwrap();
        assert_eq!(latest.id(), first.id());
        assert!(prompt.is_empty());

        let (explicit_resume, prompt) = resolve_resumed_session(
            &runtime,
            &parser
                .parse(["resume", first.id(), "继续当前任务"])
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(explicit_resume.id(), first.id());
        assert_eq!(prompt, "继续当前任务");

        let explicit = parser.parse([format!("--session={}", first.id())]).unwrap();
        let resumed = select_or_create_console_session(
            &runtime,
            &explicit,
            "default-agent",
            "context-default",
        )
        .await
        .unwrap();
        assert_eq!(resumed.id(), first.id());
        let conflicting = parser
            .parse([
                format!("--session={}", first.id()),
                "--context=another-context".to_string(),
            ])
            .unwrap();
        let error = select_or_create_console_session(
            &runtime,
            &conflicting,
            "default-agent",
            "context-default",
        )
        .await
        .err()
        .expect("conflicting mount selectors must be rejected");
        assert!(error.to_string().contains("与 --context 不一致"));

        let independent = parser
            .parse([
                "session",
                "create",
                "--independent",
                "--id=independent-test",
            ])
            .unwrap();
        create_session_command(&runtime, &independent, "default-agent", "context-default")
            .await
            .unwrap();
        let independent_record = runtime
            .get_session("independent-test")
            .await
            .unwrap()
            .unwrap();
        assert_ne!(independent_record.context_id, "context-default");
        let copied_context = runtime
            .get_context(&independent_record.context_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            copied_context.seed_context_id.as_deref(),
            Some("context-default")
        );
        assert_eq!(
            copied_context.seed_projection.as_deref(),
            Some("mind_snapshot")
        );
    }
}
