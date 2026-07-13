use crate::permission::{
    ApprovalPolicy, PermissionConfig, PermissionMode, ReviewerKind, SandboxMode,
};
use serde::{Deserialize, Deserializer};
use std::fs::File;
use std::io::{self, BufRead, BufReader};

/// 零依赖的极简 .env 环境变量加载器，读取文件并注入到系统环境变量中
pub fn load_env(filepath: &str) -> io::Result<()> {
    let file = File::open(filepath)?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((key, val)) = trimmed.split_once('=') {
            let key = key.trim();
            let mut val_str = val.trim();

            // 剥离行尾的 # 注释
            if let Some(idx) = val_str.find('#') {
                val_str = val_str[..idx].trim();
            }

            // 剥离单双引号
            let val_cleaned = val_str.trim_matches(|c| c == '"' || c == '\'');
            // 显式进程环境变量优先于 .env，避免部署注入值或测试隔离值被本地文件覆盖。
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, val_cleaned);
            }
        }
    }
    Ok(())
}

// ==========================================
// 工业化集中配置 (Industrial Centralized Config)
// ==========================================

/// Orchestrator 运行时配置 — 消除散落的魔法数字
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct OrchestratorConfig {
    /// 并发信号量限制
    pub concurrency_limit: usize,
    /// 单条 Delegation 链允许的最大嵌套深度。根 Agent 派生第一个 Sub Agent 计为 1。
    pub max_delegation_depth: usize,
    /// 同一 Agent 同时处于 queued/running 的 Delegation 总数上限。
    pub max_active_delegations_per_agent: usize,
    /// 等待最终回复期间的进度提示间隔（秒）；0 表示不提示。
    ///
    /// 这不是任务超时：交互端会持续等待，直到 Agent 回复或用户主动中断。
    #[serde(alias = "reply_timeout_secs")]
    pub reply_wait_notice_secs: u64,
    /// 工具执行超时（秒）
    pub tool_timeout_secs: u64,
    /// 完整一次 LLM Attempt 的绝对超时（包含 Client 内部重试与响应解析）
    pub model_attempt_timeout_secs: u64,
    /// Agent-Owned Context 的 warning 软阈值（估算 Token）
    pub context_soft_token_limit: usize,
    /// Agent-Owned Context 的物理硬阈值（估算 Token）
    pub context_hard_token_limit: usize,
    /// 预留给 Agent 执行 Context 自维护的 Token 空间
    pub context_maintenance_reserve_tokens: usize,
    /// 单条原始 Observation 在 Context 中展示的最大字符数；原文仍保留在 Ledger
    pub observation_preview_chars: usize,
    /// 单条用户消息的模型求值软检查点间隔；只提示复盘，不限制任务继续执行。
    #[serde(alias = "max_attempts_per_turn")]
    pub attempt_soft_checkpoint_interval: usize,
    /// 单个用户回合允许提交的 Context transaction 次数；不限制物理工具或回复
    pub max_context_transactions_per_turn: usize,
    /// 是否允许同一 Context 中同时就绪的多个 Session 合并为一次模型求值。
    pub merged_evaluation_enabled: bool,
    /// 收集近同时到达消息的短窗口；只增加首个消息最多该数值的调度延迟。
    pub session_batch_coalesce_ms: u64,
    /// 一次合并求值最多包含的 ready Session 数。
    pub max_sessions_per_evaluation: usize,
    /// 是否在 Ledger 中保留完整 Context Encoding 与模型消息。
    /// 默认仅保存内容哈希和尺寸；实时事件订阅仍能看到完整内容。
    pub persist_full_context_inspect: bool,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            concurrency_limit: 4,
            max_delegation_depth: 3,
            max_active_delegations_per_agent: 8,
            reply_wait_notice_secs: 120,
            tool_timeout_secs: 30,
            model_attempt_timeout_secs: 180,
            context_soft_token_limit: 196_608,
            context_hard_token_limit: 262_144,
            context_maintenance_reserve_tokens: 32_768,
            observation_preview_chars: 16_000,
            attempt_soft_checkpoint_interval: 90,
            max_context_transactions_per_turn: 6,
            merged_evaluation_enabled: false,
            session_batch_coalesce_ms: 25,
            max_sessions_per_evaluation: 8,
            persist_full_context_inspect: false,
        }
    }
}

