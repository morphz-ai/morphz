use crate::i18n::UiLanguage;
use crate::llm::{ModelInputLimits, ReasoningEffort};
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
                let value = u64::try_from(value)
                    .map_err(|_| E::custom("duration must be greater than 0"))?;
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
        Err("duration must be greater than 0".to_string())
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
            .map_err(|_| "invalid duration value".to_string())?;
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
        .map_err(|_| "invalid duration value".to_string())?;
    positive_duration(
        number
            .checked_mul(multiplier)
            .ok_or_else(|| "duration exceeds the u64 seconds range".to_string())?,
    )
}

/// Minimal dependency-free `.env` loader that injects file entries into the process environment.
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
            // Explicit process variables take precedence so local files cannot override deployment
            // injection or test isolation.
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, val_cleaned);
            }
        }
    }
    Ok(())
}

pub(crate) fn parse_env_value(raw: &str) -> io::Result<String> {
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
            "user-level Morphz .env contains an unclosed quote or escape",
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
            home.filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join(".morphz"))
        })
        .or_else(|| {
            app_data
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join("Morphz"))
        })
        .or_else(|| {
            xdg_config_home
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join("morphz"))
        })
}

/// Previous releases used the platform configuration directory. Keep this
/// lookup private and read-only so a new binary can migrate host-owned state
/// without making the legacy location part of the public path contract.
fn legacy_morphz_home_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("MORPHZ_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(explicit));
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| path.join("morphz"))
        .or_else(|| {
            std::env::var_os("APPDATA")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join("Morphz"))
        })
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
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
        .or_else(|| host_state_path(".env"))
}

pub(crate) fn host_state_path(filename: &str) -> Option<PathBuf> {
    let primary = morphz_home_dir()?.join(filename);
    if primary.exists() {
        return Some(primary);
    }
    if let Some(legacy) = legacy_morphz_home_dir().map(|path| path.join(filename)) {
        if legacy.exists() {
            return Some(legacy);
        }
    }
    Some(primary)
}

// ==========================================
// Centralized production configuration.
// ==========================================

/// Orchestrator runtime configuration that centralizes operational constants.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OrchestratorConfig {
    /// Maximum number of concurrent physical model-provider requests.
    ///
    /// This constrains model calls, not activations waiting on tools, timers, or approval.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub model_provider_max_in_flight: usize,
    /// In-process concurrency window for asynchronous EventBus business handlers.
    pub event_bus: EventBusConfig,
    /// Bounded single-node write and group-commit policy for durable Session state and Events.
    pub event_writer: EventWriterConfig,
    /// General runtime scheduling policy. It defines physical windows, not task semantics.
    pub scheduler: SchedulerConfig,
    /// Single-node admission policy for durable Thread Activations moving from queued to running.
    pub activation_admission: ActivationAdmissionConfig,
    /// Maximum delegation-chain depth. The first sub-agent spawned by the root agent has depth 1.
    pub max_delegation_depth: usize,
    /// Maximum number of queued or running delegations owned by one agent.
    pub max_active_delegations_per_agent: usize,
    /// Progress-notification interval while awaiting a final reply, in seconds; 0 disables it.
    ///
    /// This is not a task timeout: the client waits until the agent replies or the user interrupts.
    pub reply_wait_notice_secs: u64,
    /// Tool execution timeout, in seconds.
    pub tool_timeout_secs: u64,
    /// Maximum wait for a model-provider concurrency slot. This limits only queueing, not a
    /// physical request that continues to produce stream data.
    pub model_provider_queue_timeout_secs: u64,
    /// Renewable lease duration for a Thread Activation, in seconds.
    ///
    /// This is a failure-detection window, not a model or tool timeout. The runtime holding local
    /// execution authority renews the lease before expiry. After that process exits, another
    /// runtime waits at most this long before taking over safely, rather than treating a complete
    /// model-request deadline as the failure-detection interval.
    #[serde(deserialize_with = "deserialize_positive_u64")]
    pub activation_lease_secs: u64,
    /// Renewable failure-detection window for an Objective Evaluation, in seconds.
    ///
    /// This is not a maximum duration for the Objective or model request. A running Activation
    /// keeps renewing its lease. If its runtime or worker disappears, another node waits at most
    /// this long before taking over with a new fencing token; the interval must not be derived from
    /// a model hard deadline that may span several minutes.
    #[serde(deserialize_with = "deserialize_positive_u64")]
    pub objective_evaluation_lease_secs: u64,
    /// Optional absolute wall-clock limit for one physical model request. `None` disables the hard
    /// deadline; provider idle-timeout detection still catches stalled streams.
    pub model_attempt_hard_timeout_secs: Option<u64>,
    /// Safety circuit-breaker limit for reasoning-only continuations.
    ///
    /// This is not a normal scheduling budget. It only prevents unbounded consumption when a
    /// provider or model misbehaves. `None` disables count-based breaking; healthy reasoning that
    /// continues to make progress is not throttled.
    pub reasoning_continuation_safety_limit: Option<usize>,
    /// Number of identical consecutive reasoning summaries that constitutes a stall; 0 disables it.
    pub max_stalled_reasoning_continuations: usize,
    /// A new message from the same Principal replaces an in-flight
    /// DialogueTurn until that turn crosses the durable Execution boundary.
    /// Disable this to preserve strict FIFO dialogue behavior.
    pub interrupt_dialogue_on_new_message: bool,
    /// Warning threshold for agent-owned context, in estimated tokens.
    pub context_soft_token_limit: usize,
    /// Physical hard limit for agent-owned context, in estimated tokens.
    pub context_hard_token_limit: usize,
    /// Token capacity reserved for agent-driven context maintenance.
    pub context_maintenance_reserve_tokens: usize,
    /// Maximum characters shown for one raw Observation; the persisted Event retains full text.
    pub observation_preview_chars: usize,
    /// Soft model-evaluation checkpoint interval for one user message. It prompts reflection but
    /// does not stop the task.
    pub attempt_soft_checkpoint_interval: usize,
    /// Maximum Context transactions per user turn; does not limit physical tools or replies.
    pub max_context_transactions_per_turn: usize,
    /// Whether the model-facing Runtime exposes Context transactions.
    ///
    /// This defaults to true. A false value keeps the production Context projection and durable
    /// Event path while making the Mind read-only for controlled evaluations or restricted hosts.
    pub context_transactions_enabled: bool,
    /// Maximum number of validated authoritative Context states retained by
    /// one exclusive Runtime process. A value of zero disables the cache.
    /// Shared-worker modes bypass it until they can revision-fence a cached
    /// state against the database head.
    pub context_state_cache_capacity: usize,
    /// Session history automatically included in the current Context Encoding.
    pub session_working_set: SessionWorkingSetConfig,
    /// Cognitive-activity window between an explicit frame-retirement request and actual retirement.
    pub frame_retirement: FrameRetirementConfig,
    /// Tools available to `call` in `eval` programs and to evidence collection in `infer`.
    ///
    /// Both paths share this list. Admission of the whole program cannot foresee every argument
    /// produced after `map`, so out-of-scope tools discovered during evaluation are rejected rather
    /// than escalated for approval. Separate lists would let this invariant drift with configuration.
    ///
    /// If omitted, a default read-only set is used. An explicit empty list disables all in-tree
    /// tool calls, leaving only structure and `infer` in `eval`. Tools outside this list remain
    /// available through ordinary Function Calling, and their own jail and path checks still apply.
    pub eval_callable_tools: Vec<String>,
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
            objective_evaluation_lease_secs: 90,
            model_attempt_hard_timeout_secs: None,
            reasoning_continuation_safety_limit: Some(64),
            max_stalled_reasoning_continuations: 3,
            interrupt_dialogue_on_new_message: true,
            context_soft_token_limit: 196_608,
            context_hard_token_limit: 262_144,
            context_maintenance_reserve_tokens: 32_768,
            observation_preview_chars: 16_000,
            attempt_soft_checkpoint_interval: 90,
            max_context_transactions_per_turn: 6,
            context_transactions_enabled: true,
            context_state_cache_capacity: 64,
            session_working_set: SessionWorkingSetConfig::default(),
            frame_retirement: FrameRetirementConfig::default(),
            eval_callable_tools: crate::sexpr_eval::DEFAULT_CALLABLE_TOOLS
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        }
    }
}

/// Single-node backpressure policy for asynchronous EventBus business dispatch.
///
/// This window precedes Activation and model-provider admission and constrains only concurrent
/// business handlers. Durable redelivery of the same Event to one subscriber is deduplicated first.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct EventBusConfig {
    /// Maximum number of concurrent asynchronous business handlers.
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
    /// Advances only when the current Cognitive Context receives new external facts; not wall time.
    #[serde(deserialize_with = "deserialize_positive_u64")]
    pub cooling_ticks: u64,
}

impl Default for FrameRetirementConfig {
    fn default() -> Self {
        Self { cooling_ticks: 8 }
    }
}

/// Single-writer batch-commit window for SQLite WAL. Every producer waits for confirmation of the
/// actual commit; a full queue applies backpressure and never silently drops a durable Event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct EventWriterConfig {
    /// Maximum in-process requests waiting for a durable commit.
    pub queue_capacity: usize,
    /// Maximum Events committed by one SQLite transaction.
    pub max_batch_size: usize,
    /// Small window for coalescing adjacent writes after the first Event arrives.
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

/// General durable scheduling policy for the runtime.
///
/// The delivery window coalesces only adjacent completion notices in one Session. It neither delays
/// nor combines the underlying physical Thread results.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct SchedulerConfig {
    /// Wait after the first background result so adjacent results share one Delivery Router decision.
    pub delivery_merge_window: HumanDuration,
    /// Maximum time the first pending result may wait, regardless of later arrivals.
    pub delivery_max_wait: HumanDuration,
    /// Hard bound for one durable Delivery Timer snapshot and one Delivery
    /// Composer request. Remaining results stay pending for the next
    /// generation instead of inflating one timer/model input without bound.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub delivery_snapshot_max_items: usize,
    /// Number of pending Sessions inspected in one startup-recovery page.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub delivery_recovery_page_size: usize,
    /// Maximum completed results the runtime may combine deterministically without a model call.
    /// A single result is always passed through verbatim; larger batches use the Delivery Composer.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub delivery_deterministic_batch_max_items: usize,
    /// Maximum total characters in deterministic batch delivery. Larger batches are compressed by
    /// the model so the runtime does not mechanically concatenate multiple long terminal reports.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub delivery_deterministic_batch_max_chars: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            delivery_merge_window: HumanDuration::from_secs(1),
            delivery_max_wait: HumanDuration::from_secs(3),
            delivery_snapshot_max_items: 64,
            delivery_recovery_page_size: 256,
            delivery_deterministic_batch_max_items: 3,
            delivery_deterministic_batch_max_chars: 6_000,
        }
    }
}

/// Single-node admission configuration for durable Activations.
///
/// `max_in_flight` limits complete Activations on one node independently of model-provider request
/// quotas. Remaining fields define queueing, reserved capacity, and aging. All values are runtime
/// policy; arbitrary numeric priorities supplied by a model are never accepted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ActivationAdmissionConfig {
    /// Maximum complete Activations in `running`. An Activation waiting on a tool, timer, or approval
    /// remains part of the execution unit but does not consume a model-provider slot.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_in_flight: usize,
    /// Maximum durable queued Activations waiting in runtime memory.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_queued: usize,
    /// Running slots reserved for interactive dialogue and completion delivery.
    pub dialogue_delivery_reserved_slots: usize,
    /// Tail queue positions reserved for interactive dialogue and completion delivery.
    pub dialogue_delivery_reserved_queue_slots: usize,
    /// Promote a fixed class after each complete waiting interval to prevent starvation.
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
    /// Maximum age of the latest cognitively meaningful activity at evaluation time.
    pub active_window: HumanDuration,
    /// Maximum Full Projection Sessions, including the current Session.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_sessions: usize,
}

fn deserialize_positive_usize<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = usize::deserialize(deserializer)?;
    if value == 0 {
        Err(serde::de::Error::custom(
            "configuration value must be greater than or equal to 1",
        ))
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
        Err(serde::de::Error::custom(
            "configuration value must be greater than or equal to 1",
        ))
    } else {
        Ok(value)
    }
}

fn deserialize_optional_positive_usize<'de, D>(deserializer: D) -> Result<Option<usize>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<usize>::deserialize(deserializer)?;
    if value == Some(0) {
        Err(serde::de::Error::custom(
            "configuration value must be greater than or equal to 1",
        ))
    } else {
        Ok(value)
    }
}

fn deserialize_optional_reasoning_effort<'de, D>(
    deserializer: D,
) -> Result<Option<ReasoningEffort>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case("default")
        || value.eq_ignore_ascii_case("auto")
    {
        return Ok(None);
    }
    ReasoningEffort::parse(value).map(Some).ok_or_else(|| {
        serde::de::Error::custom(
            "reasoning_effort supports only default, none, low, medium, high, or max",
        )
    })
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

/// Authoritative representation used for the Agent's current cognitive state.
///
/// ContextDB is the product default. `Legacy` is an explicit, temporary
/// rollback mode kept only for the pre-release stabilization window; selecting
/// the physical database backend never changes this choice implicitly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CognitiveStoreBackend {
    #[default]
    ContextDb,
    Legacy,
}

impl CognitiveStoreBackend {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ContextDb => "context_db",
            Self::Legacy => "legacy",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "context_db" | "context-db" | "contextdb" => Ok(Self::ContextDb),
            "legacy" => Ok(Self::Legacy),
            _ => Err(format!(
                "cognitive_store supports only context_db or legacy: {value}"
            )),
        }
    }
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

/// Conservative startup cleanup for records that no longer carry Runtime
/// authority. This never applies to persisted Events, model attempts, Threads,
/// Objectives, tool results, Mind snapshots, or Recall documents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StorageRetentionConfig {
    pub enabled: bool,
    pub resolved_signal_outbox_age: HumanDuration,
    pub expired_edge_credential_age: HumanDuration,
    pub startup_batch_limit: usize,
}

impl Default for StorageRetentionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            resolved_signal_outbox_age: HumanDuration::from_secs(7 * 24 * 60 * 60),
            expired_edge_credential_age: HumanDuration::from_secs(24 * 60 * 60),
            startup_batch_limit: 1_000,
        }
    }
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
    pub cognitive_store: CognitiveStoreBackend,
    pub sqlite: SqliteStorageConfig,
    pub postgres: PostgresStorageConfig,
    pub retention: StorageRetentionConfig,
}

/// Server and network configuration.
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

/// Server and network configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Web server bind address.
    pub bind: String,
    /// WebSocket broadcast-channel capacity.
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

