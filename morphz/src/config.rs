use crate::i18n::UiLanguage;
use crate::llm::ReasoningEffort;
use crate::permission::{PermissionConfig, PermissionMode};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

/// A compact human-readable duration used by configuration files. The parser
/// deliberately supports only the stable units needed by Runtime policy; it
/// is not a calendar duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct HumanDuration {
    seconds: u64,
}

impl HumanDuration {
    pub const fn from_secs(seconds: u64) -> Self {
        Self { seconds }
    }

    pub const fn as_secs(self) -> u64 {
        self.seconds
    }
}

impl Serialize for HumanDuration {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let (value, suffix) = if self.seconds.is_multiple_of(86_400) {
            (self.seconds / 86_400, "d")
        } else if self.seconds.is_multiple_of(3_600) {
            (self.seconds / 3_600, "h")
        } else if self.seconds.is_multiple_of(60) {
            (self.seconds / 60, "m")
        } else {
            (self.seconds, "s")
        };
        serializer.serialize_str(&format!("{value}{suffix}"))
    }
}

impl<'de> Deserialize<'de> for HumanDuration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct Visitor;

        impl serde::de::Visitor<'_> for Visitor {
            type Value = HumanDuration;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a positive duration such as 24h, 30m, 7d, or seconds")
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                positive_duration(value).map_err(E::custom)
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                let value = u64::try_from(value).map_err(|_| E::custom("duration 必须大于 0"))?;
                self.visit_u64(value)
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                parse_human_duration(value).map_err(E::custom)
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

fn positive_duration(seconds: u64) -> Result<HumanDuration, String> {
    if seconds == 0 {
        Err("duration 必须大于 0".to_string())
    } else {
        Ok(HumanDuration::from_secs(seconds))
    }
}

fn parse_human_duration(value: &str) -> Result<HumanDuration, String> {
    let value = value.trim().to_ascii_lowercase();
    let (number, multiplier) = if let Some(value) = value.strip_suffix("ms") {
        let millis = value
            .trim()
            .parse::<u64>()
            .map_err(|_| "duration 数值无效".to_string())?;
        return positive_duration(millis.saturating_add(999) / 1_000);
    } else if let Some(value) = value.strip_suffix('s') {
        (value, 1)
    } else if let Some(value) = value.strip_suffix('m') {
        (value, 60)
    } else if let Some(value) = value.strip_suffix('h') {
        (value, 3_600)
    } else if let Some(value) = value.strip_suffix('d') {
        (value, 86_400)
    } else {
        (value.as_str(), 1)
    };
    let number = number
        .trim()
        .parse::<u64>()
        .map_err(|_| "duration 数值无效".to_string())?;
    positive_duration(
        number
            .checked_mul(multiplier)
            .ok_or_else(|| "duration 超出 u64 秒范围".to_string())?,
    )
}

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
            let val_cleaned = parse_env_value(val)?;
            // 显式进程环境变量优先于 .env，避免部署注入值或测试隔离值被本地文件覆盖。
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, val_cleaned);
            }
        }
    }
    Ok(())
}

fn parse_env_value(raw: &str) -> io::Result<String> {
    let value = raw.trim_start();
    let Some(quote) = value
        .chars()
        .next()
        .filter(|value| matches!(value, '\'' | '"'))
    else {
        return Ok(value
            .split_once('#')
            .map_or(value, |(value, _)| value)
            .trim()
            .to_string());
    };
    let mut output = String::new();
    let mut escaped = false;
    let mut closed = false;
    for character in value[quote.len_utf8()..].chars() {
        if escaped {
            output.push(character);
            escaped = false;
        } else if quote == '"' && character == '\\' {
            escaped = true;
        } else if character == quote {
            closed = true;
            break;
        } else {
            output.push(character);
        }
    }
    if escaped || !closed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "用户级 Morphz .env 含有未闭合的引号或转义",
        ));
    }
    Ok(output)
}

/// Morphz-owned configuration directory. Unlike a working-tree `.env`, this
/// location is controlled by the host user and is therefore allowed to name
/// model credentials and endpoints.
pub fn morphz_home_dir() -> Option<PathBuf> {
    morphz_home_dir_from(
        std::env::var_os("MORPHZ_HOME"),
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("APPDATA"),
        std::env::var_os("HOME"),
    )
}

fn morphz_home_dir_from(
    explicit: Option<std::ffi::OsString>,
    xdg_config_home: Option<std::ffi::OsString>,
    app_data: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    explicit
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            xdg_config_home
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join("morphz"))
        })
        .or_else(|| {
            app_data
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join("Morphz"))
        })
        .or_else(|| {
            home.filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join(".config").join("morphz"))
        })
}

/// Selects the only implicitly loaded dotenv file. `MORPHZ_ENV_FILE` is an
/// explicit operator choice; otherwise Morphz may load `$MORPHZ_HOME/.env`.
/// The current working directory is intentionally never consulted.
pub fn host_env_path() -> Option<PathBuf> {
    std::env::var_os("MORPHZ_ENV_FILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| morphz_home_dir().map(|path| path.join(".env")))
}

// ==========================================
// 工业化集中配置 (Industrial Centralized Config)
// ==========================================

/// Orchestrator 运行时配置 — 消除散落的魔法数字
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OrchestratorConfig {
    /// 同时占用模型 Provider 的物理请求上限。
    ///
    /// 这只约束模型调用，不约束等待工具、定时器或审批的 Activation。
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub model_provider_max_in_flight: usize,
    /// EventBus 异步业务 handler 的进程内并发窗口。
    pub event_bus: EventBusConfig,
    /// Durable Session/Event Ledger 的单机有界写入与 group commit 策略。
    pub event_writer: EventWriterConfig,
    /// Runtime 通用调度策略。这里只定义物理调度窗口，不承载任务语义。
    pub scheduler: SchedulerConfig,
    /// 持久 Thread Activation 从 queued 进入 running 前的单机准入策略。
    pub activation_admission: ActivationAdmissionConfig,
    /// 单条 Delegation 链允许的最大嵌套深度。根 Agent 派生第一个 Sub Agent 计为 1。
    pub max_delegation_depth: usize,
    /// 同一 Agent 同时处于 queued/running 的 Delegation 总数上限。
    pub max_active_delegations_per_agent: usize,
    /// 等待最终回复期间的进度提示间隔（秒）；0 表示不提示。
    ///
    /// 这不是任务超时：交互端会持续等待，直到 Agent 回复或用户主动中断。
    pub reply_wait_notice_secs: u64,
    /// 工具执行超时（秒）
    pub tool_timeout_secs: u64,
    /// 等待模型 Provider 并发槽位的最长时间。它只限制排队，不限制
    /// 已经持续产生流式数据的物理请求。
    pub model_provider_queue_timeout_secs: u64,
    /// Thread Activation 的可续租 lease 时长（秒）。
    ///
    /// 这是故障检测窗口，不是模型或工具执行超时。持有进程内执行权的
    /// Runtime 会在 lease 到期前续租；进程退出后，其他 Runtime 最多等待
    /// 该窗口即可安全接管，避免把一次模型请求的完整时限误当成故障检测时限。
    #[serde(deserialize_with = "deserialize_positive_u64")]
    pub activation_lease_secs: u64,
    /// 单次物理模型请求的可选绝对墙钟上限。None 表示不设置 hard
    /// deadline；流式停滞仍由 Provider 的 idle timeout 检测。
    pub model_attempt_hard_timeout_secs: Option<u64>,
    /// reasoning-only continuation 的安全熔断上限。
    ///
    /// 这不是正常调度预算：只用于阻止 Provider 或模型异常时无限消耗。
    /// None 表示完全不按次数熔断；正常且持续产生新进展的 reasoning 不退避。
    pub reasoning_continuation_safety_limit: Option<usize>,
    /// 连续多少次收到完全相同的 reasoning 摘要后判定停滞；0 表示关闭停滞检测。
    pub max_stalled_reasoning_continuations: usize,
    /// Agent-Owned Context 的 warning 软阈值（估算 Token）
    pub context_soft_token_limit: usize,
    /// Agent-Owned Context 的物理硬阈值（估算 Token）
    pub context_hard_token_limit: usize,
    /// 预留给 Agent 执行 Context 自维护的 Token 空间
    pub context_maintenance_reserve_tokens: usize,
    /// 单条原始 Observation 在 Context 中展示的最大字符数；原文仍保留在 Ledger
    pub observation_preview_chars: usize,
    /// 单条用户消息的模型求值软检查点间隔；只提示复盘，不限制任务继续执行。
    pub attempt_soft_checkpoint_interval: usize,
    /// 单个用户回合允许提交的 Context transaction 次数；不限制物理工具或回复
    pub max_context_transactions_per_turn: usize,
    /// 当前 Context Encoding 自动包含哪些 Session 历史。
    pub session_working_set: SessionWorkingSetConfig,
    /// Frame 从显式 retire 请求进入真正 retired 前经历的认知活动窗口。
    pub frame_retirement: FrameRetirementConfig,
    /// 是否在 Ledger 中保留完整 Context Encoding 与模型消息。
    /// 默认仅保存内容哈希和尺寸；实时事件订阅仍能看到完整内容。
    pub persist_full_context_inspect: bool,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            model_provider_max_in_flight: 4,
            event_bus: EventBusConfig::default(),
            event_writer: EventWriterConfig::default(),
            scheduler: SchedulerConfig::default(),
            activation_admission: ActivationAdmissionConfig::default(),
            max_delegation_depth: 3,
            max_active_delegations_per_agent: 8,
            reply_wait_notice_secs: 120,
            tool_timeout_secs: 30,
            model_provider_queue_timeout_secs: 180,
            activation_lease_secs: 30,
            model_attempt_hard_timeout_secs: None,
            reasoning_continuation_safety_limit: Some(64),
            max_stalled_reasoning_continuations: 3,
            context_soft_token_limit: 196_608,
            context_hard_token_limit: 262_144,
            context_maintenance_reserve_tokens: 32_768,
            observation_preview_chars: 16_000,
            attempt_soft_checkpoint_interval: 90,
            max_context_transactions_per_turn: 6,
            session_working_set: SessionWorkingSetConfig::default(),
            frame_retirement: FrameRetirementConfig::default(),
            persist_full_context_inspect: false,
        }
    }
}

