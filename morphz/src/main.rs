use chrono::Utc;
use morphz::approval::{
    AiAutoReviewProvider, ApprovalDecision, ApprovalProvider, DenyAllApprovalProvider,
    EscalatingApprovalProvider, HumanApprovalHub, HumanApprovalProvider,
};
use morphz::config;
use morphz::context_tools::{ContextTxTool, RecallTool};
use morphz::event::{Event, InMemoryEventBus};
use morphz::llm::OpenAIClient;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{NewAgent, NewCognitiveContext, NewSession, SessionMountKind, SessionStore};
use morphz::orchestrator::context::ContextEngine;
use morphz::orchestrator::orchestrator::Orchestrator;
use morphz::permission::{PermissionBroker, PermissionProfile, ReviewerKind, SandboxMode};
use morphz::tool::{
    DelegateTool, EditFileTool, ExecuteCommandTool, KillTaskTool, ListFilesTool, ListSkillsTool,
    ReadFileTool, Registry, SearchTool, WriteFileTool,
};
use morphz::web::{Server, ServerDefaults};
use std::io::{BufRead, Write};
use std::sync::Arc;
use tracing_subscriber::{fmt, EnvFilter};

fn init_logging() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,morphz=debug"));

    fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_timer(fmt::time::UtcTime::rfc_3339())
        .init();
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // 初始化结构化日志
    init_logging();

    // 0. 加载 TOML 配置文件（不存在时使用默认值）
    let config_path =
        std::env::var("MORPHZ_CONFIG_PATH").unwrap_or_else(|_| "morphz.toml".to_string());
    let mut app_config = config::AppConfig::load_or_default(&config_path);
    app_config.apply_runtime_env_overrides()?;
    tracing::info!(?app_config, "已加载应用配置");

    // 1.0. 冷启动直接在当前内存中加载 BERT 语义模型
    let model_store = match executor::load_model() {
        Ok(store) => {
            tracing::info!(target: "bge_model", "本地内存加载成功，就绪状态");
            Some(Arc::new(store))
        }
        Err(e) => {
            tracing::error!(target: "bge_model", error = %e, "本地内存加载失败");
            tracing::warn!(target: "bge_model", "请确保本地模型文件齐全：路径 models/bge-small-zh-1.5/。将使用降级 Hashing Embedding 兜底。");
            None
        }
    };

    // 1. 加载根目录下的 .env 环境变量
    if let Err(e) = config::load_env(".env") {
        tracing::warn!(error = %e, "加载 .env 文件失败或不存在，使用系统环境变量");
    }

    // 2. 从环境变量获取接口配置并实例化大模型客户端
    let api_key = match std::env::var("OPENAI_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            tracing::error!("未检测到 OPENAI_API_KEY 环境变量");
            tracing::info!("请在终端运行：export OPENAI_API_KEY=\"your_key_here\"");
            return Ok(());
        }
    };

    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
    // 模型名称：环境变量优先，否则使用配置文件中的值
    let model_name = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| app_config.llm.model.clone());

    tracing::info!(model = %model_name, "当前使用模型");
    let client = Arc::new(OpenAIClient::new_with_config(
        api_key,
        base_url,
        model_name,
        model_store,
        &app_config.llm,
    )?);

    // 3. 初始化事件总线与事件存储（数据库路径来自配置）
    let bus = Arc::new(InMemoryEventBus::new());
    let database_path =
        std::env::var("MORPHZ_DB_PATH").unwrap_or_else(|_| app_config.server.database_path.clone());
    let store = Arc::new(SqliteStore::new_with_config(&database_path, &app_config.memory).await?);
    let auto_review = Arc::new(AiAutoReviewProvider::new(
        Arc::clone(&client) as Arc<dyn morphz::llm::Client>,
        Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
    ));
    let human_approval_hub = HumanApprovalHub::default();
    let human_review: Arc<dyn ApprovalProvider> = Arc::new(HumanApprovalProvider::new(
        human_approval_hub.clone(),
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
    ));

    // 4. 初始化工具注册表并注册本地文件工具
    let registry = Arc::new(Registry::new());
    let context_engine = Arc::new(
        ContextEngine::new(
            Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
            app_config.orchestrator.clone(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn morphz::memory::SessionStore>),
    );
    let permission_profile = Arc::new(PermissionProfile::from_config(&app_config.permissions)?);
    if permission_profile.sandbox_mode == SandboxMode::DangerFullAccess {
        tracing::warn!("完全访问权限已启用：文件工具与 Shell 均不受工作区或操作系统沙箱限制");
    }
    let approval_provider: Arc<dyn ApprovalProvider> = match permission_profile.reviewer {
        ReviewerKind::AutoReview => Arc::new(EscalatingApprovalProvider::new(
            auto_review,
            Arc::clone(&human_review),
        )),
        ReviewerKind::User => Arc::clone(&human_review),
        ReviewerKind::Deny => Arc::new(DenyAllApprovalProvider::new(
            "当前权限 Profile 禁止边界外能力申请",
        )),
    };
    let permissions = Arc::new(PermissionBroker::new(permission_profile, approval_provider));
    let background_config = Arc::new(app_config.background_task.clone());
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&context_engine))));
    let context_eval_mode = env_flag_enabled("MORPHZ_CONTEXT_EVAL_MODE");
    if !context_eval_mode {
        registry.register(Arc::new(WriteFileTool::new_with_runtime(
            Arc::clone(&permissions),
            Arc::clone(&bus),
        )));
        registry.register(Arc::new(ReadFileTool::new_with_permissions(Arc::clone(
            &permissions,
        ))));
        registry.register(Arc::new(EditFileTool::new_with_runtime(
            Arc::clone(&permissions),
            Arc::clone(&bus),
        )));
        registry.register(Arc::new(ListFilesTool::new_with_permissions(Arc::clone(
            &permissions,
        ))));
        registry.register(Arc::new(SearchTool::new_with_permissions(Arc::clone(
            &permissions,
        ))));
        registry.register(Arc::new(RecallTool::new(Arc::clone(&context_engine))));
        registry.register(Arc::new(ExecuteCommandTool::new_with_permissions(
            Arc::clone(&bus),
            Arc::clone(&background_config),
            Arc::clone(&permissions),
            app_config.orchestrator.tool_timeout_secs,
        )));
        registry.register(Arc::new(KillTaskTool));
        if !env_flag_enabled("MORPHZ_CODING_EVAL_MODE") {
            registry.register(Arc::new(DelegateTool::new(Arc::clone(&bus))));
            registry.register(Arc::new(ListSkillsTool));
        }
    }

    // 5. 初始化并启动 Orchestrator
    let orc = Arc::new(Orchestrator::new_with_context_engine(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
        Arc::clone(&client) as Arc<dyn morphz::llm::Client>,
        Arc::clone(&registry),
        app_config.orchestrator.clone(),
        Arc::clone(&context_engine),
    ));

    orc.clone().start().await?;

    let default_agent_id =
        std::env::var("MORPHZ_AGENT_ID").unwrap_or_else(|_| "default-agent".to_string());
    let default_context_id =
        std::env::var("MORPHZ_CONTEXT_ID").unwrap_or_else(|_| "context-default".to_string());
    // 旧数据库迁移时可能已经为 default-agent 选择了一个历史 Context
    // 作为 Root。Root 是身份血缘，启动参数不应静默改写它；仅在 Agent
    // 尚不存在时把当前默认 Context 设为 Root。
    if store.get_agent(&default_agent_id).await?.is_none() {
        store
            .ensure_agent(NewAgent {
                id: default_agent_id.clone(),
                title: "默认 Agent".to_string(),
                root_context_id: default_context_id.clone(),
            })
            .await?;
    }
    store
        .ensure_context(NewCognitiveContext {
            id: default_context_id.clone(),
            agent_id: default_agent_id.clone(),
            title: "默认认知 Context".to_string(),
        })
        .await?;

    // 5.5 启动大盘 API & WebSocket 服务器
    let web_srv = Arc::new(
        Server::new_with_capacity(
            Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
            Some(Arc::clone(&store) as Arc<dyn morphz::memory::GraphStore>),
            Arc::clone(&store) as Arc<dyn morphz::memory::SessionStore>,
            Arc::clone(&bus),
            Arc::clone(&orc),
            ServerDefaults {
                agent_id: default_agent_id.clone(),
                context_id: default_context_id.clone(),
            },
            app_config.server.broadcast_capacity,
        )
        .with_approval_hub(human_approval_hub.clone()),
    );

    let server_bind =
        std::env::var("MORPHZ_BIND").unwrap_or_else(|_| app_config.server.bind.clone());
    web_srv.start(&server_bind).await?;

    let tool_names: Vec<String> = registry
        .definitions()
        .iter()
        .map(|def| def.name.clone())
        .collect();
    tracing::info!("Morphz Attempt Loop 运行成功");
    tracing::info!(tools = %tool_names.join(", "), "已注册工具");
    tracing::info!("您可以通过指令命令它做事情，例如：");
    tracing::info!(">> 帮我写一个 notes.txt 文件，内容为 Morphz Loop OK");
    tracing::info!("您也可以输入 ctx 随时查看大脑心智状态。");
    tracing::info!("多行输入：先输入 /multi，正文结束后单独输入 /send；使用 /cancel 取消。");

    let session_id = std::env::var("MORPHZ_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("session_{}", Utc::now().timestamp()));
    store
        .ensure_session(NewSession {
            id: session_id.clone(),
            agent_id: default_agent_id,
            context_id: default_context_id.clone(),
            parent_session_id: None,
            title: "本地终端".to_string(),
            mount_kind: SessionMountKind::ExistingContext,
        })
        .await?;

    let bus_clone = Arc::clone(&bus);
    let session_id_clone = session_id.clone();
    let orc_clone = Arc::clone(&orc);
    let reply_wait_notice_secs = app_config.orchestrator.reply_wait_notice_secs;

    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::channel::<ConsoleMessage>(100);
    let reply_tx_clone = reply_tx.clone();

    bus.subscribe(
        "chat/reply".to_string(),
        Arc::new(move |ev| {
            let tx = reply_tx_clone.clone();
            Box::pin(async move {
                if let Some(sess_id) = ev.payload.get("session_id").and_then(|s| s.as_str()) {
                    let text = ev
                        .payload
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let _ = tx
                        .send((sess_id.to_string(), text, ConsoleMessageKind::Final))
                        .await;
                }
                Ok(())
            })
        }),
    );
    let progress_tx = reply_tx.clone();
    bus.subscribe(
        "chat/progress".to_string(),
        Arc::new(move |ev| {
            let tx = progress_tx.clone();
            Box::pin(async move {
                if let Some(sess_id) = ev.payload.get("session_id").and_then(|s| s.as_str()) {
                    let text = ev
                        .payload
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let _ = tx
                        .send((sess_id.to_string(), text, ConsoleMessageKind::Progress))
                        .await;
                }
                Ok(())
            })
        }),
    );
    let tool_call_tx = reply_tx.clone();
    bus.subscribe(
        "runtime/tool_calls_selected".to_string(),
        Arc::new(move |ev| {
            let tx = tool_call_tx.clone();
            Box::pin(async move {
                let Some(sess_id) = ev.payload.get("session_id").and_then(|s| s.as_str()) else {
                    return Ok(());
                };
                if let Some(text) = format_tool_call_activity(&ev.payload) {
                    let _ = tx
                        .send((sess_id.to_string(), text, ConsoleMessageKind::ToolCall))
                        .await;
                }
                Ok(())
            })
        }),
    );
    let approval_tx = reply_tx.clone();
    bus.subscribe(
        "runtime/approval_requested".to_string(),
        Arc::new(move |ev| {
            let tx = approval_tx.clone();
            Box::pin(async move {
                let Some(sess_id) = ev.payload.get("session_id").and_then(|s| s.as_str()) else {
                    return Ok(());
                };
                let Some(approval_id) = ev.payload.get("approval_id").and_then(|s| s.as_str())
                else {
                    return Ok(());
                };
                let text = ev
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or("权限请求需要用户决定");
                let payload = serde_json::json!({
                    "approval_id": approval_id,
                    "text": text,
                })
                .to_string();
                let _ = tx
                    .send((sess_id.to_string(), payload, ConsoleMessageKind::Approval))
                    .await;
                Ok(())
            })
        }),
    );

    // 在阻塞线程中同步监听 stdin
    let console_approval_hub = human_approval_hub.clone();
    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        let mut msg_counter = 0;
        let stdin = std::io::stdin();
        let mut stdin = stdin.lock();
        // Do not keep a StdoutLock alive while waiting for the Agent. Tracing and
        // tool execution may also write to the process output; retaining the lock
        // across `rt.block_on` can deadlock the attempt that is supposed to
        // produce the reply we are waiting for. `Stdout` locks only per write.
        let mut stdout = std::io::stdout();
        loop {
            let _ = write!(stdout, "> ");
            let _ = stdout.flush();
            let console_input = match read_console_input(&mut stdin, &mut stdout) {
                Ok(input) => input,
                Err(e) => {
                    let _ = writeln!(stdout, "\n[stdin 错误] {}，退出 Morphz。", e);
                    std::process::exit(1);
                }
            };

            let (text, commands_allowed) = match console_input {
                ConsoleInput::Eof => {
                    let _ = writeln!(stdout, "\n[EOF] 退出 Morphz。");
                    std::process::exit(0);
                }
                ConsoleInput::Empty | ConsoleInput::Cancelled => continue,
                ConsoleInput::SingleLine(text) => (text, true),
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

                let orc_inner = Arc::clone(&orc_clone);
                let sess_id_label = sess_id.clone();
                let context_result =
                    rt.block_on(async move { orc_inner.get_current_context(&sess_id).await });
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

            msg_counter += 1;

            // 清理已经结束的上一轮残留通知；正常等待不会因时间流逝而提前结束。
            while reply_rx.try_recv().is_ok() {}

            let mut payload = serde_json::Map::new();
            payload.insert(
                "context_id".to_string(),
                serde_json::json!(&default_context_id),
            );
            payload.insert(
                "session_id".to_string(),
                serde_json::json!(session_id_clone),
            );
            payload.insert("text".to_string(), serde_json::json!(&text));

            let ev = Event::new(
                format!(
                    "msg_{}_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0),
                    msg_counter
                ),
                "User-Shafreeck".to_string(),
                morphz::event::TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                payload,
            );

            let bus_inner = Arc::clone(&bus_clone);
            tokio::spawn(async move {
                let _ = bus_inner.publish(ev).await;
            });

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
                    Some(ConsoleWaitOutcome::Approval(payload)) => {
                        if let Err(error) = prompt_for_human_approval(
                            &payload,
                            &console_approval_hub,
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

    // 保持异步主线程活着，监听 Ctrl+C / SIGTERM 优雅关闭
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
    Progress,
    ToolCall,
    Approval,
}

type ConsoleMessage = (String, String, ConsoleMessageKind);

#[derive(Debug, PartialEq, Eq)]
enum ConsoleWaitOutcome {
    Final(String),
    Approval(String),
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
                    ConsoleMessageKind::Approval => return Some(ConsoleWaitOutcome::Approval(text)),
                    ConsoleMessageKind::Progress => print_agent_progress(&text),
                    ConsoleMessageKind::ToolCall => print_tool_call_activity(&text),
                }
            }
            _ = notice.tick() => {
                let mut stdout = std::io::stdout();
                let _ = writeln!(
                    stdout,
                    "\n[Agent 仍在运行] 已等待约 {} 秒；将继续等待，可按 Ctrl+C 中断。",
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
            ConsoleWaitOutcome::Approval(_) => continue,
        }
    }
}

fn prompt_for_human_approval<R: BufRead, W: Write>(
    payload: &str,
    hub: &HumanApprovalHub,
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
        write!(output, "允许本次操作？[y/N] ")
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
        let decision = match line.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" | "allow" | "approve" => ApprovalDecision::AllowOnce {
                rationale: "用户通过本地终端允许本次操作".to_string(),
                risk_tags: vec!["human-approved".to_string()],
            },
            "" | "n" | "no" | "deny" | "reject" => ApprovalDecision::Deny {
                rationale: "用户通过本地终端拒绝本次操作".to_string(),
                risk_tags: vec!["human-denied".to_string()],
            },
            _ => {
                writeln!(output, "请输入 y/yes 或 n/no。")
                    .map_err(|error| format!("无法显示审批提示: {error}"))?;
                continue;
            }
        };
        return hub.decide(approval_id, decision);
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

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name).ok().is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{
        format_tool_call_activity, read_console_input, wait_for_session_reply, ConsoleInput,
        ConsoleMessageKind,
    };
    use std::io::Cursor;
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
}
