use chrono::Utc;
use morphz::config;
use morphz::event::{Event, InMemoryEventBus};
use morphz::llm::OpenAIClient;
use morphz::memory::sqlite::SqliteStore;
use morphz::orchestrator::orchestrator::Orchestrator;
use morphz::tool::{ReadFileTool, Registry, WriteFileTool, EvalContextTool, ExecuteCommandTool, KillTaskTool, SpawnAgentTool, ListSkillsTool};
use morphz::web::Server;
use std::io::Write;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // 1.0. 冷启动直接在当前内存中加载 BERT 语义模型（零 IPC 跨进程网络调用）
    let model_store = match executor::load_model() {
        Ok(store) => {
            println!("⚙️ [BGE Model] 本地内存加载成功，就绪状态。");
            Some(Arc::new(store))
        }
        Err(e) => {
            eprintln!("⚠️ [BGE Model] 本地内存加载失败: {}", e);
            eprintln!("💡 [排查建议] 请确保本地模型文件齐全：路径 models/bge-small-zh-1.5/。将使用降级和 Hashing Embedding 兜底。");
            None
        }
    };

    // 1. 加载根目录下的 .env 环境变量
    let _ = config::load_env(".env");

    // 2. 从环境变量获取接口配置并实例化大模型客户端
    let api_key = match std::env::var("OPENAI_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            println!("==================================================");
            println!("❌ 错误：未检测到 OPENAI_API_KEY 环境变量。");
            println!("   请在终端运行：export OPENAI_API_KEY=\"your_key_here\"");
            println!("==================================================");
            return Ok(());
        }
    };

    let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
    let model_name = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());

    println!("[配置] 当前使用模型: {}", model_name);
    let client = Arc::new(OpenAIClient::new(
        api_key,
        base_url,
        model_name,
        model_store,
    ));

    // 3. 初始化事件总线与事件存储
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new("morphz.db").await?);

    // 4. 初始化工具注册表并注册本地文件工具
    let registry = Arc::new(Registry::new());
    registry.register(Arc::new(WriteFileTool));
    registry.register(Arc::new(ReadFileTool));
    registry.register(Arc::new(EvalContextTool::new(Arc::clone(&bus))));
    registry.register(Arc::new(ExecuteCommandTool::new(Arc::clone(&bus))));
    registry.register(Arc::new(KillTaskTool));
    registry.register(Arc::new(SpawnAgentTool::new(Arc::clone(&bus))));
    registry.register(Arc::new(ListSkillsTool));

    // 5. 初始化并启动 Orchestrator
    // 我们的 SqliteStore 同时实现了 EventStore 和 GraphStore，
    // 将其分别作为 store (EventStore) 和 graph_store (GraphStore) 传入
    let orc = Arc::new(Orchestrator::new(
        Arc::clone(&bus),
        Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
        Some(Arc::clone(&store) as Arc<dyn morphz::memory::GraphStore>),
        Arc::clone(&client) as Arc<dyn morphz::llm::Client>,
        Arc::clone(&registry),
    ));

    orc.start().await?;

    // 5.5 启动大盘 API & WebSocket 服务器
    let web_srv = Arc::new(Server::new(
        Arc::clone(&store) as Arc<dyn morphz::memory::EventStore>,
        Some(Arc::clone(&store) as Arc<dyn morphz::memory::GraphStore>),
        Arc::clone(&bus),
    ));

    web_srv.start("127.0.0.1:8080").await?;

    // 6. 启动控制台输入传感器 (Stdin Sensor)
    println!("==================================================");
    println!("   Morphz Attempt Loop 运行成功！");
    println!("   已注册工具: write_file, read_file");
    println!("   您可以通过指令命令它做事情，例如：");
    println!("   > 帮我写一个 notes.txt 文件，内容为“Morphz Loop OK”");
    println!("==================================================");

    let session_id = format!("session_{}", Utc::now().timestamp());

    let bus_clone = Arc::clone(&bus);
    let session_id_clone = session_id.clone();

    // 在阻塞线程中同步监听 stdin
    tokio::task::spawn_blocking(move || {
        let mut msg_counter = 0;
        let mut input = String::new();
        loop {
            print!("> ");
            let _ = std::io::stdout().flush();
            input.clear();
            if std::io::stdin().read_line(&mut input).is_err() {
                break;
            }
            let text = input.trim();
            if text.is_empty() {
                continue;
            }
            if text == "exit" {
                println!("👋 退出 Morphz。");
                std::process::exit(0);
            }

            msg_counter += 1;

            let mut payload = serde_json::Map::new();
            payload.insert("session_id".to_string(), serde_json::json!(session_id_clone));
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

            // 稍微等待下日志输出，避免抢占
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    });

    // 保持异步主线程活着
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
    }
}
