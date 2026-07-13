use crate::config::{BackgroundTaskConfig, ToolSecurityConfig};
use crate::event::{Event, InMemoryEventBus, TYPE_FILE_CHANGE};
use crate::llm::ToolDefinition;
use crate::tool_security::{resolve_tool_path, ToolAccess};
use dashmap::DashMap;
use glob::Pattern;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::{OpenOptions, Permissions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use tokio::io::{AsyncBufReadExt, BufReader};
use walkdir::WalkDir;

tokio::task_local! {
    pub static CURRENT_SESSION_ID: String;
    pub static CURRENT_CONTEXT_ID: String;
}

#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn definition(&self) -> ToolDefinition;
    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>>;
}

pub struct Registry {
    tools: RwLock<HashMap<String, RegisteredTool>>,
}

struct RegisteredTool {
    tool: Arc<dyn Tool>,
    definition: ToolDefinition,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
        }
    }

    pub fn register(&self, tool: Arc<dyn Tool>) {
        let name = tool.name().to_string();
        let definition = tool.definition();
        self.tools
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(name, RegisteredTool { tool, definition });
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(name)
            .map(|entry| Arc::clone(&entry.tool))
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(|entry| entry.definition.clone())
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
    pub session_id: String,
    pub context_id: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub last_output_at: chrono::DateTime<chrono::Utc>,
    pub output_bytes: usize,
    pub timeout_notified: bool,
}

static BACKGROUND_TASKS: OnceLock<Arc<DashMap<String, BackgroundTask>>> = OnceLock::new();

pub fn get_tasks_map() -> &'static Arc<DashMap<String, BackgroundTask>> {
    BACKGROUND_TASKS.get_or_init(|| Arc::new(DashMap::new()))
}

// 共享的实时输出管道缓冲
struct ExecutionBuffer {
    output: std::sync::Mutex<String>,
    archive: std::sync::Mutex<std::fs::File>,
    archive_path: String,
    truncated: AtomicBool,
    max_bytes: usize,
    task_id: String,
    bus: Arc<crate::event::InMemoryEventBus>,
    session_id: String,
    context_id: String,
}

impl ExecutionBuffer {
    fn append(&self, text: &str, publish: bool) {
        let archive_result = match self.archive.lock() {
            Ok(mut archive) => archive.write_all(text.as_bytes()),
            Err(poisoned) => poisoned.into_inner().write_all(text.as_bytes()),
        };
        if let Err(error) = archive_result {
            tracing::error!(archive = %self.archive_path, %error, "写入 exec 原始输出归档失败");
        }
        {
            let mut guard = match self.output.lock() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    tracing::error!("ExecutionBuffer Mutex poisoned, recovering");
                    poisoned.into_inner()
                }
            };
            guard.push_str(text);
            if self.max_bytes == 0 {
                guard.clear();
                self.truncated.store(true, Ordering::Relaxed);
            } else if guard.len() > self.max_bytes {
                let mut keep_from = guard.len() - self.max_bytes;
                while !guard.is_char_boundary(keep_from) {
                    keep_from += 1;
                }
                guard.drain(..keep_from);
                self.truncated.store(true, Ordering::Relaxed);
            }
            if let Some(mut task) = get_tasks_map().get_mut(&self.task_id) {
                task.last_output_at = chrono::Utc::now();
                task.output_bytes = task.output_bytes.saturating_add(text.len());
            }
        }
        if publish {
            let mut payload = serde_json::Map::new();
            payload.insert("context_id".to_string(), serde_json::json!(self.context_id));
            payload.insert("session_id".to_string(), serde_json::json!(self.session_id));
            payload.insert("task_id".to_string(), serde_json::json!(self.task_id));
            payload.insert("text".to_string(), serde_json::json!(text));

            let ev = Event::new(
                format!(
                    "task_out_{}_{}",
                    self.task_id,
                    chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "System-TaskMonitor".to_string(),
                "task_output".to_string(),
                format!("task/output/{}", self.task_id),
                payload,
            );

            let bus_clone = Arc::clone(&self.bus);
            tokio::spawn(async move {
                let _ = bus_clone.publish(ev).await;
            });
        }
    }

    fn get_all(&self) -> String {
        let guard = match self.output.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::error!("ExecutionBuffer Mutex poisoned in get_all, recovering");
                poisoned.into_inner()
            }
        };
        if self.truncated.load(Ordering::Relaxed) {
            format!(
                "[Context preview 已按缓冲上限截断；完整原始输出: {}]\n{}",
                self.archive_path, &*guard
            )
        } else {
            guard.clone()
        }
    }
}

async fn monitor_pipe<R>(reader: R, buffer: Arc<ExecutionBuffer>, publish_ref: Arc<AtomicBool>)
where
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

#[derive(Debug)]
struct FileSnapshot {
    content: String,
    sha256: String,
    bytes: usize,
    permissions: Permissions,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_text_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取文件元数据 '{}': {}", path.display(), error))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "为避免原子替换改变符号链接语义，禁止直接修改符号链接 '{}'",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!("'{}' 不是普通文件", path.display()));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("无法读取文件 '{}': {}", path.display(), error))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| format!("文件 '{}' 不是 UTF-8 文本", path.display()))?;
    Ok(FileSnapshot {
        sha256: sha256_hex(&bytes),
        bytes: bytes.len(),
        content,
        permissions: metadata.permissions(),
    })
}

fn atomic_write_text(
    path: &Path,
    content: &str,
    permissions: Option<Permissions>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("写入路径 '{}' 缺少父目录", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建目录 '{}': {}", parent.display(), error))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let temp_path = parent.join(format!(
        ".{}.morphz-tmp-{}-{}",
        file_name,
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| {
                format!(
                    "无法创建原子写入临时文件 '{}': {}",
                    temp_path.display(),
                    error
                )
            })?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("写入临时文件失败: {}", error))?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)
                .map_err(|error| format!("保留文件权限失败: {}", error))?;
        }
        file.sync_all()
            .map_err(|error| format!("同步临时文件失败: {}", error))?;
        drop(file);
        std::fs::rename(&temp_path, path).map_err(|error| {
            format!(
                "原子替换 '{}' -> '{}' 失败: {}",
                temp_path.display(),
                path.display(),
                error
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn diff_line_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.bytes().filter(|byte| *byte == b'\n').count() + usize::from(!text.ends_with('\n'))
    }
}

fn prefix_lines(text: &str, prefix: char) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut output = String::new();
    for segment in text.split_inclusive('\n') {
        output.push(prefix);
        output.push_str(segment);
    }
    if !text.ends_with('\n') && !output.ends_with('\n') {
        output.push('\n');
    }
    output
}

fn replacement_diff(path: &str, hunks: &[(usize, usize, usize, String, String)]) -> String {
    let mut diff = format!("--- a/{path}\n+++ b/{path}\n");
    for (old_start, old_count, new_start, old_text, new_text) in hunks {
        diff.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old_start,
            old_count,
            new_start,
            diff_line_count(new_text)
        ));
        diff.push_str(&prefix_lines(old_text, '-'));
        diff.push_str(&prefix_lines(new_text, '+'));
    }
    diff
}

fn bounded_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head = text.chars().take(max_chars).collect::<String>();
    format!(
        "{}\n...[diff 截断，原文 {} 字符]",
        head,
        text.chars().count()
    )
}

struct FileChangeRecord<'a> {
    path: &'a str,
    operation: &'a str,
    before_sha256: Option<&'a str>,
    after_sha256: &'a str,
    bytes_before: usize,
    bytes_after: usize,
    diff: &'a str,
}

async fn publish_file_change(
    bus: Option<&Arc<crate::event::InMemoryEventBus>>,
    change: FileChangeRecord<'_>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(bus) = bus else {
        return Ok(());
    };
    let session_id = CURRENT_SESSION_ID
        .try_with(Clone::clone)
        .unwrap_or_else(|_| "default_session".to_string());
    let context_id = CURRENT_CONTEXT_ID
        .try_with(Clone::clone)
        .unwrap_or_else(|_| session_id.clone());
    let payload = vec![
        ("context_id".to_string(), serde_json::json!(context_id)),
        ("session_id".to_string(), serde_json::json!(session_id)),
        ("path".to_string(), serde_json::json!(change.path)),
        ("operation".to_string(), serde_json::json!(change.operation)),
        (
            "before_sha256".to_string(),
            serde_json::json!(change.before_sha256),
        ),
        (
            "after_sha256".to_string(),
            serde_json::json!(change.after_sha256),
        ),
        (
            "bytes_before".to_string(),
            serde_json::json!(change.bytes_before),
        ),
        (
            "bytes_after".to_string(),
            serde_json::json!(change.bytes_after),
        ),
        ("diff".to_string(), serde_json::json!(change.diff)),
        (
            "text".to_string(),
            serde_json::json!(format!(
                "文件变更已提交：operation={} path={} sha256={}\n{}",
                change.operation,
                change.path,
                change.after_sha256,
                bounded_text(change.diff, 8_000)
            )),
        ),
    ]
    .into_iter()
    .collect();
    bus.publish(Event::new(
        format!(
            "file_change_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ),
        "System-CodingTools".to_string(),
        TYPE_FILE_CHANGE.to_string(),
        "chat/file_change".to_string(),
        payload,
    ))
    .await?;
    Ok(())
}

