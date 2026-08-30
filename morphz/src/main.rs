use chrono::{Local, SecondsFormat, Utc};
use morphz::approval::ApprovalDecision;
use morphz::cli::{morphz_command, morphz_command_line_parser_for, Invocation};
use morphz::config;
use morphz::harness_package::HarnessPackage;
use morphz::i18n::{locale_from_cli_args, Locale, UiLanguage};
use morphz::llm::{Client, Message, ReasoningEffort, Response, ToolDefinition};
use morphz::memory::{
    ExecutionTargetAuthorizationScope, ExecutionTargetKind, ExecutionTargetRegistration,
    ExecutionTargetStatus, NewAgent, NewCognitiveContext, NewSession, ObjectiveMutation,
    ObjectiveStatus, QueryFilter, SessionMountKind, SessionRecord, SessionStatus,
    ThreadControlAction, ThreadMutation,
};
use morphz::orchestrator::context::{
    FrameRecallDirection, FrameRecallRequest, RecallSearchRequest,
};
use morphz::permission::{ApprovalPolicy, PermissionMode, ReviewerKind, SandboxMode};
use morphz::provider::auth::{OAuthFlowKind, OAuthLoginCompletion, OAuthLoginProgress};
use morphz::provider::build_configured_client;
use morphz::provider::control::ProviderAccountControlAction;
use morphz::provider::routing::EffectiveProviderCatalog;
use morphz::provider::{list_provider_models, probe_provider};
use morphz::runtime::{
    MorphzRuntime, RuntimeEventStream, RuntimeIdentity, SchedulerQuery, SessionHandle,
};
use morphz::sdk::{
    AuthorizeExecutionTargetCommand, CreateNodePairingCodeCommand, CreateObjectiveCommand,
    ExactHarnessRef, ExecutionJobQuery, MorphzSdk, ObjectiveRequestOrigin, SdkErrorCode,
    SendMessageCommand, TrajectoryExportRequest,
};
use morphz::trajectory::{AgentTrajectoryBundle, TrajectoryRights};
use morphz::web::{Server, ServerDefaults};
use std::io::IsTerminal;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing_subscriber::{fmt, EnvFilter};

type AppError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone, Copy)]
struct LocalRfc3339Time;

impl tracing_subscriber::fmt::time::FormatTime for LocalRfc3339Time {
    fn format_time(
        &self,
        writer: &mut tracing_subscriber::fmt::format::Writer<'_>,
    ) -> std::fmt::Result {
        write!(
            writer,
            "{}",
            Local::now().to_rfc3339_opts(SecondsFormat::Millis, false)
        )
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
            .with_timer(LocalRfc3339Time)
            .with_writer(std::io::sink)
            .try_init()?;
    } else {
        fmt()
            .with_env_filter(filter)
            .with_target(true)
            .with_timer(LocalRfc3339Time)
            .try_init()?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), AppError> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    // Language is needed before Clap can render help or parse errors. Load the
    // host-owned environment and the non-secret configuration layers without
    // mutating the working directory so every UI starts from one preference.
    if let Some(path) = config::host_env_path() {
        let _ = config::load_env(&path.to_string_lossy());
    }
    let locale = locale_from_cli_args(&args)
        .or_else(|| bootstrap_config_language(&args).map(UiLanguage::resolve))
        .unwrap_or_else(Locale::detect);
    let invocation = morphz_command_line_parser_for(locale)
        .parse(args)
        .unwrap_or_else(|error| error.exit());

    if invocation.command_path() == ["version"] {
        println!("morphz {}", morphz::build_info::VERSION);
        return Ok(());
    }
    if invocation.command_path() == ["completion"] {
        generate_completion(&invocation)?;
        return Ok(());
    }

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

    if let Some(path) = host_env_path {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(event_code = "app.user_env.load_failed", %error, path = %path.display(), "Failed to load the user-level Morphz environment file");
            }
        } else {
            tracing::debug!(event_code = "app.user_env.loaded", path = %path.display(), "Loaded the user-level Morphz environment file");
        }
    }

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

    let mut setup_oauth_account = None;

    // Setup is a host-side control-plane action. It must be available before
    // database/runtime initialization and, most importantly, before a model
    // credential exists.
    if invocation.command_path() == ["setup"] && tui_mode {
        let result =
            morphz::setup::run_interactive_setup_for(resolved.config.ui.language.resolve()).await?;
        setup_oauth_account = result.oauth_account;
        if setup_oauth_account.is_none() {
            return Ok(());
        }
        // OAuth login is deliberately not implemented inside Setup. Re-load
        // the atomically persisted Provider graph, then enter the exact same
        // Runtime/AuthAdapter path used by CLI, HTTP and Dashboard.
        resolved = resolve_invocation_config(
            &invocation,
            &cwd,
            explicit_config_path.as_deref(),
            selected_profile,
        )?;
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
        let result =
            morphz::setup::run_interactive_setup_for(resolved.config.ui.language.resolve()).await?;
        setup_oauth_account = result.oauth_account;
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
    if dispatch_experiment_command(&invocation, &resolved.config)? {
        return Ok(());
    }
    morphz::experimental::require_all_enabled_compiled(&resolved.config.experimental.enabled)?;
    let protected_config_paths = resolved
        .loaded_paths()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    let mut app_config = resolved.config;
    let explicit_sqlite_path = std::env::var("MORPHZ_STORAGE_SQLITE_PATH")
        .ok()
        .filter(|path| !path.trim().is_empty());
    if let Some(path) = explicit_sqlite_path.as_ref() {
        app_config.storage.sqlite.path.clone_from(path);
    }
    validate_coding_eval_storage_isolation(
        std::env::var("MORPHZ_CODING_EVAL_MODE")
            .ok()
            .is_some_and(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            }),
        app_config.storage.backend,
        explicit_sqlite_path.as_deref(),
    )?;
    protect_runtime_files(&mut app_config, &protected_config_paths);

    let default_agent_id =
        std::env::var("MORPHZ_AGENT_ID").unwrap_or_else(|_| "default-agent".to_string());
    let default_context_id =
        std::env::var("MORPHZ_CONTEXT_ID").unwrap_or_else(|_| "context-default".to_string());
    let identity = RuntimeIdentity {
        agent_id: default_agent_id.clone(),
        context_id: default_context_id.clone(),
        principal_id: std::env::var("MORPHZ_PRINCIPAL_ID")
            .unwrap_or_else(|_| "principal-default".to_string()),
    };
    let needs_workers = command_needs_llm(&invocation);
    let client = build_client(&invocation, &app_config, needs_workers)?;
    let trusted_gateway_serve = invocation.command_path() == ["serve"]
        && app_config.server.identity.mode == config::ServerIdentityMode::TrustedGateway;
    let runtime = MorphzRuntime::builder(app_config.clone(), client)
        .identity(identity)
        .principal_first_seen_cues(trusted_gateway_serve)
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
    if !trusted_gateway_serve {
        let sdk = MorphzSdk::new(runtime.clone());
        sdk.adopt_sessions_for_default_principal(sdk.default_principal(), true)
            .await?;
    }

    if let Some(account_id) = setup_oauth_account.as_deref() {
        start_provider_account_login_for(&runtime, account_id, false).await?;
        return Ok(());
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

fn validate_coding_eval_storage_isolation(
    coding_eval: bool,
    backend: config::StorageBackend,
    explicit_sqlite_path: Option<&str>,
) -> Result<(), AppError> {
    if coding_eval
        && backend == config::StorageBackend::Sqlite
        && explicit_sqlite_path.is_none_or(|path| path.trim().is_empty())
    {
        return Err(
            "Coding evaluation with SQLite requires an explicit MORPHZ_STORAGE_SQLITE_PATH. Refusing to reuse the working directory's default morphz.db; allocate one database path per benchmark run."
                .into(),
        );
    }
    Ok(())
}

fn bootstrap_config_language(args: &[std::ffi::OsString]) -> Option<UiLanguage> {
    let initial_cwd = std::env::current_dir().ok()?;
    let cwd = bootstrap_option_value(args, "cwd", Some('C'))
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                initial_cwd.join(path)
            }
        })
        .unwrap_or(initial_cwd);
    let explicit_path = bootstrap_option_value(args, "config-file", None)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("MORPHZ_CONFIG_PATH").map(PathBuf::from));
    let profile = bootstrap_option_value(args, "profile", Some('p'))
        .or_else(|| config::active_profile().ok().flatten());
    config::resolve_config(&cwd, explicit_path.as_deref(), profile.as_deref())
        .ok()
        .map(|resolved| resolved.config.ui.language)
}