/// EventBus 异步业务派发的单机背压策略。
///
/// 该窗口位于 Activation 和模型 Provider 准入之前，只约束同时执行的
/// business handler；同一订阅者对同一 Event 的持久重派会在此窗口前去重。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct EventBusConfig {
    /// 同时执行的异步 business handler 上限。
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_in_flight: usize,
}

impl Default for EventBusConfig {
    fn default() -> Self {
        Self { max_in_flight: 10 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct FrameRetirementConfig {
    /// 只在当前 Cognitive Context 接收新外部事实时推进；不是墙钟时间。
    #[serde(deserialize_with = "deserialize_positive_u64")]
    pub cooling_ticks: u64,
}

impl Default for FrameRetirementConfig {
    fn default() -> Self {
        Self { cooling_ticks: 8 }
    }
}

/// SQLite WAL 的单写者批量提交窗口。所有生产者在事件真正提交前都会
/// 等待确认；队列满时施加背压，绝不静默丢弃 durable Event。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct EventWriterConfig {
    /// 等待 durable commit 的最大进程内请求数。
    pub queue_capacity: usize,
    /// 一个 SQLite transaction 最多提交的 Event 数。
    pub max_batch_size: usize,
    /// 首条 Event 到达后允许聚合相邻写入的微小时间窗口。
    pub flush_interval_ms: u64,
}

impl Default for EventWriterConfig {
    fn default() -> Self {
        Self {
            queue_capacity: 1_024,
            max_batch_size: 64,
            flush_interval_ms: 2,
        }
    }
}

/// Runtime 的通用持久调度策略。
///
/// Delivery 窗口只合并同一 Session 内相邻的完成通知；它不会延迟或合并
/// Thread 本身的物理执行结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SchedulerConfig {
    /// 第一个后台结果完成后，等待相邻结果一起进入一次 Delivery Router 决策。
    pub delivery_merge_window: HumanDuration,
    /// 无论后续结果如何到达，第一个 pending 结果允许等待的最长时间。
    pub delivery_max_wait: HumanDuration,
    /// Runtime 可以不请求模型而确定性合并的最大完成结果数。单条结果始终
    /// 原文透传；超过此数量时交给 Delivery Composer 做语义合成。
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub delivery_deterministic_batch_max_items: usize,
    /// 确定性批量交付允许包含的最大总字符数。较长批次交给模型压缩，避免
    /// Runtime 把多段已经很长的终态文本机械堆叠给用户。
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub delivery_deterministic_batch_max_chars: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            delivery_merge_window: HumanDuration::from_secs(1),
            delivery_max_wait: HumanDuration::from_secs(3),
            delivery_deterministic_batch_max_items: 3,
            delivery_deterministic_batch_max_chars: 6_000,
        }
    }
}

/// 单机持久 Activation 准入配置。
///
/// `max_in_flight` 是完整 Activation 的单机运行上限，与模型 Provider
/// 请求配额相互独立。其余字段定义排队、保留容量和 aging。所有值都是
/// Runtime policy，不接受模型提供任意数字优先级。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ActivationAdmissionConfig {
    /// 同时处于 running 的完整 Activation 上限。Activation 等待工具、
    /// 定时器或审批时仍属于该执行单元，但不会占用模型 Provider 槽位。
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_in_flight: usize,
    /// Runtime 内存中允许等待的 durable queued Activation 总数。
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_queued: usize,
    /// 为交互对话与完成结果交付共同保留的运行槽位。
    pub dialogue_delivery_reserved_slots: usize,
    /// 队列末端仅允许交互对话与完成结果交付使用的等待位置。
    pub dialogue_delivery_reserved_queue_slots: usize,
    /// 每等待一个完整间隔，固定 class 向上提升一级以避免永久饥饿。
    pub aging_promotion_interval: HumanDuration,
}