/// LLM client configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LlmConfig {
    /// Selects a Provider instance from `[providers.<id>]`; may be empty before initial setup.
    pub provider: Option<String>,
    /// Primary model name.
    pub model: String,
    /// Models the current Provider permits at runtime. `model` is merged into this catalog
    /// automatically for backward compatibility; the Dashboard can select only declared models.
    pub models: Vec<String>,
    /// Logical Model Routes an Agent may select explicitly for delegated
    /// Evaluations such as infer or schedule_tx.spawn. The primary `model` is
    /// always permitted and remains the default when no override is supplied.
    /// An empty list therefore grants no additional model authority.
    pub allowed_evaluation_models: Vec<String>,
    /// Maximum retry count.
    pub max_retries: u32,
    /// Initial retry backoff, in seconds.
    pub initial_backoff_secs: u64,
    /// TCP/TLS connection timeout, in seconds.
    pub connect_timeout_secs: u64,
    /// Maximum silence between adjacent stream chunks after the first response-body byte. Each
    /// chunk resets the timer so continuously emitted reasoning is not terminated accidentally.
    pub stream_idle_timeout_secs: u64,
    /// Maximum wait for response headers and, after successful headers, the first response-body
    /// byte. Large contexts often have much higher first-byte latency than inter-chunk latency, so
    /// this must be configured independently.
    pub first_byte_timeout_secs: u64,
    /// Maximum output tokens for one completion; `None` delegates the default to the model service.
    pub max_output_tokens: Option<u32>,
    /// Native model reasoning depth; `None` omits the control field and preserves model defaults.
    #[serde(default, deserialize_with = "deserialize_optional_reasoning_effort")]
    pub reasoning_effort: Option<ReasoningEffort>,
}

/// Host-owned safety ceilings for binary inputs that may become visible to a
/// model. These are resource-protection policy, not claims about any Provider
/// or physical model. Exact Provider limits belong to [`ProviderModelConfig`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ModelInputConfig {
    /// Maximum artifacts accepted by one ingress/tool-result import.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_artifacts_per_import: usize,
    /// Maximum decoded bytes of one imported artifact.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_artifact_bytes: usize,
    /// Maximum decoded bytes accepted by one import operation.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_import_bytes: usize,
    /// Maximum artifacts assembled into one physical model request.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_artifacts_per_request: usize,
    /// Maximum decoded artifact bytes assembled into one model request.
    #[serde(deserialize_with = "deserialize_positive_usize")]
    pub max_request_bytes: usize,
    /// Minimum age before startup recovery may treat a pending message import
    /// as abandoned. This protects an import still running in another Runtime
    /// worker while allowing crash leftovers to be reclaimed deterministically.
    pub pending_import_grace: HumanDuration,
}

impl Default for ModelInputConfig {
    fn default() -> Self {
        Self {
            // These defaults intentionally support large screenshot sets such
            // as a 43-image visual review. They remain finite host safeguards
            // and may be raised by an operator with sufficient memory/disk.
            max_artifacts_per_import: 128,
            max_artifact_bytes: 128 * 1024 * 1024,
            max_import_bytes: 256 * 1024 * 1024,
            max_artifacts_per_request: 128,
            max_request_bytes: 256 * 1024 * 1024,
            // Message persistence and the following database claim normally
            // complete within seconds. One hour is a deliberately conservative
            // multi-worker fencing window and remains operator-configurable.
            pending_import_grace: HumanDuration::from_secs(60 * 60),
        }
    }
}

impl ModelInputConfig {
    pub fn import_limits(&self) -> ModelInputLimits {
        ModelInputLimits {
            max_attachments: Some(self.max_artifacts_per_import),
            max_attachment_bytes: Some(self.max_artifact_bytes),
            max_total_bytes: Some(self.max_import_bytes),
        }
    }

    pub fn request_limits(&self) -> ModelInputLimits {
        ModelInputLimits {
            max_attachments: Some(self.max_artifacts_per_request),
            max_attachment_bytes: Some(self.max_artifact_bytes),
            max_total_bytes: Some(self.max_request_bytes),
        }
    }

    /// Dashboard currently transports message attachments as JSON Base64.
    /// Derive that transport envelope from the decoded import policy so the
    /// HTTP layer cannot silently impose a different product limit.
    pub fn dashboard_body_limit_bytes(&self) -> usize {
        let base64_bytes = (self.max_import_bytes.saturating_add(2) / 3).saturating_mul(4);
        base64_bytes
            .saturating_add(self.max_artifacts_per_import.saturating_mul(1024))
            .saturating_add(2 * 1024 * 1024)
    }
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: None,
            // An unconfigured Runtime has no model. A product default here
            // would be indistinguishable from an operator-selected physical
            // model and would leak into the Dashboard selector.
            model: String::new(),
            models: Vec::new(),
            allowed_evaluation_models: Vec::new(),
            max_retries: 5,
            initial_backoff_secs: 1,
            connect_timeout_secs: 30,
            stream_idle_timeout_secs: 120,
            first_byte_timeout_secs: 300,
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

/// Prompt-cache behavior declared for one physical Provider/model pair.
///
/// This is deliberately endpoint capability, not a task preference. `Auto`
/// preserves the canonical single-text request and lets the endpoint discover
/// token prefixes implicitly. Capabilities such as explicit breakpoints must
/// be declared by the operator because a model name cannot identify the
/// physical endpoint behind an OpenAI-compatible gateway.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PromptCacheStrategy {
    #[default]
    Auto,
    Disabled,
    ImplicitPrefix,
    ImplicitContentBoundaries,
    ImplicitMessageBoundaries,
    /// Compile-time gated ChatGPT/Codex compatibility experiment. The
    /// Provider receives one User message containing a canonical Context seed
    /// followed by ordered ContextDelta input_text blocks.
    ExperimentalStructuredDeltas,
    ExplicitContentBoundaries,
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

