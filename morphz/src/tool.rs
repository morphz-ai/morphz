use crate::llm::ToolDefinition;
use dashmap::DashMap;
use serde::Deserialize;
use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, BufReader};
use crate::event::Event;

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

// ==========================================
// 工业级后台长任务托管机制
// ==========================================
pub struct BackgroundTask {
    pub id: String,
    pub cmd_str: String,
    pub pgid: i32,
}

static BACKGROUND_TASKS: OnceLock<Arc<DashMap<String, BackgroundTask>>> = OnceLock::new();

pub fn get_tasks_map() -> &'static Arc<DashMap<String, BackgroundTask>> {
    BACKGROUND_TASKS.get_or_init(|| Arc::new(DashMap::new()))
}

// 共享的实时输出管道缓冲
struct ExecutionBuffer {
    output: std::sync::Mutex<String>,
    task_id: String,
    bus: Arc<crate::event::InMemoryEventBus>,
    session_id: String,
}

impl ExecutionBuffer {
    fn append(&self, text: &str, publish: bool) {
        {
            let mut guard = self.output.lock().unwrap();
            guard.push_str(text);
        }
        if publish {
            let mut payload = serde_json::Map::new();
            payload.insert("session_id".to_string(), serde_json::json!(self.session_id));
            payload.insert("task_id".to_string(), serde_json::json!(self.task_id));
            payload.insert("text".to_string(), serde_json::json!(text));

            let ev = Event::new(
                format!("task_out_{}_{}", self.task_id, chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                "System-TaskMonitor".to_string(),
                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                payload,
            );
            
            let bus_clone = Arc::clone(&self.bus);
            tokio::spawn(async move {
                let _ = bus_clone.publish(ev).await;
            });
        }
    }

    fn get_all(&self) -> String {
        let guard = self.output.lock().unwrap();
        guard.clone()
    }
}

async fn monitor_pipe<R>(
    reader: R,
    buffer: Arc<ExecutionBuffer>,
    publish_ref: Arc<AtomicBool>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    while let Ok(n) = reader.read_line(&mut line).await {
        if n == 0 {
            break;
        }
        let publish = publish_ref.load(Ordering::SeqCst);
        buffer.append(&line, publish);
        line.clear();
    }
}

// ==========================================
// 1. WriteFileTool 工业级路径与权限容错
// ==========================================
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
            description: "向指定路径的文件写入文本内容。支持相对和绝对路径，并尊重操作系统用户权限。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: WriteFileArgs = serde_json::from_str(arguments)?;
        let path = std::path::Path::new(&args.path);
        
        let parent = path.parent().unwrap_or_else(|| std::path::Path::new(""));
        let parent_resolved = if parent.as_os_str().is_empty() {
            std::fs::canonicalize(".").unwrap_or_else(|_| std::path::PathBuf::from("."))
        } else {
            match std::fs::canonicalize(parent) {
                Ok(p) => p,
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        let _ = tokio::fs::create_dir_all(parent).await;
                        std::fs::canonicalize(parent).unwrap_or_else(|_| std::path::PathBuf::from(parent))
                    } else {
                        return Ok(format!("系统报错：解析写入目录失败 (错误: {:?})，请确保路径合法。", e));
                    }
                }
            }
        };
        
        let file_name = match path.file_name() {
            Some(f) => f,
            None => return Ok("系统报错：指定的文件名不合法。".to_string()),
        };
        let absolute_path = parent_resolved.join(file_name);

        match tokio::fs::write(&absolute_path, &args.content).await {
            Ok(_) => {
                Ok(format!("成功向文件 '{}' 写入了 {} 字节数据。", absolute_path.display(), args.content.len()))
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    return Ok(format!("系统报错：无写入权限，禁止写入路径 '{}'。请检查操作系统权限设置或更换有写权的路径。", absolute_path.display()));
                }
                Ok(format!("系统报错：向路径 '{}' 写入数据失败，原因: {:?}", absolute_path.display(), e))
            }
        }
    }
}