// ==========================================
// 1. WriteFileTool 工业级路径与权限容错
// ==========================================
pub struct WriteFileTool {
    security: Arc<ToolSecurityConfig>,
    bus: Option<Arc<crate::event::InMemoryEventBus>>,
}

impl WriteFileTool {
    pub fn new(security: Arc<ToolSecurityConfig>) -> Self {
        Self {
            security,
            bus: None,
        }
    }

    pub fn new_with_bus(
        security: Arc<ToolSecurityConfig>,
        bus: Arc<crate::event::InMemoryEventBus>,
    ) -> Self {
        Self {
            security,
            bus: Some(bus),
        }
    }
}

impl Default for WriteFileTool {
    fn default() -> Self {
        Self::new(Arc::new(ToolSecurityConfig::default()))
    }
}

#[derive(Deserialize)]
struct WriteFileArgs {
    path: String,
    content: String,
    mode: String,
    expected_sha256: Option<String>,
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
                },
                "mode": {
                    "type": "string",
                    "enum": ["create", "overwrite"],
                    "description": "create 只允许新文件；overwrite 只允许已存在文件且必须提供 expected_sha256"
                },
                "expected_sha256": {
                    "type": "string",
                    "description": "overwrite 必填，必须等于最近一次 read 返回的 SHA-256；不一致时拒绝覆盖"
                }
            },
            "required": ["path", "content", "mode"]
        });

        ToolDefinition {
            name: "write".to_string(),
            description: "原子创建或显式覆盖 UTF-8 文本文件。修改既有代码优先使用 edit；overwrite 必须携带 read 返回的 expected_sha256，防止覆盖并发变化。成功后返回 diff/hash 并产生 file_change observation。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: WriteFileArgs = serde_json::from_str(arguments)?;
        let absolute_path = match resolve_tool_path(&args.path, ToolAccess::Write, &self.security) {
            Ok(path) => path,
            Err(e) => return Ok(format!("系统报错：写入路径被安全策略拒绝：{}", e)),
        };

        let (operation, before_content, before_sha256, before_bytes, permissions) = match args
            .mode
            .as_str()
        {
            "create" => {
                if absolute_path.exists() {
                    return Err(format!(
                        "create 拒绝覆盖已存在文件 '{}'；请先 read，再使用 edit 或 overwrite",
                        args.path
                    )
                    .into());
                }
                ("create", String::new(), None, 0, None)
            }
            "overwrite" => {
                if !absolute_path.exists() {
                    return Err(format!(
                        "overwrite 目标 '{}' 不存在；创建新文件请使用 mode=create",
                        args.path
                    )
                    .into());
                }
                let snapshot = read_text_snapshot(&absolute_path)?;
                let expected = args
                    .expected_sha256
                    .as_deref()
                    .ok_or("overwrite 必须提供最近一次 read 返回的 expected_sha256")?;
                if expected != snapshot.sha256 {
                    return Err(format!(
                            "文件版本冲突：'{}' 当前 sha256={}，expected_sha256={}。请重新 read 后再修改",
                            args.path, snapshot.sha256, expected
                        )
                        .into());
                }
                (
                    "overwrite",
                    snapshot.content,
                    Some(snapshot.sha256),
                    snapshot.bytes,
                    Some(snapshot.permissions),
                )
            }
            other => {
                return Err(
                    format!("write.mode 只支持 create 或 overwrite，实际为 '{other}'").into(),
                )
            }
        };

        atomic_write_text(&absolute_path, &args.content, permissions)?;
        let after_sha256 = sha256_hex(args.content.as_bytes());
        let diff = replacement_diff(
            &args.path,
            &[(
                1,
                diff_line_count(&before_content),
                1,
                before_content,
                args.content.clone(),
            )],
        );
        publish_file_change(
            self.bus.as_ref(),
            FileChangeRecord {
                path: &args.path,
                operation,
                before_sha256: before_sha256.as_deref(),
                after_sha256: &after_sha256,
                bytes_before: before_bytes,
                bytes_after: args.content.len(),
                diff: &diff,
            },
        )
        .await?;
        Ok(format!(
            "文件写入成功：operation={} path={} bytes={} sha256={}\n{}",
            operation,
            args.path,
            args.content.len(),
            after_sha256,
            bounded_text(&diff, 8_000)
        ))
    }
}

// ==========================================
// 2. ReadFileTool 工业级路径与权限容错
// ==========================================
pub struct ReadFileTool {
    security: Arc<ToolSecurityConfig>,
}

impl ReadFileTool {
    pub fn new(security: Arc<ToolSecurityConfig>) -> Self {
        Self { security }
    }
}

impl Default for ReadFileTool {
    fn default() -> Self {
        Self::new(Arc::new(ToolSecurityConfig::default()))
    }
}

#[derive(Deserialize)]
struct ReadFileArgs {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    query: Option<String>,
    context_lines: Option<usize>,
    max_matches: Option<usize>,
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
                },
                "start_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "可选，1-based 起始行；与 end_line 配合精确读取"
                },
                "end_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "可选，1-based 包含式结束行"
                },
                "query": {
                    "type": "string",
                    "description": "可选，在文件中进行大小写不敏感的字面文本查询，并返回带行号的匹配上下文；查证具体实现时优先使用，避免重复读取整文件或调用 grep"
                },
                "context_lines": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 20,
                    "description": "query 每个匹配前后的上下文行数，默认 3"
                },
                "max_matches": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "query 最多展示的匹配数，默认 20"
                }
            },
            "required": ["path"]
        });

        ToolDefinition {
            name: "read".to_string(),
            description: "读取指定路径的 UTF-8 文件，并始终返回 bytes 与 SHA-256 版本标识，供后续 edit/overwrite 使用。短文件可只传 path；长文件应使用 query 查找带行号的窄证据，或使用 start_line/end_line 精确分页。"
                .to_string(),
            parameters: params_json,
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ReadFileArgs = serde_json::from_str(arguments)?;
        let absolute_path = match resolve_tool_path(&args.path, ToolAccess::Read, &self.security) {
            Ok(path) => path,
            Err(e) => return Ok(format!("系统报错：读取路径被安全策略拒绝：{}", e)),
        };

        if !absolute_path.exists() {
            return Ok(format!(
                "系统报错：读取失败。指定的文件路径 '{}' 不存在，请检查路径是否正确。",
                args.path
            ));
        }

        match tokio::fs::read_to_string(&absolute_path).await {
            Ok(content) => {
                let sha256 = sha256_hex(content.as_bytes());
                let header = format!(
                    "[path={}, bytes={}, sha256={}]\n",
                    args.path,
                    content.len(),
                    sha256
                );
                if args.query.is_none() && args.start_line.is_none() && args.end_line.is_none() {
                    return Ok(format!("{}{}", header, content));
                }
                Ok(format!("{}{}", header, select_file_lines(&content, &args)?))
            }
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    return Ok(format!("系统报错：无权限读取文件 '{}'。请检查操作系统权限设置或更换有读取权限的路径。", absolute_path.display()));
                }
                Ok(format!(
                    "系统报错：读取文件 '{}' 失败，原因: {:?}",
                    absolute_path.display(),
                    e
                ))
            }
        }
    }
}

fn select_file_lines(
    content: &str,
    args: &ReadFileArgs,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let lines = content.lines().collect::<Vec<_>>();
    let total = lines.len();
    let start = args.start_line.unwrap_or(1);
    let end = args.end_line.unwrap_or(total).min(total);
    if start == 0 || (total > 0 && start > total) || end < start {
        return Err(format!(
            "无效行范围：start_line={}，end_line={}，文件共 {} 行",
            start, end, total
        )
        .into());
    }

    let mut selected = BTreeSet::new();
    let mut match_count = 0usize;
    let mut shown_matches = 0usize;
    if let Some(query) = args.query.as_deref() {
        let query = query.trim();
        if query.is_empty() {
            return Err("query 不能为空字符串".into());
        }
        let needle = query.to_lowercase();
        let context = args.context_lines.unwrap_or(3).min(20);
        let max_matches = args.max_matches.unwrap_or(20).clamp(1, 100);
        for line_number in start..=end {
            if lines[line_number - 1].to_lowercase().contains(&needle) {
                match_count += 1;
                if shown_matches < max_matches {
                    shown_matches += 1;
                    let context_start = line_number.saturating_sub(context).max(start);
                    let context_end = line_number.saturating_add(context).min(end);
                    selected.extend(context_start..=context_end);
                }
            }
        }
    } else if total > 0 {
        selected.extend(start..=end);
    }

    let mut output = if let Some(query) = args.query.as_deref() {
        format!(
            "[query={query:?}, matches={match_count}, shown={shown_matches}, lines={start}..{end}, total-lines={total}]\n"
        )
    } else {
        format!("[lines={start}..{end}, total-lines={total}]\n")
    };
    for line_number in selected {
        output.push_str(&format!(
            "{:>6} | {}\n",
            line_number,
            lines[line_number - 1]
        ));
    }
    Ok(output)
}

// ==========================================
// 3. EditFileTool — 带版本前提的精确局部编辑
// ==========================================
pub struct EditFileTool {
    security: Arc<ToolSecurityConfig>,
    bus: Option<Arc<crate::event::InMemoryEventBus>>,
}

