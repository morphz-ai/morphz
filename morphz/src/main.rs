use chrono::Utc;
use morphz::config;
use morphz::context_tools::{ContextTxTool, RecallTool};
use morphz::event::{Event, InMemoryEventBus};
use morphz::llm::OpenAIClient;
use morphz::memory::sqlite::SqliteStore;
use morphz::memory::{NewAgent, NewCognitiveContext, NewSession, SessionMountKind, SessionStore};
use morphz::orchestrator::context::ContextEngine;
use morphz::orchestrator::orchestrator::Orchestrator;
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

    // 4. 初始化工具注册表并注册本地文件工具
    let registry = Arc::new(Registry::new());
    let context_engine = Arc::new(
        ContextEngine::new(
            Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
            app_config.orchestrator.clone(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn morphz::memory::SessionStore>),
    );
    let tool_security = Arc::new(app_config.tool_security.clone());
    let background_config = Arc::new(app_config.background_task.clone());
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&context_engine))));
    let context_eval_mode = env_flag_enabled("MORPHZ_CONTEXT_EVAL_MODE");
    if !context_eval_mode {
        registry.register(Arc::new(WriteFileTool::new_with_bus(
            Arc::clone(&tool_security),
            Arc::clone(&bus),
        )));
        registry.register(Arc::new(ReadFileTool::new(Arc::clone(&tool_security))));
        registry.register(Arc::new(EditFileTool::new_with_bus(
            Arc::clone(&tool_security),
            Arc::clone(&bus),
        )));
        registry.register(Arc::new(ListFilesTool::new(Arc::clone(&tool_security))));
        registry.register(Arc::new(SearchTool::new(Arc::clone(&tool_security))));
        registry.register(Arc::new(RecallTool::new(Arc::clone(&context_engine))));
        registry.register(Arc::new(ExecuteCommandTool::new_with_configs(
            Arc::clone(&bus),
            Arc::clone(&background_config),
            Arc::clone(&tool_security),
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
    let web_srv = Arc::new(Server::new_with_capacity(
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
    ));

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
    let reply_timeout_secs = app_config.orchestrator.reply_timeout_secs;

    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::channel::<(String, String, bool)>(100);
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
                    let _ = tx.send((sess_id.to_string(), text, true)).await;
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
                    let _ = tx.send((sess_id.to_string(), text, false)).await;
                }
                Ok(())
            })
        }),
    );

    // 在阻塞线程中同步监听 stdin
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

            // 丢弃上一轮超时后才到达的迟到回复，避免它误解锁下一条输入。
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

            // 等待回复完成再继续下一次循环，超时值由集中配置控制。
            let sess_id_to_wait = session_id_clone.clone();
            let wait_result = rt.block_on(async {
                tokio::time::timeout(std::time::Duration::from_secs(reply_timeout_secs), async {
                    while let Some((sess, text, is_final)) = reply_rx.recv().await {
                        if sess != sess_id_to_wait {
                            continue;
                        }
                        if is_final {
                            return Some(text);
                        }
                        if !text.trim().is_empty() {
                            let mut stdout = std::io::stdout();
                            let _ = writeln!(stdout, "\n[Agent 进度] {}", text);
                            let _ = stdout.flush();
                        }
                    }
                    None
                })
                .await
            });
            match wait_result {
                Ok(Some(reply)) => {
                    let _ = writeln!(stdout, "\n{}\n", reply);
                }
                Ok(None) | Err(_) => {
                    let _ = writeln!(
                        stdout,
                        "等待 Agent 回复超过 {} 秒，可继续输入或使用 ctx 检查状态。",
                        reply_timeout_secs
                    );
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
    use super::{read_console_input, ConsoleInput};
    use std::io::Cursor;

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
}