    /// Temporary CLIProxyAPI compatibility workaround for Claude models.
    ///
    /// Its OpenAI-compatible Responses path currently loses two pieces of
    /// Anthropic protocol truth observed in production: an upstream
    /// `stop_reason=refusal` can become an empty successful response, and a
    /// completed reasoning output item can be followed by a synthesized
    /// missing-terminal error. The same gateway's native Messages path
    /// preserves both boundaries, so Claude physical models use that path even
    /// when the Provider instance was configured as OpenAI-compatible.
    ///
    /// FIXME(cliproxyapi): remove this model-name override once the Responses
    /// translator (1) preserves an explicit refusal terminal and (2) always
    /// emits a valid terminal envelope after authoritative output-item events.
    /// Keep the native refusal/parser tests when removing it so a proxy upgrade
    /// cannot silently reintroduce empty responses or reasoning replay loops.
    pub fn effective_for_model(self, model: &str) -> Self {
        let model = model.trim().to_ascii_lowercase();
        let is_claude = model == "claude" || model.starts_with("claude-");
        match self {
            Self::OpenaiResponses | Self::OpenaiChat if is_claude => Self::AnthropicMessages,
            configured => configured,
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
    /// Environment-variable name or Keychain account.
    pub name: Option<String>,
    /// Keychain service; defaults to `morphz` when omitted.
    pub service: Option<String>,
    /// Credential-helper command and arguments with no stdin; the first item is the executable.
    pub command: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderConfig {
    pub protocol: ModelProtocol,
    pub base_url: String,
    pub credential: Option<String>,
    /// Operator-declared physical capabilities keyed by the exact model name
    /// accepted by this Provider endpoint. Morphz never probes a remote model
    /// in the request path; an absent entry falls back to the global Runtime
    /// context limit.
    pub models: BTreeMap<String, ProviderModelConfig>,
    /// Non-sensitive static headers.
    pub headers: BTreeMap<String, String>,
    /// Header-name to environment-variable mapping for additional sensitive headers.
    pub env_headers: BTreeMap<String, String>,
}

/// A deployable model endpoint. Authentication identities are deliberately
/// referenced as an account pool instead of being embedded in this object.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderInstanceConfig {
    /// Thin service-specific composition layer, for example
    /// `openai-compatible` or `openai-codex`.
    pub adapter: String,
    pub protocol: ModelProtocol,
    pub base_url: String,
    /// Ordered account pool. Dynamic health/cooldown state is Runtime data and
    /// therefore never written back into this static configuration.
    pub accounts: Vec<String>,
    pub models: BTreeMap<String, ProviderModelConfig>,
    pub headers: BTreeMap<String, String>,
    pub env_headers: BTreeMap<String, String>,
}

/// Non-secret catalog metadata for one independently schedulable login.
/// `credential_ref` points at the existing credential/Secret Store boundary;
/// token values are never placed in this structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthAccountConfig {
    pub auth_adapter: String,
    pub credential_ref: String,
    /// Explicit Secret Store value backend for OAuth token sets. `None` uses
    /// the Runtime default (normally the native OS credential store). A
    /// headless deployment may deliberately select `morphz_env_file`; Morphz
    /// never falls back to plaintext implicitly.
    pub secret_backend: Option<String>,
    pub provider: Option<String>,
    pub label: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl AuthAccountConfig {
    pub fn enabled(&self) -> bool {
        self.enabled
    }
}

impl Default for AuthAccountConfig {
    fn default() -> Self {
        Self {
            auth_adapter: String::new(),
            credential_ref: String::new(),
            secret_backend: None,
            provider: None,
            label: None,
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ModelRouteAffinity {
    None,
    Session,
    #[default]
    Context,
    Objective,
    Explicit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ModelRouteSelection {
    #[default]
    #[serde(alias = "least-recently-used")]
    AvailableLeastRecentlyUsed,
    Priority,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ModelRouteCandidateConfig {
    #[serde(alias = "service")]
    pub provider: String,
    /// Exact physical model name accepted by this Provider Instance.
    #[serde(alias = "physical_model")]
    pub model: String,
    /// Lower values are preferred.
    pub priority: u32,
    /// Optional hard account pin used for operator-controlled routes.
    pub account: Option<String>,
    /// Capabilities required from this candidate before it is eligible.
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct ModelRouteConfig {
    /// User-selected alias preferred by operator-facing model selectors. A
    /// generated Route ID is not a display alias unless the operator records
    /// it here explicitly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_alias: Option<String>,
    /// Additional public aliases accepted for route resolution. The map key
    /// is also accepted by the routing engine, but may be system-generated.
    pub aliases: Vec<String>,
    #[serde(alias = "targets")]
    pub candidates: Vec<ModelRouteCandidateConfig>,
    #[serde(alias = "stickiness")]
    pub affinity: ModelRouteAffinity,
    #[serde(alias = "strategy")]
    pub selection: ModelRouteSelection,
    pub fallback: bool,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ModelRouteConfigInput {
    display_alias: Option<String>,
    aliases: Vec<String>,
    #[serde(alias = "targets")]
    candidates: Vec<ModelRouteCandidateConfig>,
    #[serde(alias = "stickiness")]
    affinity: ModelRouteAffinity,
    #[serde(alias = "strategy")]
    selection: ModelRouteSelection,
    fallback: bool,
    service: Option<String>,
    physical_model: Option<String>,
    account: Option<String>,
    priority: u32,
    capabilities: Vec<String>,
}

impl<'de> Deserialize<'de> for ModelRouteConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = ModelRouteConfigInput::deserialize(deserializer)?;
        let direct_target_present = input.service.is_some()
            || input.physical_model.is_some()
            || input.account.is_some()
            || input.priority != 0
            || !input.capabilities.is_empty();
        if direct_target_present && !input.candidates.is_empty() {
            return Err(serde::de::Error::custom(
                "a model cannot use direct target fields and [[models.<name>.targets]] together",
            ));
        }
        let candidates = if direct_target_present {
            let provider = input
                .service
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    serde::de::Error::custom("direct model target is missing service")
                })?;
            let model = input
                .physical_model
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    serde::de::Error::custom("direct model target is missing physical_model")
                })?;
            vec![ModelRouteCandidateConfig {
                provider,
                model,
                priority: input.priority,
                account: input.account,
                capabilities: input.capabilities,
            }]
        } else {
            input.candidates
        };
        Ok(Self {
            display_alias: input.display_alias,
            aliases: input.aliases,
            candidates,
            affinity: input.affinity,
            selection: input.selection,
            fallback: input.fallback,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderModelConfig {
    /// Physical prompt-cache capability for this exact Provider/model pair.
    pub prompt_cache_strategy: PromptCacheStrategy,
    /// Total model context window, including input and generated output.
    #[serde(deserialize_with = "deserialize_optional_positive_usize")]
    pub context_window_tokens: Option<usize>,
    /// Explicit prompt/input ceiling. When present it is more authoritative
    /// than deriving a ceiling from `context_window_tokens`.
    #[serde(deserialize_with = "deserialize_optional_positive_usize")]
    pub max_input_tokens: Option<usize>,
    /// Output allowance reserved when deriving the physical prompt ceiling.
    #[serde(deserialize_with = "deserialize_optional_positive_usize")]
    pub max_output_tokens: Option<usize>,
    /// Exact maximum attachment count declared by this Provider/model. `None`
    /// means unknown; Morphz never manufactures a value from a model name.
    #[serde(deserialize_with = "deserialize_optional_positive_usize")]
    pub max_input_attachments: Option<usize>,
    /// Exact decoded byte ceiling for one attachment, when declared.
    #[serde(deserialize_with = "deserialize_optional_positive_usize")]
    pub max_input_attachment_bytes: Option<usize>,
    /// Exact decoded byte ceiling for all attachments in one request.
    #[serde(deserialize_with = "deserialize_optional_positive_usize")]
    pub max_input_attachment_total_bytes: Option<usize>,
}

impl ProviderModelConfig {
    pub fn prompt_token_limit(&self) -> Option<usize> {
        self.max_input_tokens.or_else(|| {
            self.context_window_tokens.and_then(|window| {
                window
                    .checked_sub(self.max_output_tokens.unwrap_or_default())
                    .filter(|limit| *limit > 0)
            })
        })
    }

    pub fn model_input_limits(&self) -> ModelInputLimits {
        ModelInputLimits {
            max_attachments: self.max_input_attachments,
            max_attachment_bytes: self.max_input_attachment_bytes,
            max_total_bytes: self.max_input_attachment_total_bytes,
        }
    }
}

/// Background-task configuration: the runtime reports timeouts but does not kill automatically.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BackgroundTaskConfig {
    pub timeout_notify_enabled: bool,
    pub timeout_notify_secs: u64,
    pub max_output_buffer_bytes: usize,
    /// Window for combining background stdout/stderr before publishing Events, avoiding line-by-line
    /// Event Store amplification.
    pub output_event_coalesce_ms: u64,
    /// Maximum characters in one background-output Event; artifacts always retain full content.
    pub max_output_event_chars: usize,
    /// Archive directory for full raw `exec` output. Context contains only a bounded preview and a
    /// stable reference to this file.
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

/// Optional pinned Runtime-local Managed SSH destinations. Normal on-demand
/// use resolves the host user's existing OpenSSH aliases and needs no Morphz
/// target configuration; pinned descriptors keep connection details in
/// operator-owned endpoint files.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ManagedSshConfig {
    pub targets: Vec<ManagedSshTargetConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ManagedSshTargetConfig {
    pub id: String,
    pub name: String,
    pub endpoint_ref: String,
    pub owner_principal_id: Option<String>,
    pub platform: Option<String>,
    pub workspace_root: Option<String>,
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

/// Operator opt-ins for code which has no stability or compatibility promise.
/// Compilation alone never enables an experiment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ExperimentalConfig {
    pub enabled: BTreeSet<String>,
    /// Experimental Cognitive Coordination participant and Mesh settings.
    /// Empty configuration keeps the feature visible but fail-closed.
    pub cognitive_coordination: CognitiveCoordinationConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CognitiveCoordinationConfig {
    /// One Coordination Mesh discovery source. Supported v0 forms are
    /// `static:URL,URL` and `file:/absolute/or/relative/path.toml`.
    /// Discovery is advisory and never gates local Runtime startup.
    pub mesh: Option<String>,
    pub participant: Option<CognitiveCoordinationParticipantConfig>,
    pub peers: Vec<CognitiveCoordinationPeerConfig>,
    pub request_timeout_secs: u64,
    pub handshake_timeout_secs: u64,
    pub handshake_ttl_secs: u64,
    pub heartbeat_interval_secs: u64,
    pub max_clock_skew_secs: u64,
}

impl Default for CognitiveCoordinationConfig {
    fn default() -> Self {
        Self {
            mesh: None,
            participant: None,
            peers: Vec::new(),
            request_timeout_secs: 180,
            handshake_timeout_secs: 10,
            handshake_ttl_secs: 60,
            heartbeat_interval_secs: 10,
            max_clock_skew_secs: 60,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CognitiveCoordinationParticipantConfig {
    pub authority_id: String,
    pub agent_id: String,
    pub context_id: String,
    /// Deprecated compatibility field. Coordination Mesh advertisements do
    /// not bind a Runtime node to one durable Session; each Assignment receives
    /// a request-scoped execution Session mounted into the participant's shared
    /// Context unless the operator explicitly isolates that Session.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session_id: String,
    pub capabilities: BTreeSet<String>,
    pub max_token_budget: u64,
    pub priority: i32,
    /// Legacy explicit-peer mode only: environment variable holding the
    /// node's HMAC secret. Mesh mode uses the node identity in Secret Store.
    pub token_env: String,
    /// Empty means only the participant Runtime's effective default route may
    /// be used remotely. Additional routes require explicit operator consent.
    pub allowed_model_routes: BTreeSet<String>,
}

impl Default for CognitiveCoordinationParticipantConfig {
    fn default() -> Self {
        Self {
            authority_id: String::new(),
            agent_id: "default-agent".to_string(),
            context_id: "context-default".to_string(),
            session_id: String::new(),
            capabilities: BTreeSet::from(["general-reasoning".to_string()]),
            max_token_budget: 32_768,
            priority: 0,
            token_env: "MORPHZ_COORDINATION_TOKEN".to_string(),
            allowed_model_routes: BTreeSet::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CognitiveCoordinationPeerConfig {
    pub authority_id: String,
    pub base_url: String,
    /// Environment variable holding the pairwise HMAC secret shared with this
    /// Authority. Both sides of a pairing must configure the same secret.
    pub token_env: String,
    pub enabled: bool,
}

impl Default for CognitiveCoordinationPeerConfig {
    fn default() -> Self {
        Self {
            authority_id: String::new(),
            base_url: String::new(),
            token_env: "MORPHZ_COORDINATION_TOKEN".to_string(),
            enabled: true,
        }
    }
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            language: UiLanguage::Auto,
        }
    }
}

/// Production global configuration aggregating all sub-configurations.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub orchestrator: OrchestratorConfig,
    pub llm: LlmConfig,
    pub model_input: ModelInputConfig,
    pub usage_pricing: UsagePricingConfig,
    pub providers: BTreeMap<String, ProviderConfig>,
    pub credentials: BTreeMap<String, CredentialConfig>,
    /// Authoritative Provider/Account/Route model. Legacy `providers` and
    /// `credentials` are normalized into these structures once at startup
    /// when this catalog is absent; evaluation never consults both models.
    #[serde(alias = "services")]
    pub provider_instances: BTreeMap<String, ProviderInstanceConfig>,
    #[serde(alias = "accounts")]
    pub auth_accounts: BTreeMap<String, AuthAccountConfig>,
    #[serde(alias = "models")]
    pub model_routes: BTreeMap<String, ModelRouteConfig>,
    pub permissions: PermissionConfig,
    pub background_task: BackgroundTaskConfig,
    pub edge_execution: EdgeExecutionConfig,
    pub managed_ssh: ManagedSshConfig,
    pub experimental: ExperimentalConfig,
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
        let mut value = toml::Value::try_from(&self.config).map_err(|error| {
            format!("failed to construct CLI configuration override view: {error}")
        })?;
        for override_text in overrides {
            let (key, raw_value) = override_text
                .split_once('=')
                .ok_or_else(|| format!("--set requires key=value; received '{override_text}'"))?;
            validate_dotted_config_key(key)?;
            let parsed = parse_cli_toml_value(raw_value);
            set_toml_path(&mut value, key, parsed)?;
            self.mark_source(key, "cli:--set");
        }
        self.config = value
            .try_into::<AppConfig>()
            .map_err(|error| format!("--set produced invalid configuration: {error}"))?;
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
        Err(format!("invalid --set configuration key '{key}'"))
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
        let table = cursor.as_table_mut().ok_or_else(|| {
            format!(
                "--set parent path '{}' is not a configuration table",
                segment
            )
        })?;
        cursor = table
            .get_mut(*segment)
            .ok_or_else(|| format!("--set references unknown configuration path '{key}'"))?;
    }
    let table = cursor
        .as_table_mut()
        .ok_or_else(|| format!("--set parent path is not a configuration table: '{key}'"))?;
    let leaf = segments.last().expect("validated key has one segment");
    if !table.contains_key(*leaf) {
        return Err(format!(
            "--set references unknown configuration key '{key}'"
        ));
    }
    table.insert((*leaf).to_string(), value);
    Ok(())
}

/// Loads durable configuration layers without consulting the working tree for
/// credentials. The host configuration is `~/.morphz/morphz.toml`; project
/// configuration belongs in `.morphz/morphz.toml` and is subject to the
/// ownership policy below. Previous filenames remain read-only compatibility
/// layers so an upgrade never drops an existing account or model selection.
pub fn resolve_config(
    cwd: &Path,
    explicit_path: Option<&Path>,
    profile: Option<&str>,
) -> Result<ResolvedConfig, String> {
    let primary_home = morphz_home_dir();
    if let Some(home) = primary_home.as_ref() {
        let primary = home.join("morphz.toml");
        migrate_primary_config_if_needed(&primary)?;
        split_primary_model_config_if_needed(&primary, &home.join("models.toml"))?;
    }
    resolve_config_with_homes(
        cwd,
        explicit_path,
        profile,
        primary_home,
        legacy_morphz_home_dir(),
    )
}

pub fn managed_config_path() -> Result<PathBuf, String> {
    let path = morphz_home_dir()
        .map(|home| home.join("morphz.toml"))
        .ok_or_else(|| "cannot determine Morphz user configuration directory".to_string())?;
    migrate_primary_config_if_needed(&path)?;
    let model_path = path.with_file_name("models.toml");
    split_primary_model_config_if_needed(&path, &model_path)?;
    Ok(path)
}

/// Operator-owned Provider, Account, Model Route and default inference
/// configuration. Runtime policy stays in `morphz.toml`; model infrastructure
/// stays in this file so changing a route never requires editing the kernel's
/// unrelated storage, permission or scheduler settings.
pub fn managed_model_config_path() -> Result<PathBuf, String> {
    let core_path = managed_config_path()?;
    Ok(core_path.with_file_name("models.toml"))
}

const MODEL_CONFIG_ROOT_KEYS: &[&str] = &[
    "llm",
    "usage_pricing",
    "providers",
    "credentials",
    "services",
    "accounts",
    "models",
];

fn split_primary_model_config_if_needed(core_path: &Path, model_path: &Path) -> Result<(), String> {
    if !core_path.is_file() {
        return Ok(());
    }
    let content = std::fs::read_to_string(core_path).map_err(|error| {
        format!(
            "failed to read Morphz core configuration '{}': {error}",
            core_path.display()
        )
    })?;
    let mut core = content.parse::<toml::Value>().map_err(|error| {
        format!(
            "failed to parse Morphz core configuration '{}': {error}",
            core_path.display()
        )
    })?;
    canonicalize_primary_config(&mut core)?;
    let core_table = core
        .as_table_mut()
        .ok_or_else(|| "Morphz configuration root must be a TOML table".to_string())?;
    let mut extracted = toml::map::Map::new();
    for key in MODEL_CONFIG_ROOT_KEYS {
        if let Some(value) = core_table.remove(*key) {
            extracted.insert((*key).to_string(), value);
        }
    }
    if extracted.is_empty() {
        return Ok(());
    }

    // Write the model file first. If the process stops before replacing the
    // core file, the loader gives models.toml precedence, so the duplicate
    // old keys remain harmless and the next startup completes the cleanup.
    let mut models = read_managed_value(model_path)?;
    let mut extracted = toml::Value::Table(extracted);
    merge_toml_prefer_right(&mut extracted, models);
    models = extracted;
    write_managed_value(model_path, &models)?;
    write_managed_value(core_path, &core)
}

fn migrate_primary_config_if_needed(primary: &Path) -> Result<(), String> {
    if let (Some(primary_home), Some(legacy_home)) = (primary.parent(), legacy_morphz_home_dir()) {
        if primary_home != legacy_home {
            migrate_legacy_host_files(primary_home, &legacy_home)?;
        }
    }
    if primary.exists() {
        return Ok(());
    }
    let mut candidates = Vec::new();
    if let Some(home) = legacy_morphz_home_dir() {
        candidates.push(home.join("config.toml"));
        candidates.push(home.join("managed.toml"));
    }
    if let Some(home) = morphz_home_dir() {
        candidates.push(home.join("config.toml"));
        candidates.push(home.join("managed.toml"));
    }
    let mut seen = BTreeSet::new();
    let mut merged = toml::Value::Table(Default::default());
    let mut found = false;
    for candidate in candidates {
        if candidate == primary || !seen.insert(candidate.clone()) {
            continue;
        }
        let content = match std::fs::read_to_string(&candidate) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "failed to read legacy Morphz configuration '{}': {error}",
                    candidate.display()
                ))
            }
        };
        let mut value = content.parse::<toml::Value>().map_err(|error| {
            format!(
                "failed to parse legacy Morphz configuration '{}': {error}",
                candidate.display()
            )
        })?;
        canonicalize_primary_config(&mut value)?;
        merge_toml_prefer_right(&mut merged, value);
        found = true;
    }
    if found {
        write_managed_value(primary, &merged)?;
    }
    Ok(())
}

fn migrate_legacy_host_files(primary_home: &Path, legacy_home: &Path) -> Result<(), String> {
    let mut copied_any = false;
    for filename in [
        ".env",
        "managed-secrets.json",
        "managed-secret-usage.jsonl",
        "active-profile",
    ] {
        let source = legacy_home.join(filename);
        let destination = primary_home.join(filename);
        copied_any |= copy_legacy_host_file_if_absent(&source, &destination)?;
    }
    let legacy_profiles = legacy_home.join("profiles");
    if let Ok(entries) = std::fs::read_dir(&legacy_profiles) {
        for entry in entries.flatten() {
            let source = entry.path();
            if source.extension().and_then(|value| value.to_str()) != Some("toml") {
                continue;
            }
            let destination = primary_home.join("profiles").join(entry.file_name());
            copied_any |= copy_legacy_host_file_if_absent(&source, &destination)?;
        }
    }
    if copied_any {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(primary_home, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| {
                    format!(
                        "failed to protect Morphz user directory '{}': {error}",
                        primary_home.display()
                    )
                })?;
        }
    }
    Ok(())
}

fn copy_legacy_host_file_if_absent(source: &Path, destination: &Path) -> Result<bool, String> {
    if destination.exists() || !source.is_file() {
        return Ok(false);
    }
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "migration destination '{}' has no parent directory",
            destination.display()
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create Morphz user directory '{}': {error}",
            parent.display()
        )
    })?;
    let temporary = destination.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::copy(source, &temporary).map_err(|error| {
        format!(
            "failed to migrate Morphz host file '{}': {error}",
            source.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "failed to protect migrated Morphz host file '{}': {error}",
                    temporary.display()
                )
            },
        )?;
    }
    std::fs::rename(&temporary, destination).map_err(|error| {
        format!(
            "failed to install migrated Morphz host file '{}': {error}",
            destination.display()
        )
    })?;
    Ok(true)
}

pub fn active_profile() -> Result<Option<String>, String> {
    let Some(path) = host_state_path("active-profile") else {
        return Ok(None);
    };
    match std::fs::read_to_string(path) {
        Ok(value) => {
            let profile = value.trim();
            validate_profile_name(profile)?;
            Ok(Some(profile.to_string()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read default Profile: {error}")),
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
                "failed to read Profile directory '{}': {error}",
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
    let home = morphz_home_dir()
        .ok_or_else(|| "cannot determine Morphz user configuration directory".to_string())?;
    let profile_path = home.join("profiles").join(format!("{profile}.toml"));
    if !profile_path.is_file() {
        return Err(format!(
            "Profile '{profile}' does not exist: {}",
            profile_path.display()
        ));
    }
    std::fs::create_dir_all(&home).map_err(|error| {
        format!(
            "failed to create Morphz configuration directory '{}': {error}",
            home.display()
        )
    })?;
    let path = home.join("active-profile");
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, format!("{profile}\n"))
        .map_err(|error| format!("failed to write default Profile: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("failed to select default Profile: {error}"))?;
    Ok(path)
}

pub fn save_managed_provider(
    provider_id: &str,
    provider: &ProviderConfig,
    credential: Option<(&str, &CredentialConfig)>,
    model: &str,
) -> Result<PathBuf, String> {
    validate_profile_name(provider_id)?;
    let path = managed_model_config_path()?;
    let mut root = read_managed_value(&path)?;
    insert_managed_value(
        &mut root,
        &["providers", provider_id],
        toml::Value::try_from(provider)
            .map_err(|error| format!("failed to serialize Provider: {error}"))?,
    )?;
    if let Some((credential_id, credential)) = credential {
        validate_profile_name(credential_id)?;
        insert_managed_value(
            &mut root,
            &["credentials", credential_id],
            toml::Value::try_from(credential)
                .map_err(|error| format!("failed to serialize Credential: {error}"))?,
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
        return Err("Provider and Model must not be empty".to_string());
    }
    let path = managed_model_config_path()?;
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

/// Atomically persist the Runtime primary model route and the additional
/// routes an Agent may explicitly select for child Evaluations. The primary
/// route is deliberately omitted from `allowed_evaluation_models`: it is
/// always authorized by policy and storing it twice obscures that invariant.
pub fn save_managed_evaluation_model_policy_at(
    path: &Path,
    primary_model: &str,
    allowed_evaluation_models: &[String],
) -> Result<(), String> {
    let primary_model = primary_model.trim();
    if primary_model.is_empty() {
        return Err("primary evaluation model must not be empty".to_string());
    }
    let mut allowed = allowed_evaluation_models
        .iter()
        .map(|model| model.trim())
        .filter(|model| !model.is_empty() && *model != primary_model)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    allowed.sort();
    allowed.dedup();

    let mut root = read_managed_value(path)?;
    insert_managed_value(
        &mut root,
        &["llm", "model"],
        toml::Value::String(primary_model.to_string()),
    )?;
    insert_managed_value(
        &mut root,
        &["llm", "allowed_evaluation_models"],
        toml::Value::Array(allowed.into_iter().map(toml::Value::String).collect()),
    )?;
    write_managed_value(path, &root)
}

/// Persist one Provider Instance in the operator-owned managed layer.
///
/// Provider catalog objects contain references to credentials and OAuth token
/// sets, never the secret values themselves. Cross-object validation belongs
/// to the application control service because the effective catalog may also
/// contain objects supplied by a profile or the host configuration layer.
pub fn save_managed_provider_instance_at(
    path: &Path,
    provider_id: &str,
    provider: &ProviderInstanceConfig,
) -> Result<(), String> {
    validate_catalog_key("Provider Instance", provider_id)?;
    let mut root = read_managed_value(path)?;
    insert_managed_value(
        &mut root,
        &["services", provider_id],
        toml::Value::try_from(provider)
            .map_err(|error| format!("failed to serialize Provider Instance: {error}"))?,
    )?;
    write_managed_value(path, &root)
}

pub fn save_managed_provider_instance(
    provider_id: &str,
    provider: &ProviderInstanceConfig,
) -> Result<PathBuf, String> {
    let path = managed_model_config_path()?;
    save_managed_provider_instance_at(&path, provider_id, provider)?;
    Ok(path)
}

/// Persist non-secret Auth Account metadata. OAuth refresh/access tokens stay
/// behind `credential_ref` in the Secret Store and are never written here.
pub fn save_managed_auth_account_at(
    path: &Path,
    account_id: &str,
    account: &AuthAccountConfig,
) -> Result<(), String> {
    validate_catalog_key("Auth Account", account_id)?;
    let mut root = read_managed_value(path)?;
    insert_managed_value(
        &mut root,
        &["accounts", account_id],
        toml::Value::try_from(account)
            .map_err(|error| format!("failed to serialize Auth Account: {error}"))?,
    )?;
    write_managed_value(path, &root)
}

pub fn save_managed_auth_account(
    account_id: &str,
    account: &AuthAccountConfig,
) -> Result<PathBuf, String> {
    let path = managed_model_config_path()?;
    save_managed_auth_account_at(&path, account_id, account)?;
    Ok(path)
}

/// Atomically persist a Provider Instance and one Auth Account without
/// inventing a Model Route. OAuth proves account ownership first; discovered
/// models become routes only after the operator enables them.
pub fn save_managed_provider_account_at(
    path: &Path,
    provider_id: &str,
    provider: &ProviderInstanceConfig,
    account_id: &str,
    account: &AuthAccountConfig,
) -> Result<(), String> {
    validate_catalog_key("Provider Instance", provider_id)?;
    validate_catalog_key("Auth Account", account_id)?;
    let mut root = read_managed_value(path)?;
    insert_managed_value(
        &mut root,
        &["services", provider_id],
        toml::Value::try_from(provider)
            .map_err(|error| format!("failed to serialize Provider Instance: {error}"))?,
    )?;
    insert_managed_value(
        &mut root,
        &["accounts", account_id],
        toml::Value::try_from(account)
            .map_err(|error| format!("failed to serialize Auth Account: {error}"))?,
    )?;
    write_managed_value(path, &root)
}

/// Persist one logical Model Route, including aliases and its ordered
/// Provider/model candidates.
pub fn save_managed_model_route_at(
    path: &Path,
    route_id: &str,
    route: &ModelRouteConfig,
) -> Result<(), String> {
    validate_catalog_key("Model Route", route_id)?;
    let mut root = read_managed_value(path)?;
    insert_managed_value(
        &mut root,
        &["models", route_id],
        toml::Value::try_from(route)
            .map_err(|error| format!("failed to serialize Model Route: {error}"))?,
    )?;
    write_managed_value(path, &root)
}

pub fn save_managed_model_route(
    route_id: &str,
    route: &ModelRouteConfig,
) -> Result<PathBuf, String> {
    let path = managed_model_config_path()?;
    save_managed_model_route_at(&path, route_id, route)?;
    Ok(path)
}

/// Atomically persist the model choices for one Provider account. Model
/// discovery is runtime data; only the operator's enabled subset and optional
/// capability overrides belong in managed configuration.
pub fn save_managed_provider_account_models_at(
    path: &Path,
    provider_id: &str,
    provider: &ProviderInstanceConfig,
    changed_routes: &BTreeMap<String, ModelRouteConfig>,
    removed_route_ids: &BTreeSet<String>,
    selected_model: Option<&str>,
) -> Result<(), String> {
    validate_catalog_key("Provider Instance", provider_id)?;
    for route_id in changed_routes.keys() {
        validate_catalog_key("Model Route", route_id)?;
    }
    let mut root = read_managed_value(path)?;
    insert_managed_value(
        &mut root,
        &["services", provider_id],
        toml::Value::try_from(provider)
            .map_err(|error| format!("failed to serialize Provider Instance: {error}"))?,
    )?;
    for (route_id, route) in changed_routes {
        insert_managed_value(
            &mut root,
            &["models", route_id],
            toml::Value::try_from(route)
                .map_err(|error| format!("failed to serialize Model Route: {error}"))?,
        )?;
    }
    if let Some(routes) = root.get_mut("models").and_then(toml::Value::as_table_mut) {
        for route_id in removed_route_ids {
            routes.remove(route_id);
        }
    }
    if let Some(model) = selected_model {
        insert_managed_value(
            &mut root,
            &["llm", "model"],
            toml::Value::String(model.to_string()),
        )?;
    }
    write_managed_value(path, &root)
}

/// Atomically persist the minimal routed Provider catalog produced by first
/// setup. A partially written Provider/Account/Route graph is unusable and
/// must never become visible merely because the process stopped between
/// several independent managed-config mutations.
#[allow(clippy::too_many_arguments)]
pub fn save_managed_provider_catalog_at(
    path: &Path,
    provider_id: &str,
    provider: &ProviderInstanceConfig,
    account_id: &str,
    account: &AuthAccountConfig,
    credential: Option<(&str, &CredentialConfig)>,
    route_id: &str,
    route: &ModelRouteConfig,
    selected_model: &str,
) -> Result<(), String> {
    validate_catalog_key("Provider Instance", provider_id)?;
    validate_catalog_key("Auth Account", account_id)?;
    validate_catalog_key("Model Route", route_id)?;
    let mut root = read_managed_value(path)?;
    insert_managed_value(
        &mut root,
        &["services", provider_id],
        toml::Value::try_from(provider)
            .map_err(|error| format!("failed to serialize Provider Instance: {error}"))?,
    )?;
    insert_managed_value(
        &mut root,
        &["accounts", account_id],
        toml::Value::try_from(account)
            .map_err(|error| format!("failed to serialize Auth Account: {error}"))?,
    )?;
    if let Some((credential_id, credential)) = credential {
        validate_profile_name(credential_id)?;
        insert_managed_value(
            &mut root,
            &["credentials", credential_id],
            toml::Value::try_from(credential)
                .map_err(|error| format!("failed to serialize Credential: {error}"))?,
        )?;
    }
    insert_managed_value(
        &mut root,
        &["models", route_id],
        toml::Value::try_from(route)
            .map_err(|error| format!("failed to serialize Model Route: {error}"))?,
    )?;
    // Keep this mutation compatible with older in-memory readers. The TOML
    // writer removes `llm.provider` because the route already names its
    // service and duplicating the selection invites drift.
    insert_managed_value(
        &mut root,
        &["llm", "provider"],
        toml::Value::String(provider_id.to_string()),
    )?;
    insert_managed_value(
        &mut root,
        &["llm", "model"],
        toml::Value::String(selected_model.to_string()),
    )?;
    write_managed_value(path, &root)
}

pub fn save_managed_provider_catalog(
    provider_id: &str,
    provider: &ProviderInstanceConfig,
    account_id: &str,
    account: &AuthAccountConfig,
    credential: Option<(&str, &CredentialConfig)>,
    route_id: &str,
    route: &ModelRouteConfig,
) -> Result<PathBuf, String> {
    let path = managed_model_config_path()?;
    save_managed_provider_catalog_at(
        &path,
        provider_id,
        provider,
        account_id,
        account,
        credential,
        route_id,
        route,
        route_id,
    )?;
    Ok(path)
}

/// Remove catalog fragments left by pre-transactional OAuth setup versions.
/// A login attempt is not an account: once the referenced accounts are gone,
/// empty Provider pools and routes are removed in the same managed-file write.
pub fn remove_managed_provider_accounts_at(
    path: &Path,
    account_ids: &BTreeSet<String>,
) -> Result<(), String> {
    if account_ids.is_empty() || !path.exists() {
        return Ok(());
    }
    let mut root = read_managed_value(path)?;
    let removed_credential_refs = root
        .get("accounts")
        .and_then(toml::Value::as_table)
        .into_iter()
        .flat_map(|accounts| accounts.iter())
        .filter(|(account_id, _)| account_ids.contains(*account_id))
        .filter_map(|(_, account)| {
            account
                .get("credential_ref")
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect::<BTreeSet<_>>();
    if let Some(accounts) = root.get_mut("accounts").and_then(toml::Value::as_table_mut) {
        accounts.retain(|account_id, _| !account_ids.contains(account_id));
    }

    let retained_credential_refs = root
        .get("accounts")
        .and_then(toml::Value::as_table)
        .into_iter()
        .flat_map(|accounts| accounts.values())
        .filter_map(|account| {
            account
                .get("credential_ref")
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .chain(
            root.get("providers")
                .and_then(toml::Value::as_table)
                .into_iter()
                .flat_map(|providers| providers.values())
                .filter_map(|provider| {
                    provider
                        .get("credential")
                        .and_then(toml::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                }),
        )
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    if let Some(credentials) = root
        .get_mut("credentials")
        .and_then(toml::Value::as_table_mut)
    {
        credentials.retain(|credential_id, _| {
            !removed_credential_refs.contains(credential_id)
                || retained_credential_refs.contains(credential_id)
        });
    }

    let mut empty_providers = BTreeSet::new();
    if let Some(providers) = root.get_mut("services").and_then(toml::Value::as_table_mut) {
        for (provider_id, provider) in providers.iter_mut() {
            if let Some(accounts) = provider
                .get_mut("accounts")
                .and_then(toml::Value::as_array_mut)
            {
                let previous_len = accounts.len();
                accounts.retain(|account| {
                    account
                        .as_str()
                        .is_none_or(|account_id| !account_ids.contains(account_id))
                });
                if previous_len != accounts.len() && accounts.is_empty() {
                    empty_providers.insert(provider_id.clone());
                }
            }
        }
        providers.retain(|provider_id, _| !empty_providers.contains(provider_id));
    }

    let mut empty_routes = BTreeSet::new();
    if let Some(routes) = root.get_mut("models").and_then(toml::Value::as_table_mut) {
        for (route_id, route) in routes.iter_mut() {
            if let Some(candidates) = route.get_mut("targets").and_then(toml::Value::as_array_mut) {
                let previous_len = candidates.len();
                candidates.retain(|candidate| {
                    let account_removed = candidate
                        .get("account")
                        .and_then(toml::Value::as_str)
                        .is_some_and(|account_id| account_ids.contains(account_id));
                    let provider_removed = candidate
                        .get("provider")
                        .and_then(toml::Value::as_str)
                        .is_some_and(|provider_id| empty_providers.contains(provider_id));
                    !account_removed && !provider_removed
                });
                if previous_len != candidates.len() && candidates.is_empty() {
                    empty_routes.insert(route_id.clone());
                }
            }
        }
        routes.retain(|route_id, _| !empty_routes.contains(route_id));
    }

    let fallback_route = root
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|routes| routes.keys().next())
        .cloned();
    let selected_model = root
        .get("llm")
        .and_then(toml::Value::as_table)
        .and_then(|llm| llm.get("model"))
        .and_then(toml::Value::as_str)
        .map(str::to_string);
    let selected_model_exists = selected_model.as_deref().is_some_and(|selected| {
        root.get("models")
            .and_then(toml::Value::as_table)
            .is_some_and(|routes| {
                routes.get(selected).is_some()
                    || routes.values().any(|route| {
                        route
                            .get("aliases")
                            .and_then(toml::Value::as_array)
                            .is_some_and(|aliases| {
                                aliases.iter().any(|alias| alias.as_str() == Some(selected))
                            })
                    })
            })
    });
    if let Some(llm) = root.get_mut("llm").and_then(toml::Value::as_table_mut) {
        if llm
            .get("provider")
            .and_then(toml::Value::as_str)
            .is_some_and(|provider_id| empty_providers.contains(provider_id))
        {
            llm.remove("provider");
        }
        if !selected_model_exists {
            if let Some(fallback) = fallback_route {
                llm.insert("model".to_string(), toml::Value::String(fallback));
            } else {
                llm.remove("model");
            }
        }
    }
    write_managed_value(path, &root)
}

/// Persist the operator-selected inference profile in Morphz's primary user
/// configuration. Provider-native reasoning is represented by omitting
/// `reasoning_effort`; explicit levels remain ordinary TOML values.
pub fn save_managed_inference_at(
    path: &Path,
    provider_id: Option<&str>,
    model: &str,
    reasoning_effort: Option<ReasoningEffort>,
    prompt_token_limit: Option<usize>,
) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("Model must not be empty".to_string());
    }
    let provider_id = provider_id.map(str::trim).filter(|value| !value.is_empty());
    if let Some(provider_id) = provider_id {
        validate_profile_name(provider_id)?;
    }
    let mut root = read_managed_value(path)?;
    let mut routed_targets = root
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|routes| {
            routes.get(model).or_else(|| {
                routes.values().find(|route| {
                    route
                        .get("aliases")
                        .and_then(toml::Value::as_array)
                        .is_some_and(|aliases| {
                            aliases.iter().any(|alias| alias.as_str() == Some(model))
                        })
                })
            })
        })
        .and_then(|route| route.get("targets"))
        .and_then(toml::Value::as_array)
        .map(|targets| {
            targets
                .iter()
                .filter_map(toml::Value::as_table)
                .filter_map(|target| {
                    Some((
                        target.get("provider")?.as_str()?.to_string(),
                        target.get("model")?.as_str()?.to_string(),
                    ))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    routed_targets.sort();
    routed_targets.dedup();
    let selected_target = (routed_targets.len() == 1)
        .then(|| routed_targets[0].clone())
        .or_else(|| {
            provider_id.and_then(|provider_id| {
                root.get("services")
                    .and_then(toml::Value::as_table)
                    .is_some_and(|services| services.contains_key(provider_id))
                    .then(|| (provider_id.to_string(), model.to_string()))
            })
        });
    let missing_route_target = (provider_id.is_some() && routed_targets.is_empty())
        .then_some(())
        .and(selected_target.as_ref());
    if let Some((service, physical_model)) = missing_route_target {
        let mut target = toml::map::Map::new();
        target.insert("provider".to_string(), toml::Value::String(service.clone()));
        target.insert(
            "model".to_string(),
            toml::Value::String(physical_model.clone()),
        );
        insert_managed_value(
            &mut root,
            &["models", model, "targets"],
            toml::Value::Array(vec![toml::Value::Table(target)]),
        )?;
    }
    if let Some(limit) = prompt_token_limit {
        if limit == 0 {
            return Err("model physical input capacity must be greater than 0".to_string());
        }
        if routed_targets.len() > 1 {
            return Err(
                "the current model route contains multiple physical targets; configure capacity for each physical model separately on the identity and model page"
                    .to_string(),
            );
        }
        let (section, resolved_provider, physical_model) = selected_target
            .as_ref()
            .map(|(provider, model)| ("services", provider.as_str(), model.as_str()))
            .or_else(|| provider_id.map(|provider| ("providers", provider, model)))
            .ok_or_else(|| {
                "the current model has no resolvable service target; physical input capacity cannot be saved"
                    .to_string()
            })?;
        insert_managed_value(
            &mut root,
            &[
                section,
                resolved_provider,
                "models",
                physical_model,
                "max_input_tokens",
            ],
            toml::Value::Integer(
                i64::try_from(limit)
                    .map_err(|_| "model physical input capacity exceeds the TOML integer range")?,
            ),
        )?;
    }
    if selected_target.is_some() {
        if let Some(llm) = root.get_mut("llm").and_then(toml::Value::as_table_mut) {
            llm.remove("provider");
        }
    } else if let Some(provider_id) = provider_id {
        insert_managed_value(
            &mut root,
            &["llm", "provider"],
            toml::Value::String(provider_id.to_string()),
        )?;
    }
    insert_managed_value(
        &mut root,
        &["llm", "model"],
        toml::Value::String(model.to_string()),
    )?;
    if let Some(reasoning_effort) = reasoning_effort {
        insert_managed_value(
            &mut root,
            &["llm", "reasoning_effort"],
            toml::Value::String(reasoning_effort.as_str().to_string()),
        )?;
    } else if let Some(llm) = root.get_mut("llm").and_then(toml::Value::as_table_mut) {
        llm.remove("reasoning_effort");
    }
    write_managed_value(path, &root)
}

/// Persist the optional logical Model Route used exclusively by the built-in
/// automatic permission reviewer. Removing the value restores main-model
/// fallback without disturbing the remaining permission profile.
pub fn save_managed_auto_review_model_at(path: &Path, model: Option<&str>) -> Result<(), String> {
    let model = model.map(str::trim).filter(|value| !value.is_empty());
    let mut root = read_managed_value(path)?;
    if let Some(model) = model {
        insert_managed_value(
            &mut root,
            &["permissions", "auto_review_model"],
            toml::Value::String(model.to_string()),
        )?;
    } else if let Some(permissions) = root
        .get_mut("permissions")
        .and_then(toml::Value::as_table_mut)
    {
        permissions.remove("auto_review_model");
    }
    write_managed_value(path, &root)
}

fn read_managed_value(path: &Path) -> Result<toml::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let mut value = content.parse::<toml::Value>().map_err(|error| {
                format!(
                    "failed to parse Morphz configuration '{}': {error}",
                    path.display()
                )
            })?;
            canonicalize_primary_config(&mut value)?;
            Ok(value)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(toml::Value::Table(Default::default()))
        }
        Err(error) => Err(format!(
            "failed to read Morphz configuration '{}': {error}",
            path.display()
        )),
    }
}

fn merge_toml_prefer_right(base: &mut toml::Value, right: toml::Value) {
    match (base, right) {
        (toml::Value::Table(base), toml::Value::Table(right)) => {
            for (key, value) in right {
                if let Some(existing) = base.get_mut(&key) {
                    merge_toml_prefer_right(existing, value);
                } else {
                    base.insert(key, value);
                }
            }
        }
        (base, right) => *base = right,
    }
}

fn rename_config_key(table: &mut toml::map::Map<String, toml::Value>, old: &str, new: &str) {
    let Some(old_value) = table.remove(old) else {
        return;
    };
    if let Some(new_value) = table.remove(new) {
        let mut merged = old_value;
        merge_toml_prefer_right(&mut merged, new_value);
        table.insert(new.to_string(), merged);
    } else {
        table.insert(new.to_string(), old_value);
    }
}

fn table_value_is_empty(value: Option<&toml::Value>) -> bool {
    value.is_some_and(|value| {
        value.as_table().is_some_and(toml::map::Map::is_empty)
            || value.as_array().is_some_and(Vec::is_empty)
    })
}

/// Fold the pre-routing `[providers]` representation into the same
/// service/account/model vocabulary used by OAuth providers. Credentials stay
/// separate because they describe how a secret is materialised, not where a
/// model request is sent.
fn canonicalize_legacy_providers(
    table: &mut toml::map::Map<String, toml::Value>,
) -> Result<(), String> {
    let existing_service_ids = table
        .get("services")
        .and_then(toml::Value::as_table)
        .map(|services| services.keys().cloned().collect::<BTreeSet<_>>())
        .unwrap_or_default();
    let Some(legacy) = table.remove("providers") else {
        return Ok(());
    };
    let legacy = legacy
        .as_table()
        .ok_or_else(|| "[providers] must be a TOML table".to_string())?
        .clone();

    let mut generated_accounts = Vec::new();
    let mut generated_services = Vec::new();
    for (provider_id, value) in legacy {
        if existing_service_ids.contains(&provider_id) {
            continue;
        }
        let mut provider = value
            .as_table()
            .ok_or_else(|| format!("[providers.{provider_id}] must be a TOML table"))?
            .clone();
        let credential = provider
            .remove("credential")
            .and_then(|value| value.as_str().map(str::to_string));
        let account_id = if credential.is_some() {
            format!("{provider_id}-default")
        } else {
            format!("{provider_id}-anonymous")
        };

        let mut account = toml::map::Map::new();
        account.insert(
            "auth_adapter".to_string(),
            toml::Value::String(if credential.is_some() {
                "credential".to_string()
            } else {
                "none".to_string()
            }),
        );
        if let Some(credential) = credential {
            account.insert(
                "credential_ref".to_string(),
                toml::Value::String(credential),
            );
        }
        account.insert(
            "provider".to_string(),
            toml::Value::String(provider_id.clone()),
        );

        provider.insert(
            "adapter".to_string(),
            toml::Value::String("protocol-compatible".to_string()),
        );
        provider.insert(
            "accounts".to_string(),
            toml::Value::Array(vec![toml::Value::String(account_id.clone())]),
        );
        generated_accounts.push((account_id, toml::Value::Table(account)));
        generated_services.push((provider_id, toml::Value::Table(provider)));
    }
    if generated_services.is_empty() {
        return Ok(());
    }

    let services = table
        .entry("services".to_string())
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| "[services] must be a TOML table".to_string())?;
    let generated_provider_ids = generated_services
        .iter()
        .map(|(provider_id, _)| provider_id.clone())
        .collect::<BTreeSet<_>>();
    for (provider_id, service) in generated_services {
        services.entry(provider_id).or_insert(service);
    }

    let accounts = table
        .entry("accounts".to_string())
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| "[accounts] must be a TOML table".to_string())?;
    for (account_id, account) in generated_accounts {
        accounts.entry(account_id).or_insert(account);
    }

    let routes_are_empty = table
        .get("models")
        .and_then(toml::Value::as_table)
        .is_none_or(toml::map::Map::is_empty);
    if routes_are_empty {
        let selected_provider = table
            .get("llm")
            .and_then(toml::Value::as_table)
            .and_then(|llm| llm.get("provider"))
            .and_then(toml::Value::as_str)
            .filter(|provider_id| generated_provider_ids.contains(*provider_id))
            .map(str::to_string);
        if let Some(provider_id) = selected_provider {
            let llm = table
                .get("llm")
                .and_then(toml::Value::as_table)
                .expect("selected provider came from llm table");
            let mut model_names = llm
                .get("models")
                .and_then(toml::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(toml::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            if let Some(model) = llm.get("model").and_then(toml::Value::as_str) {
                if !model.trim().is_empty() && !model_names.iter().any(|item| item == model) {
                    model_names.push(model.to_string());
                }
            }
            let routes = table
                .entry("models".to_string())
                .or_insert_with(|| toml::Value::Table(Default::default()))
                .as_table_mut()
                .expect("models was absent or a table");
            for model in model_names {
                let mut target = toml::map::Map::new();
                target.insert(
                    "provider".to_string(),
                    toml::Value::String(provider_id.clone()),
                );
                target.insert("model".to_string(), toml::Value::String(model.clone()));
                let mut route = toml::map::Map::new();
                route.insert(
                    "targets".to_string(),
                    toml::Value::Array(vec![toml::Value::Table(target)]),
                );
                routes.entry(model).or_insert(toml::Value::Table(route));
            }
        }
    }
    Ok(())
}

/// Convert every accepted legacy spelling to the compact, user-facing file
/// schema. Runtime/API structures deliberately retain their stable Rust and
/// JSON field names; this transformation belongs only at the TOML boundary.
fn canonicalize_primary_config(root: &mut toml::Value) -> Result<(), String> {
    let table = root
        .as_table_mut()
        .ok_or_else(|| "Morphz configuration root must be a TOML table".to_string())?;
    rename_config_key(table, "provider_instances", "services");
    rename_config_key(table, "auth_accounts", "accounts");
    rename_config_key(table, "model_routes", "models");
    canonicalize_legacy_providers(table)?;

    if let Some(accounts) = table
        .get_mut("accounts")
        .and_then(toml::Value::as_table_mut)
    {
        for account in accounts
            .iter_mut()
            .filter_map(|(_, value)| value.as_table_mut())
        {
            if account.get("enabled").and_then(toml::Value::as_bool) == Some(true) {
                account.remove("enabled");
            }
        }
    }

    if let Some(services) = table
        .get_mut("services")
        .and_then(toml::Value::as_table_mut)
    {
        for service in services
            .iter_mut()
            .filter_map(|(_, value)| value.as_table_mut())
        {
            let remove_models = service
                .get_mut("models")
                .and_then(toml::Value::as_table_mut)
                .is_some_and(|models| {
                    models.retain(|_, profile| {
                        !profile.as_table().is_some_and(toml::map::Map::is_empty)
                    });
                    models.is_empty()
                });
            if remove_models {
                service.remove("models");
            }
            for key in ["headers", "env_headers"] {
                if table_value_is_empty(service.get(key)) {
                    service.remove(key);
                }
            }
        }
    }

    if let Some(routes) = table.get_mut("models").and_then(toml::Value::as_table_mut) {
        for route in routes
            .iter_mut()
            .filter_map(|(_, value)| value.as_table_mut())
        {
            rename_config_key(route, "candidates", "targets");
            rename_config_key(route, "affinity", "stickiness");
            rename_config_key(route, "selection", "strategy");
            let direct_target_present = [
                "service",
                "physical_model",
                "account",
                "priority",
                "capabilities",
            ]
            .iter()
            .any(|key| route.contains_key(*key));
            if direct_target_present {
                if route.contains_key("targets") {
                    return Err(
                        "a model cannot use direct target fields and [[models.<name>.targets]] together"
                            .to_string()
                    );
                }
                let mut target = toml::map::Map::new();
                for (source, destination) in [
                    ("service", "provider"),
                    ("physical_model", "model"),
                    ("account", "account"),
                    ("priority", "priority"),
                    ("capabilities", "capabilities"),
                ] {
                    if let Some(value) = route.remove(source) {
                        target.insert(destination.to_string(), value);
                    }
                }
                route.insert(
                    "targets".to_string(),
                    toml::Value::Array(vec![toml::Value::Table(target)]),
                );
            }
            if table_value_is_empty(route.get("aliases")) {
                route.remove("aliases");
            }
            if route.get("fallback").and_then(toml::Value::as_bool) == Some(false) {
                route.remove("fallback");
            }
            if route.get("stickiness").and_then(toml::Value::as_str) == Some("context") {
                route.remove("stickiness");
            }
            if route
                .get("strategy")
                .and_then(toml::Value::as_str)
                .is_some_and(|value| {
                    matches!(
                        value,
                        "available-least-recently-used" | "least-recently-used"
                    )
                })
            {
                route.remove("strategy");
            }
            if let Some(targets) = route.get_mut("targets").and_then(toml::Value::as_array_mut) {
                for target in targets.iter_mut().filter_map(toml::Value::as_table_mut) {
                    rename_config_key(target, "service", "provider");
                    rename_config_key(target, "physical_model", "model");
                    if target.get("priority").and_then(toml::Value::as_integer) == Some(0) {
                        target.remove("priority");
                    }
                    if table_value_is_empty(target.get("capabilities")) {
                        target.remove("capabilities");
                    }
                }
            }
        }
    }

    if let Some(credentials) = table
        .get_mut("credentials")
        .and_then(toml::Value::as_table_mut)
    {
        for credential in credentials
            .iter_mut()
            .filter_map(|(_, value)| value.as_table_mut())
        {
            if table_value_is_empty(credential.get("command")) {
                credential.remove("command");
            }
        }
    }

    let routed_default = table
        .get("llm")
        .and_then(toml::Value::as_table)
        .and_then(|llm| llm.get("model"))
        .and_then(toml::Value::as_str)
        .is_some_and(|selected| {
            table
                .get("models")
                .and_then(toml::Value::as_table)
                .is_some_and(|models| models.contains_key(selected))
        });
    if let Some(llm) = table.get_mut("llm").and_then(toml::Value::as_table_mut) {
        if routed_default {
            llm.remove("provider");
        }
        if llm.get("reasoning_effort").and_then(toml::Value::as_str) == Some("default") {
            llm.remove("reasoning_effort");
        }
    }
    Ok(())
}

fn compact_primary_config_for_write(root: &mut toml::Value) {
    let Some(routes) = root.get_mut("models").and_then(toml::Value::as_table_mut) else {
        return;
    };
    for route in routes
        .iter_mut()
        .filter_map(|(_, value)| value.as_table_mut())
    {
        let Some(mut targets) = route.remove("targets").and_then(|value| match value {
            toml::Value::Array(targets) => Some(targets),
            _ => None,
        }) else {
            continue;
        };
        for target in targets.iter_mut().filter_map(toml::Value::as_table_mut) {
            rename_config_key(target, "provider", "service");
            rename_config_key(target, "model", "physical_model");
        }
        if targets.len() == 1 {
            if let Some(toml::Value::Table(target)) = targets.pop() {
                route.extend(target);
            }
        } else {
            route.insert("targets".to_string(), toml::Value::Array(targets));
        }
    }
}

fn insert_managed_value(
    root: &mut toml::Value,
    path: &[&str],
    value: toml::Value,
) -> Result<(), String> {
    let (leaf, parents) = path
        .split_last()
        .ok_or_else(|| "Managed configuration path must not be empty".to_string())?;
    let mut cursor = root;
    for segment in parents {
        let table = cursor.as_table_mut().ok_or_else(|| {
            format!("Managed configuration parent path '{segment}' is not a table")
        })?;
        cursor = table
            .entry((*segment).to_string())
            .or_insert_with(|| toml::Value::Table(Default::default()));
    }
    cursor
        .as_table_mut()
        .ok_or_else(|| "Managed configuration target parent path is not a table".to_string())?
        .insert((*leaf).to_string(), value);
    Ok(())
}

fn write_managed_value(path: &Path, value: &toml::Value) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Managed configuration path '{}' has no parent directory",
            path.display()
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create Morphz configuration directory '{}': {error}",
            parent.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "failed to protect Morphz configuration directory '{}': {error}",
                    parent.display()
                )
            },
        )?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut canonical = value.clone();
    canonicalize_primary_config(&mut canonical)?;
    compact_primary_config_for_write(&mut canonical);
    let content = toml::to_string_pretty(&canonical)
        .map_err(|error| format!("failed to encode Morphz configuration: {error}"))?;
    std::fs::write(&temporary, content).map_err(|error| {
        format!(
            "failed to write temporary Managed configuration '{}': {error}",
            temporary.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "failed to protect Managed configuration '{}': {error}",
                    temporary.display()
                )
            },
        )?;
    }
    std::fs::rename(&temporary, path).map_err(|error| {
        format!(
            "failed to atomically replace Managed configuration '{}': {error}",
            path.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
fn resolve_config_with_home(
    cwd: &Path,
    explicit_path: Option<&Path>,
    profile: Option<&str>,
    morphz_home: Option<PathBuf>,
) -> Result<ResolvedConfig, String> {
    resolve_config_with_homes(
        cwd,
        explicit_path,
        profile,
        morphz_home.clone(),
        morphz_home,
    )
}

fn resolve_config_with_homes(
    cwd: &Path,
    explicit_path: Option<&Path>,
    profile: Option<&str>,
    morphz_home: Option<PathBuf>,
    legacy_home: Option<PathBuf>,
) -> Result<ResolvedConfig, String> {
    let mut candidates = Vec::new();

    #[cfg(unix)]
    candidates.push(ConfigLayer {
        kind: ConfigLayerKind::System,
        path: PathBuf::from("/etc/morphz/config.toml"),
    });

    #[cfg(unix)]
    candidates.push(ConfigLayer {
        kind: ConfigLayerKind::System,
        path: PathBuf::from("/etc/morphz/morphz.toml"),
    });

    #[cfg(unix)]
    candidates.push(ConfigLayer {
        kind: ConfigLayerKind::System,
        path: PathBuf::from("/etc/morphz/models.toml"),
    });

    let primary_exists = morphz_home
        .as_ref()
        .is_some_and(|home| home.join("morphz.toml").is_file());
    if !primary_exists {
        if let Some(home) = legacy_home.as_ref() {
            candidates.push(ConfigLayer {
                kind: ConfigLayerKind::User,
                path: home.join("config.toml"),
            });
            candidates.push(ConfigLayer {
                kind: ConfigLayerKind::Managed,
                path: home.join("managed.toml"),
            });
        }
    }

    if let Some(home) = morphz_home.as_ref() {
        candidates.push(ConfigLayer {
            kind: ConfigLayerKind::User,
            path: home.join("morphz.toml"),
        });
        candidates.push(ConfigLayer {
            kind: ConfigLayerKind::User,
            path: home.join("models.toml"),
        });
        if let Some(profile) = profile {
            validate_profile_name(profile)?;
            candidates.push(ConfigLayer {
                kind: ConfigLayerKind::Profile,
                path: home.join("profiles").join(format!("{profile}.toml")),
            });
        }
    } else if profile.is_some() {
        return Err(
            "cannot determine the Morphz user configuration directory; --profile cannot be loaded"
                .to_string(),
        );
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
                    "failed to read {} configuration '{}': {error}",
                    layer.kind.as_str(),
                    absolute.display()
                ))
            }
        };
        let mut value = content.parse::<toml::Value>().map_err(|error| {
            format!(
                "failed to parse {} configuration '{}': {error}",
                layer.kind.as_str(),
                absolute.display()
            )
        })?;
        canonicalize_primary_config(&mut value)?;
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
        .map_err(|error| format!("merged Morphz configuration is invalid: {error}"))?;
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
            "Profile name '{profile}' is invalid; only letters, digits, hyphens, and underscores are allowed"
        ))
    }
}

fn validate_catalog_key(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 255
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "{kind} ID '{value}' is invalid; it cannot be empty, contain leading or trailing whitespace or control characters, or exceed 255 bytes"
        ));
    }
    Ok(())
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
        .flat_map(|path| {
            [
                path.join(".morphz").join("config.toml"),
                path.join(".morphz").join("morphz.toml"),
            ]
        })
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
            "project configuration '{}' attempts to set host control-plane fields: {}. Move these fields to the user configuration",
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
                || key == "provider_instances"
                || key.starts_with("provider_instances.")
                || key == "services"
                || key.starts_with("services.")
                || key == "auth_accounts"
                || key.starts_with("auth_accounts.")
                || key == "accounts"
                || key.starts_with("accounts.")
                || key == "model_routes"
                || key.starts_with("model_routes.")
                || key == "models"
                || key.starts_with("models.")
                || key == "managed_ssh"
                || key.starts_with("managed_ssh.")
                || key == "server.bind"
                || key == "server.identity"
                || key.starts_with("server.identity.")
                || key == "storage"
                || key.starts_with("storage.")
                || key == "model_input"
                || key.starts_with("model_input.")
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
        if let Ok(value) = std::env::var("MORPHZ_STORAGE_BACKEND") {
            self.storage.backend = parse_storage_backend_env(&value)?;
        }
        if let Ok(value) = std::env::var("MORPHZ_COGNITIVE_STORE") {
            self.storage.cognitive_store = parse_cognitive_store_backend_env(&value)?;
        }
        apply_u32_env(
            "MORPHZ_POSTGRES_MAX_CONNECTIONS",
            &mut self.storage.postgres.max_connections,
        )?;
        if let Ok(value) = std::env::var("MORPHZ_SERVER_IDENTITY_MODE") {
            self.server.identity.mode = parse_server_identity_mode_env(&value)?;
        }
        if let Ok(value) = std::env::var("MORPHZ_SERVER_IDENTITY_PROVIDER_ID") {
            let value = value.trim();
            if value.is_empty() {
                return Err("MORPHZ_SERVER_IDENTITY_PROVIDER_ID cannot be empty".to_string());
            }
            self.server.identity.provider_id = value.to_string();
        }
        if let Ok(value) = std::env::var("MORPHZ_SERVER_IDENTITY_SERVICE_TOKEN_ENV") {
            let value = value.trim();
            if value.is_empty() {
                return Err("MORPHZ_SERVER_IDENTITY_SERVICE_TOKEN_ENV cannot be empty".to_string());
            }
            self.server.identity.service_token_env = value.to_string();
        }
        if let Ok(model) = std::env::var("MORPHZ_LLM_MODEL") {
            let model = model.trim();
            if model.is_empty() {
                return Err("MORPHZ_LLM_MODEL cannot be empty".to_string());
            }
            self.llm.model = model.to_string();
        }
        if let Ok(provider) = std::env::var("MORPHZ_LLM_PROVIDER") {
            let provider = provider.trim();
            if provider.is_empty() {
                return Err("MORPHZ_LLM_PROVIDER cannot be empty".to_string());
            }
            self.llm.provider = Some(provider.to_string());
        }
        if let Ok(root) = std::env::var("MORPHZ_WORKSPACE_ROOT") {
            if !root.trim().is_empty() {
                self.permissions.workspace_root = root;
                // Strict evaluation mode does not inherit default `/tmp` extra roots, preventing
                // file tools from escaping the evaluation workspace.
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
                .ok_or_else(|| format!("MORPHZ_EXEC_NETWORK is not a valid boolean: {value}"))?;
        }
        if let Ok(value) = std::env::var("MORPHZ_PERMISSION_MODE") {
            self.permissions.mode = match value.trim().to_ascii_lowercase().as_str() {
                "request_approval" | "request-approval" | "ask" => PermissionMode::RequestApproval,
                "auto_review" | "auto-review" | "auto" => PermissionMode::AutoReview,
                "full_access" | "full-access" | "danger_full_access" => PermissionMode::FullAccess,
                "custom" => PermissionMode::Custom,
                _ => {
                    return Err(format!(
                        "MORPHZ_PERMISSION_MODE is not a valid mode: {value}"
                    ))
                }
            };
        }
        if let Ok(value) = std::env::var("MORPHZ_AUTO_REVIEW_MODEL") {
            let value = value.trim();
            if value.is_empty() {
                return Err("MORPHZ_AUTO_REVIEW_MODEL cannot be empty".to_string());
            }
            self.permissions.auto_review_model = Some(value.to_string());
        }
        if let Ok(value) = std::env::var("MORPHZ_INTERRUPT_DIALOGUE_ON_NEW_MESSAGE") {
            self.orchestrator.interrupt_dialogue_on_new_message = parse_env_bool(&value)
                .ok_or_else(|| {
                    format!(
                        "MORPHZ_INTERRUPT_DIALOGUE_ON_NEW_MESSAGE is not a valid boolean: {value}"
                    )
                })?;
        }
        if let Ok(value) = std::env::var("MORPHZ_CONTEXT_TRANSACTIONS_ENABLED") {
            self.orchestrator.context_transactions_enabled =
                parse_env_bool(&value).ok_or_else(|| {
                    format!("MORPHZ_CONTEXT_TRANSACTIONS_ENABLED is not a valid boolean: {value}")
                })?;
        }
        if let Ok(value) = std::env::var("MORPHZ_EXPERIMENTAL_FEATURES") {
            self.experimental.enabled.extend(
                value
                    .split(|character: char| character == ',' || character.is_whitespace())
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
            );
        }
        if let Ok(value) = std::env::var("MORPHZ_EVAL_CALLABLE_TOOLS") {
            let mut tools = Vec::new();
            for name in value
                .split(|character: char| character == ',' || character.is_whitespace())
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                if !tools.iter().any(|existing| existing == name) {
                    tools.push(name.to_string());
                }
            }
            self.orchestrator.eval_callable_tools = tools;
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
            "MORPHZ_LLM_FIRST_BYTE_TIMEOUT_SECS",
            &mut self.llm.first_byte_timeout_secs,
        )?;
        apply_u64_env(
            "MORPHZ_REPLY_WAIT_NOTICE_SECS",
            &mut self.orchestrator.reply_wait_notice_secs,
        )?;
        apply_u64_env(
            "MORPHZ_ACTIVATION_LEASE_SECS",
            &mut self.orchestrator.activation_lease_secs,
        )?;
        apply_u64_env(
            "MORPHZ_OBJECTIVE_EVALUATION_LEASE_SECS",
            &mut self.orchestrator.objective_evaluation_lease_secs,
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
                        "MORPHZ_LLM_REASONING_EFFORT supports only default, none, low, medium, high, and max: {value}"
                    )
                })?)
            };
        }
        if let Ok(value) = std::env::var("MORPHZ_SESSION_ACTIVE_WINDOW") {
            self.orchestrator.session_working_set.active_window = parse_human_duration(&value)
                .map_err(|error| {
                    format!("MORPHZ_SESSION_ACTIVE_WINDOW is not a valid duration: {error}")
                })?;
        }
        apply_usize_env(
            "MORPHZ_SESSION_WORKING_SET_MAX",
            &mut self.orchestrator.session_working_set.max_sessions,
        )?;
        Ok(())
    }
}