impl EditFileTool {
    pub fn new(security: Arc<ToolSecurityConfig>) -> Self {
        Self {
            security,
            bus: None,
        }
    }

    pub fn new_with_bus(
        security: Arc<ToolSecurityConfig>,
        bus: Arc<crate::event::InMemoryEventBus>,
    ) -> Self {
        Self {
            security,
            bus: Some(bus),
        }
    }
}

#[derive(Deserialize)]
struct ExactEdit {
    old_text: String,
    new_text: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Deserialize)]
struct EditFileArgs {
    path: String,
    expected_sha256: String,
    edits: Vec<ExactEdit>,
}

struct PlannedReplacement {
    start: usize,
    end: usize,
    old_text: String,
    new_text: String,
}

#[async_trait::async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "edit".to_string(),
            description: "对已读取的 UTF-8 文件执行带 SHA-256 版本前提的精确文本替换。默认要求 old_text 在原文件中唯一匹配；需要替换全部匹配时显式设置 replace_all=true。全部编辑先校验、再原子提交，成功后返回 diff/hash 并产生 file_change observation。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "工作区内已存在的文本文件" },
                    "expected_sha256": { "type": "string", "description": "最近一次 read 返回的完整 SHA-256" },
                    "edits": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_text": { "type": "string", "minLength": 1, "description": "必须在原文件中精确出现的文本" },
                                "new_text": { "type": "string", "description": "替换后的文本；空字符串表示删除" },
                                "replace_all": { "type": "boolean", "default": false, "description": "false 时 old_text 必须唯一；true 时替换全部匹配" }
                            },
                            "required": ["old_text", "new_text"]
                        }
                    }
                },
                "required": ["path", "expected_sha256", "edits"]
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: EditFileArgs = serde_json::from_str(arguments)?;
        if args.edits.is_empty() {
            return Err("edit.edits 至少需要一项".into());
        }
        let absolute_path = resolve_tool_path(&args.path, ToolAccess::Write, &self.security)?;
        let snapshot = read_text_snapshot(&absolute_path)?;
        if snapshot.sha256 != args.expected_sha256 {
            return Err(format!(
                "文件版本冲突：'{}' 当前 sha256={}，expected_sha256={}。请重新 read 后再编辑",
                args.path, snapshot.sha256, args.expected_sha256
            )
            .into());
        }

        let mut replacements = Vec::new();
        for (index, edit) in args.edits.iter().enumerate() {
            if edit.old_text.is_empty() {
                return Err(format!("edit.edits[{index}].old_text 不能为空").into());
            }
            let matches = snapshot
                .content
                .match_indices(&edit.old_text)
                .map(|(start, _)| start)
                .collect::<Vec<_>>();
            if matches.is_empty() {
                return Err(format!(
                    "edit.edits[{index}] 的 old_text 在 '{}' 中没有精确匹配；请重新 read 并扩大上下文",
                    args.path
                )
                .into());
            }
            if !edit.replace_all && matches.len() != 1 {
                return Err(format!(
                    "edit.edits[{index}] 的 old_text 匹配 {} 次；默认编辑要求唯一匹配。请扩大 old_text 上下文，或明确设置 replace_all=true",
                    matches.len()
                )
                .into());
            }
            for start in matches
                .into_iter()
                .take(if edit.replace_all { usize::MAX } else { 1 })
            {
                replacements.push(PlannedReplacement {
                    start,
                    end: start + edit.old_text.len(),
                    old_text: edit.old_text.clone(),
                    new_text: edit.new_text.clone(),
                });
            }
        }
        replacements.sort_by_key(|replacement| replacement.start);
        for pair in replacements.windows(2) {
            if pair[0].end > pair[1].start {
                return Err("edit 中的两个替换范围发生重叠；请合并为一个更大的精确替换".into());
            }
        }

        let mut updated = String::with_capacity(snapshot.content.len());
        let mut cursor = 0usize;
        let mut line_delta = 0isize;
        let mut hunks = Vec::new();
        for replacement in &replacements {
            updated.push_str(&snapshot.content[cursor..replacement.start]);
            updated.push_str(&replacement.new_text);
            let old_start = snapshot.content[..replacement.start]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count()
                + 1;
            let new_start = old_start.saturating_add_signed(line_delta);
            let old_count = diff_line_count(&replacement.old_text);
            let new_count = diff_line_count(&replacement.new_text);
            hunks.push((
                old_start,
                old_count,
                new_start,
                replacement.old_text.clone(),
                replacement.new_text.clone(),
            ));
            line_delta += new_count as isize - old_count as isize;
            cursor = replacement.end;
        }
        updated.push_str(&snapshot.content[cursor..]);
        if updated == snapshot.content {
            return Err("edit 没有产生任何内容变化".into());
        }

        atomic_write_text(&absolute_path, &updated, Some(snapshot.permissions.clone()))?;
        let after_sha256 = sha256_hex(updated.as_bytes());
        let diff = replacement_diff(&args.path, &hunks);
        publish_file_change(
            self.bus.as_ref(),
            FileChangeRecord {
                path: &args.path,
                operation: "edit",
                before_sha256: Some(&snapshot.sha256),
                after_sha256: &after_sha256,
                bytes_before: snapshot.bytes,
                bytes_after: updated.len(),
                diff: &diff,
            },
        )
        .await?;
        Ok(format!(
            "文件编辑成功：path={} replacements={} bytes={} sha256={}\n{}",
            args.path,
            replacements.len(),
            updated.len(),
            after_sha256,
            bounded_text(&diff, 8_000)
        ))
    }
}

// ==========================================
// 4. ListFilesTool / SearchTool — 结构化代码发现
// ==========================================
pub struct ListFilesTool {
    security: Arc<ToolSecurityConfig>,
}

impl ListFilesTool {
    pub fn new(security: Arc<ToolSecurityConfig>) -> Self {
        Self { security }
    }
}

#[derive(Deserialize)]
struct ListFilesArgs {
    #[serde(default = "default_dot")]
    path: String,
    #[serde(default = "default_all_glob")]
    glob: String,
    #[serde(default = "default_list_limit")]
    max_results: usize,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    include_directories: bool,
}

fn default_dot() -> String {
    ".".to_string()
}

fn default_all_glob() -> String {
    "**/*".to_string()
}

fn default_list_limit() -> usize {
    500
}

fn is_hidden_relative(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|part| part.starts_with('.') && part != ".")
    })
}

fn matches_glob(pattern: &Pattern, pattern_text: &str, relative: &str) -> bool {
    pattern.matches(relative)
        || pattern_text
            .strip_prefix("**/")
            .and_then(|tail| Pattern::new(tail).ok())
            .is_some_and(|tail| tail.matches(relative))
}

fn candidate_allowed(candidate: &Path, security: &ToolSecurityConfig, access: ToolAccess) -> bool {
    let workspace = std::fs::canonicalize(&security.workspace_root).ok();
    let input = workspace
        .as_deref()
        .and_then(|root| candidate.strip_prefix(root).ok())
        .map(|relative| relative.to_string_lossy().to_string())
        .unwrap_or_else(|| candidate.to_string_lossy().to_string());
    resolve_tool_path(&input, access, security).is_ok()
}

fn discovery_entries(
    root: &Path,
    include_hidden: bool,
    security: &ToolSecurityConfig,
) -> Vec<walkdir::DirEntry> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.path() == root
                || include_hidden
                || !is_hidden_relative(entry.path().strip_prefix(root).unwrap_or(entry.path()))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.path() != root)
        .filter(|entry| candidate_allowed(entry.path(), security, ToolAccess::Read))
        .collect()
}

#[async_trait::async_trait]
impl Tool for ListFilesTool {
    fn name(&self) -> &str {
        "list_files"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "list_files".to_string(),
            description: "在 workspace jail 内递归发现文件。支持 glob、结果上限和隐藏文件控制；用于代码导航，避免通过 exec/ls/find 产生不受控输出。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "default": ".", "description": "搜索根目录" },
                    "glob": { "type": "string", "default": "**/*", "description": "相对于 path 的 glob，例如 **/*.rs" },
                    "max_results": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 500 },
                    "include_hidden": { "type": "boolean", "default": false },
                    "include_directories": { "type": "boolean", "default": false }
                }
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ListFilesArgs = serde_json::from_str(arguments)?;
        let root = resolve_tool_path(&args.path, ToolAccess::Read, &self.security)?;
        if !root.is_dir() {
            return Err(format!("list_files.path '{}' 不是目录", args.path).into());
        }
        let pattern = Pattern::new(&args.glob)
            .map_err(|error| format!("无效 glob '{}': {}", args.glob, error))?;
        let limit = args.max_results.clamp(1, 2_000);
        let mut matches = Vec::new();
        let mut truncated = false;
        for entry in discovery_entries(&root, args.include_hidden, &self.security) {
            if !args.include_directories && !entry.file_type().is_file() {
                continue;
            }
            let relative = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            if !matches_glob(&pattern, &args.glob, &relative_text) {
                continue;
            }
            if matches.len() == limit {
                truncated = true;
                break;
            }
            let kind = if entry.file_type().is_dir() {
                "dir"
            } else {
                "file"
            };
            let bytes = entry.metadata().ok().map(|metadata| metadata.len());
            matches.push(serde_json::json!({
                "path": relative_text,
                "kind": kind,
                "bytes": bytes,
            }));
        }
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "root": args.path,
            "glob": args.glob,
            "count": matches.len(),
            "truncated": truncated,
            "entries": matches,
        }))?)
    }
}