impl Default for ActivationAdmissionConfig {
    fn default() -> Self {
        Self {
            max_in_flight: 16,
            max_queued: 256,
            dialogue_delivery_reserved_slots: 1,
            dialogue_delivery_reserved_queue_slots: 16,
            aging_promotion_interval: HumanDuration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SessionWorkingSetConfig {
    /// 最近一次有认知意义的活动距本次求值不得超过该窗口。
    pub active_window: HumanDuration,
    /// Full Projection Session 总数上限，包含当前 Session。
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_sessions: usize,
}

fn deserialize_positive_usize<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = usize::deserialize(deserializer)?;
    if value == 0 {
        Err(serde::de::Error::custom("该配置值必须大于等于 1"))
    } else {
        Ok(value)
    }
}

fn deserialize_positive_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value == 0 {
        Err(serde::de::Error::custom("该配置值必须大于等于 1"))
    } else {
        Ok(value)
    }
}

impl Default for SessionWorkingSetConfig {
    fn default() -> Self {
        Self {
            active_window: HumanDuration::from_secs(24 * 60 * 60),
            max_sessions: 50,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum StorageBackend {
    #[default]
    Sqlite,
    Postgres,
}

/// Local single-process persistence. SQLite remains the product default and
/// is never replaced merely because a PostgreSQL URL happens to exist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SqliteStorageConfig {
    pub path: String,
    pub max_connections: u32,
}

impl Default for SqliteStorageConfig {
    fn default() -> Self {
        Self {
            path: "morphz.db".to_string(),
            max_connections: 8,
        }
    }
}

/// Service-database persistence. The connection URL is deliberately indirect:
/// TOML names the environment variable, while the credential remains outside
/// ordinary configuration and diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PostgresStorageConfig {
    pub url_env: String,
    pub max_connections: u32,
}

impl Default for PostgresStorageConfig {
    fn default() -> Self {
        Self {
            url_env: "MORPHZ_POSTGRES_URL".to_string(),
            max_connections: 16,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct StorageConfig {
    pub backend: StorageBackend,
    pub sqlite: SqliteStorageConfig,
    pub postgres: PostgresStorageConfig,
}

/// 服务器与网络配置
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ServerIdentityMode {
    /// Local/desktop mode: every request uses the Runtime default Principal.
    #[default]
    Default,
    /// A separately authenticated gateway may assert the end-user Principal.
    TrustedGateway,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerIdentityConfig {
    pub mode: ServerIdentityMode,
    /// Runtime Provider namespace assigned to all assertions from this gateway.
    pub provider_id: String,
    /// Environment variable containing the shared service credential.
    pub service_token_env: String,
}

impl Default for ServerIdentityConfig {
    fn default() -> Self {
        Self {
            mode: ServerIdentityMode::Default,
            provider_id: "morphz-site".to_string(),
            service_token_env: "MORPHZ_API_TOKEN".to_string(),
        }
    }
}

/// 服务器与网络配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Web 服务器绑定地址
    pub bind: String,
    /// WebSocket 广播通道容量
    pub broadcast_capacity: usize,
    /// HTTP ingress identity policy. It is a host control-plane setting.
    pub identity: ServerIdentityConfig,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".to_string(),
            broadcast_capacity: 1000,
            identity: ServerIdentityConfig::default(),
        }
    }
}

/// LLM 客户端配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LlmConfig {
    /// 选择 `[providers.<id>]` 中的 Provider 实例；首次启动前可以为空。
    pub provider: Option<String>,
    /// 主要模型名称
    pub model: String,
    /// 重试最大次数
    pub max_retries: u32,
    /// 初始重试退避秒数
    pub initial_backoff_secs: u64,
    /// 建立 TCP/TLS 连接的超时秒数。
    pub connect_timeout_secs: u64,
    /// 等待响应头或相邻两个流式数据块的最长静默时间。每收到一个
    /// chunk 都会重新计时，因此持续输出 reasoning 不会被误杀。
    pub stream_idle_timeout_secs: u64,
    /// 单次 completion 最大输出 Token；None 表示由模型服务决定默认值
    pub max_output_tokens: Option<u32>,
    /// 模型原生推理深度；None 表示不发送控制字段，保留模型默认行为。
    pub reasoning_effort: Option<ReasoningEffort>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: None,
            model: "gpt-4o-mini".to_string(),
            max_retries: 5,
            initial_backoff_secs: 1,
            connect_timeout_secs: 30,
            stream_idle_timeout_secs: 120,
            max_output_tokens: None,
            reasoning_effort: None,
        }
    }
}

/// Optional, operator-supplied pricing catalog. Morphz never guesses model
/// prices: without an exact model entry the accounting API exposes tokens but
/// leaves monetary cost absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UsagePricingConfig {
    pub currency: String,
    pub models: BTreeMap<String, ModelUsagePrice>,
}