// ==========================================
// 2. ReadFileTool 工业级路径与权限容错
// ==========================================
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
            description: "读取指定路径文件的文本内容。支持相对和绝对路径，并尊重操作系统用户权限。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ReadFileArgs = serde_json::from_str(arguments)?;
        let path = std::path::Path::new(&args.path);
        
        let absolute_path = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Ok(format!("系统报错：读取失败。指定的文件路径 '{}' 不存在，请检查路径是否正确。", args.path));
                }
                return Ok(format!("系统报错：解析文件路径失败 (错误: {:?})，请确保路径合法。", e));
            }
        };

        match tokio::fs::read_to_string(&absolute_path).await {
            Ok(content) => Ok(content),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    return Ok(format!("系统报错：无权限读取文件 '{}'。请检查操作系统权限设置或更换有读取权限的路径。", absolute_path.display()));
                }
                Ok(format!("系统报错：读取文件 '{}' 失败，原因: {:?}", absolute_path.display(), e))
            }
        }
    }
}

// ==========================================
// 3. EvalContextTool 大脑符号化 Context 状态演算
// ==========================================
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
                    "description": "Yao-lang 格式的 S-Expression 状态演算指令，例如 (set (variables key) \"value\")"
                }
            },
            "required": ["session_id", "instruction"]
        });

        ToolDefinition {
            name: "eval".to_string(),
            description: "用于更新和维护大模型自身的大脑 Context 状态。大模型修改变量、todo_stack 或是总结 history 时必须调用此工具。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut val: serde_json::Value = serde_json::from_str(arguments)?;
        
        if let Some(obj) = val.as_object_mut() {
            if !obj.contains_key("instruction") {
                if let Some(script_val) = obj.remove("script") {
                    obj.insert("instruction".to_string(), script_val);
                }
            }
            
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

        if let Err(e) = crate::sexpr::parse(&args.instruction) {
            return Err(format!("语法解析错误：传入的演算指令非法：{}", e).into());
        }

        let mut payload = serde_json::Map::new();
        payload.insert("session_id".to_string(), serde_json::json!(args.session_id));
        payload.insert("instruction".to_string(), serde_json::json!(args.instruction));
        payload.insert("text".to_string(), serde_json::json!(args.instruction));

        let ev = Event::new(
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

// ==========================================
// 4. ExecuteCommandTool 异步 Detach + 进程组级销毁
// ==========================================
pub struct ExecuteCommandTool {
    bus: Arc<crate::event::InMemoryEventBus>,
}

impl ExecuteCommandTool {
    pub fn new(bus: Arc<crate::event::InMemoryEventBus>) -> Self {
        Self { bus }
    }
}

#[derive(Deserialize)]
struct ExecuteCommandArgs {
    command: String,
    wait_ms: Option<u64>,
    timeout_secs: Option<u64>,
    session_id: Option<String>,
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
                },
                "wait_ms": {
                    "type": "integer",
                    "description": "同步等待输出的最长超时毫秒数。默认 1000 毫秒(1秒)，超时后命令会自动转入后台异步运行。"
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "同步等待输出的最长超时秒数(旧接口，建议改用 wait_ms)。"
                },
                "session_id": {
                    "type": "string",
                    "description": "当前会话的唯一 Session ID，可从 Context 元数据中直接读取"
                }
            },
            "required": ["command"]
        });

        ToolDefinition {
            name: "exec".to_string(),
            description: "在宿主环境终端同步执行命令并返回输出。如果运行超时，将自动转为后台托管，后续输出将通过事件投递大模型。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ExecuteCommandArgs = serde_json::from_str(arguments)?;
        let cmd_trimmed = args.command.trim();

        if cmd_trimmed.contains(":(){:|:&};:") {
            return Err("安全审计拦截：检测到 fork 炸弹高危指令破坏操作。".into());
        }

        let mut session_id = args.session_id.unwrap_or_default();
        if session_id.is_empty() {
            if let Some(fallback_id) = CURRENT_SESSION_ID.try_with(|id| id.clone()).ok() {
                session_id = fallback_id;
            }
        }
        if session_id.is_empty() {
            session_id = "default_session".to_string();
        }

        use std::process::Stdio;
        use tokio::process::Command;

        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(cmd_trimmed)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // 必须通过 pre_exec 分配独立的进程组，以便于进程组强杀
        unsafe {
            cmd.pre_exec(|| {
                let pid = nix::libc::getpid();
                nix::libc::setpgid(pid, pid);
                Ok(())
            });
        }

        let mut child = cmd.spawn()?;
        let pid = child.id().ok_or("无法获取进程 ID")? as i32;

        let task_id = format!("task_{}_{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0), pid);

        let stdout = child.stdout.take().ok_or("无法捕获 stdout 管道")?;
        let stderr = child.stderr.take().ok_or("无法捕获 stderr 管道")?;

        let bus_clone = Arc::clone(&self.bus);
        let session_id_clone = session_id.clone();
        let task_id_clone = task_id.clone();

        // 共享缓冲区
        let buffer = Arc::new(ExecutionBuffer {
            output: std::sync::Mutex::new(String::new()),
            task_id: task_id_clone.clone(),
            bus: bus_clone,
            session_id: session_id_clone,
        });

        // 共享的“是否开启事件发布”标志 (前 N 秒同步时不发布，转入后台时才发布)
        let publish_flag = Arc::new(AtomicBool::new(false));

        let buffer_out = Arc::clone(&buffer);
        let publish_out = Arc::clone(&publish_flag);
        tokio::spawn(async move {
            monitor_pipe(stdout, buffer_out, publish_out).await;
        });

        let buffer_err = Arc::clone(&buffer);
        let publish_err = Arc::clone(&publish_flag);
        tokio::spawn(async move {
            monitor_pipe(stderr, buffer_err, publish_err).await;
        });

        // 将任务先行放入全局的任务 Map 以供超时或手动 kill
        let tasks = get_tasks_map();
        tasks.insert(task_id.clone(), BackgroundTask {
            id: task_id.clone(),
            cmd_str: cmd_trimmed.to_string(),
            pgid: pid,
        });

        // 同步等待设定时间
        let wait_duration = if let Some(ms) = args.wait_ms {
            tokio::time::Duration::from_millis(ms)
        } else if let Some(secs) = args.timeout_secs {
            tokio::time::Duration::from_secs(secs)
        } else {
            tokio::time::Duration::from_millis(1000) // 默认1秒，更高效，不阻塞大模型！
        };
        let wait_result = tokio::time::timeout(wait_duration, child.wait()).await;

        match wait_result {
            Ok(exit_status_res) => {
                // 命令在同步时间内直接执行完成
                tasks.remove(&task_id);
                let code = exit_status_res.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                let output_str = buffer.get_all();
                Ok(format!(
                    "执行结束 [退出码: {}]\n--- 输出 ---\n{}",
                    code, output_str
                ))
            }
            Err(_) => {
                // 运行超时，正式脱离 (Detach) 为后台长任务
                publish_flag.store(true, Ordering::SeqCst);
                
                // 启动一个后台协程，在进程最终退出时清理 map 并发送完成事件通知大模型
                let bus_cleanup = Arc::clone(&self.bus);
                let task_id_cleanup = task_id.clone();
                let session_id_cleanup = session_id.clone();
                tokio::spawn(async move {
                    let wait_res = child.wait().await;
                    let tasks_cleanup = get_tasks_map();
                    tasks_cleanup.remove(&task_id_cleanup);

                    let code = wait_res.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                    
                    let mut payload = serde_json::Map::new();
                    payload.insert("session_id".to_string(), serde_json::json!(session_id_cleanup));
                    payload.insert("task_id".to_string(), serde_json::json!(task_id_cleanup));
                    payload.insert("text".to_string(), serde_json::json!(format!("\n[后台任务 {} 执行结束，退出码: {}]", task_id_cleanup, code)));
                    
                    let ev = Event::new(
                        format!("task_exit_{}_{}", task_id_cleanup, chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                        "System-TaskMonitor".to_string(),
                        crate::event::TYPE_TOOL_OUTPUT.to_string(),
                        "chat/tool_output".to_string(),
                        payload,
                    );
                    let _ = bus_cleanup.publish(ev).await;
                });

                let elapsed_str = if args.wait_ms.is_some() {
                    format!("{} 毫秒", wait_duration.as_millis())
                } else if args.timeout_secs.is_some() {
                    format!("{} 秒", wait_duration.as_secs())
                } else {
                    format!("{} 毫秒", wait_duration.as_millis())
                };

                Ok(format!(
                    "[任务已转入后台异步运行，任务 ID: {}]\n命令已运行了超过 {} 最大同步时间。您可以在后续的心智状态中查收该任务持续投递的事件输出，或调用 kill_task 强杀它。",
                    task_id, elapsed_str
                ))
            }
        }
    }
}

// ==========================================
// 5. KillTaskTool 进程组广播灭杀 ( kill_task )
// ==========================================
pub struct KillTaskTool;

#[derive(Deserialize)]
struct KillTaskArgs {
    task_id: String,
}

#[async_trait::async_trait]
impl Tool for KillTaskTool {
    fn name(&self) -> &str {
        "kill_task"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "要强杀的后台任务 ID，例如 task_1719234560"
                }
            },
            "required": ["task_id"]
        });

        ToolDefinition {
            name: "kill_task".to_string(),
            description: "强行终止失控或已无用处的后台托管 Shell 任务，释放其占用的全部进程树及物理资源。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: KillTaskArgs = serde_json::from_str(arguments)?;
        let tasks = get_tasks_map();

        if let Some((_, task)) = tasks.remove(&args.task_id) {
            let pgid = nix::unistd::Pid::from_raw(-task.pgid); // 负数代表杀死整个进程组
            match nix::sys::signal::kill(pgid, nix::sys::signal::Signal::SIGKILL) {
                Ok(_) => Ok(format!("成功强杀后台任务 {}，其下属的子孙进程组 {} 已彻底清理。", args.task_id, task.pgid)),
                Err(e) => {
                    if e == nix::errno::Errno::ESRCH {
                        Ok(format!("后台任务 {} 此前已自动退出，进程组 {} 已不在运行。", args.task_id, task.pgid))
                    } else {
                        Err(format!("强杀进程组 {} 遭遇系统级错误: {:?}", task.pgid, e).into())
                    }
                }
            }
        } else {
            Ok(format!("系统报错：未找到活跃的后台任务 ID '{}'，该任务可能已提前结束。", args.task_id))
        }
    }
}