pub struct SearchTool {
    security: Arc<ToolSecurityConfig>,
}

impl SearchTool {
    pub fn new(security: Arc<ToolSecurityConfig>) -> Self {
        Self { security }
    }
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    paths: Vec<String>,
    #[serde(default = "default_all_glob")]
    glob: String,
    #[serde(default = "default_search_limit")]
    max_matches: usize,
    #[serde(default = "default_search_context")]
    context_lines: usize,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    include_hidden: bool,
}

fn default_search_limit() -> usize {
    100
}

fn default_search_context() -> usize {
    2
}

#[async_trait::async_trait]
impl Tool for SearchTool {
    fn name(&self) -> &str {
        "search"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "search".to_string(),
            description: "在 workspace jail 内对 UTF-8 源文件执行大小受限的字面文本搜索，返回路径、行号和上下文。用于定位代码，避免使用 exec/rg/grep。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "description": "字面搜索文本，不是正则表达式" },
                    "paths": { "type": "array", "minItems": 1, "items": { "type": "string" }, "description": "文件或目录列表" },
                    "glob": { "type": "string", "default": "**/*", "description": "目录内文件过滤，例如 **/*.rs" },
                    "max_matches": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "context_lines": { "type": "integer", "minimum": 0, "maximum": 20, "default": 2 },
                    "case_sensitive": { "type": "boolean", "default": false },
                    "include_hidden": { "type": "boolean", "default": false }
                },
                "required": ["query", "paths"]
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: SearchArgs = serde_json::from_str(arguments)?;
        if args.query.trim().is_empty() {
            return Err("search.query 不能为空".into());
        }
        if args.paths.is_empty() {
            return Err("search.paths 至少需要一个路径".into());
        }
        let pattern = Pattern::new(&args.glob)
            .map_err(|error| format!("无效 glob '{}': {}", args.glob, error))?;
        let limit = args.max_matches.clamp(1, 1_000);
        let context_lines = args.context_lines.min(20);
        let needle = if args.case_sensitive {
            args.query.clone()
        } else {
            args.query.to_lowercase()
        };
        let mut results = Vec::new();
        let mut truncated = false;

        'paths: for input in &args.paths {
            let resolved = resolve_tool_path(input, ToolAccess::Read, &self.security)?;
            let candidates = if resolved.is_file() {
                vec![(
                    resolved.clone(),
                    PathBuf::from(resolved.file_name().unwrap_or_default()),
                )]
            } else if resolved.is_dir() {
                discovery_entries(&resolved, args.include_hidden, &self.security)
                    .into_iter()
                    .filter(|entry| entry.file_type().is_file())
                    .map(|entry| {
                        let relative = entry
                            .path()
                            .strip_prefix(&resolved)
                            .unwrap_or(entry.path())
                            .to_path_buf();
                        (entry.into_path(), relative)
                    })
                    .collect::<Vec<_>>()
            } else {
                return Err(format!("search 路径 '{}' 不存在", input).into());
            };

            for (path, relative) in candidates {
                let relative_text = relative.to_string_lossy().replace('\\', "/");
                if !matches_glob(&pattern, &args.glob, &relative_text) {
                    continue;
                }
                let metadata = match std::fs::metadata(&path) {
                    Ok(metadata) if metadata.len() <= 2 * 1024 * 1024 => metadata,
                    _ => continue,
                };
                let _ = metadata;
                let content = match std::fs::read_to_string(&path) {
                    Ok(content) => content,
                    Err(_) => continue,
                };
                let lines = content.lines().collect::<Vec<_>>();
                for (index, line) in lines.iter().enumerate() {
                    let haystack = if args.case_sensitive {
                        (*line).to_string()
                    } else {
                        line.to_lowercase()
                    };
                    if !haystack.contains(&needle) {
                        continue;
                    }
                    if results.len() == limit {
                        truncated = true;
                        break 'paths;
                    }
                    let line_number = index + 1;
                    let start = line_number.saturating_sub(context_lines).max(1);
                    let end = line_number.saturating_add(context_lines).min(lines.len());
                    let context = (start..=end)
                        .map(|number| {
                            serde_json::json!({
                                "line": number,
                                "text": lines[number - 1],
                            })
                        })
                        .collect::<Vec<_>>();
                    results.push(serde_json::json!({
                        "path": if resolved.is_file() { input.clone() } else { format!("{}/{}", input.trim_end_matches('/'), relative_text) },
                        "line": line_number,
                        "context": context,
                    }));
                }
            }
        }
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "query": args.query,
            "count": results.len(),
            "truncated": truncated,
            "matches": results,
        }))?)
    }
}

// ==========================================
// 5. ExecuteCommandTool 异步 Detach + 进程组级销毁
// ==========================================

/// 危险命令模式黑名单 — 纵深防御层
const DANGEROUS_PATTERNS: &[&str] = &[
    ":(){:|:&};:", // fork bomb
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf .",
    "mkfs.",
    "> /dev/sda",
    "dd if=",
    "dd of=",
    "mv /* ",
    "chmod -R 777 /",
    "chown -R",
    ".env",
    ".ssh/",
    ".git/config",
];

/// 命令安全检查：匹配危险模式则拦截，返回 Err
fn check_command_safety(cmd: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let lowered = cmd.to_lowercase();
    for pattern in DANGEROUS_PATTERNS {
        if lowered.contains(&pattern.to_lowercase()) {
            return Err(format!("⛔ 命令被安全策略拦截：匹配危险模式 '{}'", pattern).into());
        }
    }
    // 额外拦截管道执行（curl/wget | sh/bash），防止远程代码注入
    let pipe_segments: Vec<&str> = cmd.split('|').collect();
    if pipe_segments.len() > 1 {
        for seg in &pipe_segments[1..] {
            let seg_trimmed = seg.trim().to_lowercase();
            if seg_trimmed.starts_with("sh")
                || seg_trimmed.starts_with("bash")
                || seg_trimmed.starts_with("zsh")
                || seg_trimmed.starts_with("python")
                || seg_trimmed.starts_with("perl")
            {
                return Err(format!(
                    "⛔ 命令被安全策略拦截：检测到管道执行模式 '...|{}'",
                    seg_trimmed
                )
                .into());
            }
        }
    }
    Ok(())
}

fn seatbelt_string(value: &Path) -> String {
    value
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn build_seatbelt_profile(workspace_root: &Path, network_enabled: bool) -> String {
    let network_rule = if network_enabled {
        "(allow network*)"
    } else {
        "(deny network*)"
    };
    let home_rules = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| {
            format!(
                "(deny file-read* (subpath \"{}\"))\n\
                 (allow file-read* (subpath \"{}\") (subpath \"{}\"))",
                seatbelt_string(&home),
                seatbelt_string(&home.join(".cargo")),
                seatbelt_string(&home.join(".rustup"))
            )
        })
        .unwrap_or_default();
    let parent_metadata = workspace_root
        .ancestors()
        .skip(1)
        .filter(|path| path.parent().is_some())
        .map(|path| format!("(literal \"{}\")", seatbelt_string(path)))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "(version 1)\n\
         (allow default)\n\
         {network_rule}\n\
         (deny file-write*)\n\
         (allow file-write* (subpath \"{}\") (literal \"/dev/null\"))\n\
         (deny file-read* (subpath \"/private/tmp\"))\n\
         {home_rules}\n\
         (allow file-read-metadata {parent_metadata})\n\
         (allow file-read* (subpath \"{}\"))\n",
        seatbelt_string(workspace_root),
        seatbelt_string(workspace_root)
    )
}

pub struct ExecuteCommandTool {
    bus: Arc<crate::event::InMemoryEventBus>,
    background_config: Arc<BackgroundTaskConfig>,
    security: Arc<ToolSecurityConfig>,
    max_sync_wait: tokio::time::Duration,
}

impl ExecuteCommandTool {
    pub fn new(bus: Arc<crate::event::InMemoryEventBus>) -> Self {
        Self::new_with_config(bus, Arc::new(BackgroundTaskConfig::default()))
    }

    pub fn new_with_config(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
    ) -> Self {
        Self::new_with_configs(
            bus,
            background_config,
            Arc::new(ToolSecurityConfig::default()),
            30,
        )
    }

    pub fn new_with_configs(
        bus: Arc<crate::event::InMemoryEventBus>,
        background_config: Arc<BackgroundTaskConfig>,
        security: Arc<ToolSecurityConfig>,
        tool_timeout_secs: u64,
    ) -> Self {
        let max_sync_wait_ms = tool_timeout_secs
            .saturating_mul(1000)
            .saturating_sub(250)
            .max(100);
        Self {
            bus,
            background_config,
            security,
            max_sync_wait: tokio::time::Duration::from_millis(max_sync_wait_ms),
        }
    }
}