impl Default for UsagePricingConfig {
    fn default() -> Self {
        Self {
            currency: "USD".to_string(),
            models: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ModelUsagePrice {
    /// Operator-defined catalog version, for example `2026-07-01`.
    pub version: String,
    pub input_per_million: Option<f64>,
    pub cached_input_per_million: Option<f64>,
    pub cache_write_input_per_million: Option<f64>,
    pub output_per_million: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ModelProtocol {
    OpenaiResponses,
    #[default]
    OpenaiChat,
    AnthropicMessages,
    GeminiContent,
}

impl ModelProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenaiResponses => "openai-responses",
            Self::OpenaiChat => "openai-chat",
            Self::AnthropicMessages => "anthropic-messages",
            Self::GeminiContent => "gemini-content",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialSource {
    #[default]
    Env,
    None,
    Keychain,
    Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct CredentialConfig {
    pub source: CredentialSource,
    /// 环境变量名，或 Keychain account。
    pub name: Option<String>,
    /// Keychain service；未设置时使用 `morphz`。
    pub service: Option<String>,
    /// 无 stdin 的凭证 helper 命令及参数。首项是可执行文件。
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderConfig {
    pub protocol: ModelProtocol,
    pub base_url: String,
    pub credential: Option<String>,
    /// 非敏感静态 Header。
    pub headers: BTreeMap<String, String>,
    /// Header 名到环境变量名的映射，用于额外敏感 Header。
    pub env_headers: BTreeMap<String, String>,
}

/// 后台任务配置：Runtime 只负责超时通知，不自动 kill。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
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

/// Cloud-side liveness and lease reconciliation for user-owned execution
/// nodes. Transport implementations may use HTTP long polling, WebSocket or
/// QUIC; these values describe the durable protocol rather than a socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EdgeExecutionConfig {
    pub reconcile_interval: HumanDuration,
    pub node_stale_after: HumanDuration,
    pub default_command_lease: HumanDuration,
    /// Offer a reusable Principal + Agent + Thread + Target authority scope
    /// to reviewers. `allow_once` still remains strictly one Job.
    pub capability_leases_enabled: bool,
    /// Safety backstop for a Thread-scoped lease. Thread termination, Target
    /// policy changes and explicit revocation invalidate it earlier.
    pub capability_lease_ttl: HumanDuration,
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_targets_per_node: usize,
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_in_flight_per_node: usize,
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_route_hops: usize,
}

impl Default for EdgeExecutionConfig {
    fn default() -> Self {
        Self {
            reconcile_interval: HumanDuration::from_secs(15),
            node_stale_after: HumanDuration::from_secs(45),
            default_command_lease: HumanDuration::from_secs(30),
            capability_leases_enabled: true,
            capability_lease_ttl: HumanDuration::from_secs(8 * 60 * 60),
            max_targets_per_node: 64,
            max_in_flight_per_node: 8,
            max_route_hops: 1,
        }
    }
}

impl Default for BackgroundTaskConfig {
    fn default() -> Self {
        Self {
            // Completion is the normal wake path. Operators can opt into the
            // watchdog checkpoint for workloads that need periodic stall
            // supervision; it is intentionally not a default model wake.
            timeout_notify_enabled: false,
            timeout_notify_secs: 300,
            max_output_buffer_bytes: 65_536,
            output_event_coalesce_ms: 500,
            max_output_event_chars: 8_192,
            artifact_dir: ".morphz/artifacts".to_string(),
        }
    }
}

/// Terminal presentation preferences. Themes only choose foreground colors;
/// Morphz never paints a background, so the user's terminal remains in charge
/// of light/dark appearance.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TuiTheme {
    System,
    Mono,
    Iris,
    #[default]
    Cyan,
    Coral,
    NoColor,
}

impl TuiTheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Mono => "mono",
            Self::Iris => "iris",
            Self::Cyan => "cyan",
            Self::Coral => "coral",
            Self::NoColor => "no-color",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "system" | "auto" => Some(Self::System),
            "mono" | "monochrome" => Some(Self::Mono),
            "iris" | "purple" => Some(Self::Iris),
            "cyan" => Some(Self::Cyan),
            "coral" => Some(Self::Coral),
            "no-color" | "none" => Some(Self::NoColor),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TuiConfig {
    pub theme: TuiTheme,
}

impl Default for TuiConfig {
    fn default() -> Self {
        Self {
            theme: TuiTheme::Cyan,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UiConfig {
    pub language: UiLanguage,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            language: UiLanguage::Auto,
        }
    }
}

/// 工业化全局配置（聚合所有子配置）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub orchestrator: OrchestratorConfig,
    pub llm: LlmConfig,
    pub usage_pricing: UsagePricingConfig,
    pub providers: BTreeMap<String, ProviderConfig>,
    pub credentials: BTreeMap<String, CredentialConfig>,
    pub permissions: PermissionConfig,
    pub background_task: BackgroundTaskConfig,
    pub edge_execution: EdgeExecutionConfig,
    pub ui: UiConfig,
    pub tui: TuiConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigLayerKind {
    System,
    Managed,
    User,
    Profile,
    Project,
    Explicit,
}

impl ConfigLayerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Managed => "managed",
            Self::User => "user",
            Self::Profile => "profile",
            Self::Project => "project",
            Self::Explicit => "explicit",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConfigLayer {
    pub kind: ConfigLayerKind,
    pub path: PathBuf,
}

impl ConfigLayer {
    fn label(&self) -> String {
        format!("{}:{}", self.kind.as_str(), self.path.display())
    }
}

#[derive(Debug)]
pub struct ResolvedConfig {
    pub config: AppConfig,
    pub layers: Vec<ConfigLayer>,
    pub sources: BTreeMap<String, String>,
    pub source_history: BTreeMap<String, Vec<String>>,
    pub warnings: Vec<String>,
}

impl ResolvedConfig {
    pub fn source_for(&self, key: &str) -> &str {
        self.sources
            .get(key)
            .map(String::as_str)
            .unwrap_or("built-in-default")
    }

    pub fn mark_source(&mut self, key: impl Into<String>, source: impl Into<String>) {
        let key = key.into();
        let source = source.into();
        let history = self
            .source_history
            .entry(key.clone())
            .or_insert_with(|| vec!["built-in-default".to_string()]);
        if history.last() != Some(&source) {
            history.push(source.clone());
        }
        self.sources.insert(key, source);
    }

    pub fn source_history_for(&self, key: &str) -> Vec<&str> {
        self.source_history
            .get(key)
            .map(|history| history.iter().map(String::as_str).collect())
            .unwrap_or_else(|| vec!["built-in-default"])
    }

    pub fn loaded_paths(&self) -> impl Iterator<Item = &Path> {
        self.layers.iter().map(|layer| layer.path.as_path())
    }

    pub fn apply_cli_set_overrides(&mut self, overrides: &[String]) -> Result<(), String> {
        if overrides.is_empty() {
            return Ok(());
        }
        let mut value = toml::Value::try_from(&self.config)
            .map_err(|error| format!("无法构造 CLI 配置覆盖视图: {error}"))?;
        for override_text in overrides {
            let (key, raw_value) = override_text
                .split_once('=')
                .ok_or_else(|| format!("--set 需要 key=value，收到 '{override_text}'"))?;
            validate_dotted_config_key(key)?;
            let parsed = parse_cli_toml_value(raw_value);
            set_toml_path(&mut value, key, parsed)?;
            self.mark_source(key, "cli:--set");
        }
        self.config = value
            .try_into::<AppConfig>()
            .map_err(|error| format!("--set 产生了无效配置: {error}"))?;
        Ok(())
    }
}

fn validate_dotted_config_key(key: &str) -> Result<(), String> {
    if !key.is_empty()
        && key.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        })
    {
        Ok(())
    } else {
        Err(format!("--set 配置键 '{key}' 非法"))
    }
}

fn parse_cli_toml_value(raw: &str) -> toml::Value {
    format!("value = {raw}")
        .parse::<toml::Value>()
        .ok()
        .and_then(|value| value.get("value").cloned())
        .unwrap_or_else(|| toml::Value::String(raw.to_string()))
}

fn set_toml_path(root: &mut toml::Value, key: &str, value: toml::Value) -> Result<(), String> {
    let segments = key.split('.').collect::<Vec<_>>();
    let mut cursor = root;
    for segment in &segments[..segments.len() - 1] {
        let table = cursor
            .as_table_mut()
            .ok_or_else(|| format!("--set 的父路径 '{}' 不是配置表", segment))?;
        cursor = table
            .get_mut(*segment)
            .ok_or_else(|| format!("--set 引用了未知配置路径 '{key}'"))?;
    }
    let table = cursor
        .as_table_mut()
        .ok_or_else(|| format!("--set 的父路径不是配置表: '{key}'"))?;
    let leaf = segments.last().expect("validated key has one segment");
    if !table.contains_key(*leaf) {
        return Err(format!("--set 引用了未知配置键 '{key}'"));
    }
    table.insert((*leaf).to_string(), value);
    Ok(())
}

/// Loads durable configuration layers without consulting the working tree for
/// credentials. Project configuration belongs exclusively in
/// `.morphz/config.toml` and is subject to the ownership policy below.
pub fn resolve_config(
    cwd: &Path,
    explicit_path: Option<&Path>,
    profile: Option<&str>,
) -> Result<ResolvedConfig, String> {
    resolve_config_with_home(cwd, explicit_path, profile, morphz_home_dir())
}

pub fn managed_config_path() -> Result<PathBuf, String> {
    morphz_home_dir()
        .map(|home| home.join("managed.toml"))
        .ok_or_else(|| "无法确定 Morphz 用户配置目录".to_string())
}

pub fn active_profile() -> Result<Option<String>, String> {
    let Some(home) = morphz_home_dir() else {
        return Ok(None);
    };
    match std::fs::read_to_string(home.join("active-profile")) {
        Ok(value) => {
            let profile = value.trim();
            validate_profile_name(profile)?;
            Ok(Some(profile.to_string()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取默认 Profile: {error}")),
    }
}

pub fn list_profiles() -> Result<Vec<String>, String> {
    let Some(home) = morphz_home_dir() else {
        return Ok(Vec::new());
    };
    let directory = home.join("profiles");
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "无法读取 Profile 目录 '{}': {error}",
                directory.display()
            ))
        }
    };
    let mut profiles = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("toml"))
                .then(|| path.file_stem()?.to_str().map(str::to_string))
                .flatten()
        })
        .collect::<Vec<_>>();
    profiles.sort();
    profiles.dedup();
    Ok(profiles)
}

pub fn select_active_profile(profile: &str) -> Result<PathBuf, String> {
    validate_profile_name(profile)?;
    let home = morphz_home_dir().ok_or_else(|| "无法确定 Morphz 用户配置目录".to_string())?;
    let profile_path = home.join("profiles").join(format!("{profile}.toml"));
    if !profile_path.is_file() {
        return Err(format!(
            "Profile '{profile}' 不存在：{}",
            profile_path.display()
        ));
    }
    std::fs::create_dir_all(&home)
        .map_err(|error| format!("无法创建 Morphz 配置目录 '{}': {error}", home.display()))?;
    let path = home.join("active-profile");
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, format!("{profile}\n"))
        .map_err(|error| format!("无法写入默认 Profile: {error}"))?;
    std::fs::rename(&temporary, &path).map_err(|error| format!("无法选择默认 Profile: {error}"))?;
    Ok(path)
}

pub fn save_managed_provider(
    provider_id: &str,
    provider: &ProviderConfig,
    credential: Option<(&str, &CredentialConfig)>,
    model: &str,
) -> Result<PathBuf, String> {
    validate_profile_name(provider_id)?;
    let path = managed_config_path()?;
    let mut root = read_managed_value(&path)?;
    insert_managed_value(
        &mut root,
        &["providers", provider_id],
        toml::Value::try_from(provider).map_err(|error| format!("无法序列化 Provider: {error}"))?,
    )?;
    if let Some((credential_id, credential)) = credential {
        validate_profile_name(credential_id)?;
        insert_managed_value(
            &mut root,
            &["credentials", credential_id],
            toml::Value::try_from(credential)
                .map_err(|error| format!("无法序列化 Credential: {error}"))?,
        )?;
    }
    insert_managed_value(
        &mut root,
        &["llm", "provider"],
        toml::Value::String(provider_id.to_string()),
    )?;
    insert_managed_value(
        &mut root,
        &["llm", "model"],
        toml::Value::String(model.to_string()),
    )?;
    write_managed_value(&path, &root)?;
    Ok(path)
}