fn bootstrap_option_value(
    args: &[std::ffi::OsString],
    long: &str,
    short: Option<char>,
) -> Option<String> {
    let long_flag = format!("--{long}");
    for (index, argument) in args.iter().enumerate() {
        let argument = argument.to_str()?;
        if let Some(value) = argument.strip_prefix(&format!("{long_flag}=")) {
            return Some(value.to_string());
        }
        if argument == long_flag {
            return args
                .get(index + 1)
                .and_then(|value| value.to_str())
                .map(str::to_string);
        }
        if let Some(short) = short {
            let short_flag = format!("-{short}");
            if argument == short_flag {
                return args
                    .get(index + 1)
                    .and_then(|value| value.to_str())
                    .map(str::to_string);
            }
            if let Some(value) = argument
                .strip_prefix(&short_flag)
                .filter(|value| !value.is_empty())
            {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn generate_completion(invocation: &Invocation) -> Result<(), AppError> {
    let shell = invocation
        .prompt_args()
        .first()
        .ok_or("completion 缺少 SHELL")?
        .parse::<clap_complete::Shell>()
        .map_err(|error| format!("无法识别 completion Shell: {error}"))?;
    let mut command = morphz_command();
    clap_complete::generate(shell, &mut command, "morphz", &mut std::io::stdout());
    Ok(())
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
    if command == "setup" {
        if force_plain {
            return Err(
                "morphz setup 默认使用 Dashboard；终端向导请使用 --tui，不能使用 --plain".into(),
            );
        }
        return Ok(force_tui);
    }
    let conversational = matches!(command.as_str(), "" | "resume" | "session resume");
    Ok(conversational && !force_plain && (force_tui || interactive_terminal))
}

fn selected_config_path(invocation: &Invocation) -> Option<PathBuf> {
    option_value(invocation, "config-file")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("MORPHZ_CONFIG_PATH").map(PathBuf::from))
}

fn resolve_invocation_config(
    invocation: &Invocation,
    cwd: &Path,
    explicit_config_path: Option<&Path>,
    selected_profile: Option<&str>,
) -> Result<config::ResolvedConfig, AppError> {
    let mut resolved = config::resolve_config(cwd, explicit_config_path, selected_profile)?;
    for warning in &resolved.warnings {
        tracing::warn!(
            event_code = "app.startup.warning",
            warning,
            "Morphz startup warning"
        );
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
        && option_value(invocation, "model").is_none()
        && app_config.llm.provider.is_none()
        && app_config.llm.model.trim().is_empty()
        && app_config.llm.models.is_empty()
        && app_config.model_routes.is_empty()
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
        morphz::experimental::require_all_enabled_compiled(&resolved.config.experimental.enabled)?;
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
        ("MORPHZ_STORAGE_BACKEND", "storage.backend"),
        (
            "MORPHZ_POSTGRES_MAX_CONNECTIONS",
            "storage.postgres.max_connections",
        ),
        ("MORPHZ_SERVER_IDENTITY_MODE", "server.identity.mode"),
        (
            "MORPHZ_SERVER_IDENTITY_PROVIDER_ID",
            "server.identity.provider_id",
        ),
        (
            "MORPHZ_SERVER_IDENTITY_SERVICE_TOKEN_ENV",
            "server.identity.service_token_env",
        ),
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
            "MORPHZ_CONTEXT_TRANSACTIONS_ENABLED",
            "orchestrator.context_transactions_enabled",
        ),
        (
            "MORPHZ_LLM_CONNECT_TIMEOUT_SECS",
            "llm.connect_timeout_secs",
        ),
        (
            "MORPHZ_LLM_STREAM_IDLE_TIMEOUT_SECS",
            "llm.stream_idle_timeout_secs",
        ),
        (
            "MORPHZ_LLM_FIRST_BYTE_TIMEOUT_SECS",
            "llm.first_byte_timeout_secs",
        ),
        ("MORPHZ_LLM_MAX_OUTPUT_TOKENS", "llm.max_output_tokens"),
        ("MORPHZ_LLM_REASONING_EFFORT", "llm.reasoning_effort"),
        ("MORPHZ_LANGUAGE", "ui.language"),
        ("MORPHZ_EXPERIMENTAL_FEATURES", "experimental.enabled"),
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
        ("language", "ui.language"),
        ("network", "permissions.network"),
        ("add-dir", "permissions.read_roots/write_roots"),
        ("enable-experimental", "experimental.enabled"),
        (
            "coordination-mesh",
            "experimental.cognitive_coordination.mesh",
        ),
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
    if let Some(language) = option_value(invocation, "language") {
        app_config.ui.language = UiLanguage::parse(language)
            .ok_or_else(|| format!("未知界面语言 '{language}'；可用 auto、en、zh-CN"))?;
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
    if let Some(features) = invocation.option("enable-experimental") {
        app_config.experimental.enabled.extend(
            features
                .occurrences()
                .iter()
                .flatten()
                .map(|name| name.trim())
                .filter(|name| !name.is_empty())
                .map(str::to_string),
        );
    }
    if let Some(mesh) = option_value(invocation, "coordination-mesh") {
        let mesh = mesh.trim();
        if mesh.is_empty() {
            return Err("--coordination-mesh must not be empty".into());
        }
        app_config
            .experimental
            .enabled
            .insert(morphz::experimental::COGNITIVE_COORDINATION.to_string());
        app_config.experimental.cognitive_coordination.mesh = Some(mesh.to_string());
        let participant = app_config
            .experimental
            .cognitive_coordination
            .participant
            .get_or_insert_with(config::CognitiveCoordinationParticipantConfig::default);
        if let Some(agent_id) = option_value(invocation, "agent") {
            participant.agent_id = agent_id.to_string();
        }
        if let Some(context_id) = option_value(invocation, "context") {
            participant.context_id = context_id.to_string();
        }
        // --session selects the local interactive Session only. A Mesh node
        // never publishes that Session as its durable participant identity.
        participant.session_id.clear();
    }
    morphz::experimental::validate_enabled(&app_config.experimental.enabled)?;
    if let Some(format) = option_value(invocation, "format") {
        if !matches!(format, "human" | "json") {
            return Err("--format 只支持 human 或 json".into());
        }
    }
    Ok(())
}

fn dispatch_experiment_command(
    invocation: &Invocation,
    app_config: &config::AppConfig,
) -> Result<bool, AppError> {
    let command = invocation.command_path().join(" ");
    if !matches!(
        command.as_str(),
        "experiment" | "experiment list" | "experiment check"
    ) {
        return Ok(false);
    }

    let statuses = morphz::experimental::statuses(&app_config.experimental.enabled)?;
    if command == "experiment check" {
        let name = invocation
            .prompt_args()
            .first()
            .ok_or("morphz experiment check requires FEATURE")?;
        let permit = morphz::experimental::require_enabled(&app_config.experimental.enabled, name)?;
        let feature = permit.feature();
        if json_output(invocation) {
            let status = statuses
                .into_iter()
                .find(|status| status.name == feature.name)
                .expect("known feature has a status");
            println!("{}", serde_json::to_string_pretty(&status)?);
        } else {
            println!("{}: available (experimental)", feature.name);
        }
        return Ok(true);
    }

    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&statuses)?);
    } else {
        for status in statuses {
            println!(
                "{}\tcompiled={}\tenabled={}\tavailable={}\t{}",
                status.name, status.compiled, status.enabled, status.available, status.summary
            );
        }
    }
    Ok(true)
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
            | "setup"
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
    let configured = build_configured_client(
        app_config,
        option_value(invocation, "provider"),
        option_value(invocation, "model"),
    );
    let (client, selected) = match configured {
        Ok(configured) => configured,
        Err(error) if invocation.command_path() == ["setup"] => {
            tracing::warn!(
                error = %error,
            event_code = "app.setup.inference_unavailable",
            "Current model configuration cannot run inference; Setup is starting as a configurable control plane"
            );
            return Ok(Arc::new(morphz::provider::routing::RoutedClient::empty(
                app_config.llm.clone(),
            )));
        }
        Err(error)
            if (invocation.command_path() == ["serve"]
                || invocation.command_path() == ["dashboard"])
                && app_config.provider_instances.is_empty()
                && app_config.model_routes.is_empty()
                && app_config.providers.is_empty()
                && app_config.llm.provider.is_none() =>
        {
            tracing::warn!(
                error = %error,
            event_code = "app.runtime.model_service_unconfigured",
            "No model service is configured; Runtime is starting as a configurable control plane"
            );
            return Ok(Arc::new(morphz::provider::routing::RoutedClient::empty(
                app_config.llm.clone(),
            )));
        }
        Err(error) => return Err(error),
    };
    tracing::info!(
        provider = %selected.id,
        protocol = selected.protocol.as_str(),
        model = %selected.model,
        base_url = %selected.base_url,
            event_code = "app.provider.selected",
            "Using the configured Provider"
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
            let harness = option_value(&invocation, "harness")
                .map(parse_exact_harness_ref)
                .transpose()?;
            if tui_mode {
                morphz::tui::run(runtime, session, prompt, harness).await
            } else {
                run_interactive(
                    runtime,
                    session,
                    prompt,
                    harness,
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
            let harness = option_value(&invocation, "harness")
                .map(parse_exact_harness_ref)
                .transpose()?;
            run_once(runtime, session, prompt, harness).await
        }
        "serve" => {
            let server = Arc::new(
                Server::new_with_capacity(
                    runtime,
                    ServerDefaults {
                        agent_id: default_agent_id,
                        context_id: default_context_id,
                    },
                    app_config.server.broadcast_capacity,
                )
                .with_identity(app_config.server.identity.clone()),
            );
            server.start(&app_config.server.bind).await?;
            tracing::info!(event_code = "app.server.started", bind = %app_config.server.bind, "Morphz Server started");
            exit_after_shutdown_signal(shutdown_signal().await)
        }
        "dashboard" | "setup" => {
            let setup_mode = command == "setup";
            let open_browser = !switch_enabled(&invocation, "no-open")?;
            let token = generate_dashboard_token()?;
            let browser_url = if setup_mode {
                dashboard_setup_browser_url(&app_config.server.bind, &token)?
            } else {
                dashboard_browser_url(&app_config.server.bind, &token)?
            };
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
            println!(
                "{}: {browser_url}",
                if setup_mode { "Setup" } else { "Dashboard" }
            );
            if open_browser {
                if let Err(error) = open_dashboard_browser(&browser_url) {
                    tracing::warn!(event_code = "app.browser.open_failed", %error, "Failed to open the default browser automatically; open the displayed address manually");
                }
            }
            if setup_mode {
                tracing::info!(event_code = "app.dashboard_setup.started", bind = %app_config.server.bind, "Morphz Dashboard Setup started");
            } else {
                tracing::info!(event_code = "app.dashboard.started", bind = %app_config.server.bind, "Morphz Dashboard started");
            }
            exit_after_shutdown_signal(shutdown_signal().await)
        }
        "edge pair" => pair_edge_node(&runtime, &invocation).await,
        "edge run" => run_edge_node(runtime, &app_config, &invocation).await,
        "edge rotate-key" => rotate_edge_node_key(&runtime, &invocation).await,
        "edge pairing-code" => create_edge_pairing_code(&runtime, &invocation).await,
        "edge nodes" => list_edge_nodes(&runtime, &invocation).await,
        "edge revoke" => revoke_edge_node(&runtime, &invocation).await,
        "edge local-leases" => list_edge_local_leases(&invocation),
        "edge revoke-local-lease" => revoke_edge_local_lease(&invocation),
        "edge" | "edge status" => show_edge_node_status(&invocation),
        "target" | "target list" => list_execution_targets(&runtime, &invocation).await,
        "target show" => show_execution_target(&runtime, &invocation).await,
        "target enable" => {
            mutate_execution_target(&runtime, &invocation, ExecutionTargetStatus::Online).await
        }
        "target disable" => {
            mutate_execution_target(&runtime, &invocation, ExecutionTargetStatus::Disabled).await
        }
        "target authorize" => authorize_execution_target(&runtime, &invocation).await,
        "target authorizations" => {
            list_execution_target_authorizations(&runtime, &invocation).await
        }
        "target revoke-authorization" => {
            revoke_execution_target_authorization(&runtime, &invocation).await
        }
        "lease" | "lease list" => list_capability_leases(&runtime, &invocation).await,
        "lease revoke" => revoke_capability_lease(&runtime, &invocation).await,
        "execution" | "execution list" => list_execution_jobs(&runtime, &invocation).await,
        "execution show" => show_execution_job(&runtime, &invocation).await,
        "execution output" => show_execution_job_output(&runtime, &invocation).await,
        "execution cancel" => cancel_execution_job(&runtime, &invocation).await,
        "provider" | "provider list" => list_providers(&app_config, &invocation),
        "provider test" => test_provider(&app_config, &invocation).await,
        "provider show" => show_provider_instance(&runtime, &invocation).await,
        "provider set" => set_provider_instance(&runtime, &invocation).await,
        "provider account" | "provider account list" => {
            list_provider_accounts(&runtime, &invocation).await
        }
        "provider account login" => start_provider_account_login(&runtime, &invocation).await,
        "provider account complete" => complete_provider_account_login(&runtime, &invocation).await,
        "provider account logout" => logout_provider_account(&runtime, &invocation).await,
        "provider account set" => set_provider_account(&runtime, &invocation).await,
        "provider account enable" => {
            mutate_provider_account(&runtime, &invocation, ProviderAccountControlAction::Enable)
                .await
        }
        "provider account disable" => {
            mutate_provider_account(&runtime, &invocation, ProviderAccountControlAction::Disable)
                .await
        }
        "provider account test" => test_provider_account(&runtime, &invocation).await,
        "model" | "model list" => list_models(&app_config, &invocation).await,
        "model refresh" => refresh_model_catalog(&runtime, &invocation).await,
        "model use" => use_model(&app_config, &invocation),
        "model route" | "model route list" => list_model_routes(&runtime, &invocation).await,
        "model route show" => show_model_route(&runtime, &invocation).await,
        "model route set" => set_model_route(&runtime, &invocation).await,
        "model route test" => test_model_route(&runtime, &invocation).await,
        "profile" | "profile list" => list_profiles(&invocation),
        "profile show" => show_profile(&invocation),
        "profile use" => use_profile(&invocation),
        "resume" | "session resume" => {
            let (session, prompt) = resolve_resumed_session(&runtime, &invocation).await?;
            let harness = option_value(&invocation, "harness")
                .map(parse_exact_harness_ref)
                .transpose()?;
            if tui_mode {
                morphz::tui::run(runtime, session, nonempty_prompt(prompt), harness).await
            } else {
                run_interactive(
                    runtime,
                    session,
                    nonempty_prompt(prompt),
                    harness,
                    app_config.orchestrator.reply_wait_notice_secs,
                )
                .await
            }
        }
        "context" | "context list" => list_contexts(&runtime, &invocation).await,
        "context show" => show_context(&runtime, &invocation, &default_context_id, false).await,
        "context status" => show_context(&runtime, &invocation, &default_context_id, true).await,
        "context audit" => audit_context(&runtime, &invocation, &default_context_id).await,
        "context recall-index" | "context recall-index inspect" => {
            inspect_recall_index(&runtime, &invocation, &default_context_id).await
        }
        "context recall-index rebuild" => {
            rebuild_recall_index(&runtime, &invocation, &default_context_id).await
        }
        "context recall search" => {
            search_context_recall(&runtime, &invocation, &default_context_id).await
        }
        "context recall frame" => {
            recall_context_frame(&runtime, &invocation, &default_context_id).await
        }
        "scheduler" | "scheduler show" => {
            show_scheduler(&runtime, &invocation, &default_context_id).await
        }
        "scheduler thread show" => {
            show_scheduler_thread(&runtime, &invocation, &default_context_id).await
        }
        "scheduler thread pause" => {
            control_scheduler_thread(
                &runtime,
                &invocation,
                &default_context_id,
                ThreadControlAction::Pause,
            )
            .await
        }
        "scheduler thread resume" => {
            control_scheduler_thread(
                &runtime,
                &invocation,
                &default_context_id,
                ThreadControlAction::Resume,
            )
            .await
        }
        "scheduler thread cancel" => {
            control_scheduler_thread(
                &runtime,
                &invocation,
                &default_context_id,
                ThreadControlAction::Cancel,
            )
            .await
        }
        "scheduler thread supersede" => {
            supersede_scheduler_thread(&runtime, &invocation, &default_context_id).await
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
        "harness" | "harness list" => list_harnesses(&runtime, &invocation),
        "harness show" => show_harness(&runtime, &invocation),
        "harness install" => install_harness(&runtime, &invocation).await,
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
        "trajectory export" => export_agent_trajectory(&runtime, &invocation).await,
        "trajectory verify" => verify_agent_trajectory(&runtime, &invocation),
        "trajectory episode" => derive_training_episode_command(&runtime, &invocation),
        "job" | "job list" => list_jobs(&runtime, &invocation).await,
        "job cancel" => cancel_job(&runtime, &invocation).await,
        "doctor" => doctor(&runtime, &app_config),
        command => Err(format!("命令尚未实现: {command}").into()),
    }
}

async fn export_agent_trajectory(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let context_id = option_value(invocation, "context-id")
        .ok_or("morphz trajectory export 缺少 --context-id")?;
    let max_events = option_value(invocation, "max-events")
        .unwrap_or("10000")
        .parse::<usize>()
        .map_err(|error| format!("--max-events 无效: {error}"))?;
    let profile = option_value(invocation, "trajectory-profile")
        .unwrap_or("AT-Core")
        .to_string();
    let allow_training = switch_enabled(invocation, "allow-training")?;
    if allow_training && profile != "AT-Training" {
        return Err("--allow-training 只允许与 --trajectory-profile=AT-Training 一起使用".into());
    }
    let sdk = MorphzSdk::new(runtime.clone());
    let bundle = sdk
        .export_agent_trajectory(TrajectoryExportRequest {
            context_id: context_id.to_string(),
            objective_id: option_value(invocation, "objective-id").map(str::to_string),
            activation_id: None,
            start_time: None,
            end_time: None,
            max_events,
            profiles: vec![profile],
            include_payloads: true,
            include_user_content: switch_enabled(invocation, "include-user-content")?,
            rights: TrajectoryRights {
                training: allow_training,
                ..TrajectoryRights::default()
            },
        })
        .await?;
    let json = serde_json::to_string_pretty(&bundle)?;
    if let Some(path) = option_value(invocation, "output") {
        std::fs::write(path, format!("{json}\n"))?;
        println!("{}", path);
    } else {
        println!("{json}");
    }
    Ok(())
}

fn verify_agent_trajectory(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let path = invocation
        .prompt_args()
        .first()
        .ok_or("morphz trajectory verify 需要 FILE")?;
    let bytes = std::fs::read(path)?;
    let bundle: AgentTrajectoryBundle = serde_json::from_slice(&bytes)?;
    let report = MorphzSdk::new(runtime.clone()).verify_agent_trajectory(&bundle);
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !report.valid {
        return Err("Agent Trajectory Bundle 校验失败".into());
    }
    Ok(())
}

fn derive_training_episode_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let path = invocation
        .prompt_args()
        .first()
        .ok_or("morphz trajectory episode 需要 FILE")?;
    let bytes = std::fs::read(path)?;
    let bundle: AgentTrajectoryBundle = serde_json::from_slice(&bytes)?;
    let sdk = MorphzSdk::new(runtime.clone());
    let verification = sdk.verify_agent_trajectory(&bundle);
    if !verification.valid {
        return Err(format!(
            "Agent Trajectory Bundle 校验失败: {}",
            verification.errors.join("; ")
        )
        .into());
    }
    let episode = sdk.derive_training_episode(&bundle)?;
    let json = serde_json::to_string_pretty(&episode)?;
    if let Some(output) = option_value(invocation, "output") {
        std::fs::write(output, format!("{json}\n"))?;
        println!("{}", output);
    } else {
        println!("{json}");
    }
    Ok(())
}

fn edge_credential_path(invocation: &Invocation) -> Result<PathBuf, AppError> {
    option_value(invocation, "credential-file")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| morphz::edge_node::EdgeNodeCredentials::default_path())
}

async fn pair_edge_node(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let server_url =
        option_value(invocation, "server-url").ok_or("morphz edge pair 缺少 --server-url")?;
    let pairing_code =
        option_value(invocation, "pairing-code").ok_or("morphz edge pair 缺少 --pairing-code")?;
    let node_name = option_value(invocation, "node-name")
        .map(str::to_string)
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "Morphz Edge Node".to_string());
    let identity = morphz::edge_node::generate_device_identity()?;
    let gateway = morphz::edge_node::EdgeGatewayClient::new(server_url)?;
    let paired = gateway
        .pair(morphz::sdk::PairExecutionNodeCommand {
            code: pairing_code.to_string(),
            node_id: option_value(invocation, "node-id").map(str::to_string),
            name: node_name,
            device_key_fingerprint: identity.fingerprint.clone(),
            device_public_key: identity.public_key.clone(),
            protocol_version: 1,
            platform: Some(format!(
                "{}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )),
            capabilities: runtime.physical_tool_names(),
            metadata: serde_json::json!({
                "client_version": morphz::build_info::VERSION,
                "transport": "outbound_http_long_poll"
            }),
        })
        .await?;
    let credentials = morphz::edge_node::EdgeNodeCredentials {
        server_url: server_url.trim_end_matches('/').to_string(),
        node_id: paired.node.id.clone(),
        device_key_fingerprint: identity.fingerprint,
        device_public_key: identity.public_key,
        device_private_key_pkcs8: identity.private_key_pkcs8,
    };
    let path = edge_credential_path(invocation)?;
    credentials.save(&path)?;
    println!(
        "Paired Edge Node '{}' ({})\nCredentials: {}",
        paired.node.name,
        paired.node.id,
        path.display()
    );
    Ok(())
}

fn show_edge_node_status(invocation: &Invocation) -> Result<(), AppError> {
    let path = edge_credential_path(invocation)?;
    let credentials = morphz::edge_node::EdgeNodeCredentials::load(&path)?;
    println!(
        "Edge Node: {}\nGateway: {}\nCredentials: {}",
        credentials.node_id,
        credentials.server_url,
        path.display()
    );
    Ok(())
}

async fn create_edge_pairing_code(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let ttl = option_value(invocation, "ttl")
        .map(str::parse::<u64>)
        .transpose()?
        .unwrap_or(300);
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let pairing = sdk
        .create_node_pairing_code(
            &principal.principal_id,
            CreateNodePairingCodeCommand {
                expires_in_seconds: ttl,
            },
        )
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&pairing)?);
    } else {
        println!(
            "Pairing code: {}\nExpires at: {}",
            pairing.code,
            morphz::local_time::format_utc_for_local(pairing.expires_at)
        );
    }
    Ok(())
}

