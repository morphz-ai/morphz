use chrono::Utc;
use morphz::approval::ApprovalDecision;
use morphz::cli::{morphz_command_line_parser, Invocation};
use morphz::config;
use morphz::llm::{Client, Message, OpenAIClient, Response, ToolDefinition};
use morphz::memory::{
    NewAgent, NewCognitiveContext, NewSession, SessionMountKind, SessionRecord, SessionStatus,
};
use morphz::permission::{ApprovalPolicy, PermissionMode, ReviewerKind, SandboxMode};
use morphz::runtime::{MorphzRuntime, RuntimeIdentity, SessionHandle};
use morphz::web::{Server, ServerDefaults};
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
  morphz <context|session|agent|job|config> <COMMAND> [ARGS...]

SESSION SEMANTICS:
  A bare invocation creates a new Session mounted in the selected shared Context.
  --session=ID and `session resume` reattach the same Session identity.

CORE COMMANDS:
  exec PROMPT...                 Run one prompt and print the final reply
  serve                          Start the HTTP/WebSocket server
  context list|show|status       Inspect Cognitive Contexts
  session list|show|create       Manage Sessions
  session resume ID [PROMPT...]  Reattach an existing Session
  session resume --last          Reattach the most recently active Session
  agent list|show|create         Manage Agents
  job list|cancel                Inspect or cancel Sub Agent jobs
  config show|check|path         Inspect configuration
  doctor                         Check the local Runtime setup

GLOBAL OPTIONS:
  -C, --cwd=DIR                  Change working directory before loading config
      --config-file=FILE         Select morphz.toml
  -m, --model=MODEL              Override the configured model
      --agent=ID                 Select an Agent
      --context=ID               Select or mount a Cognitive Context
      --session=ID               Reattach an existing Session
  -s, --sandbox=MODE             workspace-write | full-access
  -a, --approval=MODE            human | auto | never
      --add-dir=DIR              Add a readable and writable directory
      --network[=BOOL]           Allow sandboxed command network access
      --bind=ADDR                Override server bind address
      --format=human|json        Management-command output format
      --log-level=LEVEL          Override the tracing filter
  -h, --help                     Print help
  -V, --version                  Print version

Use `--` to force every remaining argv token to be prompt text.
Options that take values support --name=value; this form also removes command/value ambiguity.
"#;

