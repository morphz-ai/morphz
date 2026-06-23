use crate::llm::ToolDefinition;
use dashmap::DashMap;
use serde::Deserialize;
use std::sync::Arc;

tokio::task_local! {
    pub static CURRENT_SESSION_ID: String;
}

#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn definition(&self) -> ToolDefinition;
    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;
}

pub struct Registry {
    tools: DashMap<String, Arc<dyn Tool>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            tools: DashMap::new(),
        }
    }

    pub fn register(&self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).map(|r| Arc::clone(r.value()))
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .iter()
            .map(|r| r.value().definition())
            .collect()
    }
}

// WriteFileTool 本地物理文件写入工具
pub struct WriteFileTool;

#[derive(Deserialize)]
struct WriteFileArgs {
    path: String,
    content: String,
}

#[async_trait::async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要写入的文件路径，例如: test.txt"
                },
                "content": {
                    "type": "string",
                    "description": "要写入文件的文本内容"
                }
            },
            "required": ["path", "content"]
        });

        ToolDefinition {
            name: "write".to_string(),
            description: "向指定路径的文件写入文本内容。如果文件不存在，会自动创建该文件。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: WriteFileArgs = serde_json::from_str(arguments)?;
        tokio::fs::write(&args.path, &args.content).await?;
        Ok(format!(
            "成功向文件 '{}' 写入了 {} 字节数据。",
            args.path,
            args.content.len()
        ))
    }
}

// ReadFileTool 本地物理文件读取工具
pub struct ReadFileTool;

#[derive(Deserialize)]
struct ReadFileArgs {
    path: String,
}

#[async_trait::async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要读取的文件路径，例如: test.txt"
                }
            },
            "required": ["path"]
        });

        ToolDefinition {
            name: "read".to_string(),
            description: "读取指定路径文件的文本内容并返回给大模型。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ReadFileArgs = serde_json::from_str(arguments)?;
        let content = tokio::fs::read_to_string(&args.path).await?;
        Ok(content)
    }
}

// EvalContextTool 大脑符号化 Context 状态维护工具
pub struct EvalContextTool {
    bus: Arc<crate::event::InMemoryEventBus>,
}

impl EvalContextTool {
    pub fn new(bus: Arc<crate::event::InMemoryEventBus>) -> Self {
        Self { bus }
    }
}

#[derive(Deserialize)]
struct EvalContextArgs {
    session_id: String,
    instruction: String,
}

#[async_trait::async_trait]
impl Tool for EvalContextTool {
    fn name(&self) -> &str {
        "eval"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "当前会话的唯一 Session ID，可从 Context 元数据中直接读取"
                },
                "instruction": {
                    "type": "string",
                    "description": "Yao-lang 格式的 S-Expression 状态演算指令，例如 (set (variables current_file) \"notes.txt\")"
                }
            },
            "required": ["session_id", "instruction"]
        });

        ToolDefinition {
            name: "eval".to_string(),
            description: "用于更新和维护大模型自身的大脑 Context 状态。大模型每次决策时如果改变了变量、todo_stack 或是总结了 history，必须调用此工具进行状态转移演算。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut val: serde_json::Value = serde_json::from_str(arguments)?;
        
        // 容错处理：如果大模型误用 script，将其映射至 instruction
        if let Some(obj) = val.as_object_mut() {
            if !obj.contains_key("instruction") {
                if let Some(script_val) = obj.remove("script") {
                    obj.insert("instruction".to_string(), script_val);
                }
            }
            
            // 容错处理：如果漏掉 session_id，从 task-local 自动回填
            let has_session_id = obj.get("session_id")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
                
            if !has_session_id {
                if let Some(fallback_id) = CURRENT_SESSION_ID.try_with(|id| id.clone()).ok() {
                    obj.insert("session_id".to_string(), serde_json::json!(fallback_id));
                }
            }
        }

        let args: EvalContextArgs = serde_json::from_value(val)?;

        // 先验证 instruction 是否为合法的 S-Expression
        if let Err(e) = crate::sexpr::parse(&args.instruction) {
            return Err(format!("语法解析错误：传入的演算指令非法：{}", e).into());
        }

        // 创建 TypeProposal 事件并发布
        let mut payload = serde_json::Map::new();
        payload.insert("session_id".to_string(), serde_json::json!(args.session_id));
        payload.insert("instruction".to_string(), serde_json::json!(args.instruction));
        payload.insert("text".to_string(), serde_json::json!(args.instruction));

        let ev = crate::event::Event::new(
            format!("prop_{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "chat/context_proposal".to_string(),
            payload,
        );

        self.bus.publish(ev).await?;

        Ok(format!("大脑状态演算指令 '{}' 成功提案并发布。", args.instruction))
    }
}

