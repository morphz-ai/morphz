use serde::Deserialize;
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
    /// 回复等待超时（秒）
    pub reply_timeout_secs: u64,
    /// 工具执行超时（秒）
    pub tool_timeout_secs: u64,
    /// Agent-Owned Context 的 warning 软阈值（估算 Token）
    pub context_soft_token_limit: usize,
    /// Agent-Owned Context 的物理硬阈值（估算 Token）
    pub context_hard_token_limit: usize,
    /// 预留给 Agent 执行 Context 自维护的 Token 空间
    pub context_maintenance_reserve_tokens: usize,
    /// 单条原始 Observation 在 Context 中展示的最大字符数；原文仍保留在 Ledger
    pub observation_preview_chars: usize,
    /// 单条用户消息的 Attempt 上限；达到上限时进入一次 context_tx-only 收口，再无工具回复
    pub max_attempts_per_turn: usize,
    /// 普通 work 阶段允许提交的 Context transaction 次数；最终收口另有一次保留机会
    pub max_context_transactions_per_turn: usize,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            concurrency_limit: 4,
            reply_timeout_secs: 120,
            tool_timeout_secs: 30,
            context_soft_token_limit: 60_000,
            context_hard_token_limit: 100_000,
            context_maintenance_reserve_tokens: 12_000,
            observation_preview_chars: 4_000,
            max_attempts_per_turn: 12,
            max_context_transactions_per_turn: 6,
        }
    }
}

/// 记忆与检索配置
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MemoryConfig {
    /// SQLite 连接池大小
    pub sqlite_pool_size: u32,
    /// FTS5 搜索结果上限
    pub fts_search_limit: usize,
    /// 向量检索结果上限
    pub vector_search_limit: usize,
    /// 语义过渡锚点候选数
    pub transition_anchor_count: usize,
    /// Embedding 相似度低阈值（语义过渡）
    pub semantic_low_threshold: f32,
    /// Embedding 相似度高阈值（语义过渡）
    pub semantic_high_threshold: f32,
    /// 向量检索过滤阈值（低维 hashing）
    pub vector_filter_threshold_low: f32,
    /// 向量检索过滤阈值（BGE 高维）
    pub vector_filter_threshold_high: f32,
    /// 递归 CTE 路径宽度上限
    pub cte_path_width_limit: usize,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            sqlite_pool_size: 8,
            fts_search_limit: 5,
            vector_search_limit: 5,
            transition_anchor_count: 3,
            semantic_low_threshold: 0.55,
            semantic_high_threshold: 0.85,
            vector_filter_threshold_low: 0.45,
            vector_filter_threshold_high: 0.70,
            cte_path_width_limit: 50,
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
    /// Embedding 模型名称
    pub embedding_model: String,
    /// 重试最大次数
    pub max_retries: u32,
    /// 初始重试退避秒数
    pub initial_backoff_secs: u64,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            model: "gpt-4o-mini".to_string(),
            embedding_model: "text-embedding-3-small".to_string(),
            max_retries: 5,
            initial_backoff_secs: 1,
        }
    }
}

/// 工具安全配置：默认启用 workspace jail，但允许高级用户显式关闭。
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ToolSecurityConfig {
    pub workspace_jail_enabled: bool,
    pub workspace_root: String,
    pub allow_absolute_paths: bool,
    pub allow_parent_traversal: bool,
    pub extra_read_roots: Vec<String>,
    pub extra_write_roots: Vec<String>,
    pub deny_patterns: Vec<String>,
    /// macOS 上通过 sandbox-exec 为 exec 子进程施加文件系统/网络 Seatbelt。
    pub exec_seatbelt_enabled: bool,
    /// Seatbelt 开启时是否允许 exec 子进程访问网络；Coding Eval 默认关闭。
    pub exec_network_enabled: bool,
}

impl Default for ToolSecurityConfig {
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
                "models/**".to_string(),
            ],
            exec_seatbelt_enabled: false,
            exec_network_enabled: false,
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
    /// exec 完整原始输出归档目录；Context 中只放受控 preview 和此稳定文件引用
    pub artifact_dir: String,
}

impl Default for BackgroundTaskConfig {
    fn default() -> Self {
        Self {
            timeout_notify_enabled: true,
            timeout_notify_secs: 300,
            max_output_buffer_bytes: 65_536,
            artifact_dir: ".morphz/artifacts".to_string(),
        }
    }
}

/// 工业化全局配置（聚合所有子配置）
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub orchestrator: OrchestratorConfig,
    #[serde(default)]
    pub memory: MemoryConfig,
    #[serde(default)]
    pub llm: LlmConfig,
    #[serde(default)]
    pub tool_security: ToolSecurityConfig,
    #[serde(default)]
    pub background_task: BackgroundTaskConfig,
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
                self.tool_security.workspace_root = root;
                // 严格评测模式下不继承默认 /tmp extra roots，避免文件工具逃逸。
                self.tool_security.extra_read_roots.clear();
                self.tool_security.extra_write_roots.clear();
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
                    self.tool_security.extra_read_roots.push(path);
                }
            }
        }
        if let Ok(value) = std::env::var("MORPHZ_EXEC_SEATBELT") {
            self.tool_security.exec_seatbelt_enabled = parse_env_bool(&value)
                .ok_or_else(|| format!("MORPHZ_EXEC_SEATBELT 不是合法布尔值: {value}"))?;
        }
        if let Ok(value) = std::env::var("MORPHZ_EXEC_NETWORK") {
            self.tool_security.exec_network_enabled = parse_env_bool(&value)
                .ok_or_else(|| format!("MORPHZ_EXEC_NETWORK 不是合法布尔值: {value}"))?;
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
        assert_eq!(cfg.memory.sqlite_pool_size, 8);
        assert_eq!(cfg.llm.max_retries, 5);
        assert!(cfg.tool_security.workspace_jail_enabled);
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
}