async fn list_edge_nodes(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let nodes = sdk.list_execution_nodes(&principal.principal_id).await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&nodes)?);
    } else if nodes.is_empty() {
        println!("No Execution Nodes.");
    } else {
        for node in nodes {
            println!(
                "{}\t{}\t{}\tr{}\t{}\t{}",
                node.id,
                node.name,
                node.status.as_str(),
                node.revision,
                node.platform.as_deref().unwrap_or("—"),
                node.capabilities.join(",")
            );
        }
    }
    Ok(())
}

async fn revoke_edge_node(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let node_id = invocation
        .prompt_args()
        .first()
        .ok_or("edge revoke 缺少 NODE_ID")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let node = sdk
        .revoke_execution_node(
            &principal.principal_id,
            node_id,
            required_revision(invocation)?,
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&node)?);
    Ok(())
}

fn list_edge_local_leases(invocation: &Invocation) -> Result<(), AppError> {
    let credentials =
        morphz::edge_node::EdgeNodeCredentials::load(&edge_credential_path(invocation)?)?;
    let store = morphz::edge_node::EdgeLocalCapabilityLeaseStore::for_node(&credentials.node_id);
    let leases = store.list();
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&leases)?);
    } else if leases.is_empty() {
        println!("No Provider-local Capability Leases.");
    } else {
        for lease in leases {
            println!(
                "{}\t{}\t{}\t{}\t{}",
                lease.id,
                lease.target_id,
                lease.thread_id,
                lease.capability,
                if lease.revoked_at.is_some() {
                    "revoked"
                } else {
                    "active"
                }
            );
        }
    }
    Ok(())
}

fn revoke_edge_local_lease(invocation: &Invocation) -> Result<(), AppError> {
    let lease_id = invocation
        .prompt_args()
        .first()
        .ok_or("edge revoke-local-lease 缺少 LEASE_ID")?;
    let credentials =
        morphz::edge_node::EdgeNodeCredentials::load(&edge_credential_path(invocation)?)?;
    let store = morphz::edge_node::EdgeLocalCapabilityLeaseStore::for_node(&credentials.node_id);
    if !store.revoke(lease_id)? {
        return Err(format!("Provider-local Capability Lease '{lease_id}' 不存在").into());
    }
    println!("Revoked Provider-local Capability Lease: {lease_id}");
    Ok(())
}

async fn rotate_edge_node_key(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let path = edge_credential_path(invocation)?;
    let credentials = morphz::edge_node::EdgeNodeCredentials::load(&path)?;
    let gateway = morphz::edge_node::EdgeGatewayClient::new(&credentials.server_url)?;
    let node = gateway
        .heartbeat_node(
            &credentials,
            &morphz::edge_node::EdgeNodeAdvertisement {
                platform: Some(format!(
                    "{}-{}",
                    std::env::consts::OS,
                    std::env::consts::ARCH
                )),
                capabilities: runtime.physical_tool_names(),
                metadata: serde_json::json!({
                    "client_version": morphz::build_info::VERSION,
                    "transport": "outbound_http_long_poll"
                }),
                targets: Vec::new(),
            },
        )
        .await?;
    let identity = morphz::edge_node::generate_device_identity()?;
    let replacement = morphz::edge_node::EdgeNodeCredentials {
        server_url: credentials.server_url.clone(),
        node_id: credentials.node_id.clone(),
        device_key_fingerprint: identity.fingerprint.clone(),
        device_public_key: identity.public_key.clone(),
        device_private_key_pkcs8: identity.private_key_pkcs8.clone(),
    };
    let pending_path = path.with_extension("json.rotate-pending");
    replacement.save(&pending_path)?;
    if let Err(error) = gateway
        .rotate_device_key(&credentials, node.revision, &identity)
        .await
    {
        let _ = std::fs::remove_file(&pending_path);
        return Err(error);
    }
    std::fs::rename(&pending_path, &path).map_err(|error| {
        format!(
            "服务端密钥已轮换，但本地凭证替换失败；请将 '{}' 恢复为 '{}': {error}",
            pending_path.display(),
            path.display()
        )
    })?;
    println!(
        "Rotated Edge Node device key: {}\nCredentials: {}",
        credentials.node_id,
        path.display()
    );
    Ok(())
}