// ExecuteCommandTool 异步终端执行工具 (exec)
pub struct ExecuteCommandTool;

#[derive(Deserialize)]
struct ExecuteCommandArgs {
    command: String,
}

#[async_trait::async_trait]
impl Tool for ExecuteCommandTool {
    fn name(&self) -> &str {
        "exec"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "要在本地终端执行的 Shell 命令，例如 'cargo test' 或 'ls'"
                }
            },
            "required": ["command"]
        });

        ToolDefinition {
            name: "exec".to_string(),
            description: "在受限的物理沙箱中异步执行指定的 Shell 命令并返回输出。不支持交互式命令，且最大超时时间为 15 秒。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ExecuteCommandArgs = serde_json::from_str(arguments)?;

        let cmd_trimmed = args.command.trim();
        // 简单的高危指令静态拦截
        if cmd_trimmed.contains("rm -rf") || cmd_trimmed.contains(":(){:|:&};:") {
            return Err("安全审计拦截：检测到高危指令破坏操作。".into());
        }

        use std::process::Stdio;
        use tokio::process::Command;

        let child = Command::new("sh")
            .arg("-c")
            .arg(cmd_trimmed)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let result = tokio::time::timeout(tokio::time::Duration::from_secs(15), child.wait_with_output()).await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);

                Ok(format!(
                    "执行结束 [退出码: {}]\n--- stdout ---\n{}\n--- stderr ---\n{}",
                    exit_code, stdout, stderr
                ))
            }
            Ok(Err(e)) => Err(format!("进程执行报错: {:?}", e).into()),
            Err(_) => {
                Err("执行超时：超过了 15 秒最大执行时限。".into())
            }
        }
    }
}

// SpawnAgentTool 并发子智能体协程派生工具 (spawn)
pub struct SpawnAgentTool {
    bus: Arc<crate::event::InMemoryEventBus>,
}

impl SpawnAgentTool {
    pub fn new(bus: Arc<crate::event::InMemoryEventBus>) -> Self {
        Self { bus }
    }
}

#[derive(Deserialize)]
struct SpawnAgentArgs {
    sub_session_id: String,
    parent_session_id: String,
    initial_context: String,
}