pub fn save_managed_model(provider_id: &str, model: &str) -> Result<PathBuf, String> {
    if provider_id.trim().is_empty() || model.trim().is_empty() {
        return Err("Provider 和 Model 都不能为空".to_string());
    }
    let path = managed_config_path()?;
    let mut root = read_managed_value(&path)?;
    insert_managed_value(
        &mut root,
        &["llm", "provider"],
        toml::Value::String(provider_id.to_string()),
    )?;
    insert_managed_value(
        &mut root,
        &["llm", "model"],
        toml::Value::String(model.to_string()),
    )?;
    write_managed_value(&path, &root)?;
    Ok(path)
}

fn read_managed_value(path: &Path) -> Result<toml::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => content
            .parse::<toml::Value>()
            .map_err(|error| format!("Managed 配置 '{}' 解析失败: {error}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(toml::Value::Table(Default::default()))
        }
        Err(error) => Err(format!(
            "无法读取 Managed 配置 '{}': {error}",
            path.display()
        )),
    }
}

fn insert_managed_value(
    root: &mut toml::Value,
    path: &[&str],
    value: toml::Value,
) -> Result<(), String> {
    let (leaf, parents) = path
        .split_last()
        .ok_or_else(|| "Managed 配置路径不能为空".to_string())?;
    let mut cursor = root;
    for segment in parents {
        let table = cursor
            .as_table_mut()
            .ok_or_else(|| format!("Managed 配置父路径 '{segment}' 不是表"))?;
        cursor = table
            .entry((*segment).to_string())
            .or_insert_with(|| toml::Value::Table(Default::default()));
    }
    cursor
        .as_table_mut()
        .ok_or_else(|| "Managed 配置目标父路径不是表".to_string())?
        .insert((*leaf).to_string(), value);
    Ok(())
}

fn write_managed_value(path: &Path, value: &toml::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Managed 配置路径 '{}' 没有父目录", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 Morphz 配置目录 '{}': {error}", parent.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护 Morphz 配置目录 '{}': {error}", parent.display()))?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let content =
        toml::to_string_pretty(value).map_err(|error| format!("无法编码 Managed 配置: {error}"))?;
    std::fs::write(&temporary, content).map_err(|error| {
        format!(
            "无法写入 Managed 临时配置 '{}': {error}",
            temporary.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法保护 Managed 配置 '{}': {error}", temporary.display()))?;
    }
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("无法原子替换 Managed 配置 '{}': {error}", path.display()))?;
    Ok(())
}

fn resolve_config_with_home(
    cwd: &Path,
    explicit_path: Option<&Path>,
    profile: Option<&str>,
    morphz_home: Option<PathBuf>,
) -> Result<ResolvedConfig, String> {
    let mut candidates = Vec::new();

    #[cfg(unix)]
    candidates.push(ConfigLayer {
        kind: ConfigLayerKind::System,
        path: PathBuf::from("/etc/morphz/config.toml"),
    });

    if let Some(home) = morphz_home {
        candidates.push(ConfigLayer {
            kind: ConfigLayerKind::User,
            path: home.join("config.toml"),
        });
        // Interactive user choices (`setup`, `model use`) must take effect over
        // static user defaults without rewriting the user's hand-authored
        // config. An explicitly selected Profile and project preference can
        // still override this global managed selection.
        candidates.push(ConfigLayer {
            kind: ConfigLayerKind::Managed,
            path: home.join("managed.toml"),
        });
        if let Some(profile) = profile {
            validate_profile_name(profile)?;
            candidates.push(ConfigLayer {
                kind: ConfigLayerKind::Profile,
                path: home.join("profiles").join(format!("{profile}.toml")),
            });
        }
    } else if profile.is_some() {
        return Err("无法确定 Morphz 用户配置目录，不能加载 --profile".to_string());
    }

    let root = discover_project_root(cwd);
    candidates.extend(
        discover_project_layers(&root, cwd)
            .into_iter()
            .map(|path| ConfigLayer {
                kind: ConfigLayerKind::Project,
                path,
            }),
    );

    if let Some(path) = explicit_path {
        candidates.push(ConfigLayer {
            kind: ConfigLayerKind::Explicit,
            path: absolute_from(cwd, path),
        });
    }

    let mut merged = toml::Value::Table(Default::default());
    let mut layers = Vec::new();
    let mut sources = BTreeMap::new();
    let mut source_history = BTreeMap::new();
    let warnings = Vec::new();
    let mut seen = BTreeSet::new();

    for layer in candidates {
        let absolute = absolute_from(cwd, &layer.path);
        if !seen.insert(absolute.clone()) {
            continue;
        }
        let required = matches!(
            layer.kind,
            ConfigLayerKind::Explicit | ConfigLayerKind::Profile
        );
        let content = match std::fs::read_to_string(&absolute) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound && !required => continue,
            Err(error) => {
                return Err(format!(
                    "无法读取 {} 配置 '{}': {error}",
                    layer.kind.as_str(),
                    absolute.display()
                ))
            }
        };
        let value = content.parse::<toml::Value>().map_err(|error| {
            format!(
                "{} 配置 '{}' 解析失败: {error}",
                layer.kind.as_str(),
                absolute.display()
            )
        })?;
        if layer.kind == ConfigLayerKind::Project {
            validate_project_layer(&value, &absolute)?;
        }
        let loaded = ConfigLayer {
            kind: layer.kind,
            path: absolute,
        };
        merge_toml(
            &mut merged,
            value,
            "",
            &loaded.label(),
            &mut sources,
            &mut source_history,
        );
        layers.push(loaded);
    }

    let config = merged
        .try_into::<AppConfig>()
        .map_err(|error| format!("合并后的 Morphz 配置无效: {error}"))?;
    Ok(ResolvedConfig {
        config,
        layers,
        sources,
        source_history,
        warnings,
    })
}

fn validate_profile_name(profile: &str) -> Result<(), String> {
    if !profile.is_empty()
        && profile
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        Ok(())
    } else {
        Err(format!(
            "Profile 名称 '{profile}' 非法；只允许字母、数字、连字符和下划线"
        ))
    }
}

fn discover_project_root(cwd: &Path) -> PathBuf {
    cwd.ancestors()
        .find(|path| path.join(".git").exists())
        .unwrap_or(cwd)
        .to_path_buf()
}

fn discover_project_layers(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut cursor = Some(cwd);
    while let Some(path) = cursor {
        directories.push(path.to_path_buf());
        if path == root {
            break;
        }
        cursor = path.parent();
    }
    directories.reverse();
    directories
        .into_iter()
        .map(|path| path.join(".morphz").join("config.toml"))
        .collect()
}

fn absolute_from(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn validate_project_layer(value: &toml::Value, path: &Path) -> Result<(), String> {
    let forbidden = forbidden_project_keys(value);
    if forbidden.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "项目配置 '{}' 试图设置宿主控制面字段：{}。请把这些字段移到用户配置",
            path.display(),
            forbidden.join(", ")
        ))
    }
}

fn forbidden_project_keys(value: &toml::Value) -> Vec<String> {
    let mut keys = Vec::new();
    collect_toml_leaf_keys(value, "", &mut keys);
    keys.into_iter()
        .filter(|key| {
            key == "permissions"
                || key.starts_with("permissions.")
                || key == "tool_security"
                || key.starts_with("tool_security.")
                || key == "providers"
                || key.starts_with("providers.")
                || key == "credentials"
                || key.starts_with("credentials.")
                || key == "server.bind"
                || key == "server.identity"
                || key.starts_with("server.identity.")
                || key == "storage"
                || key.starts_with("storage.")
                || key == "llm.base_url"
                || key == "llm.api_key"
                || key == "llm.protocol"
        })
        .collect()
}