async fn run_edge_node(
    runtime: MorphzRuntime,
    app_config: &config::AppConfig,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let credentials =
        morphz::edge_node::EdgeNodeCredentials::load(&edge_credential_path(invocation)?)?;
    let target_id = option_value(invocation, "target-id")
        .map(str::to_string)
        .unwrap_or_else(|| format!("target-{}-workspace", credentials.node_id));
    let target_name = option_value(invocation, "target-name")
        .map(str::to_string)
        .unwrap_or_else(|| "Edge Workspace".to_string());
    let worker_count = option_value(invocation, "workers")
        .map(str::parse::<usize>)
        .transpose()?
        .unwrap_or(app_config.edge_execution.max_in_flight_per_node)
        .clamp(1, app_config.edge_execution.max_in_flight_per_node.max(1));
    let capabilities = runtime.physical_tool_names();
    let target = ExecutionTargetRegistration {
        id: target_id.clone(),
        owner_principal_id: None,
        provider_node_id: Some(credentials.node_id.clone()),
        kind: ExecutionTargetKind::EdgeNode,
        name: target_name,
        status: ExecutionTargetStatus::Online,
        platform: Some(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )),
        workspace_root: Some(app_config.permissions.workspace_root.clone()),
        capabilities: capabilities.clone(),
        metadata: serde_json::json!({
            "backend": "edge_node",
            "protocol_version": 1,
            "workspace_identity": target_id,
        }),
        policy_digest: runtime.execution_policy_digest(),
        last_seen_at: Some(Utc::now()),
    };
    let gateway = morphz::edge_node::EdgeGatewayClient::new(&credentials.server_url)?;
    let advertisement = morphz::edge_node::EdgeNodeAdvertisement {
        platform: target.platform.clone(),
        capabilities,
        metadata: serde_json::json!({
            "client_version": morphz::build_info::VERSION,
            "transport": "outbound_http_long_poll"
        }),
        targets: vec![target],
    };
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut workers = tokio::task::JoinSet::new();
    for index in 0..worker_count {
        let worker = morphz::edge_node::EdgeNodeWorker::new(
            gateway.clone(),
            credentials.clone(),
            advertisement.clone(),
            runtime.clone(),
            morphz::edge_node::EdgeWorkerConfig {
                worker_id: format!("{}-{}-{}", credentials.node_id, std::process::id(), index),
                lease_seconds: app_config.edge_execution.default_command_lease.as_secs(),
                ..Default::default()
            },
        );
        workers.spawn(worker.run_until_shutdown(shutdown_rx.clone()));
    }
    println!(
        "Edge Node {} is online; target={} workers={} (Ctrl+C to stop)",
        credentials.node_id, target_id, worker_count
    );
    tokio::signal::ctrl_c().await?;
    let _ = shutdown_tx.send(true);
    while let Some(result) = workers.join_next().await {
        result??;
    }
    Ok(())
}

fn required_revision(invocation: &Invocation) -> Result<u64, AppError> {
    option_value(invocation, "revision")
        .ok_or_else(|| "缺少 --revision".into())
        .and_then(|value| value.parse::<u64>().map_err(Into::into))
}

async fn list_execution_targets(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let targets = sdk.list_execution_targets(&principal.principal_id).await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&targets)?);
    } else if targets.is_empty() {
        println!("No Execution Targets.");
    } else {
        for target in targets {
            println!(
                "{}\t{}\t{}\t{}\tr{}\t{}",
                target.id,
                target.name,
                target.kind.as_str(),
                target.status.as_str(),
                target.revision,
                target.capabilities.join(",")
            );
        }
    }
    Ok(())
}

async fn show_execution_target(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let target_id = invocation
        .prompt_args()
        .first()
        .ok_or("target show 缺少 TARGET_ID")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let target = sdk
        .inspect_execution_target(&principal.principal_id, target_id)
        .await?;
    println!("{}", serde_json::to_string_pretty(&target)?);
    Ok(())
}

async fn mutate_execution_target(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    status: ExecutionTargetStatus,
) -> Result<(), AppError> {
    let target_id = invocation
        .prompt_args()
        .first()
        .ok_or("target enable/disable 缺少 TARGET_ID")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let target = sdk
        .set_execution_target_status(
            &principal.principal_id,
            target_id,
            required_revision(invocation)?,
            status,
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&target)?);
    Ok(())
}

async fn authorize_execution_target(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let target_id = invocation
        .prompt_args()
        .first()
        .ok_or("target authorize 缺少 TARGET_ID")?
        .to_string();
    let scope = match option_value(invocation, "scope") {
        Some("agent") => ExecutionTargetAuthorizationScope::Agent,
        Some("context") => ExecutionTargetAuthorizationScope::Context,
        Some("thread") => ExecutionTargetAuthorizationScope::Thread,
        _ => return Err("--scope 必须是 agent、context 或 thread".into()),
    };
    let scope_id = option_value(invocation, "scope-id")
        .ok_or("target authorize 缺少 --scope-id")?
        .to_string();
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let authorization = sdk
        .authorize_execution_target(
            &principal.principal_id,
            AuthorizeExecutionTargetCommand {
                target_id,
                scope,
                scope_id,
            },
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&authorization)?);
    Ok(())
}

async fn list_execution_target_authorizations(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let authorizations = sdk
        .list_execution_target_authorizations(
            &principal.principal_id,
            invocation.prompt_args().first().cloned(),
            false,
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&authorizations)?);
    Ok(())
}

async fn revoke_execution_target_authorization(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let authorization_id = invocation
        .prompt_args()
        .first()
        .ok_or("target revoke-authorization 缺少 AUTHORIZATION_ID")?;
    let reason = option_value(invocation, "reason").unwrap_or("CLI revoke");
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let authorization = sdk
        .revoke_execution_target_authorization(
            &principal.principal_id,
            authorization_id,
            required_revision(invocation)?,
            reason,
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&authorization)?);
    Ok(())
}

async fn list_capability_leases(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let leases = sdk
        .list_capability_leases(
            &principal.principal_id,
            option_value(invocation, "thread-id").map(str::to_string),
            option_value(invocation, "target-id").map(str::to_string),
            true,
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&leases)?);
    Ok(())
}

async fn revoke_capability_lease(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let lease_id = invocation
        .prompt_args()
        .first()
        .ok_or("lease revoke 缺少 LEASE_ID")?;
    let reason = option_value(invocation, "reason").unwrap_or("CLI revoke");
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let lease = sdk
        .revoke_capability_lease(
            &principal.principal_id,
            lease_id,
            required_revision(invocation)?,
            reason,
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&lease)?);
    Ok(())
}

async fn list_execution_jobs(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let jobs = sdk
        .list_execution_jobs(
            &principal.principal_id,
            ExecutionJobQuery {
                context_id: option_value(invocation, "context-id").map(str::to_string),
                thread_id: option_value(invocation, "thread-id").map(str::to_string),
                target_id: option_value(invocation, "target-id").map(str::to_string),
                include_terminal: switch_enabled(invocation, "include-terminal")?,
                newest_first: true,
                limit: option_value(invocation, "limit")
                    .map(str::parse::<usize>)
                    .transpose()?,
                ..ExecutionJobQuery::default()
            },
        )
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&jobs)?);
    } else if jobs.is_empty() {
        println!("No Execution Jobs.");
    } else {
        for job in jobs {
            println!(
                "{}\t{}\t{}\t{}\t{}\tr{}",
                job.id,
                job.status.as_str(),
                job.tool_name,
                job.target_id,
                job.thread_id,
                job.revision
            );
        }
    }
    Ok(())
}

async fn show_execution_job(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let job_id = invocation
        .prompt_args()
        .first()
        .ok_or("execution show 缺少 JOB_ID")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let job = sdk
        .inspect_execution_job(&principal.principal_id, job_id)
        .await?;
    println!("{}", serde_json::to_string_pretty(&job)?);
    Ok(())
}

async fn show_execution_job_output(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let job_id = invocation
        .prompt_args()
        .first()
        .ok_or("execution output 缺少 JOB_ID")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    // Output inherits the parent Job's Principal authority.
    sdk.inspect_execution_job(&principal.principal_id, job_id)
        .await?;
    let after = option_value(invocation, "after")
        .map(str::parse::<u64>)
        .transpose()?
        .unwrap_or(0);
    let limit = option_value(invocation, "limit")
        .map(str::parse::<usize>)
        .transpose()?
        .unwrap_or(200)
        .clamp(1, 1_000);
    let chunks = sdk.list_edge_command_output(job_id, after, limit).await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&chunks)?);
    } else {
        for chunk in chunks {
            print!("{}", chunk.text);
        }
        std::io::stdout().flush()?;
    }
    Ok(())
}

async fn cancel_execution_job(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let job_id = invocation
        .prompt_args()
        .first()
        .ok_or("execution cancel 缺少 JOB_ID")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let job = sdk
        .cancel_execution_job(
            &principal.principal_id,
            job_id,
            required_revision(invocation)?,
            option_value(invocation, "reason"),
        )
        .await?;
    println!("{}", serde_json::to_string_pretty(&job)?);
    Ok(())
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

async fn list_provider_accounts(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let snapshot = MorphzSdk::new(runtime.clone())
        .provider_control_snapshot()
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&snapshot.auth_accounts)?);
        return Ok(());
    }
    if snapshot.auth_accounts.is_empty() {
        println!("尚未配置账号。请在 ~/.morphz/morphz.toml 的 [accounts] 中添加账号。");
        return Ok(());
    }
    for (account_id, account) in snapshot.auth_accounts {
        let status = account
            .state
            .as_ref()
            .map(|state| format!("{:?}", state.status).to_ascii_lowercase())
            .unwrap_or_else(|| {
                if account.effective_enabled {
                    "ready".to_string()
                } else {
                    "disabled".to_string()
                }
            });
        let auth = if account.oauth {
            if account.authenticated {
                "oauth:authenticated"
            } else {
                "oauth:login-required"
            }
        } else {
            account.config.auth_adapter.as_str()
        };
        let revision = account
            .state
            .as_ref()
            .map(|state| state.revision.to_string())
            .unwrap_or_else(|| "-".to_string());
        println!(
            "{account_id}\tprovider={}\tauth={}\tstatus={}\trevision={}",
            account.config.provider.as_deref().unwrap_or("-"),
            auth,
            status,
            revision
        );
    }
    Ok(())
}

async fn show_provider_instance(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let provider_id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz provider show PROVIDER")?;
    let snapshot = MorphzSdk::new(runtime.clone())
        .provider_control_snapshot()
        .await?;
    let provider = snapshot
        .provider_instances
        .get(provider_id)
        .ok_or_else(|| format!("Provider Instance '{provider_id}' 不存在"))?;
    println!("{}", toml::to_string_pretty(provider)?);
    Ok(())
}

async fn set_provider_instance(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let args = invocation.prompt_args();
    let provider_id = args
        .first()
        .ok_or("用法: morphz provider set PROVIDER FILE")?;
    let file = args
        .get(1)
        .ok_or("用法: morphz provider set PROVIDER FILE")?;
    let provider: config::ProviderInstanceConfig = read_toml_object(Path::new(file))?;
    let path = config::managed_model_config_path()?;
    let receipt = MorphzSdk::new(runtime.clone())
        .put_provider_instance_config(&path, provider_id, provider)
        .await?;
    print_provider_catalog_receipt(invocation, &receipt)?;
    Ok(())
}

async fn set_provider_account(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let args = invocation.prompt_args();
    let account_id = args
        .first()
        .ok_or("用法: morphz provider account set ACCOUNT FILE")?;
    let file = args
        .get(1)
        .ok_or("用法: morphz provider account set ACCOUNT FILE")?;
    let account: config::AuthAccountConfig = read_toml_object(Path::new(file))?;
    let path = config::managed_model_config_path()?;
    let receipt = MorphzSdk::new(runtime.clone())
        .put_auth_account_config(&path, account_id, account)
        .await?;
    print_provider_catalog_receipt(invocation, &receipt)?;
    Ok(())
}

async fn list_model_routes(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let snapshot = MorphzSdk::new(runtime.clone())
        .provider_control_snapshot()
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&snapshot.model_routes)?);
    } else {
        for (route_id, route) in snapshot.model_routes {
            println!(
                "{route_id}\taliases={}\ttargets={}\tstickiness={:?}\tstrategy={:?}\tfallback={}",
                route.aliases.join(","),
                route.candidates.len(),
                route.affinity,
                route.selection,
                route.fallback
            );
        }
    }
    Ok(())
}