/// Core SQLite persistence configuration. Recall extensions own retrieval and
/// embedding settings outside the Runtime core.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MemoryConfig {
    /// SQLite 连接池大小
    pub sqlite_pool_size: u32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            sqlite_pool_size: 8,
        }
    }
}

/// 服务器与网络配置
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// Web 服务器绑定地址
    pub bind: String,
    /// 数据库文件路径
    pub database_path: String,
    /// WebSocket 广播通道容量
    pub broadcast_capacity: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".to_string(),
            database_path: "morphz.db".to_string(),
            broadcast_capacity: 1000,
        }
    }
}

/// LLM 客户端配置
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct LlmConfig {
    /// 主要模型名称
    pub model: String,
    /// 重试最大次数
    pub max_retries: u32,
    /// 初始重试退避秒数
    pub initial_backoff_secs: u64,
    /// 单次 HTTP 请求（包含响应体读取）的超时秒数
    pub request_timeout_secs: u64,
    /// 单次 completion 最大输出 Token；None 表示由模型服务决定默认值
    pub max_output_tokens: Option<u32>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            model: "gpt-4o-mini".to_string(),
            max_retries: 5,
            initial_backoff_secs: 1,
            request_timeout_secs: 120,
            max_output_tokens: None,
        }
    }
}

/// 旧版 [tool_security] 仅用于无损迁移配置文件，不再进入 Runtime。
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct LegacyToolSecurityConfig {
    pub workspace_jail_enabled: bool,
    pub workspace_root: String,
    pub allow_absolute_paths: bool,
    pub allow_parent_traversal: bool,
    pub extra_read_roots: Vec<String>,
    pub extra_write_roots: Vec<String>,
    pub deny_patterns: Vec<String>,
    /// 通过当前操作系统的原生 Backend 为 exec 子进程树施加文件系统/网络隔离。
    /// 兼容读取旧配置名 exec_seatbelt_enabled。
    #[serde(alias = "exec_seatbelt_enabled")]
    pub exec_sandbox_enabled: bool,
    /// 原生沙箱开启时是否允许 exec 子进程访问网络。
    pub exec_network_enabled: bool,
}

impl Default for LegacyToolSecurityConfig {
    fn default() -> Self {
        Self {
            workspace_jail_enabled: true,
            workspace_root: ".".to_string(),
            allow_absolute_paths: false,
            allow_parent_traversal: false,
            extra_read_roots: vec!["/tmp".to_string()],
            extra_write_roots: vec!["/tmp".to_string()],
            deny_patterns: vec![
                ".env".to_string(),
                ".env.*".to_string(),
                ".git/**".to_string(),
                "**/.ssh/**".to_string(),
                "target/**".to_string(),
                "*.safetensors".to_string(),
                "*.onnx".to_string(),
            ],
            // 默认要求沙箱存在。未实现或未验证的平台必须 fail-closed，
            // 只有操作者显式关闭该开关时才允许退回未隔离 Shell。
            exec_sandbox_enabled: true,
            exec_network_enabled: false,
        }
    }
}