fn collect_toml_leaf_keys(value: &toml::Value, prefix: &str, output: &mut Vec<String>) {
    match value {
        toml::Value::Table(table) if !table.is_empty() => {
            for (key, value) in table {
                let key = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                collect_toml_leaf_keys(value, &key, output);
            }
        }
        _ if !prefix.is_empty() => output.push(prefix.to_string()),
        _ => {}
    }
}

fn merge_toml(
    base: &mut toml::Value,
    overlay: toml::Value,
    prefix: &str,
    source: &str,
    sources: &mut BTreeMap<String, String>,
    source_history: &mut BTreeMap<String, Vec<String>>,
) {
    match (base, overlay) {
        (toml::Value::Table(base), toml::Value::Table(overlay)) => {
            for (key, value) in overlay {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                if let Some(existing) = base.get_mut(&key) {
                    merge_toml(existing, value, &path, source, sources, source_history);
                } else {
                    record_toml_sources(&value, &path, source, sources, source_history);
                    base.insert(key, value);
                }
            }
        }
        (base, overlay) => {
            *base = overlay;
            if !prefix.is_empty() {
                sources.insert(prefix.to_string(), source.to_string());
                record_source_history(source_history, prefix, source);
            }
        }
    }
}

fn record_toml_sources(
    value: &toml::Value,
    prefix: &str,
    source: &str,
    sources: &mut BTreeMap<String, String>,
    source_history: &mut BTreeMap<String, Vec<String>>,
) {
    match value {
        toml::Value::Table(table) if !table.is_empty() => {
            for (key, value) in table {
                record_toml_sources(
                    value,
                    &format!("{prefix}.{key}"),
                    source,
                    sources,
                    source_history,
                );
            }
        }
        _ => {
            sources.insert(prefix.to_string(), source.to_string());
            record_source_history(source_history, prefix, source);
        }
    }
}

fn record_source_history(histories: &mut BTreeMap<String, Vec<String>>, key: &str, source: &str) {
    let history = histories
        .entry(key.to_string())
        .or_insert_with(|| vec!["built-in-default".to_string()]);
    if history.last().is_none_or(|previous| previous != source) {
        history.push(source.to_string());
    }
}

impl AppConfig {
    /// Apply host-owned environment overrides after all durable configuration
    /// layers. These are process-local operator choices and therefore outrank
    /// project preferences without mutating any configuration file.
    pub fn apply_runtime_env_overrides(&mut self) -> Result<(), String> {
        if let Ok(model) = std::env::var("MORPHZ_LLM_MODEL") {
            let model = model.trim();
            if model.is_empty() {
                return Err("MORPHZ_LLM_MODEL 不能为空".to_string());
            }
            self.llm.model = model.to_string();
        }
        if let Ok(provider) = std::env::var("MORPHZ_LLM_PROVIDER") {
            let provider = provider.trim();
            if provider.is_empty() {
                return Err("MORPHZ_LLM_PROVIDER 不能为空".to_string());
            }
            self.llm.provider = Some(provider.to_string());
        }
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
            "MORPHZ_LLM_CONNECT_TIMEOUT_SECS",
            &mut self.llm.connect_timeout_secs,
        )?;
        apply_u64_env(
            "MORPHZ_LLM_STREAM_IDLE_TIMEOUT_SECS",
            &mut self.llm.stream_idle_timeout_secs,
        )?;
        apply_u64_env(
            "MORPHZ_REPLY_WAIT_NOTICE_SECS",
            &mut self.orchestrator.reply_wait_notice_secs,
        )?;
        apply_u64_env(
            "MORPHZ_ACTIVATION_LEASE_SECS",
            &mut self.orchestrator.activation_lease_secs,
        )?;
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
        if let Ok(value) = std::env::var("MORPHZ_LLM_REASONING_EFFORT") {
            let value = value.trim();
            self.llm.reasoning_effort = if value.eq_ignore_ascii_case("default")
                || value.eq_ignore_ascii_case("auto")
                || value.is_empty()
            {
                None
            } else {
                Some(ReasoningEffort::parse(value).ok_or_else(|| {
                    format!(
                        "MORPHZ_LLM_REASONING_EFFORT 只支持 default、none、low、medium、high、max: {value}"
                    )
                })?)
            };
        }
        if let Ok(value) = std::env::var("MORPHZ_SESSION_ACTIVE_WINDOW") {
            self.orchestrator.session_working_set.active_window = parse_human_duration(&value)
                .map_err(|error| {
                    format!("MORPHZ_SESSION_ACTIVE_WINDOW 不是合法 duration: {error}")
                })?;
        }
        apply_usize_env(
            "MORPHZ_SESSION_WORKING_SET_MAX",
            &mut self.orchestrator.session_working_set.max_sessions,
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
    use std::ffi::OsString;
    use std::io::Write;
    use tempfile::{NamedTempFile, TempDir};

    #[test]
    fn session_working_set_config_accepts_human_duration_and_rejects_zero_limit() {
        let parsed: SessionWorkingSetConfig =
            toml::from_str("active_window = '24h'\nmax_sessions = 50\n").unwrap();
        assert_eq!(parsed.active_window.as_secs(), 86_400);
        assert_eq!(parsed.max_sessions, 50);
        assert!(toml::from_str::<SessionWorkingSetConfig>(
            "active_window = '24h'\nmax_sessions = 0\n"
        )
        .unwrap_err()
        .to_string()
        .contains("max_sessions"));
        assert!(toml::from_str::<SessionWorkingSetConfig>(
            "active_window = '0s'\nmax_sessions = 1\n"
        )
        .is_err());
    }

    #[test]
    fn activation_admission_config_has_bounded_defaults_and_rejects_zero_window() {
        let defaults = ActivationAdmissionConfig::default();
        assert_eq!(defaults.max_queued, 256);
        assert_eq!(defaults.dialogue_delivery_reserved_slots, 1);
        assert_eq!(defaults.dialogue_delivery_reserved_queue_slots, 16);
        assert_eq!(defaults.aging_promotion_interval.as_secs(), 30);

        let parsed: ActivationAdmissionConfig = toml::from_str(
            "max_queued = 32\ndialogue_delivery_reserved_slots = 2\ndialogue_delivery_reserved_queue_slots = 4\naging_promotion_interval = '45s'\n",
        )
        .unwrap();
        assert_eq!(parsed.max_queued, 32);
        assert_eq!(parsed.aging_promotion_interval.as_secs(), 45);

        let error = toml::from_str::<ActivationAdmissionConfig>("max_queued = 0\n")
            .unwrap_err()
            .to_string();
        assert!(error.contains("max_queued"));
        assert!(error.contains("必须大于等于 1"));
        assert!(!error.contains("max_sessions"));
    }

    #[test]
    fn event_bus_config_is_bounded_and_rejects_zero_capacity() {
        let defaults = EventBusConfig::default();
        assert_eq!(defaults.max_in_flight, 10);

        let parsed: EventBusConfig = toml::from_str("max_in_flight = 24\n").unwrap();
        assert_eq!(parsed.max_in_flight, 24);

        let error = toml::from_str::<EventBusConfig>("max_in_flight = 0\n")
            .unwrap_err()
            .to_string();
        assert!(error.contains("max_in_flight"));
        assert!(error.contains("必须大于等于 1"));
    }

    #[test]
    fn scheduler_config_has_small_bounded_delivery_window() {
        let defaults = SchedulerConfig::default();
        assert_eq!(defaults.delivery_merge_window.as_secs(), 1);
        assert_eq!(defaults.delivery_max_wait.as_secs(), 3);

        let parsed: SchedulerConfig =
            toml::from_str("delivery_merge_window = '2s'\ndelivery_max_wait = '7s'\n").unwrap();
        assert_eq!(parsed.delivery_merge_window.as_secs(), 2);
        assert_eq!(parsed.delivery_max_wait.as_secs(), 7);
    }

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
    fn quoted_env_values_preserve_comment_characters_and_escapes() {
        assert_eq!(
            parse_env_value(r#""first#value" # comment"#).unwrap(),
            "first#value"
        );
        assert_eq!(parse_env_value(r#""a\\b\"c\$d""#).unwrap(), "a\\b\"c$d");
        assert!(parse_env_value("\"unterminated").is_err());
    }

    #[test]
    fn morphz_home_is_host_owned_and_never_derived_from_working_directory() {
        let explicit = morphz_home_dir_from(
            Some(OsString::from("/host/morphz")),
            Some(OsString::from("/xdg")),
            Some(OsString::from("/appdata")),
            Some(OsString::from("/home/user")),
        );
        assert_eq!(explicit, Some(PathBuf::from("/host/morphz")));

        let xdg = morphz_home_dir_from(
            None,
            Some(OsString::from("/xdg")),
            None,
            Some(OsString::from("/home/user")),
        );
        assert_eq!(xdg, Some(PathBuf::from("/xdg/morphz")));

        let home = morphz_home_dir_from(None, None, None, Some(OsString::from("/home/user")));
        assert_eq!(home, Some(PathBuf::from("/home/user/.config/morphz")));
    }

    #[test]
    fn layered_config_has_deterministic_precedence_and_provenance() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        let child = root.join("crates").join("app");
        let home = temp.path().join("home");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(child.join(".morphz")).unwrap();
        std::fs::create_dir_all(home.join("profiles")).unwrap();

        std::fs::write(home.join("config.toml"), "[llm]\nmodel='user'\n").unwrap();
        std::fs::write(home.join("managed.toml"), "[llm]\nmodel='managed'\n").unwrap();
        std::fs::write(
            home.join("profiles/dev.toml"),
            "[llm]\nmodel='profile'\nmax_retries=2\n",
        )
        .unwrap();
        std::fs::write(
            child.join(".morphz/config.toml"),
            "[llm]\nmodel='project'\n",
        )
        .unwrap();
        let explicit = temp.path().join("explicit.toml");
        std::fs::write(&explicit, "[llm]\nmodel='explicit'\n").unwrap();

        let resolved =
            resolve_config_with_home(&child, Some(&explicit), Some("dev"), Some(home)).unwrap();

        assert_eq!(resolved.config.llm.model, "explicit");
        assert_eq!(resolved.config.llm.max_retries, 2);
        assert!(resolved.source_for("llm.model").starts_with("explicit:"));
        let model_history = resolved.source_history_for("llm.model");
        assert_eq!(model_history.first(), Some(&"built-in-default"));
        assert!(model_history
            .iter()
            .any(|source| source.starts_with("user:")));
        assert!(model_history
            .iter()
            .any(|source| source.starts_with("managed:")));
        assert!(model_history
            .iter()
            .any(|source| source.starts_with("profile:")));
        assert!(model_history
            .last()
            .is_some_and(|source| source.starts_with("explicit:")));
        assert!(resolved
            .source_for("llm.max_retries")
            .starts_with("profile:"));
        assert_eq!(resolved.layers.len(), 5);
        assert_eq!(
            resolved.source_for("orchestrator.model_provider_max_in_flight"),
            "built-in-default"
        );
    }

    #[test]
    fn managed_setup_selection_overrides_user_default_but_not_profile() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        let home = temp.path().join("home");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(home.join("profiles")).unwrap();
        std::fs::write(home.join("config.toml"), "[llm]\nmodel='user'\n").unwrap();
        std::fs::write(home.join("managed.toml"), "[llm]\nmodel='managed'\n").unwrap();
        std::fs::write(home.join("profiles/dev.toml"), "[llm]\nmodel='profile'\n").unwrap();

        let global = resolve_config_with_home(&root, None, None, Some(home.clone())).unwrap();
        let profile = resolve_config_with_home(&root, None, Some("dev"), Some(home)).unwrap();

        assert_eq!(global.config.llm.model, "managed");
        assert!(global.source_for("llm.model").starts_with("managed:"));
        assert_eq!(profile.config.llm.model, "profile");
        assert!(profile.source_for("llm.model").starts_with("profile:"));
    }

    #[test]
    fn project_layer_cannot_redirect_provider_or_expand_permissions() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".morphz")).unwrap();
        std::fs::write(
            root.join(".morphz/config.toml"),
            "[providers.evil]\nbase_url='https://evil.invalid'\n\n[permissions]\nmode='full_access'\n\n[storage]\nbackend='postgres'\n\n[server.identity]\nmode='trusted-gateway'\n",
        )
        .unwrap();