async fn show_model_route(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let route_id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz model route show ROUTE")?;
    let snapshot = MorphzSdk::new(runtime.clone())
        .provider_control_snapshot()
        .await?;
    let route = snapshot
        .model_routes
        .get(route_id)
        .ok_or_else(|| format!("Model Route '{route_id}' 不存在"))?;
    println!("{}", toml::to_string_pretty(route)?);
    Ok(())
}

async fn set_model_route(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let args = invocation.prompt_args();
    let route_id = args
        .first()
        .ok_or("用法: morphz model route set ROUTE FILE")?;
    let file = args
        .get(1)
        .ok_or("用法: morphz model route set ROUTE FILE")?;
    let route: config::ModelRouteConfig = read_toml_object(Path::new(file))?;
    let path = config::managed_model_config_path()?;
    let receipt = MorphzSdk::new(runtime.clone())
        .put_model_route_config(&path, route_id, route)
        .await?;
    print_provider_catalog_receipt(invocation, &receipt)?;
    Ok(())
}

fn read_toml_object<T>(path: &Path) -> Result<T, AppError>
where
    T: serde::de::DeserializeOwned,
{
    let content = std::fs::read_to_string(path)?;
    Ok(toml::from_str(&content)?)
}

fn print_provider_catalog_receipt(
    invocation: &Invocation,
    receipt: &morphz::provider::control::ProviderCatalogMutationReceipt,
) -> Result<(), AppError> {
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(receipt)?);
    } else {
        println!(
            "已保存 {:?} '{}' 到 {}。静态目录将在 Runtime 重启后生效。",
            receipt.kind, receipt.id, receipt.managed_config_path
        );
    }
    Ok(())
}

async fn start_provider_account_login(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let account_id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz provider account login ACCOUNT")?;
    start_provider_account_login_for(runtime, account_id, json_output(invocation)).await
}

async fn start_provider_account_login_for(
    runtime: &MorphzRuntime,
    account_id: &str,
    json: bool,
) -> Result<(), AppError> {
    let challenge = MorphzSdk::new(runtime.clone())
        .start_provider_oauth_login(account_id)
        .await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&challenge)?);
        return Ok(());
    }
    println!("OAuth 登录已创建：{}", challenge.login_id);
    match challenge.flow {
        OAuthFlowKind::AuthorizationCodePkce => {
            let url = challenge
                .authorization_url
                .as_deref()
                .ok_or("OAuth Adapter 未返回授权地址")?;
            println!("请在浏览器完成授权：\n{url}");
            if let Err(error) = open_dashboard_browser(url) {
                tracing::warn!(event_code = "app.oauth.browser_open_failed", %error, "Failed to open the OAuth authorization URL automatically");
            }
            println!(
                "授权后运行：morphz provider account complete {} --code CODE --state STATE",
                challenge.login_id
            );
        }
        OAuthFlowKind::DeviceCode => {
            let url = challenge
                .verification_uri_complete
                .as_deref()
                .or(challenge.verification_uri.as_deref())
                .ok_or("OAuth Adapter 未返回设备授权地址")?;
            println!("请打开：{url}");
            if let Some(code) = challenge.user_code.as_deref() {
                println!("设备码：{code}");
            }
            if let Err(error) = open_dashboard_browser(url) {
                tracing::warn!(event_code = "app.oauth.device_browser_open_failed", %error, "Failed to open the OAuth device-authorization URL automatically");
            }
            println!(
                "完成授权后运行：morphz provider account complete {} --poll",
                challenge.login_id
            );
        }
    }
    Ok(())
}

async fn complete_provider_account_login(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let login_id = invocation.prompt_args().first().ok_or(
        "用法: morphz provider account complete LOGIN_ID [--poll | --code CODE --state STATE]",
    )?;
    let completion = if switch_enabled(invocation, "poll")? {
        OAuthLoginCompletion::Poll
    } else {
        OAuthLoginCompletion::AuthorizationCode {
            code: option_value(invocation, "code")
                .filter(|value| !value.trim().is_empty())
                .ok_or("授权码流程需要 --code")?
                .to_string(),
            state: option_value(invocation, "state")
                .filter(|value| !value.trim().is_empty())
                .ok_or("授权码流程需要 --state")?
                .to_string(),
        }
    };
    let progress = MorphzSdk::new(runtime.clone())
        .continue_provider_oauth_login(login_id, completion)
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&progress)?);
        return Ok(());
    }
    match progress {
        OAuthLoginProgress::Pending { retry_after_secs } => println!(
            "授权尚未完成；约 {retry_after_secs} 秒后再次运行 `morphz provider account complete {login_id} --poll`。"
        ),
        OAuthLoginProgress::Complete { account } => println!(
            "OAuth 登录成功：account={} adapter={} subject={}",
            account.account_id,
            account.adapter_id,
            account.subject.as_deref().unwrap_or("-")
        ),
    }
    Ok(())
}

async fn logout_provider_account(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let account_id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz provider account logout ACCOUNT")?;
    let deleted = MorphzSdk::new(runtime.clone())
        .logout_provider_oauth_account(account_id)
        .await?;
    if json_output(invocation) {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "account_id": account_id,
                "logged_out": deleted,
            }))?
        );
    } else if deleted {
        println!("已注销 OAuth 账号 '{account_id}'，Token 已从 Secret Store 删除。");
    } else {
        println!("账号 '{account_id}' 当前没有已保存的 OAuth Token。");
    }
    Ok(())
}

async fn mutate_provider_account(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    action: ProviderAccountControlAction,
) -> Result<(), AppError> {
    let account_id = invocation
        .prompt_args()
        .first()
        .ok_or("缺少 Auth Account ID")?;
    let expected_revision = option_value(invocation, "revision")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| "--revision 必须是非负整数")?;
    let state = MorphzSdk::new(runtime.clone())
        .control_provider_account(account_id, expected_revision, action)
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&state)?);
    } else {
        println!(
            "账号 '{}' 已{}；status={:?} revision={}",
            account_id,
            match action {
                ProviderAccountControlAction::Enable => "启用",
                ProviderAccountControlAction::Disable => "禁用",
            },
            state.status,
            state.revision
        );
    }
    Ok(())
}

async fn test_provider_account(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let account_id = invocation
        .prompt_args()
        .first()
        .ok_or("缺少 Auth Account ID")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let snapshot = sdk.provider_control_snapshot().await?;
    if !snapshot.auth_accounts.contains_key(account_id) {
        return Err(format!("Auth Account '{account_id}' 不存在").into());
    }
    let route_id = if let Some(route) = option_value(invocation, "route") {
        route.to_string()
    } else {
        snapshot
            .model_routes
            .iter()
            .find(|(_, route)| {
                route.candidates.iter().any(|candidate| {
                    candidate.account.as_deref() == Some(account_id.as_str())
                        || snapshot
                            .provider_instances
                            .get(&candidate.provider)
                            .is_some_and(|provider| provider.accounts.contains(account_id))
                })
            })
            .map(|(route_id, _)| route_id.clone())
            .ok_or_else(|| format!("Auth Account '{account_id}' 没有可用于诊断的 Model Route"))?
    };
    let diagnostic = sdk
        .diagnose_model_route(&route_id, Some(account_id))
        .await?;
    print_model_route_diagnostic(invocation, &diagnostic)?;
    Ok(())
}

async fn test_model_route(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let route_id = invocation
        .prompt_args()
        .first()
        .ok_or("缺少 Model Route ID 或别名")?;
    let diagnostic = MorphzSdk::new(runtime.clone())
        .diagnose_model_route(route_id, option_value(invocation, "account"))
        .await?;
    print_model_route_diagnostic(invocation, &diagnostic)?;
    Ok(())
}

async fn refresh_model_catalog(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
) -> Result<(), AppError> {
    let route_id = invocation
        .prompt_args()
        .first()
        .cloned()
        .unwrap_or_else(|| runtime.model());
    let diagnostic = MorphzSdk::new(runtime.clone())
        .refresh_model_catalog(&route_id, option_value(invocation, "account"))
        .await?;
    print_model_route_diagnostic(invocation, &diagnostic)?;
    Ok(())
}

fn print_model_route_diagnostic(
    invocation: &Invocation,
    diagnostic: &morphz::llm::ModelRouteDiagnostic,
) -> Result<(), AppError> {
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(diagnostic)?);
        return Ok(());
    }
    let binding = &diagnostic.binding;
    println!(
        "Route '{}' → {}/{} · account={} · protocol={}",
        binding.requested_alias,
        binding.provider_instance_id,
        binding.physical_model,
        binding.auth_account_id,
        binding.protocol
    );
    println!(
        "健康请求: {} · {} ms",
        if diagnostic.health_verified {
            "通过"
        } else {
            "失败"
        },
        diagnostic.elapsed_ms
    );
    if let Some(error) = diagnostic.health_error.as_deref() {
        println!("健康错误: {error}");
    }
    if let Some(error) = diagnostic.catalog_error.as_deref() {
        println!("目录错误: {error}");
    } else {
        println!(
            "远端模型目录: {} 个模型",
            diagnostic.discovered_models.len()
        );
        for model in &diagnostic.discovered_models {
            println!("  {model}");
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
    if let Some(route_id) = EffectiveProviderCatalog::from_config(app_config)
        .ok()
        .and_then(|catalog| {
            catalog
                .resolve_route(value)
                .ok()
                .map(|(route_id, _)| route_id.to_string())
        })
    {
        let path = config::managed_model_config_path()?;
        config::save_managed_inference_at(
            &path,
            None,
            &route_id,
            app_config.llm.reasoning_effort,
            None,
        )?;
        println!(
            "已将默认模型设为 {route_id}；配置将在下一次求值或重启后生效。\n{}",
            path.display()
        );
        return Ok(());
    }
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
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    if let Some(session_id) = option_value(invocation, "session") {
        let record = sdk
            .get_session(&principal.principal_id, session_id)
            .await
            .map_err(|error| format!("无法恢复 Session '{session_id}': {error}"))?;
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
            match sdk.get_session(&principal.principal_id, &session_id).await {
                Ok(record) => {
                    ensure_active_session(&record)?;
                    return Ok(runtime.session(session_id));
                }
                Err(error) if error.code == SdkErrorCode::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let record = sdk
                .create_session(
                    principal,
                    NewSession {
                        id: session_id,
                        agent_id: context.agent_id,
                        context_id: context.id,
                        parent_session_id: None,
                        title: "环境指定终端 Session".to_string(),
                        mount_kind: SessionMountKind::ExistingContext,
                    },
                )
                .await?;
            return Ok(runtime.session(record.id));
        }
    }

    let session_id = generated_id("session");
    sdk.create_session(
        principal,
        NewSession {
            id: session_id.clone(),
            agent_id: context.agent_id,
            context_id: context.id,
            parent_session_id: None,
            title: "本地终端".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        },
    )
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
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let mut prompt_args = invocation.prompt_args().to_vec();
    let use_last = switch_enabled(invocation, "last")?;
    if use_last && option_value(invocation, "session").is_some() {
        return Err("resume 不能同时使用 --last 和 --session".into());
    }
    let session_id =
        if use_last || (option_value(invocation, "session").is_none() && prompt_args.is_empty()) {
            sdk.list_sessions(&principal.principal_id, false)
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
    let record = sdk
        .get_session(&principal.principal_id, &session_id)
        .await
        .map_err(|error| format!("无法恢复 Session '{session_id}': {error}"))?;
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
    let audit = MorphzSdk::new(runtime.clone())
        .audit_mind_projection(id)
        .await?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&audit)?);
    } else {
        println!(
            "{}  matches={}  replayed_events=r{}:{}  projection={}:{}  full_events={}  snapshot={}  incremental_transactions={}  incremental_matches={}  latency_us=full:{}/incremental:{}/projection:{}",
            audit.context_id,
            audit.matches,
            audit.replayed_event_revision,
            audit.replayed_state_hash,
            audit
                .projection_revision
                .map(|revision| format!("r{revision}"))
                .unwrap_or_else(|| "missing".to_string()),
            audit.projection_hash.as_deref().unwrap_or("missing"),
            audit.events_scanned,
            audit
                .snapshot_revision
                .map(|revision| format!("r{revision}"))
                .unwrap_or_else(|| "missing".to_string()),
            audit
                .incremental_transactions_scanned
                .map(|count| count.to_string())
                .unwrap_or_else(|| "n/a".to_string()),
            audit
                .incremental_matches
                .map(|matches| matches.to_string())
                .unwrap_or_else(|| "n/a".to_string()),
            audit.full_replay_micros,
            audit
                .incremental_replay_micros
                .map(|micros| micros.to_string())
                .unwrap_or_else(|| "n/a".to_string()),
            audit.projection_validation_micros,
        );
    }
    if !audit.matches {
        return Err(format!("Context '{id}' 的 Mind Projection 与事件回放结果不一致").into());
    }
    Ok(())
}