impl LegacyToolSecurityConfig {
    fn migrate(self) -> PermissionConfig {
        let fully_unconfined = !self.workspace_jail_enabled && !self.exec_sandbox_enabled;
        let mut protected_paths = self
            .deny_patterns
            .into_iter()
            .map(|pattern| match pattern.as_str() {
                ".env" => "**/.env".to_string(),
                ".env.*" => "**/.env.*".to_string(),
                ".git/**" => "**/.git/**".to_string(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>();
        protected_paths.sort();
        protected_paths.dedup();
        PermissionConfig {
            mode: if fully_unconfined {
                PermissionMode::FullAccess
            } else {
                PermissionMode::Custom
            },
            workspace_root: self.workspace_root,
            read_roots: self.extra_read_roots,
            write_roots: self.extra_write_roots,
            protected_paths,
            network: self.exec_network_enabled,
            sandbox_mode: if self.exec_sandbox_enabled {
                SandboxMode::WorkspaceWrite
            } else {
                SandboxMode::DangerFullAccess
            },
            approval_policy: if fully_unconfined {
                ApprovalPolicy::Never
            } else {
                ApprovalPolicy::OnRequest
            },
            reviewer: ReviewerKind::AutoReview,
            ..PermissionConfig::default()
        }
    }
}

/// 后台任务配置：Runtime 只负责超时通知，不自动 kill。
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct BackgroundTaskConfig {
    pub timeout_notify_enabled: bool,
    pub timeout_notify_secs: u64,
    pub max_output_buffer_bytes: usize,
    /// 后台 stdout/stderr 合并后再发布事件的窗口，避免逐行放大 Ledger。
    pub output_event_coalesce_ms: u64,
    /// 单条后台输出事件的最大字符数；完整内容始终保留在 artifact。
    pub max_output_event_chars: usize,
    /// exec 完整原始输出归档目录；Context 中只放受控 preview 和此稳定文件引用
    pub artifact_dir: String,
}

impl Default for BackgroundTaskConfig {
    fn default() -> Self {
        Self {
            timeout_notify_enabled: true,
            timeout_notify_secs: 300,
            max_output_buffer_bytes: 65_536,
            output_event_coalesce_ms: 500,
            max_output_event_chars: 8_192,
            artifact_dir: ".morphz/artifacts".to_string(),
        }
    }
}

/// 工业化全局配置（聚合所有子配置）
#[derive(Debug, Clone, Default)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub orchestrator: OrchestratorConfig,
    pub memory: MemoryConfig,
    pub llm: LlmConfig,
    pub permissions: PermissionConfig,
    pub background_task: BackgroundTaskConfig,
}

#[derive(Deserialize, Default)]
struct AppConfigWire {
    #[serde(default)]
    server: ServerConfig,
    #[serde(default)]
    orchestrator: OrchestratorConfig,
    #[serde(default)]
    memory: MemoryConfig,
    #[serde(default)]
    llm: LlmConfig,
    permissions: Option<PermissionConfig>,
    tool_security: Option<LegacyToolSecurityConfig>,
    #[serde(default)]
    background_task: BackgroundTaskConfig,
}

impl<'de> Deserialize<'de> for AppConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = AppConfigWire::deserialize(deserializer)?;
        let permissions = wire
            .permissions
            .or_else(|| wire.tool_security.map(LegacyToolSecurityConfig::migrate))
            .unwrap_or_default();
        Ok(Self {
            server: wire.server,
            orchestrator: wire.orchestrator,
            memory: wire.memory,
            llm: wire.llm,
            permissions,
            background_task: wire.background_task,
        })
    }
}

impl AppConfig {
    /// 从 TOML 文件加载配置。文件不存在时返回默认配置。
    pub fn load_or_default(path: &str) -> Self {
        match std::fs::read_to_string(path) {
            Ok(content) => match toml::from_str::<AppConfig>(&content) {
                Ok(cfg) => cfg,
                Err(e) => {
                    eprintln!("⚠️ [Config] 解析 {} 失败 ({}), 使用默认配置", path, e);
                    AppConfig::default()
                }
            },
            Err(_) => AppConfig::default(),
        }
    }