#[derive(Deserialize)]
struct ExecuteCommandArgs {
    command: String,
    cwd: Option<String>,
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
                "cwd": {
                    "type": "string",
                    "description": "可选，命令工作目录；必须是 workspace_root 内已存在的目录，默认 workspace_root"
                },
                "wait_ms": {
                    "type": "integer",
                    "description": "同步等待输出的最长超时毫秒数。默认 10000 毫秒；测试/编译超过该时长后自动转入后台异步运行。"
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "同步等待输出的最长超时秒数(旧接口，建议改用 wait_ms)。"
                }
            },
            "required": ["command"]
        });

        ToolDefinition {
            name: "exec".to_string(),
            description: "在经过 workspace jail 校验的 cwd 中执行 Shell 命令。适合运行测试、编译和格式化；文件发现优先使用 list_files/search，修改优先使用 edit/write。注意：cwd 限制不等于完整容器沙箱。命令等待超时后转为后台托管。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: ExecuteCommandArgs = serde_json::from_str(arguments)?;
        let cmd_trimmed = args.command.trim();

        // 命令安全沙箱检查
        check_command_safety(cmd_trimmed)?;

        let mut session_id = args.session_id.unwrap_or_default();
        if session_id.is_empty() {
            if let Ok(fallback_id) = CURRENT_SESSION_ID.try_with(|id| id.clone()) {
                session_id = fallback_id;
            }
        }
        if session_id.is_empty() {
            session_id = "default_session".to_string();
        }
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .unwrap_or_else(|_| session_id.clone());

        use std::process::Stdio;
        use tokio::process::Command;

        let cwd_input = args.cwd.as_deref().unwrap_or(".");
        let exec_cwd = resolve_tool_path(cwd_input, ToolAccess::Write, &self.security)?;
        if !exec_cwd.is_dir() {
            return Err(format!("exec.cwd '{}' 不是已存在目录", cwd_input).into());
        }
        let exec_cwd = std::fs::canonicalize(&exec_cwd)?;
        let workspace_root = std::fs::canonicalize(&self.security.workspace_root)
            .map_err(|error| format!("无法解析 exec workspace_root: {}", error))?;
        if self.security.workspace_jail_enabled && !exec_cwd.starts_with(&workspace_root) {
            return Err(format!(
                "exec.cwd '{}' 位于 workspace_root 之外；Shell 命令只允许从工作区内启动",
                cwd_input
            )
            .into());
        }

        let sandbox_tmp = workspace_root.join(".morphz/tmp");
        std::fs::create_dir_all(&sandbox_tmp)?;
        let mut cmd = if self.security.exec_seatbelt_enabled {
            if !cfg!(target_os = "macos") {
                return Err("exec Seatbelt 目前只支持 macOS；请使用容器或关闭该模式".into());
            }
            let profile =
                build_seatbelt_profile(&workspace_root, self.security.exec_network_enabled);
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command
                .arg("-p")
                .arg(profile)
                .arg("/bin/sh")
                .arg("-c")
                .arg(cmd_trimmed);
            command
        } else {
            let mut command = Command::new("sh");
            command.arg("-c").arg(cmd_trimmed);
            command
        };
        cmd.current_dir(&exec_cwd)
            .env("TMPDIR", &sandbox_tmp)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, _) in std::env::vars() {
            let upper = key.to_ascii_uppercase();
            if upper.contains("TOKEN")
                || upper.contains("SECRET")
                || upper.contains("PASSWORD")
                || upper.contains("CREDENTIAL")
                || upper.ends_with("_KEY")
                || upper.starts_with("OPENAI_")
                || upper.starts_with("AWS_")
                || upper.starts_with("GITHUB_")
                || upper == "SSH_AUTH_SOCK"
            {
                cmd.env_remove(key);
            }
        }

        // 必须通过 pre_exec 分配独立的进程组，以便于进程组强杀
        unsafe {
            cmd.pre_exec(|| {
                let pid = nix::libc::getpid();
                nix::libc::setpgid(pid, pid);
                Ok(())
            });
        }

        let artifact_dir = std::path::PathBuf::from(&self.background_config.artifact_dir);
        std::fs::create_dir_all(&artifact_dir).map_err(|error| {
            format!(
                "无法创建 exec 原始输出归档目录 '{}': {}",
                artifact_dir.display(),
                error
            )
        })?;

        let mut child = cmd.spawn()?;
        let pid = child.id().ok_or("无法获取进程 ID")? as i32;

        let task_id = format!(
            "task_{}_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
            pid
        );
        let archive_path = artifact_dir.join(format!("{}.log", task_id));
        let archive = match std::fs::File::create(&archive_path) {
            Ok(archive) => archive,
            Err(error) => {
                let _ = child.kill().await;
                return Err(format!(
                    "无法创建 exec 原始输出归档 '{}': {}",
                    archive_path.display(),
                    error
                )
                .into());
            }
        };

        let stdout = child.stdout.take().ok_or("无法捕获 stdout 管道")?;
        let stderr = child.stderr.take().ok_or("无法捕获 stderr 管道")?;

        let bus_clone = Arc::clone(&self.bus);
        let session_id_clone = session_id.clone();
        let context_id_clone = context_id.clone();
        let task_id_clone = task_id.clone();

        // 共享缓冲区
        let buffer = Arc::new(ExecutionBuffer {
            output: std::sync::Mutex::new(String::new()),
            archive: std::sync::Mutex::new(archive),
            archive_path: archive_path.to_string_lossy().to_string(),
            truncated: AtomicBool::new(false),
            max_bytes: self.background_config.max_output_buffer_bytes,
            task_id: task_id_clone.clone(),
            bus: bus_clone,
            session_id: session_id_clone,
            context_id: context_id_clone,
        });

        // 共享的“是否开启事件发布”标志 (前 N 秒同步时不发布，转入后台时才发布)
        let publish_flag = Arc::new(AtomicBool::new(false));

        let buffer_out = Arc::clone(&buffer);
        let publish_out = Arc::clone(&publish_flag);
        let stdout_task = tokio::spawn(async move {
            monitor_pipe(stdout, buffer_out, publish_out).await;
        });

        let buffer_err = Arc::clone(&buffer);
        let publish_err = Arc::clone(&publish_flag);
        let stderr_task = tokio::spawn(async move {
            monitor_pipe(stderr, buffer_err, publish_err).await;
        });

        // 将任务先行放入全局的任务 Map 以供超时或手动 kill
        let tasks = get_tasks_map();
        let now = chrono::Utc::now();
        tasks.insert(
            task_id.clone(),
            BackgroundTask {
                id: task_id.clone(),
                cmd_str: cmd_trimmed.to_string(),
                pgid: pid,
                session_id: session_id.clone(),
                context_id: context_id.clone(),
                started_at: now,
                last_output_at: now,
                output_bytes: 0,
                timeout_notified: false,
            },
        );

        // 同步等待设定时间
        let requested_wait = if let Some(ms) = args.wait_ms {
            tokio::time::Duration::from_millis(ms)
        } else if let Some(secs) = args.timeout_secs {
            tokio::time::Duration::from_secs(secs)
        } else {
            tokio::time::Duration::from_millis(10_000)
        };
        let wait_duration = requested_wait.min(self.max_sync_wait);
        let wait_result = tokio::time::timeout(wait_duration, child.wait()).await;

        match wait_result {
            Ok(exit_status_res) => {
                // 命令在同步时间内直接执行完成
                tasks.remove(&task_id);
                // 进程退出不代表异步 pipe reader 已经消费完内核管道；必须等待两条 reader
                // 完成后再读取 preview，才能保证归档文件和返回结果包含尾部输出。
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                let code = exit_status_res
                    .map(|s| s.code().unwrap_or(-1))
                    .unwrap_or(-1);
                let output_str = buffer.get_all();
                Ok(format!(
                    "执行结束 [退出码: {}]\n--- 输出 ---\n{}",
                    code, output_str
                ))
            }
            Err(_) => {
                // 运行超时，正式脱离 (Detach) 为后台长任务
                publish_flag.store(true, Ordering::SeqCst);

                // Phase E: 后台任务达到配置阈值时只唤醒 LLM，不自动 kill。
                // 是否继续等待或调用 kill_task 由 LLM 自己决策。
                if self.background_config.timeout_notify_enabled {
                    let timeout_secs = self.background_config.timeout_notify_secs;
                    let bus_timeout = Arc::clone(&self.bus);
                    let task_id_timeout = task_id.clone();
                    let session_id_timeout = session_id.clone();
                    let context_id_timeout = context_id.clone();
                    let cmd_timeout = cmd_trimmed.to_string();
                    let buffer_timeout = Arc::clone(&buffer);
                    tokio::spawn(async move {
                        tokio::time::sleep(tokio::time::Duration::from_secs(timeout_secs)).await;
                        let tasks = get_tasks_map();
                        if let Some(mut task) = tasks.get_mut(&task_id_timeout) {
                            if task.timeout_notified {
                                return;
                            }
                            task.timeout_notified = true;
                            let elapsed_secs =
                                (chrono::Utc::now() - task.started_at).num_seconds().max(0);
                            let output_tail = tail_chars(&buffer_timeout.get_all(), 2000);

                            let mut payload = serde_json::Map::new();
                            payload.insert(
                                "context_id".to_string(),
                                serde_json::json!(context_id_timeout),
                            );
                            payload.insert(
                                "session_id".to_string(),
                                serde_json::json!(session_id_timeout),
                            );
                            payload.insert("tool_name".to_string(), serde_json::json!("exec"));
                            payload
                                .insert("task_id".to_string(), serde_json::json!(task_id_timeout));
                            payload.insert(
                                "event".to_string(),
                                serde_json::json!("background_task_timeout"),
                            );
                            payload.insert(
                                "elapsed_secs".to_string(),
                                serde_json::json!(elapsed_secs),
                            );
                            payload.insert("cmd".to_string(), serde_json::json!(cmd_timeout));
                            payload.insert(
                                "artifact_path".to_string(),
                                serde_json::json!(buffer_timeout.archive_path),
                            );
                            payload.insert("text".to_string(), serde_json::json!(format!(
                                "后台任务 {} 已运行 {} 秒仍未结束。\n--- 最近输出 ---\n{}\n\n你可以继续等待，或调用 kill_task 终止它。",
                                task_id_timeout, elapsed_secs, output_tail
                            )));

                            let ev = Event::new(
                                format!(
                                    "task_timeout_{}_{}",
                                    task_id_timeout,
                                    chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                                ),
                                "System-TaskMonitor".to_string(),
                                crate::event::TYPE_TOOL_OUTPUT.to_string(),
                                "chat/tool_output".to_string(),
                                payload,
                            );
                            drop(task);
                            let _ = bus_timeout.publish(ev).await;
                        }
                    });
                }

                // 启动一个后台协程，在进程最终退出时清理 map 并发送完成事件通知大模型
                let bus_cleanup = Arc::clone(&self.bus);
                let task_id_cleanup = task_id.clone();
                let session_id_cleanup = session_id.clone();
                let context_id_cleanup = context_id.clone();
                let buffer_cleanup = Arc::clone(&buffer);
                tokio::spawn(async move {
                    let wait_res = child.wait().await;
                    let _ = stdout_task.await;
                    let _ = stderr_task.await;
                    let tasks_cleanup = get_tasks_map();
                    tasks_cleanup.remove(&task_id_cleanup);

                    let code = wait_res.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                    let output_str = buffer_cleanup.get_all();

                    let mut payload = serde_json::Map::new();
                    payload.insert(
                        "context_id".to_string(),
                        serde_json::json!(context_id_cleanup),
                    );
                    payload.insert(
                        "session_id".to_string(),
                        serde_json::json!(session_id_cleanup),
                    );
                    payload.insert("task_id".to_string(), serde_json::json!(task_id_cleanup));
                    payload.insert(
                        "artifact_path".to_string(),
                        serde_json::json!(buffer_cleanup.archive_path),
                    );
                    payload.insert(
                        "text".to_string(),
                        serde_json::json!(format!(
                            "\n[后台任务 {} 执行结束，退出码: {}]\n--- 输出 ---\n{}",
                            task_id_cleanup, code, output_str
                        )),
                    );

                    let ev = Event::new(
                        format!(
                            "task_exit_{}_{}",
                            task_id_cleanup,
                            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
                        ),
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
                    "[任务已转入后台异步运行，任务 ID: {}]\n完整原始输出持续归档到 {}。命令已运行了超过 {} 最大同步时间。您可以在后续 Inbox 中查收事件输出，或调用 kill_task 强杀它。",
                    task_id, buffer.archive_path, elapsed_str
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
            description:
                "强行终止失控或已无用处的后台托管 Shell 任务，释放其占用的全部进程树及物理资源。"
                    .to_string(),
            parameters: params_json,
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: KillTaskArgs = serde_json::from_str(arguments)?;
        let tasks = get_tasks_map();

        if let Some((_, task)) = tasks.remove(&args.task_id) {
            let pgid = nix::unistd::Pid::from_raw(-task.pgid); // 负数代表杀死整个进程组
            match nix::sys::signal::kill(pgid, nix::sys::signal::Signal::SIGKILL) {
                Ok(_) => Ok(format!(
                    "成功强杀后台任务 {}，其下属的子孙进程组 {} 已彻底清理。",
                    args.task_id, task.pgid
                )),
                Err(e) => {
                    if e == nix::errno::Errno::ESRCH {
                        Ok(format!(
                            "后台任务 {} 此前已自动退出，进程组 {} 已不在运行。",
                            args.task_id, task.pgid
                        ))
                    } else {
                        Err(format!("强杀进程组 {} 遭遇系统级错误: {:?}", task.pgid, e).into())
                    }
                }
            }
        } else {
            Ok(format!(
                "系统报错：未找到活跃的后台任务 ID '{}'，该任务可能已提前结束。",
                args.task_id
            ))
        }
    }
}

// ==========================================
// 6. SpawnAgentTool 并发子智能体派生
// ==========================================
pub struct SpawnAgentTool {
    bus: Arc<crate::event::InMemoryEventBus>,
}

pub struct DelegateTool {
    bus: Arc<InMemoryEventBus>,
}

impl DelegateTool {
    pub fn new(bus: Arc<InMemoryEventBus>) -> Self {
        Self { bus }
    }
}

#[derive(Deserialize)]
struct DelegateArgs {
    task: String,
    #[serde(default)]
    success_when: Option<String>,
    #[serde(default = "default_delegation_scope")]
    context_scope: String,
}

fn default_delegation_scope() -> String {
    "current_session".to_string()
}

#[async_trait::async_trait]
impl Tool for DelegateTool {
    fn name(&self) -> &str {
        "delegate"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "delegate".to_string(),
            description: "把一项较重任务委派给隔离的 Sub Agent。默认继承共享 Mind 与当前 Session 的证据，隔离兄弟 Session；Sub Agent 不能直接修改父 Mind，完成结果会作为 delegate Tool Observation 返回当前 Session，由你验证、回复或整合进共享 Mind。调用立即返回 delegation_id，Sub Agent 在后台继续执行。".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "交给 Sub Agent 的完整任务"
                    },
                    "success_when": {
                        "type": "string",
                        "description": "可验证的完成条件"
                    },
                    "context_scope": {
                        "type": "string",
                        "enum": ["current_session", "mind_only"],
                        "description": "current_session 继承 Mind 与当前 Session；mind_only 只继承 Mind",
                        "default": "current_session"
                    }
                },
                "required": ["task"]
            }),
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let args: DelegateArgs = serde_json::from_str(arguments)?;
        if args.task.trim().is_empty() {
            return Err("delegate.task 不能为空".into());
        }
        if !matches!(args.context_scope.as_str(), "current_session" | "mind_only") {
            return Err(format!("不支持的 delegate.context_scope: {}", args.context_scope).into());
        }
        let parent_session_id = CURRENT_SESSION_ID
            .try_with(Clone::clone)
            .map_err(|_| "delegate 必须在 Session 求值中调用")?;
        let parent_context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .map_err(|_| "delegate 缺少当前 Context 路由")?;
        let suffix = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
        let delegation_id = format!("delegation_{suffix}");
        let child_context_id = format!("delegate-context-{suffix}");
        let child_session_id = format!("delegate-session-{suffix}");
        let payload = vec![
            (
                "context_id".to_string(),
                serde_json::json!(parent_context_id),
            ),
            (
                "session_id".to_string(),
                serde_json::json!(parent_session_id),
            ),
            (
                "parent_context_id".to_string(),
                serde_json::json!(parent_context_id),
            ),
            (
                "parent_session_id".to_string(),
                serde_json::json!(parent_session_id),
            ),
            (
                "delegation_id".to_string(),
                serde_json::json!(delegation_id),
            ),
            (
                "child_context_id".to_string(),
                serde_json::json!(child_context_id),
            ),
            (
                "child_session_id".to_string(),
                serde_json::json!(child_session_id),
            ),
            ("task".to_string(), serde_json::json!(args.task)),
            (
                "success_when".to_string(),
                serde_json::json!(args.success_when),
            ),
            (
                "context_scope".to_string(),
                serde_json::json!(args.context_scope),
            ),
            (
                "text".to_string(),
                serde_json::json!("Delegation requested"),
            ),
        ]
        .into_iter()
        .collect();
        self.bus
            .publish(Event::new(
                format!("delegate_request_{suffix}"),
                format!("Parent-Agent-{parent_session_id}"),
                crate::event::TYPE_AGENT_CALL.to_string(),
                "chat/delegate".to_string(),
                payload,
            ))
            .await?;
        Ok(serde_json::json!({
            "delegation_id": delegation_id,
            "status": "queued",
            "child_context_id": child_context_id,
            "child_session_id": child_session_id,
            "guidance": "Sub Agent 已排队；完成结果会作为新的 delegate Tool Observation 返回当前 Session。"
        })
        .to_string())
    }
}