fn selected_context_id<'a>(
    invocation: &'a Invocation,
    default_context_id: &'a str,
    positional: bool,
) -> &'a str {
    positional
        .then(|| invocation.prompt_args().first().map(String::as_str))
        .flatten()
        .or_else(|| option_value(invocation, "context"))
        .unwrap_or(default_context_id)
}

async fn inspect_recall_index(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let context_id = selected_context_id(invocation, default_context_id, true);
    let audit = runtime.inspect_recall_index(context_id).await?;
    println!("{}", serde_json::to_string_pretty(&audit)?);
    Ok(())
}

async fn rebuild_recall_index(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let context_id = selected_context_id(invocation, default_context_id, true);
    let audit = runtime.rebuild_recall_index(context_id).await?;
    println!("{}", serde_json::to_string_pretty(&audit)?);
    Ok(())
}

async fn search_context_recall(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let query = invocation.prompt_args().join(" ");
    let parse_time = |name: &str,
                      value: Option<&str>|
     -> Result<Option<chrono::DateTime<chrono::Utc>>, AppError> {
        value
            .map(|value| {
                chrono::DateTime::parse_from_rfc3339(value)
                    .map(|time| time.with_timezone(&chrono::Utc))
                    .map_err(|_| format!("--{name} 必须是 RFC 3339 时间").into())
            })
            .transpose()
    };
    let start_time = parse_time("since", option_value(invocation, "since"))?;
    let end_time = parse_time("until", option_value(invocation, "until"))?;
    if query.trim().is_empty() && start_time.is_none() && end_time.is_none() {
        return Err("context recall search 需要 QUERY 或 --since/--until 时间范围".into());
    }
    let limit = option_value(invocation, "limit")
        .unwrap_or("20")
        .parse::<usize>()
        .map_err(|_| "--limit 必须是整数")?
        .clamp(1, 100);
    let page = runtime
        .search_recall(RecallSearchRequest {
            context_id: selected_context_id(invocation, default_context_id, false).to_string(),
            query,
            start_time,
            end_time,
            limit,
            cursor: option_value(invocation, "cursor").map(ToOwned::to_owned),
        })
        .await?;
    println!("{}", serde_json::to_string_pretty(&page)?);
    Ok(())
}

async fn recall_context_frame(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let frame_id = invocation
        .prompt_args()
        .first()
        .ok_or("context recall frame 需要 FRAME")?
        .clone();
    let depth = option_value(invocation, "depth")
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| "--depth 必须是整数")?
        .min(4);
    let max_nodes = option_value(invocation, "max-nodes")
        .unwrap_or("32")
        .parse::<usize>()
        .map_err(|_| "--max-nodes 必须是整数")?
        .clamp(1, 128);
    let direction = match option_value(invocation, "direction").unwrap_or("ancestors") {
        "ancestors" => FrameRecallDirection::Ancestors,
        "descendants" => FrameRecallDirection::Descendants,
        "both" => FrameRecallDirection::Both,
        value => return Err(format!("未知 direction '{value}'").into()),
    };
    let page = runtime
        .recall_frame(FrameRecallRequest {
            context_id: selected_context_id(invocation, default_context_id, false).to_string(),
            frame_id,
            depth,
            direction,
            include_bodies: !switch_enabled(invocation, "no-bodies")?,
            include_events: switch_enabled(invocation, "include-events")?,
            max_nodes,
            cursor: option_value(invocation, "cursor").map(ToOwned::to_owned),
        })
        .await?;
    println!("{}", serde_json::to_string_pretty(&page)?);
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
    let snapshot = MorphzSdk::new(runtime.clone())
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
        "Scheduler context={} threads={} groups={} signals={} activations={}/{} jobs={} approvals={} schedules={} provider=queued:{}/in-flight:{}/max:{}/acquired:{} event_writer=queue:{}/events:{}/batches:{}/failed:{}/contention-retries:{}/largest:{} context=tx:{}/conflicts:{}/encodings:{}/events-scanned:{}",
        snapshot.context_id,
        snapshot.summary.open_threads,
        snapshot.thread_groups.len(),
        snapshot.summary.pending_signals,
        snapshot.summary.running_activations,
        snapshot.summary.queued_activations,
        snapshot.summary.active_jobs,
        snapshot.summary.pending_approvals,
        snapshot.summary.active_schedules,
        snapshot.model_provider.queued,
        snapshot.model_provider.in_flight,
        snapshot.model_provider.max_in_flight,
        snapshot.model_provider.acquired_total,
        snapshot.event_writer.queue_depth,
        snapshot.event_writer.committed_events,
        snapshot.event_writer.committed_batches,
        snapshot.event_writer.failed_batches,
        snapshot.event_writer.contention_retries,
        snapshot.event_writer.largest_batch,
        snapshot.context_capacity.context_transactions_total,
        snapshot.context_capacity.context_tx_conflicts_total,
        snapshot.context_capacity.context_encodings_total,
        snapshot.context_capacity.events_scanned_total,
    );
    for item in &snapshot.threads {
        println!(
            "{}  kind={} lifecycle={} phase={} lifetime={} supervisor={}:{} generation={} group={} outcome={} activations={} jobs={} signals={} schedules={}",
            item.thread.id,
            item.thread.kind.as_str(),
            item.thread.lifecycle.as_str(),
            item.phase.as_str(),
            item.thread.supervision.lifetime.as_str(),
            item.thread.supervision.supervisor_kind.as_str(),
            item.thread.supervision.supervisor_id.as_deref().unwrap_or("-"),
            item.thread.supervision.generation,
            item.thread.supervision.thread_group_id.as_deref().unwrap_or("-"),
            item.outcome
                .as_ref()
                .map(|outcome| outcome.terminal_kind.as_str())
                .unwrap_or("-"),
            item.activations.len(),
            item.activations
                .iter()
                .map(|value| value.jobs.len())
                .sum::<usize>(),
            item.pending_signals.len(),
            item.schedules.len(),
        );
    }
    for item in &snapshot.thread_groups {
        println!(
            "group {}  status={} policy={} supervisor={}:{} generation={} progress={}/{} successful={} barrier={}",
            item.group.id,
            item.group.status.as_str(),
            item.group.policy.as_str(),
            item.group.supervisor_kind.as_str(),
            item.group.supervisor_id,
            item.group.generation,
            item.group.terminal_count,
            item.group.required_count,
            item.group.successful_count,
            item.group.barrier_event_id.as_deref().unwrap_or("-"),
        );
        for member in &item.members {
            let outcome = item
                .outcomes
                .iter()
                .find(|outcome| outcome.thread_id == member.thread_id);
            println!(
                "  member {} required={} status={} outcome={} summary={}",
                member.thread_id,
                member.required,
                member.status.as_str(),
                member.outcome_id.as_deref().unwrap_or("-"),
                outcome
                    .and_then(|outcome| outcome.summary.as_deref())
                    .unwrap_or("-"),
            );
        }
    }
    Ok(())
}

async fn show_scheduler_thread(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let context_id = option_value(invocation, "context").unwrap_or(default_context_id);
    let thread_id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz scheduler thread show <THREAD_ID>")?;
    let detail = MorphzSdk::new(runtime.clone())
        .thread_detail(context_id, thread_id)
        .await?;
    println!("{}", serde_json::to_string_pretty(&detail)?);
    Ok(())
}

async fn control_scheduler_thread(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
    action: ThreadControlAction,
) -> Result<(), AppError> {
    let context_id = option_value(invocation, "context").unwrap_or(default_context_id);
    let thread_id = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz scheduler thread <pause|resume|cancel> <THREAD_ID> [--reason=TEXT]")?;
    let sdk = MorphzSdk::new(runtime.clone());
    let detail = sdk.thread_detail(context_id, thread_id).await?;
    let expected_revision = option_value(invocation, "expected-revision")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| "--expected-revision 必须是非负整数")?
        .unwrap_or(detail.snapshot.thread.revision);
    let fallback_reason = match action {
        ThreadControlAction::Pause => "用户通过 CLI 暂停 Thread",
        ThreadControlAction::Resume => "用户通过 CLI 继续 Thread",
        ThreadControlAction::Cancel => "用户通过 CLI 取消 Thread",
    };
    let reason = option_value(invocation, "reason")
        .map(str::to_string)
        .or_else(|| {
            (invocation.prompt_args().len() > 1).then(|| invocation.prompt_args()[1..].join(" "))
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_reason.to_string());
    match sdk
        .control_thread(context_id, thread_id, expected_revision, action, &reason)
        .await?
    {
        ThreadMutation::Updated(thread) => {
            println!("{}", serde_json::to_string_pretty(&thread)?);
            Ok(())
        }
        ThreadMutation::Conflict { current } => Err(format!(
            "Thread revision 冲突：期望 r{expected_revision}，当前 r{}",
            current.revision
        )
        .into()),
        ThreadMutation::NotFound => Err(format!("Thread '{thread_id}' 不存在").into()),
    }
}

async fn supersede_scheduler_thread(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    default_context_id: &str,
) -> Result<(), AppError> {
    let context_id = option_value(invocation, "context").unwrap_or(default_context_id);
    let args = invocation.prompt_args();
    let thread_id = args
        .first()
        .ok_or("用法: morphz scheduler thread supersede <THREAD_ID> <INTENT> [--reason=TEXT]")?;
    let intent = args.get(1..).unwrap_or_default().join(" ");
    if intent.trim().is_empty() {
        return Err("supersede 需要非空 INTENT".into());
    }
    let sdk = MorphzSdk::new(runtime.clone());
    let detail = sdk.thread_detail(context_id, thread_id).await?;
    let expected_revision = option_value(invocation, "expected-revision")
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| "--expected-revision 必须是非负整数")?
        .unwrap_or(detail.snapshot.thread.revision);
    let reason = option_value(invocation, "reason")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("用户通过 CLI 修订 Thread");
    match sdk
        .supersede_thread(context_id, thread_id, expected_revision, &intent, reason)
        .await?
    {
        ThreadMutation::Updated(thread) => {
            println!("{}", serde_json::to_string_pretty(&thread)?);
            Ok(())
        }
        ThreadMutation::Conflict { current } => Err(format!(
            "Thread revision 冲突：期望 r{expected_revision}，当前 r{}",
            current.revision
        )
        .into()),
        ThreadMutation::NotFound => Err(format!("Thread '{thread_id}' 不存在").into()),
    }
}

async fn list_sessions(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let mut records = sdk
        .list_sessions(
            &principal.principal_id,
            switch_enabled(invocation, "include-archived")?,
        )
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
                morphz::local_time::format_utc_for_local(record.last_activity_at),
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
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let record = sdk.get_session(&principal.principal_id, id).await?;
    println!("{}", serde_json::to_string_pretty(&record)?);
    Ok(())
}

async fn create_session_command(
    runtime: &MorphzRuntime,
    invocation: &Invocation,
    _default_agent_id: &str,
    default_context_id: &str,
) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let session_id = option_value(invocation, "id")
        .map(str::to_string)
        .unwrap_or_else(|| generated_id("session"));
    validate_identifier("session_id", &session_id)?;
    let source = selected_context(runtime, invocation, default_context_id).await?;
    let (context_id, mount_kind) = if switch_enabled(invocation, "independent")? {
        let context_id = generated_id("context");
        sdk.create_context(NewCognitiveContext {
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
    let record = sdk
        .create_session(
            principal,
            NewSession {
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
            },
        )
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

fn list_harnesses(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let harnesses = sdk.list_harnesses();
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&harnesses)?);
    } else if harnesses.is_empty() {
        println!("尚未安装 Harness");
    } else {
        for harness in harnesses {
            let capabilities = if harness.capabilities.is_empty() {
                "-".to_string()
            } else {
                harness.capabilities.join(",")
            };
            println!(
                "{}@{}\t{}\t{}",
                harness.id, harness.version, harness.title, capabilities
            );
        }
    }
    Ok(())
}