fn init_logging(log_level: Option<&str>) -> Result<(), AppError> {
    let filter = match log_level {
        Some(level) => EnvFilter::try_new(level)?,
        None => EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,morphz=debug")),
    };

    fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_timer(fmt::time::UtcTime::rfc_3339())
        .try_init()?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), AppError> {
    let invocation = morphz_command_line_parser().parse(std::env::args().skip(1))?;
    if let Some(cwd) = option_value(&invocation, "cwd") {
        std::env::set_current_dir(cwd)
            .map_err(|error| format!("无法切换工作目录到 '{cwd}': {error}"))?;
    }
    init_logging(option_value(&invocation, "log-level"))?;

    if invocation.has_option("help") || invocation.command_path() == ["help"] {
        print!("{HELP}");
        return Ok(());
    }
    if invocation.has_option("version") || invocation.command_path() == ["version"] {
        println!("morphz {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    reject_unimplemented_options(&invocation)?;
    let config_path = selected_config_path(&invocation);
    if dispatch_config_command(&invocation, &config_path)? {
        return Ok(());
    }

    if let Err(error) = config::load_env(".env") {
        tracing::debug!(%error, "未加载 .env，继续使用进程环境变量");
    }
    let mut app_config = config::AppConfig::load_or_default(&config_path.to_string_lossy());
    app_config.apply_runtime_env_overrides()?;
    apply_cli_config(&invocation, &mut app_config)?;
    protect_runtime_files(&mut app_config, &config_path);

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
        // subscribers or model evaluation. Initializing only the root records
        // keeps the lack of an API key harmless and avoids background workers.
        runtime
            .ensure_agent(NewAgent {
                id: default_agent_id.clone(),
                title: "默认 Agent".to_string(),
                root_context_id: default_context_id.clone(),
            })
            .await?;
        runtime
            .ensure_context(NewCognitiveContext {
                id: default_context_id.clone(),
                agent_id: default_agent_id.clone(),
                title: "默认认知 Context".to_string(),
            })
            .await?;
    }

    dispatch_runtime_command(
        invocation,
        runtime,
        app_config,
        default_agent_id,
        default_context_id,
    )
    .await
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

fn selected_config_path(invocation: &Invocation) -> PathBuf {
    option_value(invocation, "config-file")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("MORPHZ_CONFIG_PATH").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("morphz.toml"))
}

fn reject_unimplemented_options(invocation: &Invocation) -> Result<(), AppError> {
    for (name, explanation) in [
        ("profile", "Profile 配置叠加尚未接入，不能静默忽略"),
        ("set", "单项配置覆盖尚未接入，不能静默忽略"),
        ("output", "输出文件写入尚未接入，请使用 Shell 重定向"),
        ("schema", "结构化输出 Schema 尚未接入"),
    ] {
        if invocation.has_option(name) {
            return Err(format!("--{name} 当前不可用：{explanation}").into());
        }
    }
    if let Some(provider) = option_value(invocation, "provider") {
        if !matches!(provider, "openai" | "openai-compatible") {
            return Err(format!(
                "当前只实现 openai-compatible 协议 Client，不能使用 Provider '{provider}'"
            )
            .into());
        }
    }
    Ok(())
}

fn dispatch_config_command(invocation: &Invocation, path: &Path) -> Result<bool, AppError> {
    let command = invocation.command_path().join(" ");
    if !matches!(
        command.as_str(),
        "config" | "config show" | "config check" | "config path"
    ) {
        return Ok(false);
    }
    if command == "config path" {
        println!("{}", absolute_path(path).display());
        return Ok(true);
    }
    let config = match std::fs::read_to_string(path) {
        Ok(content) => toml::from_str::<config::AppConfig>(&content)
            .map_err(|error| format!("配置 '{}' 解析失败: {error}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => config::AppConfig::default(),
        Err(error) => return Err(format!("无法读取配置 '{}': {error}", path.display()).into()),
    };
    if command == "config check" {
        println!("配置有效：{}", absolute_path(path).display());
    } else {
        println!("{config:#?}");
    }
    Ok(true)
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
    if let Some(bind) = option_value(invocation, "bind") {
        app_config.server.bind = bind.to_string();
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

fn protect_runtime_files(app_config: &mut config::AppConfig, config_path: &Path) {
    for path in [
        Some(absolute_path(config_path)),
        std::env::current_exe().ok(),
    ]
    .into_iter()
    .flatten()
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
        "" | "exec" | "serve" | "session resume"
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
    let api_key = std::env::var("OPENAI_API_KEY").ok();
    let api_key = api_key
        .ok_or("当前命令需要 LLM，但未检测到 OPENAI_API_KEY（可在环境变量或 .env 中配置）")?;
    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
    let model = option_value(invocation, "model")
        .map(str::to_string)
        .or_else(|| std::env::var("OPENAI_MODEL").ok())
        .unwrap_or_else(|| app_config.llm.model.clone());
    tracing::info!(%model, protocol = "openai-compatible", "当前使用模型");
    Ok(Arc::new(OpenAIClient::new_with_config(
        api_key,
        base_url,
        model,
        &app_config.llm,
    )?))
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
            run_interactive(
                runtime,
                session,
                prompt,
                app_config.orchestrator.reply_wait_notice_secs,
            )
            .await
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
        "session resume" => {
            let (session, prompt) = resolve_resumed_session(&runtime, &invocation).await?;
            run_interactive(
                runtime,
                session,
                nonempty_prompt(prompt),
                app_config.orchestrator.reply_wait_notice_secs,
            )
            .await
        }
        "context" | "context list" => list_contexts(&runtime, &invocation).await,
        "context show" => show_context(&runtime, &invocation, &default_context_id, false).await,
        "context status" => show_context(&runtime, &invocation, &default_context_id, true).await,
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
        "job" | "job list" => list_jobs(&runtime, &invocation).await,
        "job cancel" => cancel_job(&runtime, &invocation).await,
        "doctor" => doctor(&runtime, &app_config),
        "completion" => Err("Shell completion 生成器尚未实现".into()),
        command => Err(format!("命令尚未实现: {command}").into()),
    }
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
    let session_id = if switch_enabled(invocation, "last")? {
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
        return Err("用法: morphz session resume <ID> [PROMPT...] 或 --last".into());
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
        println!(
            "{}  [{}]  mind_version={}  active_sessions={}  agent={}  {}",
            record.id,
            record.status.as_str(),
            version,
            sessions.len(),
            record.agent_id,
            record.title
        );
    } else {
        println!("{}", serde_json::to_string_pretty(&record)?);
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
                "{}  [{}]  context={}  last={}  {}",
                record.id,
                record.status.as_str(),
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
    println!(
        "[{}] OPENAI_API_KEY",
        if std::env::var_os("OPENAI_API_KEY").is_some() {
            "ok"
        } else {
            "optional-missing"
        }
    );
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
            ConsoleMessageKind::Suppressed => return Ok(()),
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

    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::channel::<ConsoleMessage>(100);
    let mut console_events = runtime.subscribe("*", 256);
    tokio::spawn(async move {
        while let Some(event) = console_events.recv().await {
            if let Some(message) = console_message_from_event(&event) {
                if reply_tx.send(message).await.is_err() {
                    break;
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

            // 清理已经结束的上一轮残留通知；正常等待不会因时间流逝而提前结束。
            while reply_rx.try_recv().is_ok() {}

            let client_message_id = format!(
                "cli_{}_{}",
                Utc::now().timestamp_nanos_opt().unwrap_or(0),
                msg_counter
            );
            if let Err(error) =
                rt.block_on(console_session.send(text, "User-Shafreeck", Some(client_message_id)))
            {
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
                    Some(ConsoleWaitOutcome::Suppressed) => break,
                    Some(ConsoleWaitOutcome::Approval(payload)) => {
                        if let Err(error) = prompt_for_human_approval(
                            &payload,
                            &console_runtime,
                            &mut stdin,
                            &mut stdout,
                        ) {
                            let _ = writeln!(stdout, "[审批失败] {error}");
                        }
                    }
                    None => {
                        let _ = writeln!(stdout, "Agent 回复通道已关闭。");
                        break;
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
    Suppressed,
    Progress,
    ToolCall,
    Approval,
}

type ConsoleMessage = (String, String, ConsoleMessageKind);

#[derive(Debug, PartialEq, Eq)]
enum ConsoleWaitOutcome {
    Final(String),
    Suppressed,
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
        "chat/reply_suppressed" => {
            let active_background_tasks = event
                .payload
                .get("active_background_tasks")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            if active_background_tasks > 0 {
                Some((
                    session_id,
                    format!(
                        "Agent 已进入事件驱动等待；当前还有 {active_background_tasks} 个后台任务运行。"
                    ),
                    ConsoleMessageKind::Progress,
                ))
            } else {
                Some((session_id, String::new(), ConsoleMessageKind::Suppressed))
            }
        }
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
    reply_rx: &mut tokio::sync::mpsc::Receiver<ConsoleMessage>,
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
                ConsoleMessageKind::Suppressed => return Some(ConsoleWaitOutcome::Suppressed),
                ConsoleMessageKind::Approval => return Some(ConsoleWaitOutcome::Approval(text)),
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
                    ConsoleMessageKind::Suppressed => return Some(ConsoleWaitOutcome::Suppressed),
                    ConsoleMessageKind::Approval => return Some(ConsoleWaitOutcome::Approval(text)),
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
    reply_rx: &mut tokio::sync::mpsc::Receiver<ConsoleMessage>,
    session_id: &str,
    notice_interval: Option<std::time::Duration>,
) -> Option<String> {
    loop {
        match wait_for_session_activity(reply_rx, session_id, notice_interval).await? {
            ConsoleWaitOutcome::Final(text) => return Some(text),
            ConsoleWaitOutcome::Suppressed => return Some(String::new()),
            ConsoleWaitOutcome::Approval(_) => continue,
        }
    }
}

fn prompt_for_human_approval<R: BufRead, W: Write>(
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
        return runtime.decide_approval(approval_id, decision);
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
        format_tool_call_activity, parse_terminal_approval_input, read_console_input,
        select_or_create_console_session, wait_for_session_reply, ConsoleInput, ConsoleMessageKind,
        OfflineClient,
    };
    use morphz::approval::ApprovalDecision;
    use morphz::cli::morphz_command_line_parser;
    use morphz::config::AppConfig;
    use morphz::event::Event;
    use morphz::llm::Client;
    use morphz::permission::{ApprovalPolicy, PermissionMode, ReviewerKind, SandboxMode};
    use morphz::runtime::{MorphzRuntime, RuntimeIdentity};
    use std::io::Cursor;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn single_line_input_remains_backward_compatible() {
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
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(35)).await;
            tx.send((
                "session-a".to_string(),
                "late reply".to_string(),
                ConsoleMessageKind::Final,
            ))
            .await
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
    async fn suppressed_reply_ends_cli_wait_only_after_background_tasks_finish() {
        let event = |active_background_tasks| {
            Event::new(
                format!("suppressed-{active_background_tasks}"),
                "Agent-Morphz".to_string(),
                "agent_call".to_string(),
                "chat/reply_suppressed".to_string(),
                serde_json::Map::from_iter([
                    ("session_id".to_string(), serde_json::json!("session-a")),
                    (
                        "active_background_tasks".to_string(),
                        serde_json::json!(active_background_tasks),
                    ),
                ]),
            )
        };

        let (_, progress, kind) = console_message_from_event(&event(1)).unwrap();
        assert_eq!(kind, ConsoleMessageKind::Progress);
        assert!(progress.contains("1 个后台任务"));

        let terminal = console_message_from_event(&event(0)).unwrap();
        assert_eq!(terminal.2, ConsoleMessageKind::Suppressed);
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tx.send(terminal).await.unwrap();
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
    fn only_evaluation_commands_require_an_llm_client() {
        let parser = morphz_command_line_parser();
        assert!(command_needs_llm(&parser.parse(["hello"]).unwrap()));
        assert!(command_needs_llm(
            &parser.parse(["session", "resume", "s1"]).unwrap()
        ));
        assert!(!command_needs_llm(
            &parser.parse(["session", "list"]).unwrap()
        ));
        assert!(!command_needs_llm(
            &parser.parse(["agent", "create", "--id=a1"]).unwrap()
        ));
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