    /// 应用只影响物理运行边界的环境覆盖，便于为单次评测启动独立 Sandbox。
    pub fn apply_runtime_env_overrides(&mut self) -> Result<(), String> {
        if let Ok(root) = std::env::var("MORPHZ_WORKSPACE_ROOT") {
            if !root.trim().is_empty() {
                self.permissions.workspace_root = root;
                // 严格评测模式下不继承默认 /tmp extra roots，避免文件工具逃逸。
                self.permissions.read_roots.clear();
                self.permissions.write_roots.clear();
            }
        }
        if let Ok(path) = std::env::var("MORPHZ_ARTIFACT_DIR") {
            if !path.trim().is_empty() {
                self.background_task.artifact_dir = path.clone();
                if std::env::var("MORPHZ_CODING_EVAL_MODE")
                    .ok()
                    .and_then(|value| parse_env_bool(&value))
                    == Some(true)
                {
                    self.permissions.read_roots.push(path);
                }
            }
        }
        let sandbox_override = std::env::var("MORPHZ_EXEC_SANDBOX")
            .ok()
            .map(|value| ("MORPHZ_EXEC_SANDBOX", value))
            .or_else(|| {
                std::env::var("MORPHZ_EXEC_SEATBELT")
                    .ok()
                    .map(|value| ("MORPHZ_EXEC_SEATBELT", value))
            });
        if let Some((name, value)) = sandbox_override {
            let enabled =
                parse_env_bool(&value).ok_or_else(|| format!("{name} 不是合法布尔值: {value}"))?;
            eprintln!("⚠️ [Config] {name} 已废弃；请改用 MORPHZ_PERMISSION_MODE 或 [permissions]");
            self.permissions.mode = PermissionMode::Custom;
            self.permissions.sandbox_mode = if enabled {
                SandboxMode::WorkspaceWrite
            } else {
                SandboxMode::DangerFullAccess
            };
            if !enabled {
                self.permissions.approval_policy = ApprovalPolicy::Never;
            }
        }
        if let Ok(value) = std::env::var("MORPHZ_EXEC_NETWORK") {
            self.permissions.network = parse_env_bool(&value)
                .ok_or_else(|| format!("MORPHZ_EXEC_NETWORK 不是合法布尔值: {value}"))?;
        }
        if let Ok(value) = std::env::var("MORPHZ_PERMISSION_MODE") {
            self.permissions.mode = match value.trim().to_ascii_lowercase().as_str() {
                "request_approval" | "request-approval" | "ask" => PermissionMode::RequestApproval,
                "auto_review" | "auto-review" | "auto" => PermissionMode::AutoReview,
                "full_access" | "full-access" | "danger_full_access" => PermissionMode::FullAccess,
                "custom" => PermissionMode::Custom,
                _ => return Err(format!("MORPHZ_PERMISSION_MODE 不是合法模式: {value}")),
            };
        }
        apply_usize_env(
            "MORPHZ_CONTEXT_SOFT_TOKEN_LIMIT",
            &mut self.orchestrator.context_soft_token_limit,
        )?;
        apply_usize_env(
            "MORPHZ_CONTEXT_HARD_TOKEN_LIMIT",
            &mut self.orchestrator.context_hard_token_limit,
        )?;
        apply_usize_env(
            "MORPHZ_CONTEXT_MAINTENANCE_RESERVE_TOKENS",
            &mut self.orchestrator.context_maintenance_reserve_tokens,
        )?;
        apply_usize_env(
            "MORPHZ_OBSERVATION_PREVIEW_CHARS",
            &mut self.orchestrator.observation_preview_chars,
        )?;
        apply_u64_env(
            "MORPHZ_LLM_REQUEST_TIMEOUT_SECS",
            &mut self.llm.request_timeout_secs,
        )?;
        apply_u64_env(
            "MORPHZ_MODEL_ATTEMPT_TIMEOUT_SECS",
            &mut self.orchestrator.model_attempt_timeout_secs,
        )?;
        apply_u64_env(
            "MORPHZ_REPLY_WAIT_NOTICE_SECS",
            &mut self.orchestrator.reply_wait_notice_secs,
        )?;
        // 兼容旧配置名；它现在只控制等待提示间隔，不再终止等待。
        if std::env::var_os("MORPHZ_REPLY_WAIT_NOTICE_SECS").is_none() {
            apply_u64_env(
                "MORPHZ_REPLY_TIMEOUT_SECS",
                &mut self.orchestrator.reply_wait_notice_secs,
            )?;
        }
        apply_usize_env(
            "MORPHZ_ATTEMPT_SOFT_CHECKPOINT_INTERVAL",
            &mut self.orchestrator.attempt_soft_checkpoint_interval,
        )?;
        apply_usize_env(
            "MORPHZ_MAX_DELEGATION_DEPTH",
            &mut self.orchestrator.max_delegation_depth,
        )?;
        apply_usize_env(
            "MORPHZ_MAX_ACTIVE_DELEGATIONS_PER_AGENT",
            &mut self.orchestrator.max_active_delegations_per_agent,
        )?;
        apply_u32_env("MORPHZ_LLM_MAX_RETRIES", &mut self.llm.max_retries)?;
        apply_optional_u32_env(
            "MORPHZ_LLM_MAX_OUTPUT_TOKENS",
            &mut self.llm.max_output_tokens,
        )?;
        if let Ok(value) = std::env::var("MORPHZ_MERGED_EVALUATION_ENABLED") {
            self.orchestrator.merged_evaluation_enabled =
                parse_env_bool(&value).ok_or_else(|| {
                    format!("MORPHZ_MERGED_EVALUATION_ENABLED 不是合法布尔值: {value}")
                })?;
        }
        apply_u64_env(
            "MORPHZ_SESSION_BATCH_COALESCE_MS",
            &mut self.orchestrator.session_batch_coalesce_ms,
        )?;
        apply_usize_env(
            "MORPHZ_MAX_SESSIONS_PER_EVALUATION",
            &mut self.orchestrator.max_sessions_per_evaluation,
        )?;
        Ok(())
    }
}