fn show_harness(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let exact_value = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz harness show <ID@VERSION>")?;
    let exact = parse_exact_harness_ref(exact_value)?;
    let harness = sdk.get_harness(&exact.id, &exact.version)?;
    if json_output(invocation) {
        println!("{}", serde_json::to_string_pretty(&harness)?);
    } else {
        println!(
            "{}@{}\n{}\ncapabilities={}",
            harness.id,
            harness.version,
            harness.title,
            if harness.capabilities.is_empty() {
                "-".to_string()
            } else {
                harness.capabilities.join(",")
            }
        );
    }
    Ok(())
}

async fn install_harness(runtime: &MorphzRuntime, invocation: &Invocation) -> Result<(), AppError> {
    let sdk = MorphzSdk::new(runtime.clone());
    let path = invocation
        .prompt_args()
        .first()
        .ok_or("用法: morphz harness install <PACKAGE.hns>")?;
    let package = HarnessPackage::load(path)?;
    let artifact_hash = package.artifact_hash.clone();
    let descriptor = sdk.install_harness_package(package).await?;
    if json_output(invocation) {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "id": descriptor.id,
                "version": descriptor.version,
                "title": descriptor.title,
                "capabilities": descriptor.capabilities,
                "artifact_hash": artifact_hash,
            }))?
        );
    } else {
        println!(
            "已安装 Harness {}@{}\nartifact={}",
            descriptor.id, descriptor.version, artifact_hash
        );
    }
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
        return Err(
            "用法: morphz objective create [--session=ID] [--harness=ID@VERSION] GOAL...".into(),
        );
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
    let harness = option_value(invocation, "harness")
        .map(parse_exact_harness_ref)
        .transpose()?;
    let mut events = runtime.subscribe("*", 256);
    let source_event_id = generated_id("objective_request");
    let sdk = MorphzSdk::new(runtime.clone());
    let result = sdk
        .create_objective(
            &sdk.default_principal(),
            CreateObjectiveCommand {
                id: objective_id,
                coordinator_session_id: session.id.clone(),
                delivery_session_id: None,
                parent_objective_id: None,
                stated_objective,
                token_budget,
                source_event_id,
                source_origin: ObjectiveRequestOrigin::Cli,
                harness,
            },
        )
        .await?;
    let objective = result.objective;
    eprintln!(
        "[Objective 已启动] {}  session={}  revision={}{}",
        objective.id,
        objective.coordinator_session_id,
        objective.revision,
        result
            .harness_binding
            .as_ref()
            .map(|binding| format!(
                "  harness={}@{}",
                binding.harness_id, binding.harness_version
            ))
            .unwrap_or_default()
    );
    monitor_objective(runtime, &objective.id, &session.id, &mut events).await
}

fn parse_exact_harness_ref(value: &str) -> Result<ExactHarnessRef, AppError> {
    let (id, version) = value
        .rsplit_once('@')
        .filter(|(id, version)| !id.trim().is_empty() && !version.trim().is_empty())
        .ok_or("--harness 必须使用精确的 ID@VERSION 格式")?;
    validate_identifier("harness_id", id)?;
    if version.len() > 128
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '+'))
    {
        return Err(
            "harness_version 必须为 1..=128 个 ASCII 字母、数字、点、加号、横线、下划线或冒号"
                .into(),
        );
    }
    Ok(ExactHarnessRef {
        id: id.to_string(),
        version: version.to_string(),
    })
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
    const TERMINAL_DELIVERY_GRACE: std::time::Duration = std::time::Duration::from_secs(2);
    let mut poll = tokio::time::interval(std::time::Duration::from_millis(250));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut terminal_observed_at: Option<std::time::Instant> = None;

    loop {
        let mut terminal_delivery = false;
        tokio::select! {
            event = events.recv() => {
                let event = event.ok_or("Objective 事件通道已关闭")?;
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
                    ConsoleMessageKind::Coordination => print_session_coordination(&text),
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
                terminal_delivery = matches!(
                    kind,
                    ConsoleMessageKind::Final | ConsoleMessageKind::NoReply
                );
            }
            _ = poll.tick() => {}
        }

        let objective = runtime
            .get_objective(objective_id)
            .await?
            .ok_or_else(|| format!("Objective '{objective_id}' 在运行中丢失"))?;
        let stopped = objective.status.is_terminal()
            || matches!(
                objective.status,
                ObjectiveStatus::Paused | ObjectiveStatus::Blocked
            );
        if stopped {
            let observed_at = *terminal_observed_at.get_or_insert_with(std::time::Instant::now);
            // Prefer the semantic delivery boundary. If a terminal
            // objective_update cancelled every successor Activation before a
            // Final/NoReply could be emitted, the durable Objective remains
            // authoritative and ends the CLI after a short delivery grace.
            if terminal_delivery || observed_at.elapsed() >= TERMINAL_DELIVERY_GRACE {
                eprintln!(
                    "[Objective 结束监控] {}  status={}  revision={}",
                    objective.id,
                    objective.status.as_str(),
                    objective.revision
                );
                return Ok(());
            }
        } else {
            terminal_observed_at = None;
        }
    }
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
    println!("[ok] storage: {}", runtime.storage_label());
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
    harness: Option<ExactHarnessRef>,
) -> Result<(), AppError> {
    let session_id = session.id().to_string();
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let mut events = runtime.subscribe("*", 256);
    let receipt = sdk
        .send_message(
            &principal,
            SendMessageCommand {
                session_id: session_id.clone(),
                text: prompt,
                actor: "User".to_string(),
                client_message_id: Some(generated_id("cli")),
                attachments: Vec::new(),
                references: Vec::new(),
                harness,
                dispatch_mode: None,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            },
        )
        .await?;
    let root_turn_id = receipt.event_id;
    let mut observed_event_ids = std::collections::HashSet::new();
    let mut durable_sequence = 0_u64;
    let mut durable_check = tokio::time::interval(std::time::Duration::from_millis(500));
    durable_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    durable_check.tick().await;
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else {
                    return Err("Agent 回复通道已关闭".into());
                };
                if !observed_event_ids.insert(event.id.clone()) {
                    continue;
                }
                let Some((event_session, text, kind)) = console_message_from_event(&event) else {
                    continue;
                };
                if event_session != session_id {
                    continue;
                }
                if event
                    .payload
                    .get("root_turn_id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|root| root != root_turn_id)
                {
                    continue;
                }
                match kind {
                    ConsoleMessageKind::Final | ConsoleMessageKind::NoReply
                        if event
                            .payload
                            .get("root_turn_id")
                            .and_then(serde_json::Value::as_str)
                            != Some(root_turn_id.as_str()) =>
                    {
                        continue;
                    }
                    ConsoleMessageKind::Final => {
                        println!("{text}");
                        return Ok(());
                    }
                    ConsoleMessageKind::NoReply => return Ok(()),
                    ConsoleMessageKind::Message => print_agent_message(&text),
                    ConsoleMessageKind::Coordination => print_session_coordination(&text),
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
            _ = durable_check.tick() => {
                let terminal_events = runtime
                    .query_events(QueryFilter {
                        session_id: Some(session_id.clone()),
                        root_turn_id: Some(root_turn_id.clone()),
                        after_sequence: Some(durable_sequence),
                        top_k: Some(256),
                        ..Default::default()
                    })
                    .await?;
                for event in terminal_events {
                    if let Some(sequence) = event.sequence {
                        durable_sequence = durable_sequence.max(sequence);
                    }
                    if !observed_event_ids.insert(event.id.clone()) {
                        continue;
                    }
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
                        ConsoleMessageKind::Coordination => print_session_coordination(&text),
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
            }
        }
    }
}

async fn run_interactive(
    runtime: MorphzRuntime,
    session: SessionHandle,
    initial_prompt: Option<String>,
    initial_harness: Option<ExactHarnessRef>,
    reply_wait_notice_secs: u64,
) -> Result<(), AppError> {
    tracing::info!(
        event_code = "app.terminal.started",
        session_id = session.id(),
        "Morphz interactive terminal started"
    );
    tracing::info!(event_code = "app.tools.registered", tools = %runtime.tool_names().join(", "), "Tools registered");
    tracing::info!(
        event_code = "app.terminal.multiline_help",
        "Multiline input: /multi starts, /send submits, /cancel cancels, and exit quits"
    );

    let session_id = session.id().to_string();
    let session_id_clone = session_id.clone();

    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel::<ConsoleMessage>();
    let waiting_for_reply = Arc::new(std::sync::Mutex::new(false));
    let event_waiting_for_reply = Arc::clone(&waiting_for_reply);
    let event_session_id = session_id.clone();
    let history = session.events(None).await.unwrap_or_default();
    let durable_sequence = Arc::new(std::sync::atomic::AtomicU64::new(
        history
            .iter()
            .filter_map(|event| event.sequence)
            .max()
            .unwrap_or_default(),
    ));
    let recent_event_ids = Arc::new(std::sync::Mutex::new(RecentConsoleEventIds::default()));
    if let Ok(mut recent) = recent_event_ids.lock() {
        for event in history {
            recent.insert(event.id);
        }
    }
    let mut console_events = runtime.subscribe("*", 256);
    let local_recent_event_ids = Arc::clone(&recent_event_ids);
    let local_reply_tx = reply_tx.clone();
    tokio::spawn(async move {
        while let Some(event) = console_events.recv().await {
            let fresh = local_recent_event_ids
                .lock()
                .map(|mut recent| recent.insert(event.id.clone()))
                .unwrap_or(true);
            if fresh
                && !forward_console_event(
                    &event,
                    &event_session_id,
                    &event_waiting_for_reply,
                    &local_reply_tx,
                )
            {
                break;
            }
        }
    });

    let durable_runtime = runtime.clone();
    let durable_session_id = session_id.clone();
    let durable_waiting_for_reply = Arc::clone(&waiting_for_reply);
    let durable_recent_event_ids = Arc::clone(&recent_event_ids);
    let durable_reply_tx = reply_tx;
    let durable_sequence_for_task = Arc::clone(&durable_sequence);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let after_sequence =
                durable_sequence_for_task.load(std::sync::atomic::Ordering::Acquire);
            let events = match durable_runtime
                .query_events(QueryFilter {
                    session_id: Some(durable_session_id.clone()),
                    after_sequence: Some(after_sequence),
                    top_k: Some(256),
                    ..Default::default()
                })
                .await
            {
                Ok(events) => events,
                Err(error) => {
                    tracing::warn!(event_code = "app.terminal.durable_tail_failed", %error, "Interactive terminal durable Event tail failed; retaining its cursor for retry");
                    continue;
                }
            };
            for event in events {
                if let Some(sequence) = event.sequence {
                    durable_sequence_for_task
                        .fetch_max(sequence, std::sync::atomic::Ordering::AcqRel);
                }
                let fresh = durable_recent_event_ids
                    .lock()
                    .map(|mut recent| recent.insert(event.id.clone()))
                    .unwrap_or(true);
                if fresh
                    && !forward_console_event(
                        &event,
                        &durable_session_id,
                        &durable_waiting_for_reply,
                        &durable_reply_tx,
                    )
                {
                    return;
                }
            }
        }
    });

    // Listen to stdin synchronously on a blocking thread.
    let console_runtime = runtime.clone();
    let console_session = session;
    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        let mut msg_counter = 0;
        let mut initial_prompt = initial_prompt;
        let mut initial_harness = initial_harness;
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
            let sdk = MorphzSdk::new(console_runtime.clone());
            let principal = sdk.default_principal();
            if let Err(error) = rt.block_on(sdk.send_message(
                &principal,
                SendMessageCommand {
                    session_id: console_session.id().to_string(),
                    text,
                    actor: "User-Shafreeck".to_string(),
                    client_message_id: Some(client_message_id),
                    attachments: Vec::new(),
                    references: Vec::new(),
                    // `--harness` selects the first real Evaluation, whether
                    // its prompt came from argv or was typed interactively.
                    // Console-only commands above do not consume it.
                    harness: initial_harness.take(),
                    dispatch_mode: None,
                    model_alias: None,
                    reasoning_effort: None,
                    target_id: None,
                },
            )) {
                if let Ok(mut waiting) = waiting_for_reply.lock() {
                    *waiting = false;
                }
                let _ = writeln!(stdout, "发送消息失败: {error}");
                continue;
            }

            // Wait for the reply before continuing the loop. Progress notifications are not task
            // timeouts; the user may interrupt the entire process with Ctrl+C at any time.
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
        signal = shutdown_signal() => exit_after_shutdown_signal(signal),
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
    Coordination,
    Progress,
    ToolCall,
    Approval,
}