impl SpawnAgentTool {
    pub fn new(bus: Arc<crate::event::InMemoryEventBus>) -> Self {
        Self { bus }
    }
}

#[derive(Deserialize)]
struct SpawnAgentArgs {
    sub_session_id: String,
    #[serde(default)]
    parent_session_id: String,
    delegation: String,
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
                "delegation": {
                    "type": "string",
                    "description": "父 Agent 主动选择并传递的 SExpr 委托 Frame，例如 (delegation (goal ...) (success-when ...) (constraints ...) (evidence-refs ...))。不要传递完整父 Context。"
                }
            },
            "required": ["sub_session_id", "delegation"]
        });

        ToolDefinition {
            name: "spawn".to_string(),
            description: "在后台并发启动一个新的子智能体协程，专门处理独立的子任务。此工具为非阻塞，调用后立即返回。".to_string(),
            parameters: params_json,
        }
    }

    async fn execute(
        &self,
        arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut val: serde_json::Value = serde_json::from_str(arguments)?;

        if let Some(obj) = val.as_object_mut() {
            let has_parent = obj
                .get("parent_session_id")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

            if !has_parent {
                if let Ok(fallback_id) = CURRENT_SESSION_ID.try_with(|id| id.clone()) {
                    obj.insert(
                        "parent_session_id".to_string(),
                        serde_json::json!(fallback_id),
                    );
                }
            }
        }

        let args: SpawnAgentArgs = serde_json::from_value(val)?;
        let context_id = CURRENT_CONTEXT_ID
            .try_with(Clone::clone)
            .unwrap_or_else(|_| args.parent_session_id.clone());

        let mut payload = serde_json::Map::new();
        payload.insert("context_id".to_string(), serde_json::json!(context_id));
        payload.insert(
            "session_id".to_string(),
            serde_json::json!(args.sub_session_id),
        );
        payload.insert(
            "parent_session_id".to_string(),
            serde_json::json!(args.parent_session_id),
        );
        payload.insert("delegation".to_string(), serde_json::json!(args.delegation));
        payload.insert(
            "text".to_string(),
            serde_json::json!(format!("Spawning agent {}...", args.sub_session_id)),
        );

        let ev = Event::new(
            format!(
                "spawn_{}",
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            format!("Parent-Agent-{}", args.parent_session_id),
            crate::event::TYPE_AGENT_CALL.to_string(),
            "chat/spawn".to_string(),
            payload,
        );

        self.bus.publish(ev).await?;

        Ok(format!(
            "子智能体 {} 成功排队并提交，正在启动并发心智协程...",
            args.sub_session_id
        ))
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

    async fn execute(
        &self,
        _arguments: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
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
                        let mut name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let mut description = "无详细描述".to_string();

                        if let Some(stripped) = content.strip_prefix("---") {
                            if let Some(end_idx) = stripped.find("---") {
                                let yaml_part = &stripped[..end_idx];
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
                        skill_list.push(format!(
                            "- 技能名称: {}\n  描述: {}\n  路径: {}",
                            name,
                            description,
                            skill_md_path.to_string_lossy()
                        ));
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

fn tail_chars(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    let tail: String = s.chars().skip(total - max_chars).collect();
    format!("... [前 {} 字符已省略]\n{}", total - max_chars, tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Weak;
    use tempfile::{NamedTempFile, TempDir};

    struct ReplacementDefinitionTool;

    #[async_trait::async_trait]
    impl Tool for ReplacementDefinitionTool {
        fn name(&self) -> &str {
            "reentrant-definition"
        }

        fn definition(&self) -> ToolDefinition {
            ToolDefinition {
                name: self.name().to_string(),
                description: "replacement".to_string(),
                parameters: serde_json::json!({ "type": "object" }),
            }
        }

        async fn execute(
            &self,
            _arguments: &str,
        ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            Ok(String::new())
        }
    }

    struct ReentrantDefinitionTool {
        registry: Weak<Registry>,
    }

    #[async_trait::async_trait]
    impl Tool for ReentrantDefinitionTool {
        fn name(&self) -> &str {
            "reentrant-definition"
        }

        fn definition(&self) -> ToolDefinition {
            self.registry
                .upgrade()
                .unwrap()
                .register(Arc::new(ReplacementDefinitionTool));
            ToolDefinition {
                name: self.name().to_string(),
                description: "original".to_string(),
                parameters: serde_json::json!({ "type": "object" }),
            }
        }

        async fn execute(
            &self,
            _arguments: &str,
        ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            Ok(String::new())
        }
    }

    /// 测试用：关闭 workspace jail 与绝对路径限制，允许任意路径访问
    fn permissive_security() -> Arc<ToolSecurityConfig> {
        Arc::new(ToolSecurityConfig {
            workspace_jail_enabled: false,
            allow_absolute_paths: true,
            allow_parent_traversal: true,
            ..ToolSecurityConfig::default()
        })
    }

    fn jailed_security(root: &Path) -> Arc<ToolSecurityConfig> {
        Arc::new(ToolSecurityConfig {
            workspace_jail_enabled: true,
            workspace_root: root.to_string_lossy().to_string(),
            allow_absolute_paths: false,
            allow_parent_traversal: false,
            extra_read_roots: Vec::new(),
            extra_write_roots: Vec::new(),
            ..ToolSecurityConfig::default()
        })
    }

    fn hash_from_read(output: &str) -> &str {
        output
            .lines()
            .next()
            .and_then(|header| header.split("sha256=").nth(1))
            .and_then(|tail| tail.strip_suffix(']'))
            .expect("read output should contain sha256 header")
    }

    #[test]
    fn registry_caches_definitions_without_running_tool_code_during_reads() {
        let registry = Arc::new(Registry::new());
        registry.register(Arc::new(ReentrantDefinitionTool {
            registry: Arc::downgrade(&registry),
        }));

        let definitions = registry.definitions();

        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].description, "original");
        assert_eq!(registry.definitions()[0].description, "original");
    }

    #[tokio::test]
    async fn test_file_tools() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.txt");
        let path_str = path.to_str().unwrap().to_string();

        let write_tool = WriteFileTool::new(permissive_security());
        let read_tool = ReadFileTool::new(permissive_security());

        let write_args = serde_json::json!({
            "path": path_str,
            "content": "hello rust tool",
            "mode": "create"
        });

        let write_res = write_tool.execute(&write_args.to_string()).await.unwrap();
        assert!(write_res.contains("成功"));

        let read_args = serde_json::json!({
            "path": path_str
        });

        let read_res = read_tool.execute(&read_args.to_string()).await.unwrap();
        assert!(read_res.ends_with("hello rust tool"));
        let hash = hash_from_read(&read_res).to_string();

        let overwrite_res = write_tool
            .execute(
                &serde_json::json!({
                    "path": path_str,
                    "content": "updated",
                    "mode": "overwrite",
                    "expected_sha256": hash,
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(overwrite_res.contains("operation=overwrite"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "updated");
    }

    #[tokio::test]
    async fn test_write_rejects_create_overwrite_and_stale_hash() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("existing.txt");
        std::fs::write(&path, "original").unwrap();
        let write_tool = WriteFileTool::new(jailed_security(tmp.path()));

        let create_error = write_tool
            .execute(
                &serde_json::json!({
                    "path": "existing.txt",
                    "content": "clobber",
                    "mode": "create"
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(create_error.to_string().contains("拒绝覆盖"));

        let stale_error = write_tool
            .execute(
                &serde_json::json!({
                    "path": "existing.txt",
                    "content": "clobber",
                    "mode": "overwrite",
                    "expected_sha256": "stale"
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(stale_error.to_string().contains("版本冲突"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "original");
    }

    #[tokio::test]
    async fn test_edit_is_versioned_atomic_and_emits_file_change() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("src.rs");
        std::fs::write(&path, "fn answer() -> i32 {\n    41\n}\n").unwrap();
        let security = jailed_security(tmp.path());
        let read_tool = ReadFileTool::new(Arc::clone(&security));
        let read_output = read_tool
            .execute(&serde_json::json!({ "path": "src.rs" }).to_string())
            .await
            .unwrap();
        let expected_sha256 = hash_from_read(&read_output).to_string();

        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        bus.subscribe(
            "chat/file_change".to_string(),
            Arc::new(move |event| {
                let sender = sender.clone();
                Box::pin(async move { sender.send(event).await.map_err(|error| error.into()) })
            }),
        );
        let edit_tool = EditFileTool::new_with_bus(security, Arc::clone(&bus));
        let result = CURRENT_SESSION_ID
            .scope("coding-session".to_string(), async {
                edit_tool
                    .execute(
                        &serde_json::json!({
                            "path": "src.rs",
                            "expected_sha256": expected_sha256,
                            "edits": [{
                                "old_text": "    41",
                                "new_text": "    42"
                            }]
                        })
                        .to_string(),
                    )
                    .await
            })
            .await
            .unwrap();
        assert!(result.contains("-    41"));
        assert!(result.contains("+    42"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "fn answer() -> i32 {\n    42\n}\n"
        );
        let event = tokio::time::timeout(tokio::time::Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event_type, TYPE_FILE_CHANGE);
        assert_eq!(
            event
                .payload
                .get("session_id")
                .and_then(|value| value.as_str()),
            Some("coding-session")
        );
        assert_eq!(
            event
                .payload
                .get("operation")
                .and_then(|value| value.as_str()),
            Some("edit")
        );
    }

    #[tokio::test]
    async fn test_edit_rejects_stale_hash_and_ambiguous_match_without_writing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("duplicate.txt");
        std::fs::write(&path, "same\nsame\n").unwrap();
        let edit_tool = EditFileTool::new(jailed_security(tmp.path()));

        let stale = edit_tool
            .execute(
                &serde_json::json!({
                    "path": "duplicate.txt",
                    "expected_sha256": "stale",
                    "edits": [{ "old_text": "same", "new_text": "new" }]
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(stale.to_string().contains("版本冲突"));

        let hash = sha256_hex(b"same\nsame\n");
        let ambiguous = edit_tool
            .execute(
                &serde_json::json!({
                    "path": "duplicate.txt",
                    "expected_sha256": hash,
                    "edits": [{ "old_text": "same", "new_text": "new" }]
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(ambiguous.to_string().contains("匹配 2 次"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "same\nsame\n");
    }

    #[tokio::test]
    async fn test_read_file_query_and_line_range_return_numbered_evidence() {
        let tmp_file = NamedTempFile::new().unwrap();
        std::fs::write(
            tmp_file.path(),
            "alpha\ncontext before\nRetire requires reason\ncontext after\nomega\n",
        )
        .unwrap();
        let read_tool = ReadFileTool::new(permissive_security());

        let query_result = read_tool
            .execute(
                &serde_json::json!({
                    "path": tmp_file.path(),
                    "query": "retire requires",
                    "context_lines": 1
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(query_result.contains("matches=1"));
        assert!(query_result.contains("     2 | context before"));
        assert!(query_result.contains("     3 | Retire requires reason"));
        assert!(query_result.contains("     4 | context after"));
        assert!(!query_result.contains("alpha"));

        let range_result = read_tool
            .execute(
                &serde_json::json!({
                    "path": tmp_file.path(),
                    "start_line": 3,
                    "end_line": 4
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(range_result.contains("lines=3..4"));
        assert!(range_result.contains("     3 | Retire requires reason"));
        assert!(!range_result.contains("context before"));
    }

    #[tokio::test]
    async fn test_list_files_and_search_are_scoped_and_structured() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::create_dir_all(tmp.path().join("target")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".hidden")).unwrap();
        std::fs::write(
            tmp.path().join("src/lib.rs"),
            "pub fn alpha() {}\npub fn answer() -> i32 { 42 }\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("src/readme.txt"), "answer text\n").unwrap();
        std::fs::write(tmp.path().join("target/generated.rs"), "answer\n").unwrap();
        std::fs::write(tmp.path().join(".hidden/secret.rs"), "answer\n").unwrap();
        let security = jailed_security(tmp.path());

        let list_tool = ListFilesTool::new(Arc::clone(&security));
        let listed: serde_json::Value = serde_json::from_str(
            &list_tool
                .execute(
                    &serde_json::json!({
                        "path": ".",
                        "glob": "**/*.rs"
                    })
                    .to_string(),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "src/lib.rs");

        let search_tool = SearchTool::new(security);
        let searched: serde_json::Value = serde_json::from_str(
            &search_tool
                .execute(
                    &serde_json::json!({
                        "query": "answer",
                        "paths": ["src"],
                        "glob": "**/*.rs",
                        "context_lines": 1
                    })
                    .to_string(),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(searched["count"], 1);
        assert_eq!(searched["matches"][0]["path"], "src/lib.rs");
        assert_eq!(searched["matches"][0]["line"], 2);
        assert_eq!(searched["matches"][0]["context"][0]["line"], 1);
    }

    #[tokio::test]
    async fn test_coding_tools_end_to_end_bugfix() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(
            tmp.path().join("src/lib.rs"),
            "pub fn parse_retry_after(value: &str) -> Option<u64> {\n    value.parse().ok()\n}\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("check.rs"),
            "#[path = \"src/lib.rs\"]\nmod lib;\n\n#[test]\nfn accepts_whitespace() {\n    assert_eq!(lib::parse_retry_after(\" 120 \\t\"), Some(120));\n}\n",
        )
        .unwrap();
        let security = jailed_security(tmp.path());

        let list = ListFilesTool::new(Arc::clone(&security))
            .execute(&serde_json::json!({ "path": ".", "glob": "**/*.rs" }).to_string())
            .await
            .unwrap();
        assert!(list.contains("src/lib.rs"));

        let search = SearchTool::new(Arc::clone(&security))
            .execute(
                &serde_json::json!({
                    "query": "parse_retry_after",
                    "paths": ["src"],
                    "glob": "**/*.rs"
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(search.contains("src/lib.rs"));

        let read_tool = ReadFileTool::new(Arc::clone(&security));
        let read = read_tool
            .execute(&serde_json::json!({ "path": "src/lib.rs" }).to_string())
            .await
            .unwrap();
        let expected_sha256 = hash_from_read(&read).to_string();
        EditFileTool::new(Arc::clone(&security))
            .execute(
                &serde_json::json!({
                    "path": "src/lib.rs",
                    "expected_sha256": expected_sha256,
                    "edits": [{
                        "old_text": "value.parse().ok()",
                        "new_text": "value.trim().parse().ok()"
                    }]
                })
                .to_string(),
            )
            .await
            .unwrap();

        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let background = Arc::new(BackgroundTaskConfig {
            artifact_dir: tmp.path().join("artifacts").to_string_lossy().to_string(),
            ..BackgroundTaskConfig::default()
        });
        let result = ExecuteCommandTool::new_with_configs(bus, background, security, 30)
            .execute(
                &serde_json::json!({
                    "cwd": ".",
                    "command": "rustc --edition=2021 --test check.rs -o check-bin && ./check-bin",
                    "wait_ms": 5000
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(result.contains("退出码: 0"));
        assert!(result.contains("1 passed"));
    }

    #[tokio::test]
    async fn test_tool_path_permission_fallback() {
        let read_tool = ReadFileTool::new(permissive_security());
        // 读取一个显然不存在的文件目录，校验是否返回了优雅的容错字符串而不是 panic
        let bad_args = serde_json::json!({
            "path": "/obviously_not_exist_dir/no_file.txt"
        });
        let res = read_tool.execute(&bad_args.to_string()).await.unwrap();
        assert!(res.contains("不存在") || res.contains("系统报错"));
    }

    #[tokio::test]
    async fn test_workspace_jail_blocks_absolute_path() {
        // 默认安全配置：禁止绝对路径
        let read_tool = ReadFileTool::new(Arc::new(ToolSecurityConfig::default()));
        let bad_args = serde_json::json!({
            "path": "/etc/passwd"
        });
        let res = read_tool.execute(&bad_args.to_string()).await.unwrap();
        assert!(res.contains("安全策略") || res.contains("系统报错"));
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
    async fn test_exec_cwd_is_restricted_to_workspace() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("crate-a")).unwrap();
        let security = jailed_security(tmp.path());
        let background = Arc::new(BackgroundTaskConfig {
            artifact_dir: tmp.path().join("artifacts").to_string_lossy().to_string(),
            ..BackgroundTaskConfig::default()
        });
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let tool = ExecuteCommandTool::new_with_configs(bus, background, security, 30);

        let result = tool
            .execute(
                &serde_json::json!({
                    "command": "pwd",
                    "cwd": "crate-a"
                })
                .to_string(),
            )
            .await
            .unwrap();
        assert!(result.contains("crate-a"));

        let rejected = tool
            .execute(
                &serde_json::json!({
                    "command": "pwd",
                    "cwd": "/tmp"
                })
                .to_string(),
            )
            .await
            .unwrap_err();
        assert!(rejected.to_string().contains("绝对路径") || rejected.to_string().contains("之外"));
    }

    #[tokio::test]
    async fn test_exec_archives_full_output_when_context_preview_is_truncated() {
        let tmp = TempDir::new().unwrap();
        let bus = Arc::new(crate::event::InMemoryEventBus::new());
        let background = Arc::new(BackgroundTaskConfig {
            max_output_buffer_bytes: 5,
            artifact_dir: tmp.path().to_string_lossy().to_string(),
            ..BackgroundTaskConfig::default()
        });
        let tool = ExecuteCommandTool::new_with_configs(bus, background, permissive_security(), 30);
        let result = tool
            .execute(&serde_json::json!({ "command": "printf abcdefghi" }).to_string())
            .await
            .unwrap();
        assert!(result.contains("Context preview 已按缓冲上限截断"));

        let archive_path = std::fs::read_dir(tmp.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(std::fs::read_to_string(archive_path).unwrap(), "abcdefghi");
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

    #[test]
    fn test_execution_buffer_keeps_bounded_utf8_tail() {
        let archive_file = NamedTempFile::new().unwrap();
        let archive_path = archive_file.path().to_string_lossy().to_string();
        let buffer = ExecutionBuffer {
            output: std::sync::Mutex::new(String::new()),
            archive: std::sync::Mutex::new(std::fs::File::create(&archive_path).unwrap()),
            archive_path: archive_path.clone(),
            truncated: AtomicBool::new(false),
            max_bytes: 5,
            task_id: "buffer_test".to_string(),
            bus: Arc::new(crate::event::InMemoryEventBus::new()),
            session_id: "session_test".to_string(),
            context_id: "context_test".to_string(),
        };

        buffer.append("你好world", false);
        let output = buffer.get_all();
        assert!(output.contains("完整原始输出"));
        assert!(output.ends_with("world"));
        assert_eq!(std::fs::read_to_string(archive_path).unwrap(), "你好world");
    }
}