fn apply_usize_env(name: &str, target: &mut usize) -> Result<(), String> {
    let Ok(value) = std::env::var(name) else {
        return Ok(());
    };
    let parsed = value
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("{name} 不是合法正整数: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} 必须大于 0"));
    }
    *target = parsed;
    Ok(())
}

fn apply_u64_env(name: &str, target: &mut u64) -> Result<(), String> {
    let Ok(value) = std::env::var(name) else {
        return Ok(());
    };
    let parsed = value
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("{name} 不是合法正整数: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} 必须大于 0"));
    }
    *target = parsed;
    Ok(())
}

fn apply_u32_env(name: &str, target: &mut u32) -> Result<(), String> {
    let Ok(value) = std::env::var(name) else {
        return Ok(());
    };
    let parsed = value
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("{name} 不是合法正整数: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} 必须大于 0"));
    }
    *target = parsed;
    Ok(())
}

fn apply_optional_u32_env(name: &str, target: &mut Option<u32>) -> Result<(), String> {
    let Ok(value) = std::env::var(name) else {
        return Ok(());
    };
    let parsed = value
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("{name} 不是合法正整数: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} 必须大于 0"));
    }
    *target = Some(parsed);
    Ok(())
}

fn parse_env_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_load_env() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "TEST_KEY_1 = value1").unwrap();
        writeln!(tmp_file, "TEST_KEY_2 = 'value2' # comment").unwrap();
        writeln!(tmp_file, "# TEST_KEY_3 = value3").unwrap();
        writeln!(tmp_file, "TEST_KEY_4 = \"value4\"").unwrap();

        load_env(tmp_file.path().to_str().unwrap()).unwrap();

        assert_eq!(std::env::var("TEST_KEY_1").unwrap(), "value1");
        assert_eq!(std::env::var("TEST_KEY_2").unwrap(), "value2");
        assert!(std::env::var("TEST_KEY_3").is_err());
        assert_eq!(std::env::var("TEST_KEY_4").unwrap(), "value4");
    }

    #[test]
    fn test_load_env_does_not_override_process_environment() {
        let key = "MORPHZ_TEST_EXPLICIT_ENV_WINS";
        std::env::set_var(key, "process-value");
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "{}=dotenv-value", key).unwrap();

        load_env(tmp_file.path().to_str().unwrap()).unwrap();

        assert_eq!(std::env::var(key).unwrap(), "process-value");
        std::env::remove_var(key);
    }

    #[test]
    fn test_app_config_defaults() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
        assert_eq!(cfg.orchestrator.concurrency_limit, 4);
        assert_eq!(cfg.orchestrator.max_delegation_depth, 3);
        assert_eq!(cfg.orchestrator.max_active_delegations_per_agent, 8);
        assert_eq!(cfg.memory.sqlite_pool_size, 8);
        assert_eq!(cfg.llm.max_retries, 5);
        assert_eq!(cfg.llm.request_timeout_secs, 120);
        assert_eq!(cfg.llm.max_output_tokens, None);
        assert_eq!(cfg.orchestrator.reply_wait_notice_secs, 120);
        assert_eq!(cfg.orchestrator.attempt_soft_checkpoint_interval, 90);
        assert!(!cfg.orchestrator.merged_evaluation_enabled);
        assert_eq!(cfg.permissions.mode, PermissionMode::AutoReview);
        assert_eq!(cfg.background_task.timeout_notify_secs, 300);
    }

    #[test]
    fn test_app_config_load_or_default_missing_file() {
        let cfg = AppConfig::load_or_default("/nonexistent/path/morphz.toml");
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
    }

    #[test]
    fn test_app_config_load_partial_toml() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[server]").unwrap();
        writeln!(tmp_file, "bind = \"0.0.0.0:9000\"").unwrap();
        writeln!(tmp_file, "database_path = \"test.db\"").unwrap();
        writeln!(tmp_file, "broadcast_capacity = 2000").unwrap();

        let cfg = AppConfig::load_or_default(tmp_file.path().to_str().unwrap());
        assert_eq!(cfg.server.bind, "0.0.0.0:9000");
        assert_eq!(cfg.server.database_path, "test.db");
        // 未指定的部分应使用默认值
        assert_eq!(cfg.orchestrator.concurrency_limit, 4);
    }

    #[test]
    fn test_partial_section_uses_field_defaults() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[orchestrator]").unwrap();
        writeln!(tmp_file, "concurrency_limit = 2").unwrap();

        let cfg = AppConfig::load_or_default(tmp_file.path().to_str().unwrap());
        assert_eq!(cfg.orchestrator.concurrency_limit, 2);
        assert_eq!(cfg.orchestrator.tool_timeout_secs, 30);
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
    }

    #[test]
    fn legacy_tool_security_section_migrates_into_unified_permissions() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[tool_security]").unwrap();
        writeln!(tmp_file, "workspace_root = \".\"").unwrap();
        writeln!(tmp_file, "extra_read_roots = []").unwrap();
        writeln!(tmp_file, "extra_write_roots = []").unwrap();
        writeln!(tmp_file, "exec_network_enabled = true").unwrap();

        let cfg = AppConfig::load_or_default(tmp_file.path().to_str().unwrap());
        assert_eq!(cfg.permissions.mode, PermissionMode::Custom);
        assert_eq!(cfg.permissions.sandbox_mode, SandboxMode::WorkspaceWrite);
        assert!(cfg.permissions.network);
        assert!(cfg
            .permissions
            .protected_paths
            .iter()
            .any(|pattern| pattern == "**/.git/**"));
    }

    #[test]
    fn new_permissions_section_takes_precedence_over_legacy_section() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[permissions]").unwrap();
        writeln!(tmp_file, "mode = \"full_access\"").unwrap();
        writeln!(tmp_file, "\n[tool_security]").unwrap();
        writeln!(tmp_file, "workspace_jail_enabled = true").unwrap();

        let cfg = AppConfig::load_or_default(tmp_file.path().to_str().unwrap());
        assert_eq!(cfg.permissions.mode, PermissionMode::FullAccess);
    }

    #[test]
    fn test_legacy_timeout_and_attempt_names_map_to_non_terminal_controls() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[orchestrator]").unwrap();
        writeln!(tmp_file, "reply_timeout_secs = 7").unwrap();
        writeln!(tmp_file, "max_attempts_per_turn = 11").unwrap();

        let cfg = AppConfig::load_or_default(tmp_file.path().to_str().unwrap());
        assert_eq!(cfg.orchestrator.reply_wait_notice_secs, 7);
        assert_eq!(cfg.orchestrator.attempt_soft_checkpoint_interval, 11);
    }

    #[test]
    fn test_partial_llm_section_configures_request_timeout_and_retries() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[llm]").unwrap();
        writeln!(tmp_file, "request_timeout_secs = 7").unwrap();
        writeln!(tmp_file, "max_retries = 1").unwrap();
        writeln!(tmp_file, "max_output_tokens = 131072").unwrap();

        let cfg = AppConfig::load_or_default(tmp_file.path().to_str().unwrap());
        assert_eq!(cfg.llm.request_timeout_secs, 7);
        assert_eq!(cfg.llm.max_retries, 1);
        assert_eq!(cfg.llm.max_output_tokens, Some(131_072));
        assert_eq!(cfg.llm.model, "gpt-4o-mini");
    }
}