#[async_trait::async_trait]
impl Tool for SpawnAgentTool {
    fn name(&self) -> &str {
        "spawn"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "sub_session_id": {
                    "type": "string",
                    "description": "唯一的子会话 ID，例如 sess_sub_tcp_01"
                },
                "parent_session_id": {
                    "type": "string",
                    "description": "当前父会话的 Session ID，可从 Context 元数据中直接读取"
                },
                "initial_context": {
                    "type": "string",
                    "description": "传递给子智能体的初始 S-Expression 心智状态。例如 (context (metadata (session \"sess_sub_tcp_01\")) (todo_stack (task \"任务1\")))"
                }
            },
            "required": ["sub_session_id", "parent_session_id", "initial_context"]
        });

        ToolDefinition {
            name: "spawn".to_string(),
            description: "在后台并发启动一个新的子智能体协程，专门处理独立的子任务。此工具为非阻塞，调用后立即返回。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut val: serde_json::Value = serde_json::from_str(arguments)?;
        
        // 容错处理：如果 parent_session_id 缺失，从 task-local 自动回填
        if let Some(obj) = val.as_object_mut() {
            let has_parent = obj.get("parent_session_id")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !has_parent {
                if let Some(fallback_id) = CURRENT_SESSION_ID.try_with(|id| id.clone()).ok() {
                    obj.insert("parent_session_id".to_string(), serde_json::json!(fallback_id));
                }
            }
        }

        let args: SpawnAgentArgs = serde_json::from_value(val)?;

        let mut payload = serde_json::Map::new();
        payload.insert("session_id".to_string(), serde_json::json!(args.sub_session_id));
        payload.insert("parent_session_id".to_string(), serde_json::json!(args.parent_session_id));
        payload.insert("initial_context".to_string(), serde_json::json!(args.initial_context));
        payload.insert("text".to_string(), serde_json::json!(format!("Spawn sub-agent: {}", args.sub_session_id)));

        let ev = crate::event::Event::new(
            format!("spawn_{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz-Parent".to_string(),
            "chat/spawn".to_string(),
            "chat/spawn".to_string(),
            payload,
        );

        self.bus.publish(ev).await?;
        Ok(format!("子智能体协程 '{}' 启动指令已成功排队并提交。", args.sub_session_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn test_file_tools() {
        let tmp_file = NamedTempFile::new().unwrap();
        let path_str = tmp_file.path().to_str().unwrap().to_string();

        let write_tool = WriteFileTool;
        let read_tool = ReadFileTool;

        let write_args = serde_json::json!({
            "path": path_str,
            "content": "hello rust tool"
        });

        let write_res = write_tool.execute(&write_args.to_string()).await.unwrap();
        assert!(write_res.contains("成功"));

        let read_args = serde_json::json!({
            "path": path_str
        });

        let read_res = read_tool.execute(&read_args.to_string()).await.unwrap();
        assert_eq!(read_res, "hello rust tool");
    }

    #[tokio::test]
    async fn test_eval_tool() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = EvalContextTool::new(Arc::clone(&bus));

        let args = serde_json::json!({
            "session_id": "session_test",
            "instruction": "(set (variables a) 1)"
        });

        let res = tool.execute(&args.to_string()).await.unwrap();
        assert!(res.contains("成功提案"));

        // 1. 容错测试：把 instruction 写成 script
        let args_script = serde_json::json!({
            "session_id": "session_test",
            "script": "(set (variables a) 1)"
        });
        let res_script = tool.execute(&args_script.to_string()).await.unwrap();
        assert!(res_script.contains("成功提案"));

        // 2. 容错测试：漏掉 session_id，通过 task_local 回填
        let args_no_session = serde_json::json!({
            "instruction": "(set (variables a) 1)"
        });
        // 不在 CURRENT_SESSION_ID 作用域下，应该报错，因为没有 session_id 且没有回填值
        let res_err = tool.execute(&args_no_session.to_string()).await;
        assert!(res_err.is_err());

        // 在 CURRENT_SESSION_ID 作用域下，自动回填
        CURRENT_SESSION_ID.scope("session_task_local".to_string(), async {
            let res_ok = tool.execute(&args_no_session.to_string()).await.unwrap();
            assert!(res_ok.contains("成功提案"));
        }).await;
    }

    #[tokio::test]
    async fn test_exec_tool() {
        let tool = ExecuteCommandTool;
        
        let args = serde_json::json!({
            "command": "echo 'hello exec'"
        });
        
        let res = tool.execute(&args.to_string()).await.unwrap();
        assert!(res.contains("hello exec"));

        // 高危指令测试
        let bad_args = serde_json::json!({
            "command": "rm -rf /some/path"
        });
        let bad_res = tool.execute(&bad_args.to_string()).await;
        assert!(bad_res.is_err());
    }

    #[tokio::test]
    async fn test_spawn_tool() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = SpawnAgentTool::new(Arc::clone(&bus));

        let args = serde_json::json!({
            "sub_session_id": "sess_sub_test",
            "parent_session_id": "sess_parent_test",
            "initial_context": "(context (todo_stack (task \"test\")))"
        });

        let res = tool.execute(&args.to_string()).await.unwrap();
        assert!(res.contains("成功排队并提交"));

        // 容错测试：漏掉 parent_session_id，通过 task_local 回填
        let args_no_parent = serde_json::json!({
            "sub_session_id": "sess_sub_test",
            "initial_context": "(context (todo_stack (task \"test\")))"
        });
        
        // 在 CURRENT_SESSION_ID 作用域下，自动回填
        CURRENT_SESSION_ID.scope("sess_parent_task_local".to_string(), async {
            let res_ok = tool.execute(&args_no_parent.to_string()).await.unwrap();
            assert!(res_ok.contains("成功排队并提交"));
        }).await;
    }

    #[tokio::test]
    async fn test_concurrency_fork_join_e2e() {
        // 1. 初始化环境变量 (BGE 嵌入模型、API key 等)
        if crate::config::load_env("../.env").is_err() {
            let _ = crate::config::load_env(".env");
        }
        let api_key = std::env::var("OPENAI_API_KEY").unwrap_or_else(|_| "test_key".to_string());
        let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_default();
        let model_name = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gemini-3.5-flash-low".to_string());

        // 2. 初始化 OpenAIClient (内存加载 BGE 模型，如果有的话)
        let model_store = match executor::load_model() {
            Ok(store) => Some(Arc::new(store)),
            Err(_) => None,
        };
        let client = Arc::new(crate::llm::OpenAIClient::new(
            api_key,
            base_url,
            model_name,
            model_store,
        ));

        // 3. 初始化事件总线与 SQLite 存储 (使用临时测试数据库以避免污染)
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        
        let db_file = "test_fork_join_e2e.db";
        let _ = std::fs::remove_file(db_file); // 清理旧数据库
        let store = Arc::new(crate::memory::sqlite::SqliteStore::new(db_file).await.unwrap());

        // 4. 注册 5 大原子原语工具
        let registry = Arc::new(Registry::new());
        registry.register(Arc::new(WriteFileTool));
        registry.register(Arc::new(ReadFileTool));
        registry.register(Arc::new(EvalContextTool::new(Arc::clone(&bus))));
        registry.register(Arc::new(ExecuteCommandTool));
        registry.register(Arc::new(SpawnAgentTool::new(Arc::clone(&bus))));

        // 5. 初始化并启动 Orchestrator
        let orc = Arc::new(crate::orchestrator::orchestrator::Orchestrator::new(
            Arc::clone(&bus),
            Arc::clone(&store) as Arc<dyn crate::memory::EventStore>,
            Some(Arc::clone(&store) as Arc<dyn crate::memory::GraphStore>),
            Arc::clone(&client) as Arc<dyn crate::llm::Client>,
            Arc::clone(&registry),
        ));
        orc.start().await.unwrap();

        // 6. 清理目标写入文件
        let _ = std::fs::remove_file("file1.txt");
        let _ = std::fs::remove_file("file2.txt");

        // 7. 构造并发送父智能体触发事件 (chat/user_message)
        let session_id = format!("test_sess_{}", chrono::Utc::now().timestamp());
        let mut payload = serde_json::Map::new();
        payload.insert("session_id".to_string(), serde_json::json!(session_id));
        payload.insert("text".to_string(), serde_json::json!(
            "请帮我并发做两件事：\
             1. 写入文件 file1.txt，内容为 \"hello\"\
             2. 写入文件 file2.txt，内容为 \"world\"\
             你必须调用 spawn 原语并发安排两个子 Agent 去做。\
             请确保：\
             - 子 Agent 1 的 initial_context 中 todo_stack 包含 task \"写入文件 file1.txt，内容为 hello\"\
             - 子 Agent 2 的 initial_context 中 todo_stack 包含 task \"写入文件 file2.txt，内容为 world\"\
             子 Agent 接收到任务后，应直接调用 write 工具写入对应的文件。所有子 Agent 执行完毕后，你再向用户汇总结果。"
        ));

        let user_ev = crate::event::Event::new(
            "test_trigger_event".to_string(),
            "User-Test".to_string(),
            crate::event::TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            payload,
        );

        println!("🚀 [E2E 测试] 发布用户触发事件...");
        bus.publish(user_ev).await.unwrap();

        // 8. 轮询等待，最长等待 30 秒，校验 file1.txt 和 file2.txt 是否生成，并且内容正确
        let mut success = false;
        for i in 0..60 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            let f1_ok = std::fs::read_to_string("file1.txt").map(|c| c.trim() == "hello").unwrap_or(false);
            let f2_ok = std::fs::read_to_string("file2.txt").map(|c| c.trim() == "world").unwrap_or(false);
            if f1_ok && f2_ok {
                println!("🎉 [E2E 测试] 成功检测到 file1.txt (\"hello\") 和 file2.txt (\"world\") 已正确写入！");
                success = true;
                break;
            }
            if i % 10 == 0 {
                println!("⏳ [E2E 测试] 已等待 {} 秒...", i / 2);
            }
        }

        // 清理临时文件和数据库
        let _ = std::fs::remove_file("file1.txt");
        let _ = std::fs::remove_file("file2.txt");
        let _ = std::fs::remove_file(db_file);
        let _ = std::fs::remove_file(format!("{}-shm", db_file));
        let _ = std::fs::remove_file(format!("{}-wal", db_file));

        assert!(success, "E2E 并发写入测试未能在 30 秒内成功完成！");
    }
}