// ==========================================
// 6. SpawnAgentTool 并发子智能体派生
// ==========================================
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
                    "description": "当前父会话的 Session ID"
                },
                "initial_context": {
                    "type": "string",
                    "description": "传递给子智能体的初始 S-Expression 心智状态。"
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
        payload.insert("text".to_string(), serde_json::json!(format!("Spawning agent {}...", args.sub_session_id)));

        let ev = Event::new(
            format!("spawn_{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            format!("Parent-Agent-{}", args.parent_session_id),
            crate::event::TYPE_AGENT_CALL.to_string(),
            "chat/agent_call".to_string(),
            payload,
        );

        self.bus.publish(ev).await?;

        Ok(format!("子智能体 {} 成功排队并提交，正在启动并发心智协程...", args.sub_session_id))
    }
}

// ==========================================
// 7. ListSkillsTool 传统技能自动发现工具
// ==========================================
pub struct ListSkillsTool;

#[async_trait::async_trait]
impl Tool for ListSkillsTool {
    fn name(&self) -> &str {
        "list_skills"
    }

    fn definition(&self) -> ToolDefinition {
        let params_json = serde_json::json!({
            "type": "object",
            "properties": {}
        });

        ToolDefinition {
            name: "list_skills".to_string(),
            description: "扫描 ~/.agents/skills/ 和 ~/.morphz/skills/ 目录并列出当前可用的心智技能描述。大模型优先调用此工具发现新技能。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(&self, _arguments: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut paths_to_scan = Vec::new();
        if let Ok(home) = std::env::var("HOME") {
            let home_path = std::path::Path::new(&home);
            paths_to_scan.push(home_path.join(".agents").join("skills"));
            paths_to_scan.push(home_path.join(".morphz").join("skills"));
        }

        let mut skill_list = Vec::new();

        for skills_dir in paths_to_scan {
            if !skills_dir.exists() {
                continue;
            }

            let mut entries = match tokio::fs::read_dir(&skills_dir).await {
                Ok(e) => e,
                Err(_) => continue,
            };

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_dir() {
                    let skill_md_path = path.join("SKILL.md");
                    if skill_md_path.exists() {
                        let content = tokio::fs::read_to_string(&skill_md_path).await?;
                        let mut name = path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
                        let mut description = "无详细描述".to_string();

                        if content.starts_with("---") {
                            if let Some(end_idx) = content[3..].find("---") {
                                let yaml_part = &content[3..end_idx + 3];
                                for line in yaml_part.lines() {
                                    let parts: Vec<&str> = line.splitn(2, ':').collect();
                                    if parts.len() == 2 {
                                        let key = parts[0].trim();
                                        let val = parts[1].trim().trim_matches('"');
                                        if key == "name" {
                                            name = val.to_string();
                                        } else if key == "description" {
                                            description = val.to_string();
                                        }
                                    }
                                }
                            }
                        }
                        skill_list.push(format!("- 技能名称: {}\n  描述: {}\n  路径: {}", name, description, skill_md_path.to_string_lossy()));
                    }
                }
            }
        }

        if skill_list.is_empty() {
            Ok("目前标准技能库 (~/.agents/skills/ 和 ~/.morphz/skills/) 目录为空，暂无可用的外部技能。".to_string())
        } else {
            Ok(format!("发现以下可用技能：\n\n{}", skill_list.join("\n")))
        }
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
    async fn test_tool_path_permission_fallback() {
        let read_tool = ReadFileTool;
        // 读取一个显然不存在的文件目录，校验是否返回了优雅的容错字符串而不是 panic
        let bad_args = serde_json::json!({
            "path": "/obviously_not_exist_dir/no_file.txt"
        });
        let res = read_tool.execute(&bad_args.to_string()).await.unwrap();
        assert!(res.contains("不存在") || res.contains("系统报错"));
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
    }

    #[tokio::test]
    async fn test_exec_tool() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = ExecuteCommandTool::new(Arc::clone(&bus));
        
        let args = serde_json::json!({
            "command": "echo 'hello exec'"
        });
        
        let res = tool.execute(&args.to_string()).await.unwrap();
        assert!(res.contains("hello exec"));
    }

