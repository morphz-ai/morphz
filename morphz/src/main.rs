use chrono::Utc;
use morphz::config;
use morphz::context_tools::{ContextTxTool, RecallTool};
use morphz::event::{Event, InMemoryEventBus};
use morphz::llm::OpenAIClient;
use morphz::memory::sqlite::SqliteStore;
use morphz::orchestrator::context::ContextEngine;
use morphz::orchestrator::orchestrator::Orchestrator;
use morphz::tool::{
    EditFileTool, ExecuteCommandTool, KillTaskTool, ListFilesTool, ListSkillsTool, ReadFileTool,
    Registry, SearchTool, SpawnAgentTool, WriteFileTool,
};
use morphz::web::Server;
use std::io::Write;
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
    let context_engine = Arc::new(ContextEngine::new(
        Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
        app_config.orchestrator.clone(),
    ));
    let tool_security = Arc::new(app_config.tool_security.clone());
    let background_config = Arc::new(app_config.background_task.clone());
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
    registry.register(Arc::new(ContextTxTool::new(Arc::clone(&context_engine))));
    registry.register(Arc::new(RecallTool::new(Arc::clone(&context_engine))));
    registry.register(Arc::new(ExecuteCommandTool::new_with_configs(
        Arc::clone(&bus),
        Arc::clone(&background_config),
        Arc::clone(&tool_security),
        app_config.orchestrator.tool_timeout_secs,
    )));
    registry.register(Arc::new(KillTaskTool));
    let coding_eval_mode = std::env::var("MORPHZ_CODING_EVAL_MODE")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        });
    if !coding_eval_mode {
        registry.register(Arc::new(SpawnAgentTool::new(Arc::clone(&bus))));
        registry.register(Arc::new(ListSkillsTool));
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

    // 5.5 启动大盘 API & WebSocket 服务器
    let web_srv = Arc::new(Server::new_with_capacity(
        Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
        Some(Arc::clone(&store) as Arc<dyn morphz::memory::GraphStore>),
        Arc::clone(&bus),
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

    let session_id = std::env::var("MORPHZ_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("session_{}", Utc::now().timestamp()));

    let bus_clone = Arc::clone(&bus);
    let session_id_clone = session_id.clone();
    let orc_clone = Arc::clone(&orc);
    let reply_timeout_secs = app_config.orchestrator.reply_timeout_secs;

    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::channel::<(String, String)>(100);
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
                    let _ = tx.send((sess_id.to_string(), text)).await;
                }
                Ok(())
            })
        }),
    );

    // 在阻塞线程中同步监听 stdin
    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        let mut msg_counter = 0;
        let mut input = String::new();
        loop {
            print!("> ");
            let _ = std::io::stdout().flush();
            input.clear();
            // Ctrl-D / EOF 检测：read_line 返回 Ok(0) 表示流结束
            match std::io::stdin().read_line(&mut input) {
                Ok(0) => {
                    // Ctrl-D / EOF
                    println!("\n[EOF] 退出 Morphz。");
                    std::process::exit(0);
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("\n[stdin 错误] {}，退出 Morphz。", e);
                    std::process::exit(1);
                }
            }
            let text = input.trim();
            if text.is_empty() {
                continue;
            }
            if text == "exit" || text == "quit" {
                println!("退出 Morphz。");
                std::process::exit(0);
            }

            let parts: Vec<&str> = text.split_whitespace().collect();
            if !parts.is_empty() && parts[0] == "ctx" {
                let sess_id = if parts.len() > 1 {
                    parts[1].to_string()
                } else {
                    session_id_clone.clone()
                };

                let orc_inner = Arc::clone(&orc_clone);
                rt.block_on(async move {
                    match orc_inner.get_current_context(&sess_id).await {
                        Ok(ctx_state) => {
                            println!("--- 动态求值 Context SExpr 状态 (Session: {}) ---", sess_id);
                            println!("{}", ctx_state);
                            println!("--------------------------------------------------");
                        }
                        Err(e) => {
                            println!("无法获取 Context: {:?}", e);
                        }
                    }
                });
                continue;
            }

            msg_counter += 1;

            // 丢弃上一轮超时后才到达的迟到回复，避免它误解锁下一条输入。
            while reply_rx.try_recv().is_ok() {}

            let mut payload = serde_json::Map::new();
            payload.insert(
                "session_id".to_string(),
                serde_json::json!(session_id_clone),
            );
            payload.insert("text".to_string(), serde_json::json!(text));

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
                    while let Some((sess, reply)) = reply_rx.recv().await {
                        if sess == sess_id_to_wait {
                            println!("\n{}\n", reply);
                            break;
                        }
                    }
                })
                .await
            });
            if wait_result.is_err() {
                println!(
                    "等待 Agent 回复超过 {} 秒，可继续输入或使用 ctx 检查状态。",
                    reply_timeout_secs
                );
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