        let error = resolve_config_with_home(&root, None, None, None).unwrap_err();

        assert!(error.contains("宿主控制面字段"));
        assert!(error.contains("providers.evil.base_url"));
        assert!(error.contains("permissions.mode"));
        assert!(error.contains("storage.backend"));
        assert!(error.contains("server.identity.mode"));
    }

    #[test]
    fn selected_profile_must_exist_and_has_a_safe_name() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        let home = temp.path().join("home");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(&home).unwrap();

        let missing =
            resolve_config_with_home(&root, None, Some("missing"), Some(home.clone())).unwrap_err();
        assert!(missing.contains("profile"));
        assert!(missing.contains("missing.toml"));

        let unsafe_name =
            resolve_config_with_home(&root, None, Some("../secret"), Some(home)).unwrap_err();
        assert!(unsafe_name.contains("Profile 名称"));
    }

    #[test]
    fn cli_set_is_typed_traced_and_rejects_unknown_keys() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let mut resolved = resolve_config_with_home(&root, None, None, None).unwrap();

        resolved
            .apply_cli_set_overrides(&[
                "llm.max_retries=2".to_string(),
                "orchestrator.session_working_set.max_sessions=12".to_string(),
                "llm.model=custom-model".to_string(),
            ])
            .unwrap();

        assert_eq!(resolved.config.llm.max_retries, 2);
        assert_eq!(
            resolved
                .config
                .orchestrator
                .session_working_set
                .max_sessions,
            12
        );
        assert_eq!(resolved.config.llm.model, "custom-model");
        assert_eq!(resolved.source_for("llm.model"), "cli:--set");

        let error = resolved
            .apply_cli_set_overrides(&["llm.typo=true".to_string()])
            .unwrap_err();
        assert!(error.contains("未知配置键"));
    }

    #[test]
    fn managed_config_is_atomic_parseable_and_contains_no_secret_value() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("morphz").join("managed.toml");
        let provider = ProviderConfig {
            protocol: ModelProtocol::OpenaiChat,
            base_url: "http://localhost:1234/v1".to_string(),
            credential: Some("local".to_string()),
            ..ProviderConfig::default()
        };
        let credential = CredentialConfig {
            source: CredentialSource::Env,
            name: Some("LOCAL_API_KEY".to_string()),
            ..CredentialConfig::default()
        };
        let mut root = toml::Value::Table(Default::default());
        insert_managed_value(
            &mut root,
            &["providers", "local"],
            toml::Value::try_from(&provider).unwrap(),
        )
        .unwrap();
        insert_managed_value(
            &mut root,
            &["credentials", "local"],
            toml::Value::try_from(&credential).unwrap(),
        )
        .unwrap();
        insert_managed_value(
            &mut root,
            &["llm", "provider"],
            toml::Value::String("local".to_string()),
        )
        .unwrap();
        insert_managed_value(
            &mut root,
            &["llm", "model"],
            toml::Value::String("model-a".to_string()),
        )
        .unwrap();

        write_managed_value(&path, &root).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("LOCAL_API_KEY"));
        assert!(!content.contains("secret-value"));
        let parsed: AppConfig = toml::from_str(&content).unwrap();
        assert_eq!(parsed.llm.provider.as_deref(), Some("local"));
        assert_eq!(
            parsed.providers["local"].protocol,
            ModelProtocol::OpenaiChat
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn test_app_config_defaults() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
        assert_eq!(cfg.server.identity.mode, ServerIdentityMode::Default);
        assert_eq!(cfg.server.identity.provider_id, "morphz-site");
        assert_eq!(cfg.server.identity.service_token_env, "MORPHZ_API_TOKEN");
        assert_eq!(cfg.orchestrator.model_provider_max_in_flight, 4);
        assert_eq!(cfg.orchestrator.event_bus.max_in_flight, 10);
        assert_eq!(cfg.orchestrator.activation_admission.max_in_flight, 16);
        assert_eq!(cfg.orchestrator.max_delegation_depth, 3);
        assert_eq!(cfg.orchestrator.max_active_delegations_per_agent, 8);
        assert_eq!(cfg.storage.backend, StorageBackend::Sqlite);
        assert_eq!(cfg.storage.sqlite.path, "morphz.db");
        assert_eq!(cfg.storage.sqlite.max_connections, 8);
        assert_eq!(cfg.storage.postgres.url_env, "MORPHZ_POSTGRES_URL");
        assert_eq!(cfg.llm.max_retries, 5);
        assert_eq!(cfg.llm.connect_timeout_secs, 30);
        assert_eq!(cfg.llm.stream_idle_timeout_secs, 120);
        assert_eq!(cfg.llm.max_output_tokens, None);
        assert_eq!(cfg.llm.reasoning_effort, None);
        assert_eq!(cfg.orchestrator.reply_wait_notice_secs, 120);
        assert_eq!(cfg.orchestrator.activation_lease_secs, 30);
        assert_eq!(cfg.orchestrator.attempt_soft_checkpoint_interval, 90);
        assert_eq!(
            cfg.orchestrator
                .scheduler
                .delivery_deterministic_batch_max_items,
            3
        );
        assert_eq!(
            cfg.orchestrator
                .scheduler
                .delivery_deterministic_batch_max_chars,
            6_000
        );
        assert_eq!(cfg.permissions.mode, PermissionMode::AutoReview);
        assert!(!cfg.background_task.timeout_notify_enabled);
        assert_eq!(cfg.background_task.timeout_notify_secs, 300);
        assert_eq!(cfg.tui.theme, TuiTheme::Cyan);
        assert_eq!(cfg.ui.language, UiLanguage::Auto);
    }

    #[test]
    fn tui_theme_is_strictly_parsed_from_config() {
        let config = toml::from_str::<AppConfig>("[tui]\ntheme='coral'\n").unwrap();
        assert_eq!(config.tui.theme, TuiTheme::Coral);
        assert!(toml::from_str::<AppConfig>("[tui]\ntheme='unknown'\n").is_err());
    }

    #[test]
    fn trusted_gateway_identity_is_explicit_and_strictly_parsed() {
        let config = toml::from_str::<AppConfig>(
            "[server.identity]\nmode='trusted-gateway'\nprovider_id='site-production'\nservice_token_env='SITE_MORPHZ_TOKEN'\n",
        )
        .unwrap();
        assert_eq!(
            config.server.identity.mode,
            ServerIdentityMode::TrustedGateway
        );
        assert_eq!(config.server.identity.provider_id, "site-production");
        assert_eq!(
            config.server.identity.service_token_env,
            "SITE_MORPHZ_TOKEN"
        );
        assert!(toml::from_str::<AppConfig>("[server.identity]\nmode='trust-whatever'\n").is_err());
    }

    #[test]
    fn ui_language_is_strictly_parsed_from_config() {
        let config = toml::from_str::<AppConfig>("[ui]\nlanguage='zh-CN'\n").unwrap();
        assert_eq!(config.ui.language, UiLanguage::SimplifiedChinese);
        assert!(toml::from_str::<AppConfig>("[ui]\nlanguage='fr'\n").is_err());
    }

    #[test]
    fn test_app_config_load_partial_toml() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[server]").unwrap();
        writeln!(tmp_file, "bind = \"0.0.0.0:9000\"").unwrap();
        writeln!(tmp_file, "broadcast_capacity = 2000").unwrap();
        writeln!(tmp_file, "[storage.sqlite]").unwrap();
        writeln!(tmp_file, "path = \"test.db\"").unwrap();

        let cfg = toml::from_str::<AppConfig>(&std::fs::read_to_string(tmp_file.path()).unwrap())
            .unwrap();
        assert_eq!(cfg.server.bind, "0.0.0.0:9000");
        assert_eq!(cfg.storage.sqlite.path, "test.db");
        // 未指定的部分应使用默认值
        assert_eq!(cfg.orchestrator.model_provider_max_in_flight, 4);
    }

    #[test]
    fn test_partial_section_uses_field_defaults() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[orchestrator]").unwrap();
        writeln!(tmp_file, "model_provider_max_in_flight = 2").unwrap();
        writeln!(tmp_file, "[orchestrator.event_bus]").unwrap();
        writeln!(tmp_file, "max_in_flight = 12").unwrap();
        writeln!(tmp_file, "[orchestrator.activation_admission]").unwrap();
        writeln!(tmp_file, "max_in_flight = 7").unwrap();

        let cfg = toml::from_str::<AppConfig>(&std::fs::read_to_string(tmp_file.path()).unwrap())
            .unwrap();
        assert_eq!(cfg.orchestrator.model_provider_max_in_flight, 2);
        assert_eq!(cfg.orchestrator.event_bus.max_in_flight, 12);
        assert_eq!(cfg.orchestrator.activation_admission.max_in_flight, 7);
        assert_eq!(cfg.orchestrator.tool_timeout_secs, 30);
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
    }

    #[test]
    fn obsolete_configuration_names_are_rejected_instead_of_silently_migrated() {
        let old_section = toml::from_str::<AppConfig>("[tool_security]\nworkspace_root='.'\n");
        assert!(old_section.is_err());

        let old_fields = toml::from_str::<AppConfig>(
            "[orchestrator]\nreply_timeout_secs=7\nmax_attempts_per_turn=11\n",
        );
        assert!(old_fields.is_err());
        let coupled_limit = toml::from_str::<AppConfig>("[orchestrator]\nconcurrency_limit=4\n");
        assert!(coupled_limit.is_err());
    }

    #[test]
    fn test_partial_llm_section_configures_request_timeout_and_retries() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "[llm]").unwrap();
        writeln!(tmp_file, "connect_timeout_secs = 7").unwrap();
        writeln!(tmp_file, "stream_idle_timeout_secs = 11").unwrap();
        writeln!(tmp_file, "max_retries = 1").unwrap();
        writeln!(tmp_file, "max_output_tokens = 131072").unwrap();
        writeln!(tmp_file, "reasoning_effort = 'high'").unwrap();

        let cfg = toml::from_str::<AppConfig>(&std::fs::read_to_string(tmp_file.path()).unwrap())
            .unwrap();
        assert_eq!(cfg.llm.connect_timeout_secs, 7);
        assert_eq!(cfg.llm.stream_idle_timeout_secs, 11);
        assert_eq!(cfg.llm.max_retries, 1);
        assert_eq!(cfg.llm.max_output_tokens, Some(131_072));
        assert_eq!(cfg.llm.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(cfg.llm.model, "gpt-4o-mini");
    }

    #[test]
    fn reasoning_effort_supports_off_and_max_but_rejects_unknown_levels() {
        let off = toml::from_str::<AppConfig>("[llm]\nreasoning_effort='none'\n").unwrap();
        assert_eq!(off.llm.reasoning_effort, Some(ReasoningEffort::Off));
        let max = toml::from_str::<AppConfig>("[llm]\nreasoning_effort='max'\n").unwrap();
        assert_eq!(max.llm.reasoning_effort, Some(ReasoningEffort::Max));
        assert!(toml::from_str::<AppConfig>("[llm]\nreasoning_effort='xhigh'\n").is_err());
    }
}