    #[tokio::test]
    async fn test_command_detach_to_background() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = ExecuteCommandTool::new(Arc::clone(&bus));

        // 启动一个长耗时命令并缩短同步等待超时
        let args = serde_json::json!({
            "command": "sleep 10 && echo 'finished'",
            "timeout_secs": 1
        });

        let res = tool.execute(&args.to_string()).await.unwrap();
        assert!(res.contains("转入后台"));
        assert!(res.contains("task_"));
    }

    #[tokio::test]
    async fn test_kill_task_pgid_cleanup() {
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let exec_tool = ExecuteCommandTool::new(Arc::clone(&bus));
        let kill_tool = KillTaskTool;

        let exec_args = serde_json::json!({
            "command": "sleep 100",
            "timeout_secs": 1
        });

        let res = exec_tool.execute(&exec_args.to_string()).await.unwrap();
        assert!(res.contains("转入后台"));

        let prefix = "任务 ID: ";
        let start = res.find(prefix).unwrap() + prefix.len();
        let end = res[start..].find(']').unwrap() + start;
        let task_id = &res[start..end];

        let tasks = get_tasks_map();
        assert!(tasks.contains_key(task_id));

        let kill_args = serde_json::json!({
            "task_id": task_id
        });
        let kill_res = kill_tool.execute(&kill_args.to_string()).await.unwrap();
        assert!(kill_res.contains("成功强杀") || kill_res.contains("已不在运行"));

        assert!(!tasks.contains_key(task_id));
    }
}