fn parse_storage_backend_env(value: &str) -> Result<StorageBackend, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "sqlite" => Ok(StorageBackend::Sqlite),
        "postgres" | "postgresql" => Ok(StorageBackend::Postgres),
        _ => Err(format!(
            "MORPHZ_STORAGE_BACKEND supports only sqlite or postgres: {value}"
        )),
    }
}

fn parse_cognitive_store_backend_env(value: &str) -> Result<CognitiveStoreBackend, String> {
    CognitiveStoreBackend::parse(value)
        .map_err(|_| format!("MORPHZ_COGNITIVE_STORE supports only context_db or legacy: {value}"))
}

fn parse_server_identity_mode_env(value: &str) -> Result<ServerIdentityMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "default" => Ok(ServerIdentityMode::Default),
        "trusted_gateway" | "trusted-gateway" => Ok(ServerIdentityMode::TrustedGateway),
        _ => Err(format!(
            "MORPHZ_SERVER_IDENTITY_MODE supports only default or trusted-gateway: {value}"
        )),
    }
}

fn apply_usize_env(name: &str, target: &mut usize) -> Result<(), String> {
    let Ok(value) = std::env::var(name) else {
        return Ok(());
    };
    let parsed = value
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("{name} is not a valid positive integer: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} must be greater than 0"));
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
        .map_err(|_| format!("{name} is not a valid positive integer: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} must be greater than 0"));
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
        .map_err(|_| format!("{name} is not a valid positive integer: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} must be greater than 0"));
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
        .map_err(|_| format!("{name} is not a valid positive integer: {value}"))?;
    if parsed == 0 {
        return Err(format!("{name} must be greater than 0"));
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
    fn reviewer_route_and_dialogue_interruption_are_explicit_toml_controls() {
        let config: AppConfig = toml::from_str(
            r#"
                [permissions]
                auto_review_model = "reviewer-luna"

                [orchestrator]
                interrupt_dialogue_on_new_message = false
            "#,
        )
        .unwrap();

        assert_eq!(
            config.permissions.auto_review_model.as_deref(),
            Some("reviewer-luna")
        );
        assert!(!config.orchestrator.interrupt_dialogue_on_new_message);
    }

    #[test]
    fn managed_auto_review_model_can_be_set_and_removed_without_touching_permission_mode() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("morphz.toml");
        std::fs::write(&path, "[permissions]\nmode = 'auto_review'\n").unwrap();

        save_managed_auto_review_model_at(&path, Some("reviewer-luna")).unwrap();
        let configured: AppConfig =
            toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(configured.permissions.mode, PermissionMode::AutoReview);
        assert_eq!(
            configured.permissions.auto_review_model.as_deref(),
            Some("reviewer-luna")
        );

        save_managed_auto_review_model_at(&path, None).unwrap();
        let restored: AppConfig = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(restored.permissions.mode, PermissionMode::AutoReview);
        assert_eq!(restored.permissions.auto_review_model, None);
    }

    #[test]
    fn managed_evaluation_model_policy_is_canonical_and_preserves_catalog() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("models.toml");
        std::fs::write(
            &path,
            "[llm]\nmodel = 'old-primary'\n\n[models.worker]\nservice = 'service-a'\nphysical_model = 'worker-v1'\n",
        )
        .unwrap();

        save_managed_evaluation_model_policy_at(
            &path,
            "primary",
            &[
                " worker ".to_string(),
                "primary".to_string(),
                "worker".to_string(),
                "reviewer".to_string(),
                String::new(),
            ],
        )
        .unwrap();

        let persisted = std::fs::read_to_string(&path).unwrap();
        let value: toml::Value = toml::from_str(&persisted).unwrap();
        assert_eq!(value["llm"]["model"].as_str(), Some("primary"));
        assert_eq!(
            value["llm"]["allowed_evaluation_models"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(toml::Value::as_str)
                .collect::<Vec<_>>(),
            vec!["reviewer", "worker"]
        );
        assert_eq!(
            value["models"]["worker"]["physical_model"].as_str(),
            Some("worker-v1")
        );
    }

    #[test]
    fn app_config_parses_runtime_managed_ssh_targets_without_connection_secrets() {
        let config: AppConfig = toml::from_str(
            r#"
                [[managed_ssh.targets]]
                id = "target-server"
                name = "Server"
                endpoint_ref = "server"
                owner_principal_id = "principal-a"
                platform = "linux-x86_64"
                workspace_root = "/srv/app"
            "#,
        )
        .unwrap();

        assert_eq!(config.managed_ssh.targets.len(), 1);
        let target = &config.managed_ssh.targets[0];
        assert_eq!(target.id, "target-server");
        assert_eq!(target.endpoint_ref, "server");
        assert_eq!(target.owner_principal_id.as_deref(), Some("principal-a"));
    }

    #[test]
    fn session_working_set_config_accepts_human_duration_and_rejects_zero_limit() {
        let defaults = SessionWorkingSetConfig::default();
        assert_eq!(defaults.active_window.as_secs(), 86_400);
        assert_eq!(defaults.max_sessions, 50);

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
        assert!(error.contains("greater than or equal to 1"));
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
        assert!(error.contains("greater than or equal to 1"));
    }

    #[test]
    fn scheduler_config_has_small_bounded_delivery_window() {
        let defaults = SchedulerConfig::default();
        assert_eq!(defaults.delivery_merge_window.as_secs(), 1);
        assert_eq!(defaults.delivery_max_wait.as_secs(), 3);
        assert_eq!(defaults.delivery_snapshot_max_items, 64);
        assert_eq!(defaults.delivery_recovery_page_size, 256);

        let parsed: SchedulerConfig = toml::from_str(
            "delivery_merge_window = '2s'\ndelivery_max_wait = '7s'\n\
             delivery_snapshot_max_items = 12\ndelivery_recovery_page_size = 48\n",
        )
        .unwrap();
        assert_eq!(parsed.delivery_merge_window.as_secs(), 2);
        assert_eq!(parsed.delivery_max_wait.as_secs(), 7);
        assert_eq!(parsed.delivery_snapshot_max_items, 12);
        assert_eq!(parsed.delivery_recovery_page_size, 48);
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

        let xdg = morphz_home_dir_from(None, Some(OsString::from("/xdg")), None, None);
        assert_eq!(xdg, Some(PathBuf::from("/xdg/morphz")));

        let home = morphz_home_dir_from(None, None, None, Some(OsString::from("/home/user")));
        assert_eq!(home, Some(PathBuf::from("/home/user/.morphz")));
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
        std::fs::write(home.join("morphz.toml"), "[llm]\nmodel='primary'\n").unwrap();
        std::fs::write(
            home.join("profiles/dev.toml"),
            "[llm]\nmodel='profile'\nmax_retries=2\n",
        )
        .unwrap();
        std::fs::write(
            child.join(".morphz/morphz.toml"),
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
            .any(|source| source.starts_with("profile:")));
        assert!(model_history
            .last()
            .is_some_and(|source| source.starts_with("explicit:")));
        assert!(resolved
            .source_for("llm.max_retries")
            .starts_with("profile:"));
        assert_eq!(resolved.layers.len(), 4);
        assert_eq!(
            resolved.source_for("orchestrator.model_provider_max_in_flight"),
            "built-in-default"
        );
    }

    #[test]
    fn model_config_is_loaded_after_core_without_mixing_runtime_policy() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        let home = temp.path().join("home");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("morphz.toml"),
            "[server]\nbind='127.0.0.1:9900'\n[llm]\nmodel='legacy-route'\n",
        )
        .unwrap();
        std::fs::write(
            home.join("models.toml"),
            "[llm]\nmodel='primary-route'\nallowed_evaluation_models=['fast-route']\n\n[models.primary-route]\nservice='primary'\nphysical_model='physical-primary'\n\n[models.fast-route]\nservice='primary'\nphysical_model='physical-fast'\n\n[services.primary]\nadapter='openai-compatible'\nprotocol='openai-responses'\nbase_url='http://localhost:8317/v1'\n",
        )
        .unwrap();

        let resolved = resolve_config_with_home(&root, None, None, Some(home)).unwrap();

        assert_eq!(resolved.config.server.bind, "127.0.0.1:9900");
        assert_eq!(resolved.config.llm.model, "primary-route");
        assert_eq!(
            resolved.config.llm.allowed_evaluation_models,
            vec!["fast-route"]
        );
        assert!(resolved.config.model_routes.contains_key("primary-route"));
        assert!(resolved.config.model_routes.contains_key("fast-route"));
    }

    #[test]
    fn legacy_combined_config_is_split_without_losing_existing_model_edits() {
        let temp = TempDir::new().unwrap();
        let core_path = temp.path().join("morphz.toml");
        let model_path = temp.path().join("models.toml");
        std::fs::write(
            &core_path,
            "[server]\nbind='127.0.0.1:8808'\n[llm]\nmodel='legacy-primary'\nallowed_evaluation_models=['legacy-fast']\n\n[models.legacy-primary]\nservice='legacy'\nphysical_model='legacy-physical'\n\n[services.legacy]\nadapter='openai-compatible'\nprotocol='openai-responses'\nbase_url='http://legacy.invalid/v1'\n",
        )
        .unwrap();
        std::fs::write(
            &model_path,
            "[llm]\nmodel='operator-primary'\n\n[models.operator-primary]\nservice='operator'\nphysical_model='operator-physical'\n\n[services.operator]\nadapter='openai-compatible'\nprotocol='openai-responses'\nbase_url='http://operator.invalid/v1'\n",
        )
        .unwrap();

        split_primary_model_config_if_needed(&core_path, &model_path).unwrap();

        let core = std::fs::read_to_string(&core_path).unwrap();
        let models = std::fs::read_to_string(&model_path).unwrap();
        let core_value = core.parse::<toml::Value>().unwrap();
        let model_value = models.parse::<toml::Value>().unwrap();
        assert_eq!(
            core_value["server"]["bind"].as_str(),
            Some("127.0.0.1:8808")
        );
        for key in MODEL_CONFIG_ROOT_KEYS {
            assert!(core_value.get(*key).is_none(), "core still contains {key}");
        }
        assert_eq!(
            model_value["llm"]["model"].as_str(),
            Some("operator-primary")
        );
        assert!(model_value["models"].get("legacy-primary").is_some());
        assert!(model_value["models"].get("operator-primary").is_some());
        assert!(model_value["services"].get("legacy").is_some());
        assert!(model_value["services"].get("operator").is_some());

        // A completed migration is idempotent and must not rewrite either
        // file on every startup.
        let core_before = core.clone();
        let models_before = models.clone();
        split_primary_model_config_if_needed(&core_path, &model_path).unwrap();
        assert_eq!(std::fs::read_to_string(&core_path).unwrap(), core_before);
        assert_eq!(std::fs::read_to_string(&model_path).unwrap(), models_before);
    }

    #[test]
    fn primary_config_overrides_legacy_defaults_but_not_profile() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        let home = temp.path().join("home");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(home.join("profiles")).unwrap();
        std::fs::write(home.join("config.toml"), "[llm]\nmodel='user'\n").unwrap();
        std::fs::write(home.join("morphz.toml"), "[llm]\nmodel='primary'\n").unwrap();
        std::fs::write(home.join("profiles/dev.toml"), "[llm]\nmodel='profile'\n").unwrap();

        let global = resolve_config_with_home(&root, None, None, Some(home.clone())).unwrap();
        let profile = resolve_config_with_home(&root, None, Some("dev"), Some(home)).unwrap();

        assert_eq!(global.config.llm.model, "primary");
        assert!(global.source_for("llm.model").starts_with("user:"));
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
            root.join(".morphz/morphz.toml"),
            "[providers.evil]\nbase_url='https://evil.invalid'\n\n[permissions]\nmode='full_access'\n\n[storage]\nbackend='postgres'\n\n[model_input]\nmax_request_bytes=999999999\n\n[server.identity]\nmode='trusted-gateway'\n\n[[managed_ssh.targets]]\nid='target-evil'\nname='Evil'\nendpoint_ref='evil'\n",
        )
        .unwrap();

        let error = resolve_config_with_home(&root, None, None, None).unwrap_err();

        assert!(error.contains("host control-plane fields"));
        assert!(error.contains("services.evil.base_url"));
        assert!(error.contains("permissions.mode"));
        assert!(error.contains("storage.backend"));
        assert!(error.contains("model_input.max_request_bytes"));
        assert!(error.contains("server.identity.mode"));
        assert!(error.contains("managed_ssh.targets"));
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
        assert!(unsafe_name.contains("Profile name"));
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
        assert!(error.contains("unknown configuration key"));
    }

    #[test]
    fn managed_config_is_atomic_parseable_and_contains_no_secret_value() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join(".morphz").join("morphz.toml");
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
        assert!(!content.contains("[providers."));
        assert!(content.contains("[services.local]"));
        assert!(content.contains("[accounts.local-default]"));
        assert!(content.contains("[models.model-a]"));
        let parsed: AppConfig = toml::from_str(&content).unwrap();
        assert_eq!(parsed.llm.provider, None);
        assert_eq!(
            parsed.provider_instances["local"].protocol,
            ModelProtocol::OpenaiChat
        );
        assert_eq!(
            parsed.auth_accounts["local-default"].credential_ref,
            "local"
        );
        assert_eq!(
            parsed.model_routes["model-a"].candidates[0].model,
            "model-a"
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
        assert_eq!(
            cfg.storage.cognitive_store,
            CognitiveStoreBackend::ContextDb
        );
        assert_eq!(cfg.storage.sqlite.path, "morphz.db");
        assert_eq!(cfg.storage.sqlite.max_connections, 8);
        assert_eq!(cfg.storage.postgres.url_env, "MORPHZ_POSTGRES_URL");
        assert!(cfg.storage.retention.enabled);
        assert_eq!(
            cfg.storage.retention.resolved_signal_outbox_age.as_secs(),
            7 * 24 * 60 * 60
        );
        assert_eq!(
            cfg.storage.retention.expired_edge_credential_age.as_secs(),
            24 * 60 * 60
        );
        assert_eq!(cfg.storage.retention.startup_batch_limit, 1_000);
        assert_eq!(cfg.llm.max_retries, 5);
        assert_eq!(cfg.llm.connect_timeout_secs, 30);
        assert_eq!(cfg.llm.stream_idle_timeout_secs, 120);
        assert_eq!(cfg.llm.first_byte_timeout_secs, 300);
        assert_eq!(cfg.llm.max_output_tokens, None);
        assert_eq!(cfg.llm.reasoning_effort, None);
        assert_eq!(cfg.orchestrator.reply_wait_notice_secs, 120);
        assert_eq!(cfg.orchestrator.activation_lease_secs, 30);
        assert_eq!(cfg.orchestrator.objective_evaluation_lease_secs, 90);
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
    fn cloud_runtime_environment_values_are_strictly_parsed() {
        assert_eq!(
            parse_storage_backend_env("postgres").unwrap(),
            StorageBackend::Postgres
        );
        assert_eq!(
            parse_storage_backend_env("POSTGRESQL").unwrap(),
            StorageBackend::Postgres
        );
        assert!(parse_storage_backend_env("d1").is_err());

        assert_eq!(
            parse_cognitive_store_backend_env("context_db").unwrap(),
            CognitiveStoreBackend::ContextDb
        );
        assert_eq!(
            parse_cognitive_store_backend_env("CONTEXT-DB").unwrap(),
            CognitiveStoreBackend::ContextDb
        );
        assert_eq!(
            parse_cognitive_store_backend_env("legacy").unwrap(),
            CognitiveStoreBackend::Legacy
        );
        assert!(parse_cognitive_store_backend_env("projection").is_err());

        assert_eq!(
            parse_server_identity_mode_env("trusted_gateway").unwrap(),
            ServerIdentityMode::TrustedGateway
        );
        assert_eq!(
            parse_server_identity_mode_env("default").unwrap(),
            ServerIdentityMode::Default
        );
        assert!(parse_server_identity_mode_env("anonymous").is_err());
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
    fn experimental_features_are_explicit_and_disabled_by_default() {
        let default = toml::from_str::<AppConfig>("").unwrap();
        assert!(default.experimental.enabled.is_empty());

        let configured =
            toml::from_str::<AppConfig>("[experimental]\nenabled=['cognitive-coordination']\n")
                .unwrap();
        assert_eq!(
            configured.experimental.enabled,
            BTreeSet::from(["cognitive-coordination".to_string()])
        );
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
        // Unspecified sections should retain their defaults.
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
        writeln!(tmp_file, "first_byte_timeout_secs = 17").unwrap();
        writeln!(tmp_file, "max_retries = 1").unwrap();
        writeln!(tmp_file, "max_output_tokens = 131072").unwrap();
        writeln!(tmp_file, "reasoning_effort = 'high'").unwrap();

        let cfg = toml::from_str::<AppConfig>(&std::fs::read_to_string(tmp_file.path()).unwrap())
            .unwrap();
        assert_eq!(cfg.llm.connect_timeout_secs, 7);
        assert_eq!(cfg.llm.stream_idle_timeout_secs, 11);
        assert_eq!(cfg.llm.first_byte_timeout_secs, 17);
        assert_eq!(cfg.llm.max_retries, 1);
        assert_eq!(cfg.llm.max_output_tokens, Some(131_072));
        assert_eq!(cfg.llm.reasoning_effort, Some(ReasoningEffort::High));
        assert!(cfg.llm.model.is_empty());
    }

    #[test]
    fn reasoning_effort_supports_off_and_max_but_rejects_unknown_levels() {
        let off = toml::from_str::<AppConfig>("[llm]\nreasoning_effort='none'\n").unwrap();
        assert_eq!(off.llm.reasoning_effort, Some(ReasoningEffort::Off));
        let max = toml::from_str::<AppConfig>("[llm]\nreasoning_effort='max'\n").unwrap();
        assert_eq!(max.llm.reasoning_effort, Some(ReasoningEffort::Max));
        let default = toml::from_str::<AppConfig>("[llm]\nreasoning_effort='default'\n").unwrap();
        assert_eq!(default.llm.reasoning_effort, None);
        assert!(toml::from_str::<AppConfig>("[llm]\nreasoning_effort='xhigh'\n").is_err());
    }

    #[test]
    fn managed_inference_selection_survives_full_config_resolution() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        let home = temp.path().join("home");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let primary_path = home.join("morphz.toml");
        std::fs::write(
            &primary_path,
            r#"
[llm]
provider = "proxy"
model = "model-small"
reasoning_effort = "low"

[providers.proxy]
protocol = "openai-responses"
base_url = "http://localhost:8317/v1"

[providers.proxy.models.model-small]
max_input_tokens = 128000

[providers.proxy.models.model-large]
max_input_tokens = 256000
"#,
        )
        .unwrap();
        save_managed_inference_at(
            &primary_path,
            Some("proxy"),
            "model-large",
            Some(ReasoningEffort::High),
            Some(1_000_000),
        )
        .unwrap();

        let resolved = resolve_config_with_home(&root, None, None, Some(home.clone())).unwrap();
        assert_eq!(resolved.config.llm.model, "model-large");
        assert_eq!(
            resolved.config.llm.reasoning_effort,
            Some(ReasoningEffort::High)
        );
        assert_eq!(
            resolved.config.provider_instances["proxy"].models["model-large"].max_input_tokens,
            Some(1_000_000)
        );
        let contents = std::fs::read_to_string(&primary_path).unwrap();
        assert!(!contents.contains("[providers."));
        assert!(contents.contains("[services.proxy]"));
        assert!(contents.contains("[accounts.proxy-anonymous]"));
        assert!(contents.contains("[models.model-large]"));

        save_managed_inference_at(&primary_path, Some("proxy"), "model-large", None, None).unwrap();
        let reset = resolve_config_with_home(&root, None, None, Some(home)).unwrap();
        assert_eq!(reset.config.llm.reasoning_effort, None);
        assert_eq!(
            reset.config.provider_instances["proxy"].models["model-large"].max_input_tokens,
            Some(1_000_000)
        );
    }

    #[test]
    fn managed_inference_capacity_follows_routed_service_without_legacy_provider() {
        let temp = TempDir::new().unwrap();
        let primary_path = temp.path().join("morphz.toml");
        std::fs::write(
            &primary_path,
            r#"
[llm]
model = "grok-route"

[services.xai-subscription]
adapter = "xai-grok"
protocol = "openai-responses"
base_url = "https://api.x.ai/v1"

[services.xai-subscription.models."grok-4.5"]
max_input_tokens = 262144

[models.grok-route]
service = "xai-subscription"
physical_model = "grok-4.5"
"#,
        )
        .unwrap();

        save_managed_inference_at(&primary_path, None, "grok-route", None, Some(1_000_000))
            .unwrap();

        let contents = std::fs::read_to_string(&primary_path).unwrap();
        let persisted: AppConfig = toml::from_str(&contents).unwrap();
        assert_eq!(persisted.llm.provider, None);
        assert_eq!(persisted.llm.model, "grok-route");
        assert_eq!(
            persisted.provider_instances["xai-subscription"].models["grok-4.5"].max_input_tokens,
            Some(1_000_000)
        );
        assert!(!persisted.provider_instances["xai-subscription"]
            .models
            .contains_key("grok-route"));
    }

    #[test]
    fn managed_inference_capacity_rejects_ambiguous_physical_targets() {
        let temp = TempDir::new().unwrap();
        let primary_path = temp.path().join("morphz.toml");
        std::fs::write(
            &primary_path,
            r#"
[llm]
model = "fallback-route"

[services.primary]
adapter = "openai-compatible"
protocol = "openai-responses"
base_url = "https://primary.example/v1"

[services.primary.models."model-a"]
max_input_tokens = 100000

[services.backup]
adapter = "openai-compatible"
protocol = "openai-responses"
base_url = "https://backup.example/v1"

[services.backup.models."model-b"]
max_input_tokens = 200000

[[models.fallback-route.candidates]]
service = "primary"
physical_model = "model-a"

[[models.fallback-route.candidates]]
service = "backup"
physical_model = "model-b"
"#,
        )
        .unwrap();

        let error =
            save_managed_inference_at(&primary_path, None, "fallback-route", None, Some(300_000))
                .unwrap_err();

        assert!(error.contains("multiple physical targets"));
        let persisted: AppConfig =
            toml::from_str(&std::fs::read_to_string(&primary_path).unwrap()).unwrap();
        assert_eq!(
            persisted.provider_instances["primary"].models["model-a"].max_input_tokens,
            Some(100_000)
        );
        assert_eq!(
            persisted.provider_instances["backup"].models["model-b"].max_input_tokens,
            Some(200_000)
        );
    }

    #[test]
    fn managed_inference_capacity_accepts_one_physical_target_with_multiple_accounts() {
        let temp = TempDir::new().unwrap();
        let primary_path = temp.path().join("morphz.toml");
        std::fs::write(
            &primary_path,
            r#"
[llm]
model = "shared-route"

[services.shared]
adapter = "openai-compatible"
protocol = "openai-responses"
base_url = "https://shared.example/v1"

[services.shared.models."model-a"]
max_input_tokens = 100000

[[models.shared-route.candidates]]
service = "shared"
physical_model = "model-a"
account = "account-a"

[[models.shared-route.candidates]]
service = "shared"
physical_model = "model-a"
account = "account-b"
"#,
        )
        .unwrap();

        save_managed_inference_at(&primary_path, None, "shared-route", None, Some(300_000))
            .unwrap();

        let persisted: AppConfig =
            toml::from_str(&std::fs::read_to_string(&primary_path).unwrap()).unwrap();
        assert_eq!(
            persisted.provider_instances["shared"].models["model-a"].max_input_tokens,
            Some(300_000)
        );
    }

    #[test]
    fn provider_model_context_capacity_is_keyed_by_exact_model_name() {
        let config = toml::from_str::<AppConfig>(
            r#"
[providers.proxy]
protocol = "openai-responses"
base_url = "http://localhost:8317/v1"

[providers.proxy.models."model-large"]
context_window_tokens = 1_000_000
max_output_tokens = 32_000

[providers.proxy.models."model-input-capped"]
context_window_tokens = 1_000_000
max_input_tokens = 700_000
max_output_tokens = 64_000
"#,
        )
        .unwrap();

        assert_eq!(
            config.providers["proxy"].models["model-large"].prompt_token_limit(),
            Some(968_000)
        );
        assert_eq!(
            config.providers["proxy"].models["model-input-capped"].prompt_token_limit(),
            Some(700_000)
        );
        assert!(!config.providers["proxy"].models.contains_key("MODEL-LARGE"));
    }

    #[test]
    fn provider_model_context_capacity_rejects_zero_and_invalid_derived_prompt_limit() {
        assert!(toml::from_str::<AppConfig>(
            r#"
[providers.proxy]
protocol = "openai-responses"
base_url = "http://localhost:8317/v1"
[providers.proxy.models.bad]
max_input_tokens = 0
"#,
        )
        .is_err());

        let profile = ProviderModelConfig {
            context_window_tokens: Some(32_000),
            max_input_tokens: None,
            max_output_tokens: Some(32_000),
            ..ProviderModelConfig::default()
        };
        assert_eq!(profile.prompt_token_limit(), None);
    }

    #[test]
    fn model_input_policy_is_configurable_and_rejects_zero() {
        let config: AppConfig = toml::from_str(
            r#"
[model_input]
max_artifacts_per_import = 256
max_artifact_bytes = 268435456
max_import_bytes = 536870912
max_artifacts_per_request = 192
max_request_bytes = 402653184
pending_import_grace = "2h"
"#,
        )
        .unwrap();
        assert_eq!(config.model_input.max_artifacts_per_import, 256);
        assert_eq!(config.model_input.max_artifact_bytes, 256 * 1024 * 1024);
        assert_eq!(config.model_input.max_request_bytes, 384 * 1024 * 1024);
        assert_eq!(
            config.model_input.pending_import_grace.as_secs(),
            2 * 60 * 60
        );
        assert!(
            config.model_input.dashboard_body_limit_bytes() > config.model_input.max_import_bytes
        );

        assert!(toml::from_str::<AppConfig>(
            r#"
[model_input]
max_artifacts_per_import = 0
"#,
        )
        .is_err());
    }

    #[test]
    fn provider_model_input_limits_remain_unknown_unless_explicit() {
        let unknown = ProviderModelConfig::default().model_input_limits();
        assert!(unknown.is_unspecified());

        let profile: ProviderModelConfig = toml::from_str(
            r#"
max_input_attachments = 64
max_input_attachment_bytes = 67108864
max_input_attachment_total_bytes = 201326592
"#,
        )
        .unwrap();
        let limits = profile.model_input_limits();
        assert_eq!(limits.max_attachments, Some(64));
        assert_eq!(limits.max_attachment_bytes, Some(64 * 1024 * 1024));
        assert_eq!(limits.max_total_bytes, Some(192 * 1024 * 1024));
    }

    #[test]
    fn provider_model_prompt_cache_strategy_is_endpoint_declared() {
        assert_eq!(
            ProviderModelConfig::default().prompt_cache_strategy,
            PromptCacheStrategy::Auto
        );
        let explicit: ProviderModelConfig =
            toml::from_str(r#"prompt_cache_strategy = "explicit-content-boundaries""#).unwrap();
        assert_eq!(
            explicit.prompt_cache_strategy,
            PromptCacheStrategy::ExplicitContentBoundaries
        );
        let implicit: ProviderModelConfig =
            toml::from_str(r#"prompt_cache_strategy = "implicit-prefix""#).unwrap();
        assert_eq!(
            implicit.prompt_cache_strategy,
            PromptCacheStrategy::ImplicitPrefix
        );
        let implicit_content_boundaries: ProviderModelConfig =
            toml::from_str(r#"prompt_cache_strategy = "implicit-content-boundaries""#).unwrap();
        assert_eq!(
            implicit_content_boundaries.prompt_cache_strategy,
            PromptCacheStrategy::ImplicitContentBoundaries
        );
        let implicit_message_boundaries: ProviderModelConfig =
            toml::from_str(r#"prompt_cache_strategy = "implicit-message-boundaries""#).unwrap();
        assert_eq!(
            implicit_message_boundaries.prompt_cache_strategy,
            PromptCacheStrategy::ImplicitMessageBoundaries
        );
        let structured_deltas: ProviderModelConfig =
            toml::from_str(r#"prompt_cache_strategy = "experimental-structured-deltas""#).unwrap();
        assert_eq!(
            structured_deltas.prompt_cache_strategy,
            PromptCacheStrategy::ExperimentalStructuredDeltas
        );
    }

    #[test]
    fn managed_provider_catalog_persists_references_without_secret_values() {
        let temp = TempDir::new().unwrap();
        let managed_path = temp.path().join("managed.toml");
        let provider = ProviderInstanceConfig {
            adapter: "openai-codex".to_string(),
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://api.openai.com/v1".to_string(),
            accounts: vec!["codex-personal".to_string()],
            ..ProviderInstanceConfig::default()
        };
        let account = AuthAccountConfig {
            auth_adapter: "openai-codex".to_string(),
            credential_ref: "provider-account/codex-personal/oauth-token-set".to_string(),
            provider: Some("openai-subscription".to_string()),
            label: Some("Personal Codex".to_string()),
            ..AuthAccountConfig::default()
        };
        let route = ModelRouteConfig {
            display_alias: Some("coding/model-alpha".to_string()),
            aliases: vec!["coding/model-alpha".to_string()],
            candidates: vec![ModelRouteCandidateConfig {
                provider: "openai-subscription".to_string(),
                model: "physical-model-alpha".to_string(),
                ..ModelRouteCandidateConfig::default()
            }],
            ..ModelRouteConfig::default()
        };

        save_managed_provider_catalog_at(
            &managed_path,
            "openai-subscription",
            &provider,
            "codex-personal",
            &account,
            None,
            "route-alpha",
            &route,
            "route-alpha",
        )
        .unwrap();

        let contents = std::fs::read_to_string(&managed_path).unwrap();
        let persisted: AppConfig = toml::from_str(&contents).unwrap();
        assert!(contents.contains("[accounts.codex-personal]"));
        assert!(contents.contains("[services.openai-subscription]"));
        assert!(contents.contains("[models.route-alpha]"));
        assert!(contents.contains("service = \"openai-subscription\""));
        assert!(contents.contains("physical_model = \"physical-model-alpha\""));
        assert!(!contents.contains("[[models.route-alpha.targets]]"));
        assert!(!contents.contains("auth_accounts"));
        assert!(!contents.contains("provider_instances"));
        assert!(!contents.contains("model_routes"));
        assert!(!contents.contains("candidates"));
        assert!(!contents.contains("aliases = []"));
        assert!(!contents.contains("capabilities = []"));
        assert!(!contents.contains("priority = 0"));
        assert!(!contents.contains("fallback = false"));
        assert!(!contents.contains("selection ="));
        assert!(!contents.contains("affinity ="));
        assert_eq!(
            persisted.provider_instances["openai-subscription"].accounts,
            ["codex-personal"]
        );
        assert_eq!(
            persisted.auth_accounts["codex-personal"].credential_ref,
            "provider-account/codex-personal/oauth-token-set"
        );
        assert_eq!(
            persisted.model_routes["route-alpha"].aliases,
            ["coding/model-alpha"]
        );
        assert_eq!(
            persisted.model_routes["route-alpha"]
                .display_alias
                .as_deref(),
            Some("coding/model-alpha")
        );
        assert_eq!(
            persisted.model_routes["route-alpha"].candidates[0].model,
            "physical-model-alpha"
        );
        assert_eq!(persisted.llm.provider, None);
        assert_eq!(persisted.llm.model, "route-alpha");
        assert!(!contents.contains("super-secret-access-token"));
        assert!(!contents.contains("refresh_token"));
    }

    #[test]
    fn compact_model_targets_keep_full_routing_expression() {
        let config = toml::from_str::<AppConfig>(
            r#"
[llm]
model = "coding"

[accounts.primary]
auth_adapter = "credential"
credential_ref = "PRIMARY_TOKEN"
provider = "primary-service"

[accounts.backup]
auth_adapter = "credential"
credential_ref = "BACKUP_TOKEN"
provider = "backup-service"

[services.primary-service]
adapter = "protocol-compatible"
protocol = "openai-responses"
base_url = "https://primary.invalid/v1"
accounts = ["primary"]

[services.backup-service]
adapter = "protocol-compatible"
protocol = "openai-chat"
base_url = "https://backup.invalid/v1"
accounts = ["backup"]

[models.coding]
aliases = ["code"]
stickiness = "objective"
strategy = "priority"
fallback = true

[[models.coding.targets]]
service = "primary-service"
account = "primary"
physical_model = "model-primary"
priority = 0
capabilities = ["tools"]

[[models.coding.targets]]
service = "backup-service"
account = "backup"
physical_model = "model-backup"
priority = 1
"#,
        )
        .unwrap();

        let route = &config.model_routes["coding"];
        assert_eq!(route.aliases, ["code"]);
        assert_eq!(route.affinity, ModelRouteAffinity::Objective);
        assert_eq!(route.selection, ModelRouteSelection::Priority);
        assert!(route.fallback);
        assert_eq!(route.candidates.len(), 2);
        assert_eq!(route.candidates[0].provider, "primary-service");
        assert_eq!(route.candidates[0].capabilities, ["tools"]);
        assert_eq!(route.candidates[1].priority, 1);
    }

    #[test]
    fn unfinished_oauth_catalog_cleanup_removes_the_entire_orphan_graph() {
        let temp = TempDir::new().unwrap();
        let managed_path = temp.path().join("managed.toml");
        let provider = ProviderInstanceConfig {
            adapter: "openai-codex".to_string(),
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://chatgpt.com/backend-api/codex".to_string(),
            accounts: vec!["attempt-account".to_string()],
            ..ProviderInstanceConfig::default()
        };
        let account = AuthAccountConfig {
            auth_adapter: "codex-oauth".to_string(),
            credential_ref: "MORPHZ_OAUTH_ATTEMPT".to_string(),
            provider: Some("codex-subscription".to_string()),
            ..AuthAccountConfig::default()
        };
        let route = ModelRouteConfig {
            candidates: vec![ModelRouteCandidateConfig {
                provider: "codex-subscription".to_string(),
                model: "invented-default-model".to_string(),
                account: Some("attempt-account".to_string()),
                ..ModelRouteCandidateConfig::default()
            }],
            ..ModelRouteConfig::default()
        };
        save_managed_provider_catalog_at(
            &managed_path,
            "codex-subscription",
            &provider,
            "attempt-account",
            &account,
            None,
            "invented-default-route",
            &route,
            "invented-default-route",
        )
        .unwrap();

        remove_managed_provider_accounts_at(
            &managed_path,
            &BTreeSet::from(["attempt-account".to_string()]),
        )
        .unwrap();

        let contents = std::fs::read_to_string(&managed_path).unwrap();
        let persisted: AppConfig = toml::from_str(&contents).unwrap();
        assert!(persisted.auth_accounts.is_empty());
        assert!(persisted.provider_instances.is_empty());
        assert!(persisted.model_routes.is_empty());
        assert_eq!(persisted.llm.provider, None);
        assert!(!contents.contains("attempt-account"));
        assert!(!contents.contains("MORPHZ_OAUTH_ATTEMPT"));
    }
}