type ConsoleMessage = (String, String, ConsoleMessageKind);

#[derive(Default)]
struct RecentConsoleEventIds {
    ids: std::collections::HashSet<String>,
    order: std::collections::VecDeque<String>,
}

impl RecentConsoleEventIds {
    fn insert(&mut self, event_id: String) -> bool {
        const CAPACITY: usize = 16_384;
        if !self.ids.insert(event_id.clone()) {
            return false;
        }
        self.order.push_back(event_id);
        while self.order.len() > CAPACITY {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

fn forward_console_event(
    event: &morphz::event::Event,
    session_id: &str,
    waiting_for_reply: &std::sync::Mutex<bool>,
    reply_tx: &tokio::sync::mpsc::UnboundedSender<ConsoleMessage>,
) -> bool {
    let Some(message) = console_message_from_event(event) else {
        return true;
    };
    if message.0 != session_id {
        return true;
    }
    let waiting = waiting_for_reply
        .lock()
        .map(|waiting| *waiting)
        .unwrap_or(true);
    if waiting {
        reply_tx.send(message).is_ok()
    } else {
        print_idle_console_message(&message);
        true
    }
}

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
        "chat/session_signal" => Some((
            session_id,
            event
                .payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            ConsoleMessageKind::Coordination,
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
                ConsoleMessageKind::Coordination => print_session_coordination(&text),
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
                    ConsoleMessageKind::Coordination => print_session_coordination(&text),
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

fn print_session_coordination(text: &str) {
    if !text.trim().is_empty() {
        let mut stdout = std::io::stdout();
        let _ = writeln!(stdout, "\n[Session coordination] {}", text);
        let _ = stdout.flush();
    }
}

fn print_console_notification(message: &ConsoleMessage) {
    match message.2 {
        ConsoleMessageKind::Final | ConsoleMessageKind::Message => print_agent_message(&message.1),
        ConsoleMessageKind::Coordination => print_session_coordination(&message.1),
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

/// Waits for Ctrl+C or SIGTERM.
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
    dashboard_browser_url_at(bind, token, "/")
}

fn dashboard_setup_browser_url(bind: &str, token: &str) -> Result<String, AppError> {
    dashboard_browser_url_at(bind, token, "/providers/setup")
}

fn dashboard_browser_url_at(bind: &str, token: &str, path: &str) -> Result<String, AppError> {
    let address: std::net::SocketAddr = bind.parse()?;
    let host = match address.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => "127.0.0.1".to_string(),
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => "[::1]".to_string(),
        std::net::IpAddr::V6(ip) => format!("[{ip}]"),
    };
    Ok(format!(
        "http://{host}:{}{path}#token={token}",
        address.port()
    ))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownSignal {
    Interrupt,
    Terminate,
}

impl ShutdownSignal {
    fn as_str(self) -> &'static str {
        match self {
            Self::Interrupt => "SIGINT",
            Self::Terminate => "SIGTERM",
        }
    }
}

/// Do not make process shutdown depend on Tokio joining arbitrary blocking work.
/// Native credential APIs and terminal reads can wait indefinitely, and Tokio's
/// Runtime destructor otherwise waits forever for its blocking pool.
fn exit_after_shutdown_signal(signal: ShutdownSignal) -> ! {
    tracing::info!(
        event_code = "app.shutdown.signal_received",
        signal = signal.as_str(),
        "Shutdown signal received; terminating Morphz without waiting for blocking workers"
    );
    std::process::exit(0)
}

async fn shutdown_signal() -> ShutdownSignal {
    use tokio::signal;

    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
        ShutdownSignal::Interrupt
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
        ShutdownSignal::Terminate
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<ShutdownSignal>();

    tokio::select! {
        signal = ctrl_c => signal,
        signal = terminate => signal,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_cli_config, bootstrap_config_language, build_client, command_needs_llm,
        console_message_from_event, create_session_command, dashboard_browser_url,
        dashboard_setup_browser_url, ensure_cli_identity_records, format_tool_call_activity,
        generate_dashboard_token, parse_terminal_approval_input, read_console_input,
        resolve_resumed_session, select_or_create_console_session,
        should_run_first_time_setup_with_terminal, should_use_tui_with_terminal,
        validate_coding_eval_storage_isolation, wait_for_session_reply, ConsoleInput,
        ConsoleMessageKind, OfflineClient,
    };
    use morphz::approval::ApprovalDecision;
    use morphz::cli::morphz_command_line_parser;
    use morphz::config::{AppConfig, TuiTheme};
    use morphz::event::Event;
    use morphz::i18n::UiLanguage;
    use morphz::llm::{Client, ReasoningEffort};
    use morphz::memory::{NewAgent, NewCognitiveContext, NewSession, SessionMountKind};
    use morphz::permission::{ApprovalPolicy, PermissionMode, ReviewerKind, SandboxMode};
    use morphz::runtime::{MorphzRuntime, RuntimeIdentity};
    use std::io::Cursor;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn coding_eval_sqlite_requires_an_explicit_isolated_database() {
        assert!(validate_coding_eval_storage_isolation(
            true,
            morphz::config::StorageBackend::Sqlite,
            None,
        )
        .is_err());
        assert!(validate_coding_eval_storage_isolation(
            true,
            morphz::config::StorageBackend::Sqlite,
            Some("/tmp/terminal-bench-run/morphz.db"),
        )
        .is_ok());
        assert!(validate_coding_eval_storage_isolation(
            true,
            morphz::config::StorageBackend::Postgres,
            None,
        )
        .is_ok());
        assert!(validate_coding_eval_storage_isolation(
            false,
            morphz::config::StorageBackend::Sqlite,
            None,
        )
        .is_ok());
    }

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
        assert!(parser.parse(["--tui", "--plain"]).is_err());

        let setup = parser.parse(["setup"]).unwrap();
        assert!(!should_use_tui_with_terminal(&setup, true).unwrap());
        let setup_tui = parser.parse(["setup", "--tui"]).unwrap();
        assert!(should_use_tui_with_terminal(&setup_tui, false).unwrap());
        let setup_plain = parser.parse(["setup", "--plain"]).unwrap();
        assert!(should_use_tui_with_terminal(&setup_plain, true).is_err());
        assert!(parser.parse(["setup", "--tui", "--no-open"]).is_err());
        assert!(parser
            .parse(["setup", "--tui", "--bind=127.0.0.1:9090"])
            .is_err());
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

        config.llm.provider = None;
        config.llm.model = "configured-route".to_string();
        assert!(!should_run_first_time_setup_with_terminal(
            &bare, &config, true
        ));

        config.llm.model.clear();
        config.llm.models.push("configured-model".to_string());
        assert!(!should_run_first_time_setup_with_terminal(
            &bare, &config, true
        ));

        let provider_override = parser.parse(["--provider=custom"]).unwrap();
        config.llm.models.clear();
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

        let invalid = morphz_command_line_parser().parse(["--theme=ultraviolet"]);
        assert!(invalid.is_err());
    }

    #[test]
    fn cli_language_override_is_persisted_in_runtime_config() {
        let invocation = morphz_command_line_parser()
            .parse(["--language=zh-CN"])
            .unwrap();
        let mut config = AppConfig::default();
        apply_cli_config(&invocation, &mut config).unwrap();
        assert_eq!(config.ui.language, UiLanguage::SimplifiedChinese);
    }

    #[test]
    fn configured_language_is_available_before_clap_renders_help() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        std::fs::write(&path, "[ui]\nlanguage = 'zh-CN'\n").unwrap();
        let args = vec![
            std::ffi::OsString::from("--config-file"),
            path.into_os_string(),
            std::ffi::OsString::from("--help"),
        ];
        assert_eq!(
            bootstrap_config_language(&args),
            Some(UiLanguage::SimplifiedChinese)
        );
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

        let invalid = morphz_command_line_parser().parse(["--reasoning-effort=ultra"]);
        assert!(invalid.is_err());
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
        let error = morphz_command_line_parser()
            .parse(["serve", "--help"])
            .unwrap_err();
        let help = error.to_string();
        assert!(help.contains("Usage: morphz serve"));
        assert!(help.contains("--bind <ADDR>"));
        assert!(help.contains("MORPHZ_DASHBOARD_TOKEN"));
        assert!(help.contains("0.0.0.0:8080"));
        assert!(!help.contains("Manage Sessions"));
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
        assert_eq!(
            dashboard_setup_browser_url("0.0.0.0:8080", &first).unwrap(),
            format!("http://127.0.0.1:8080/providers/setup#token={first}")
        );

        let error = morphz_command_line_parser()
            .parse(["dashboard", "--help"])
            .unwrap_err();
        let help = error.to_string();
        assert!(help.contains("cryptographically random temporary authentication token"));
        assert!(help.contains("morphz dashboard --bind=0.0.0.0:8080"));

        let setup_help = morphz_command_line_parser()
            .parse(["setup", "--help"])
            .unwrap_err()
            .to_string();
        assert!(setup_help.contains("Start the embedded Dashboard directly"));
        assert!(setup_help.contains("morphz setup --tui"));
        assert!(setup_help.contains("--bind <ADDR>"));
        assert!(setup_help.contains("--no-open"));
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
        assert!(command_needs_llm(&parser.parse(["setup"]).unwrap()));
        assert!(!command_needs_llm(
            &parser.parse(["session", "list"]).unwrap()
        ));
        assert!(!command_needs_llm(
            &parser.parse(["agent", "create", "--id=a1"]).unwrap()
        ));
    }

    #[test]
    fn dashboard_setup_can_boot_without_a_complete_model_configuration() {
        let parser = morphz_command_line_parser();
        let setup = parser.parse(["setup"]).unwrap();
        let empty = AppConfig::default();
        assert!(build_client(&setup, &empty, true).is_ok());

        let mut partial = AppConfig::default();
        partial.provider_instances.insert(
            "unfinished-service".to_string(),
            morphz::config::ProviderInstanceConfig::default(),
        );
        assert!(build_client(&setup, &partial, true).is_ok());
    }

    #[test]
    fn coordination_mesh_cli_enables_the_experiment_and_defaults_local_identity() {
        let parser = morphz_command_line_parser();
        let invocation = parser
            .parse(["serve", "--coordination-mesh=file:/etc/morphz/mesh.toml"])
            .unwrap();
        let mut config = AppConfig::default();
        apply_cli_config(&invocation, &mut config).unwrap();
        assert!(config
            .experimental
            .enabled
            .contains(morphz::experimental::COGNITIVE_COORDINATION));
        assert_eq!(
            config.experimental.cognitive_coordination.mesh.as_deref(),
            Some("file:/etc/morphz/mesh.toml")
        );
        let participant = config
            .experimental
            .cognitive_coordination
            .participant
            .as_ref()
            .unwrap();
        assert_eq!(participant.agent_id, "default-agent");
        assert_eq!(participant.context_id, "context-default");
        assert!(participant.session_id.is_empty());
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
                    principal_id: "principal-test".to_string(),
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
                principal_id: "principal-test".to_string(),
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
