use crate::config::OrchestratorConfig;
use crate::event::{
    Event, TYPE_CONTEXT_SEED, TYPE_CONTEXT_TRANSACTION, TYPE_INFER_REQUEST, TYPE_TOOL_OUTPUT,
    TYPE_USER_MESSAGE,
};
use crate::memory::{
    CognitiveClockStore, ContextCognitiveClock, DeliveryStatus, EventStore,
    ExecutionTargetAuthorizationFilter, ExecutionTargetAuthorizationRecord,
    ExecutionTargetAuthorizationScope, ExecutionTargetAuthorizationStatus,
    ExecutionTargetAuthorizationStore, ExecutionTargetFilter, ExecutionTargetRecord,
    ExecutionTargetStore, MindProjectionCommit, MindProjectionRecord, MindProjectionStore,
    MindSnapshotRecord, NewMindProjection, ObjectiveRecord, ObjectiveStore, QueryFilter,
    RecallDocument, RecallDocumentKind, RecallIndexAudit, RecallProjectionStore, RecallSearchHit,
    ScheduleRecord, ScheduleStatus, SessionAttentionState, SessionAttentionUpdate,
    SessionProjectionMutation, SessionProjectionStore, SessionRecord, SessionStatus, SessionStore,
    ThreadActivationRecord, ThreadPhase, ThreadRecord, ThreadSignalRecord, ThreadSignalStatus,
    WorkerCoordinationMode,
};
use crate::orchestrator::context_contract::{
    render_context_tx_epistemic_guidance, ContractClause, EPISTEMIC_CONTRACT,
    EPISTEMIC_CONTRACT_NAME, REALITY_CONTRACT, REALITY_CONTRACT_NAME,
};
use crate::sexpr::{parse, SExpr};
use crate::tool::{active_background_task_count, get_tasks_map};
use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const CONTEXT_PROTOCOL_VERSION: u64 = 26;
const EVENT_REFERENCE_PREFIX: &str = "@e";
const FRAME_RECALL_PAGE_CHAR_BUDGET: usize = 24_000;

fn validate_snapshot_head_event(
    snapshot: &MindSnapshotRecord,
    head: &Event,
) -> Result<(), DynError> {
    let event_context_id = head
        .payload
        .get("context_id")
        .and_then(serde_json::Value::as_str);
    if event_context_id != Some(snapshot.context_id.as_str()) {
        return Err(format!(
            "Mind Snapshot '{}' 的 head Event '{}' 属于错误的 Context {:?}",
            snapshot.id, head.id, event_context_id
        )
        .into());
    }
    match (
        head.event_type.as_str(),
        head.topic.as_str(),
        head.actor.as_str(),
    ) {
        (TYPE_CONTEXT_TRANSACTION, "chat/context_tx_committed", "Agent-Context") => {
            let after_version = head
                .payload
                .get("after_version")
                .and_then(serde_json::Value::as_u64);
            let after_hash = head
                .payload
                .get("after_hash")
                .and_then(serde_json::Value::as_str);
            if after_version != Some(snapshot.revision)
                || after_hash != Some(snapshot.state_hash.as_str())
            {
                return Err(format!(
                    "Mind Snapshot '{}' 与 head transaction '{}' 的 after_version/after_hash 不一致",
                    snapshot.id, head.id
                )
                .into());
            }
        }
        (TYPE_CONTEXT_SEED, "runtime/context_seeded", "System-ContextSeed") => {
            let projected_hash = head
                .payload
                .get("projected_hash")
                .and_then(serde_json::Value::as_str);
            if snapshot.revision != 0 || projected_hash != Some(snapshot.state_hash.as_str()) {
                return Err(format!(
                    "Mind Snapshot '{}' 与 seed head Event '{}' 的 revision/projected_hash 不一致",
                    snapshot.id, head.id
                )
                .into());
            }
        }
        _ => {
            return Err(format!(
                "Mind Snapshot '{}' 的 head Event '{}' 不是合法的 Context transaction/seed 锚点",
                snapshot.id, head.id
            )
            .into());
        }
    }
    Ok(())
}

struct ContextOperationSpec {
    name: &'static str,
    syntax: &'static str,
    meaning: &'static str,
}

const CONTEXT_OPERATIONS: &[ContextOperationSpec] = &[
    ContextOperationSpec {
        name: "create",
        syntax: "(create ID BODY...)",
        meaning: "创建具有稳定 ID 的自由格式 frame；一个或多个 BODY 均可，多项由 Runtime 规范化为 context-body；不接受 from",
    },
    ContextOperationSpec {
        name: "derive",
        syntax: "(derive ID (from SOURCE_ID...) BODY...)",
        meaning: "基于 observation/frame 创建带血缘的新 frame；from 固定在 ID 后，随后可写一个或多个 BODY",
    },
    ContextOperationSpec {
        name: "revise",
        syntax: "(revise ID BODY...) | (revise ID (from SOURCE_ID...) BODY...)",
        meaning: "用新 BODY 完整替换既有 frame body 并递增 revision；不是局部 merge，仍需保留的旧字段必须在新 BODY 中重述；可选 from 固定在 ID 后",
    },
    ContextOperationSpec {
        name: "retire",
        syntax: "(retire ID...)",
        meaning: "Observation 立即移出 Context；容量压力下优先清理已消化且不再需要的 Observation。普通 Frame 进入认知活动时钟驱动的整理期，当前 Token 释放量为 0；Frame 必须按语义价值、有效性和 successor 关系判断，不能仅按体积退休；已有安全 successor 的 Frame 可在同一事务立即收口；原因只能写在事务级 reason 中",
    },
    ContextOperationSpec {
        name: "restore",
        syntax: "(restore ID...)",
        meaning: "恢复已 retire 的 frame/observation",
    },
    ContextOperationSpec {
        name: "retire-session",
        syntax: "(retire-session SESSION-ID...)",
        meaning: "把 Session mount 移出自动认知工作集；不归档、不删除 Ledger 或 Shared Mind；必须提供事务级 reason，当前或有活跃工作的 Session 会被拒绝",
    },
    ContextOperationSpec {
        name: "restore-session",
        syntax: "(restore-session SESSION-ID...)",
        meaning: "恢复 Session mount 的自动认知候选状态；新定向事件也会由 Runtime 确定性自动恢复",
    },
    ContextOperationSpec {
        name: "protect",
        syntax: "(protect ID...)",
        meaning: "保护关键内容，阻止直接 retire",
    },
    ContextOperationSpec {
        name: "unprotect",
        syntax: "(unprotect ID...)",
        meaning: "解除保护；原因只能写在事务级 reason 中",
    },
    ContextOperationSpec {
        name: "place",
        syntax: "(place FRAME first|last|(before FRAME)|(after FRAME))",
        meaning: "调整 frame 的注意力顺序",
    },
    ContextOperationSpec {
        name: "relate",
        syntax: "(relate SUBJECT RELATION OBJECT)",
        meaning: "由 Agent 声明两个稳定 Context ID 的语义关系；supersedes 表示新信息取代旧信息",
    },
    ContextOperationSpec {
        name: "unrelate",
        syntax: "(unrelate SUBJECT RELATION OBJECT)",
        meaning: "撤销错误关系；必须在事务级提供 reason",
    },
    ContextOperationSpec {
        name: "checkpoint",
        syntax: "(checkpoint ID)",
        meaning: "保存当前 Mind 的完整可回滚快照；Runtime 只显示快照元数据，不把快照内容重复注入 Context",
    },
    ContextOperationSpec {
        name: "rollback",
        syntax: "(rollback CHECKPOINT_ID)",
        meaning: "显式恢复 checkpoint 中的 frames、relations、retired 与 protected；必须在事务级提供 reason",
    },
    ContextOperationSpec {
        name: "drop-checkpoint",
        syntax: "(drop-checkpoint ID...)",
        meaning: "删除不再需要的恢复点；必须在事务级提供 reason",
    },
];

pub fn context_tx_tool_description() -> String {
    let operations = CONTEXT_OPERATIONS
        .iter()
        .map(|operation| operation.syntax)
        .collect::<Vec<_>>()
        .join("；");
    format!(
        "原子修改你拥有的 Mind Context 与 Session attention。参数 transaction 是版本化 SExpr：(context-tx (base-version N) (reason \"...\") OP...)。Mind version 是全局物理提交序列，Frame revision 是认知修改的 MVCC 边界；并发事务只修改不同 Frame 时 Runtime 可安全自动 rebase，目标或来源 Frame 已在 base-version 后变化时才要求重新读取并做语义合并。支持：{operations}。Context observation 使用 @eN 形式的确定性短引用；在 from/retire/restore/protect/unprotect/relate/unrelate 中原样使用 ref，Runtime 会在提交前解析为完整 Ledger ID。Session ID 不是 observation ref，必须使用 session-directory 中的原始 ID。create/derive/revise 可直接并列一个或多个 BODY；多项会被确定性规范化为 (context-body BODY...)。重要：revise 是完整替换 frame body，绝不是局部 merge；仍需保留的旧字段必须在新 BODY 中重述。create 不接受 from；有证据来源必须写 (derive ID (from SOURCE...) BODY...)。高风险改组前可先 (checkpoint ID)；需要恢复时用带 reason 的 (rollback ID)，确认不再需要时用 (drop-checkpoint ID...)。一个 transaction 可以顺序包含多个不同 operation，并且 Mind 修改与 retire-session/restore-session 整体成功或整体回滚。不要为了表达多个修改而并行调用多次 context_tx。reason 是事务级字段，retire/retire-session/unprotect/unrelate/rollback/drop-checkpoint 必须提供；不要把 reason 放进操作参数。Observation 的 retire 会立即释放其活动编码；容量压力下优先清理已消化且不再需要的 Observation。当前 Activation 尚未交付的根请求受 Runtime 因果保护，不得 retire；已经被当前 Attempt 消费的独立 trigger observation 可以在同一事务中总结并 retire。普通 Frame 的 retire 只进入整理期，当前释放量为 0；Frame 必须按语义价值、有效性、使用和关系判断，不能仅因体积较大而退休。整理期应优先 revise、derive 或建立 sources + supersedes 的 successor；安全 successor 可让来源 Frame 在同一事务立即退休。Frame 数量本身不是退休理由；被退休内容没有删除，可按关键词、ID 和关系链 recall。Context 修改不是给用户的最终回复。提交 BODY 时还必须遵守由协议单一事实源生成的认识契约：{}",
        render_context_tx_epistemic_guidance()
    )
}

pub fn context_tx_parameter_description() -> &'static str {
    "完整的单个 SExpr 心智事务；可在一个 transaction 内顺序组合多个 operation 并原子提交。create/derive/revise 接受一个或多个 BODY，revise 完整替换旧 BODY；from 紧跟 ID。具体语法、来源纪律与全部认识契约以本工具 description 和 Context protocol 为准。"
}

#[derive(Debug, Clone)]
struct ParsedTransaction {
    base_version: u64,
    reason: Option<String>,
    operations: Vec<SExpr>,
}

#[derive(Debug, Clone, Default)]
struct ContextReferences {
    alias_to_id: HashMap<String, String>,
    id_to_alias: HashMap<String, String>,
}

impl ContextReferences {
    fn from_events(events: &[Event]) -> Self {
        let mut references = Self::default();
        for event in events.iter().filter(|event| is_observation(event)) {
            let Some(sequence) = event.sequence else {
                continue;
            };
            let alias = format!("{EVENT_REFERENCE_PREFIX}{sequence}");
            references
                .alias_to_id
                .insert(alias.clone(), event.id.clone());
            references.id_to_alias.insert(event.id.clone(), alias);
        }
        references
    }

    fn display<'a>(&'a self, id: &'a str) -> &'a str {
        self.id_to_alias.get(id).map(String::as_str).unwrap_or(id)
    }

    fn resolve(&self, reference: &str) -> Result<String, String> {
        if !reference.starts_with(EVENT_REFERENCE_PREFIX) {
            return Ok(reference.to_string());
        }
        self.alias_to_id.get(reference).cloned().ok_or_else(|| {
            format!(
                "Context 短引用 '{}' 不存在；请使用当前 Context 展示的 ref，不要猜测或改写",
                reference
            )
        })
    }
}

/// LLM 自己创建的一个认知单元。
///
/// Runtime 不解释 body 的业务语义，只维护稳定 ID、来源、版本和生命周期。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextFrame {
    pub id: String,
    pub body: String,
    pub sources: Vec<String>,
    /// Runtime-derived identity lineage. This is evidence provenance, not an
    /// ownership or access-control decision made on behalf of the Agent.
    #[serde(default)]
    pub provenance: FrameIdentityProvenance,
    pub revision: u64,
    pub created_version: u64,
    pub updated_version: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FrameProvenanceState {
    /// Legacy data or evidence whose Runtime origin is unavailable.
    #[default]
    Unknown,
    /// The Frame was formed directly, without declared source evidence.
    Unattributed,
    /// At least one declared source has Runtime-verifiable origin metadata.
    Attributed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameIdentityProvenance {
    pub formed_principal_id: Option<String>,
    pub formed_session_id: Option<String>,
    pub source_principal_ids: Vec<String>,
    pub source_session_ids: Vec<String>,
    pub state: FrameProvenanceState,
}

/// Agent 主动声明的语义关系。Runtime 只特别解释 `supersedes` 的新旧含义，
/// 其他 relation 名称保持开放，不擅自做业务推理。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextRelation {
    pub subject: String,
    pub relation: String,
    pub object: String,
    pub created_version: u64,
}

/// A model-requested retirement that is still inside its cognitive organizing
/// window. Generation and Frame revision fence later automatic finalization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameRetirement {
    pub frame_id: String,
    pub requested_frame_revision: u64,
    pub requested_mind_version: u64,
    pub requested_at_tick: u64,
    pub eligible_at_tick: u64,
    pub generation: u64,
    pub reason: String,
}

/// Agent 显式建立的 Mind 恢复点。快照不包含其他 checkpoint，
/// 避免递归复制；Runtime 只在 Context 中展示元数据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindCheckpoint {
    pub id: String,
    pub frames: Vec<ContextFrame>,
    pub relations: Vec<ContextRelation>,
    pub retired: BTreeSet<String>,
    #[serde(default)]
    pub retiring: BTreeMap<String, FrameRetirement>,
    pub protected: BTreeSet<String>,
    pub created_version: u64,
}

/// Agent 拥有的 Mind 持久状态。
///
/// `retired` 同时可以包含 frame ID 和 Event Ledger 中的 observation ID。
/// 退役只影响当前 Context 视口，不删除底层事实。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindState {
    pub version: u64,
    pub frames: Vec<ContextFrame>,
    #[serde(default)]
    pub relations: Vec<ContextRelation>,
    pub retired: BTreeSet<String>,
    #[serde(default)]
    pub retiring: BTreeMap<String, FrameRetirement>,
    pub protected: BTreeSet<String>,
    #[serde(default)]
    pub checkpoints: Vec<MindCheckpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextChange {
    pub operation: String,
    pub target: String,
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_effect: Option<ContextChangeTokenEffect>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextChangeTokenEffect {
    pub accounting: String,
    pub estimated_active_before: usize,
    pub estimated_active_after: usize,
    pub estimated_immediate_relief: usize,
    pub estimated_eventual_relief: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextCommit {
    pub transaction_id: String,
    pub before_version: u64,
    pub after_version: u64,
    pub reason: Option<String>,
    pub token_effect: ContextTokenEffect,
    pub changes: Vec<ContextChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextTokenEffect {
    pub accounting: String,
    pub scope: String,
    pub estimated_before: usize,
    pub estimated_after: usize,
    pub estimated_immediate_relief: usize,
    pub estimated_eventual_relief: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MindSeedReceipt {
    pub source_context_id: String,
    pub source_version: u64,
    pub target_context_id: String,
    pub snapshot_hash: String,
    pub projected_hash: String,
    pub inherited_frames: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindProjectionAudit {
    pub context_id: String,
    pub ledger_revision: u64,
    pub projection_revision: Option<u64>,
    pub snapshot_revision: Option<u64>,
    pub ledger_hash: String,
    pub projection_hash: Option<String>,
    pub events_scanned: usize,
    pub incremental_transactions_scanned: Option<usize>,
    pub incremental_matches: Option<bool>,
    pub full_replay_micros: u64,
    pub incremental_replay_micros: Option<u64>,
    pub projection_validation_micros: u64,
    pub matches: bool,
}

/// Hot-path capacity counters for Context transactions and Context Encoding.
/// These are process-local operational metrics; the Ledger and Projections
/// remain the durable authority. The snapshot is exposed through the same
/// Scheduler read model used by the Rust SDK, CLI and HTTP API.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextCapacityMetricsSnapshot {
    pub context_transactions_total: u64,
    pub context_commits_total: u64,
    pub context_tx_conflicts_total: u64,
    pub context_tx_auto_rebases_total: u64,
    pub context_commit_latency_micros_total: u64,
    pub context_commit_latency_micros_max: u64,
    pub mind_projection_loads_total: u64,
    pub mind_projection_load_latency_micros_total: u64,
    pub mind_projection_load_latency_micros_max: u64,
    pub context_encodings_total: u64,
    pub events_scanned_total: u64,
    pub events_scanned_per_encoding_max: u64,
}

#[derive(Default)]
struct ContextCapacityMetrics {
    context_transactions_total: AtomicU64,
    context_commits_total: AtomicU64,
    context_tx_conflicts_total: AtomicU64,
    context_tx_auto_rebases_total: AtomicU64,
    context_commit_latency_micros_total: AtomicU64,
    context_commit_latency_micros_max: AtomicU64,
    mind_projection_loads_total: AtomicU64,
    mind_projection_load_latency_micros_total: AtomicU64,
    mind_projection_load_latency_micros_max: AtomicU64,
    context_encodings_total: AtomicU64,
    events_scanned_total: AtomicU64,
    events_scanned_per_encoding_max: AtomicU64,
}

fn record_atomic_max(target: &AtomicU64, value: u64) {
    let mut current = target.load(Ordering::Relaxed);
    while value > current {
        match target.compare_exchange_weak(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(observed) => current = observed,
        }
    }
}

impl ContextCapacityMetrics {
    fn record_projection_load(&self, elapsed_micros: u64) {
        self.mind_projection_loads_total
            .fetch_add(1, Ordering::Relaxed);
        self.mind_projection_load_latency_micros_total
            .fetch_add(elapsed_micros, Ordering::Relaxed);
        record_atomic_max(
            &self.mind_projection_load_latency_micros_max,
            elapsed_micros,
        );
    }

    fn record_encoding(&self, event_count: usize) {
        let event_count = u64::try_from(event_count).unwrap_or(u64::MAX);
        self.context_encodings_total.fetch_add(1, Ordering::Relaxed);
        self.events_scanned_total
            .fetch_add(event_count, Ordering::Relaxed);
        record_atomic_max(&self.events_scanned_per_encoding_max, event_count);
    }

    fn snapshot(&self) -> ContextCapacityMetricsSnapshot {
        ContextCapacityMetricsSnapshot {
            context_transactions_total: self.context_transactions_total.load(Ordering::Relaxed),
            context_commits_total: self.context_commits_total.load(Ordering::Relaxed),
            context_tx_conflicts_total: self.context_tx_conflicts_total.load(Ordering::Relaxed),
            context_tx_auto_rebases_total: self
                .context_tx_auto_rebases_total
                .load(Ordering::Relaxed),
            context_commit_latency_micros_total: self
                .context_commit_latency_micros_total
                .load(Ordering::Relaxed),
            context_commit_latency_micros_max: self
                .context_commit_latency_micros_max
                .load(Ordering::Relaxed),
            mind_projection_loads_total: self.mind_projection_loads_total.load(Ordering::Relaxed),
            mind_projection_load_latency_micros_total: self
                .mind_projection_load_latency_micros_total
                .load(Ordering::Relaxed),
            mind_projection_load_latency_micros_max: self
                .mind_projection_load_latency_micros_max
                .load(Ordering::Relaxed),
            context_encodings_total: self.context_encodings_total.load(Ordering::Relaxed),
            events_scanned_total: self.events_scanned_total.load(Ordering::Relaxed),
            events_scanned_per_encoding_max: self
                .events_scanned_per_encoding_max
                .load(Ordering::Relaxed),
        }
    }
}

struct SnapshotMindRecovery {
    state: MindState,
    snapshot_revision: u64,
    transactions_replayed: usize,
    head_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextObservation {
    pub id: String,
    /// 当前 Context 内由 Ledger sequence 派生的确定性短引用，例如 @e27。
    pub reference: String,
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    pub sequence: u64,
    pub turn: usize,
    pub attempt: Option<usize>,
    pub caused_by: Option<String>,
    pub kind: String,
    pub topic: String,
    pub actor: String,
    pub timestamp: String,
    pub preview: String,
    pub truncated: bool,
    pub representation: String,
    pub visible_chars: usize,
    pub total_chars: usize,
    pub retrievable: bool,
    pub protected: bool,
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_status: Option<String>,
    #[serde(default)]
    pub output_empty: Option<bool>,
    pub resource: Option<ContextResource>,
    pub freshness: ContextFreshness,
    pub usage: ContextUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextResource {
    pub kind: String,
    pub key: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextFreshness {
    pub latest: Option<bool>,
    pub supersedes: Vec<String>,
    pub superseded_by: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextUsage {
    pub recall_count_total: usize,
    pub recall_count_recent: usize,
    pub last_recalled_sequence: Option<u64>,
    pub reference_count_total: usize,
    pub reference_count_recent: usize,
    pub last_referenced_sequence: Option<u64>,
    pub referenced_by_active_frames: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPressure {
    pub level: String,
    pub estimated_tokens: usize,
    /// `context-components-heuristic`、`openai-compatible-request-estimate` 等计量来源。
    #[serde(default = "default_context_token_source")]
    pub token_source: String,
    /// `exact`、`local-tokenizer-estimate`、`usage-calibrated-estimate`
    /// 或 `heuristic-estimate`。
    #[serde(default = "default_context_token_accuracy")]
    pub token_accuracy: String,
    /// `context-components` 表示早期回退；`full-work-prompt` 表示已覆盖完整工作消息与工具定义。
    #[serde(default = "default_context_token_scope")]
    pub token_scope: String,
    #[serde(default)]
    pub token_model: Option<String>,
    pub soft_limit: usize,
    pub hard_limit: usize,
    pub maintenance_reserve: usize,
    pub active_frames: usize,
    pub active_observations: usize,
}

/// 完整 Prompt 的可解释占用归因。`estimated_tokens` 是按本地稳定权重将
/// 本轮 Prompt 总量分摊到组件后的估算，绝不是 Provider 返回的计费事实。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ContextAttribution {
    pub estimated_total_tokens: usize,
    pub total_weight_units: u64,
    pub weight_algorithm: String,
    pub components: Vec<ContextAttributionComponent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextAttributionComponent {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub weight_units: u64,
    pub estimated_tokens: usize,
    pub share: f64,
}

fn default_context_token_source() -> String {
    "context-components-heuristic".to_string()
}

fn default_context_token_accuracy() -> String {
    "heuristic-estimate".to_string()
}

fn default_context_token_scope() -> String {
    "context-components".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnBudget {
    pub attempt: usize,
    pub checkpoint_interval: usize,
    pub next_checkpoint_at: usize,
    pub attempts_until_checkpoint: usize,
    pub checkpoint_due: bool,
    pub context_transactions_used: usize,
    pub context_transactions_limit: usize,
    pub context_tx_available: bool,
    /// `work` 或 `soft-checkpoint`。检查点不会限制工具，也不会强制结束任务。
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WakeSignal {
    pub cause: String,
    pub event_id: Option<String>,
    pub tool_name: Option<String>,
    pub visible_in_inbox: bool,
}

/// The causal responsibility of one model request. This is deliberately
/// separate from the shared Mind and from other in-flight work.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivationFocus {
    pub activation_id: String,
    pub session_id: String,
    pub root_turn_id: String,
    pub thread_kind: String,
    pub root_kind: String,
    pub root_preview: String,
    pub trigger_event_id: String,
    pub trigger_kind: String,
    pub trigger_preview: String,
    /// The exact deterministic Signal batch atomically claimed by this
    /// Activation. The first entry is the primary trigger; later entries are
    /// concurrent mailbox facts that belong to the same causal Thread.
    pub signal_batch: Vec<ActivationSignalFocus>,
    /// Only an explicit Runtime route attaches an Activation to an Objective.
    /// Sharing a Session with an Objective does not create this binding.
    pub objective_id: Option<String>,
    pub objective_evaluation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivationSignalFocus {
    pub event_id: String,
    pub kind: String,
    pub sequence: u64,
}

/// Read-only status of another concurrent Activation. It is context for honest
/// progress reporting, never an instruction for the current Activation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConcurrentActivationView {
    pub activation_id: String,
    pub session_id: String,
    pub root_turn_id: String,
    pub thread_kind: String,
    pub thread_id: String,
    pub status: String,
    pub root_preview: String,
    pub pending_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackgroundTaskView {
    pub task_id: String,
    pub session_id: String,
    pub root_turn_id: Option<String>,
    pub status: String,
    pub command_preview: String,
    pub elapsed_secs: i64,
    pub last_output_age_secs: i64,
    pub next_wakeup_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionProjection {
    Full,
    MetadataOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectedSession {
    pub session: SessionRecord,
    pub projection: SessionProjection,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub principal_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_activation_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_objective_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionWorkingSetExclusions {
    pub archived: usize,
    pub retired: usize,
    pub outside_window: usize,
    pub over_count: usize,
    pub token_budget: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionWorkingSetView {
    pub active_window_secs: u64,
    pub max_sessions: usize,
    pub current_session_ids: Vec<String>,
    pub full_session_ids: Vec<String>,
    pub metadata_only_session_ids: Vec<String>,
    pub excluded: SessionWorkingSetExclusions,
    pub selection: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextView {
    pub context_id: String,
    pub active_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_principal_id: Option<String>,
    pub parent_session_id: Option<String>,
    /// Only Full and metadata-only directory entries are materialized. The
    /// excluded population is represented by `session_working_set` counts so
    /// Prompt size does not scale with the total Session registry.
    pub sessions: Vec<ProjectedSession>,
    pub session_working_set: SessionWorkingSetView,
    pub active_activations: Vec<ThreadActivationRecord>,
    pub threads: Vec<ThreadRecord>,
    pub thread_signals: Vec<ThreadSignalRecord>,
    pub thread_phases: BTreeMap<String, ThreadPhase>,
    pub schedules: Vec<ScheduleRecord>,
    pub activation: Option<ActivationFocus>,
    pub concurrent_activations: Vec<ConcurrentActivationView>,
    pub background_tasks: Vec<BackgroundTaskView>,
    pub objectives: Vec<ObjectiveRecord>,
    /// Compact, Runtime-authoritative index of execution environments visible
    /// to the active Principal. Detailed metadata remains discoverable through
    /// `inspect_target` instead of inflating every model request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub execution_targets: Vec<ExecutionTargetRecord>,
    /// Runtime-authoritative access mode for the compact Target index. The
    /// model never has to infer scoped authorization from conversational
    /// history, and a scoped-but-unauthorized Target is omitted from
    /// `execution_targets` for model-facing Activations.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub execution_target_access: Vec<ExecutionTargetAccessView>,
    pub cognitive_clock: ContextCognitiveClock,
    pub state: MindState,
    pub observations: Vec<ContextObservation>,
    pub pressure: ContextPressure,
    #[serde(default)]
    pub attribution: ContextAttribution,
    pub turn_budget: TurnBudget,
    pub wake: WakeSignal,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sexpr: String,
    /// Cached while this view is alive so pressure re-rendering does not reload
    /// and deserialize the whole Ledger a second time.
    #[serde(skip)]
    references: ContextReferences,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionTargetAccessView {
    pub target_id: String,
    /// `global`, `owner_wide`, `scoped_authorized`, or `scoped_unknown`.
    pub authorization_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matching_scopes: Vec<ExecutionTargetAuthorizationScope>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameRecallDirection {
    #[default]
    Ancestors,
    Descendants,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameRecallRequest {
    pub context_id: String,
    pub frame_id: String,
    pub depth: usize,
    pub direction: FrameRecallDirection,
    pub include_bodies: bool,
    pub include_events: bool,
    pub max_nodes: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecallSearchRequest {
    pub context_id: String,
    pub query: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecallSearchPage {
    pub context_id: String,
    pub query: String,
    pub matches: Vec<RecallSearchHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FrameRecallNode {
    Frame {
        id: String,
        revision: u64,
        lifecycle: String,
        depth: usize,
        sources: Vec<String>,
        provenance: FrameIdentityProvenance,
        body: Option<String>,
    },
    Event {
        id: String,
        reference: String,
        depth: usize,
        preview: String,
        body: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct FrameRecallEdge {
    pub subject: String,
    pub relation: String,
    pub object: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameRecallPage {
    pub root_frame_id: String,
    pub mind_version: u64,
    pub nodes: Vec<FrameRecallNode>,
    pub edges: Vec<FrameRecallEdge>,
    pub truncated: bool,
    pub next_cursor: Option<String>,
}

/// One domain service for model tools, the Rust SDK, CLI, HTTP and Dashboard.
/// Presentation layers must not read Recall tables or reimplement graph walks.
#[async_trait::async_trait]
pub trait ContextRecallService: Send + Sync {
    async fn search_recall(
        &self,
        request: RecallSearchRequest,
    ) -> Result<RecallSearchPage, DynError>;

    async fn recall_frame(&self, request: FrameRecallRequest) -> Result<FrameRecallPage, DynError>;

    async fn inspect_recall_index(&self, context_id: &str) -> Result<RecallIndexAudit, DynError>;

    async fn rebuild_recall_index(&self, context_id: &str) -> Result<RecallIndexAudit, DynError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FrameRecallCursor {
    context_id: String,
    frame_id: String,
    mind_version: u64,
    depth: usize,
    direction: FrameRecallDirection,
    include_bodies: bool,
    include_events: bool,
    max_nodes: usize,
    offset: usize,
}

fn select_session_working_set(
    registry_sessions: &[SessionRecord],
    ready_session_ids: &[String],
    evaluation_started_at: chrono::DateTime<Utc>,
    config: &crate::config::SessionWorkingSetConfig,
    objectives: &[ObjectiveRecord],
    activations: &[ThreadActivationRecord],
) -> (Vec<ProjectedSession>, SessionWorkingSetView) {
    let ready = ready_session_ids.iter().cloned().collect::<HashSet<_>>();
    let window_seconds = i64::try_from(config.active_window.as_secs()).unwrap_or(i64::MAX);
    let cutoff = evaluation_started_at - chrono::Duration::seconds(window_seconds);
    let mut excluded = SessionWorkingSetExclusions::default();
    let mut candidates = Vec::new();

    for session in registry_sessions {
        let is_current = ready.contains(&session.id);
        if session.status == SessionStatus::Archived && !is_current {
            excluded.archived += 1;
            continue;
        }
        if session.attention_state == SessionAttentionState::Retired && !is_current {
            excluded.retired += 1;
            continue;
        }
        if session.last_activity_at < cutoff && !is_current {
            excluded.outside_window += 1;
            continue;
        }
        candidates.push(session.clone());
    }

    candidates.sort_by(|left, right| {
        let left_ready = ready.contains(&left.id);
        let right_ready = ready.contains(&right.id);
        right_ready
            .cmp(&left_ready)
            .then_with(|| right.last_activity_at.cmp(&left.last_activity_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    let full_limit = config.max_sessions.max(1).max(ready.len());
    if candidates.len() > full_limit {
        excluded.over_count = candidates.len() - full_limit;
        candidates.truncate(full_limit);
    }
    let full_ids = candidates
        .iter()
        .map(|session| session.id.clone())
        .collect::<HashSet<_>>();

    let mut work_by_session = HashMap::<String, Vec<String>>::new();
    for item in activations.iter().filter(|item| !item.status.is_terminal()) {
        work_by_session
            .entry(item.session_id.clone())
            .or_default()
            .push(item.id.clone());
    }
    let mut objectives_by_session = HashMap::<String, Vec<String>>::new();
    for objective in objectives
        .iter()
        .filter(|objective| !objective.status.is_terminal())
    {
        objectives_by_session
            .entry(objective.coordinator_session_id.clone())
            .or_default()
            .push(objective.id.clone());
    }

    let mut projected = candidates
        .into_iter()
        .map(|session| ProjectedSession {
            active_activation_ids: work_by_session.remove(&session.id).unwrap_or_default(),
            active_objective_ids: objectives_by_session
                .remove(&session.id)
                .unwrap_or_default(),
            session,
            projection: SessionProjection::Full,
            principal_ids: Vec::new(),
        })
        .collect::<Vec<_>>();
    for session in registry_sessions {
        if full_ids.contains(&session.id) {
            continue;
        }
        let active_activation_ids = work_by_session.remove(&session.id).unwrap_or_default();
        let active_objective_ids = objectives_by_session
            .remove(&session.id)
            .unwrap_or_default();
        if active_activation_ids.is_empty() && active_objective_ids.is_empty() {
            continue;
        }
        projected.push(ProjectedSession {
            session: session.clone(),
            projection: SessionProjection::MetadataOnly,
            principal_ids: Vec::new(),
            active_activation_ids,
            active_objective_ids,
        });
    }
    let full_session_ids = projected
        .iter()
        .filter(|entry| entry.projection == SessionProjection::Full)
        .map(|entry| entry.session.id.clone())
        .collect::<Vec<_>>();
    let metadata_only_session_ids = projected
        .iter()
        .filter(|entry| entry.projection == SessionProjection::MetadataOnly)
        .map(|entry| entry.session.id.clone())
        .collect::<Vec<_>>();
    (
        projected,
        SessionWorkingSetView {
            active_window_secs: config.active_window.as_secs(),
            max_sessions: config.max_sessions.max(1),
            current_session_ids: ready_session_ids.to_vec(),
            full_session_ids,
            metadata_only_session_ids,
            excluded,
            selection: "current first; then last_activity desc; session_id tie-break".to_string(),
        },
    )
}

/// Agent-Owned Context v1 的唯一状态入口。
///
/// Context transaction 在每个 Cognitive Context 的互斥锁内校验、提交并写入 Event Ledger。
/// Orchestrator 与 context_tx 工具共享同一个实例。
pub struct ContextEngine {
    store: Arc<dyn EventStore>,
    session_store: Option<Arc<dyn SessionStore>>,
    mind_projection_store: Option<Arc<dyn MindProjectionStore>>,
    session_projection_store: Option<Arc<dyn SessionProjectionStore>>,
    recall_projection_store: Option<Arc<dyn RecallProjectionStore>>,
    cognitive_clock_store: Option<Arc<dyn CognitiveClockStore>>,
    objective_store: Option<Arc<dyn ObjectiveStore>>,
    execution_target_store: Option<Arc<dyn ExecutionTargetStore>>,
    execution_target_authorization_store: Option<Arc<dyn ExecutionTargetAuthorizationStore>>,
    worker_coordination_mode: WorkerCoordinationMode,
    config: OrchestratorConfig,
    context_locks: DashMap<String, Arc<Mutex<()>>>,
    capacity_metrics: ContextCapacityMetrics,
    recall_cursor_secret: [u8; 32],
}

impl ContextEngine {
    pub fn new(store: Arc<dyn EventStore>, config: OrchestratorConfig) -> Self {
        let mut recall_cursor_secret = [0_u8; 32];
        if getrandom::fill(&mut recall_cursor_secret).is_err() {
            recall_cursor_secret.copy_from_slice(&Sha256::digest(
                format!(
                    "{}:{}",
                    std::process::id(),
                    Utc::now().timestamp_nanos_opt().unwrap_or_default()
                )
                .as_bytes(),
            ));
        }
        Self {
            store,
            session_store: None,
            mind_projection_store: None,
            session_projection_store: None,
            recall_projection_store: None,
            cognitive_clock_store: None,
            objective_store: None,
            execution_target_store: None,
            execution_target_authorization_store: None,
            worker_coordination_mode: WorkerCoordinationMode::ExclusiveProcess,
            config,
            context_locks: DashMap::new(),
            capacity_metrics: ContextCapacityMetrics::default(),
            recall_cursor_secret,
        }
    }

    pub fn with_session_store(mut self, session_store: Arc<dyn SessionStore>) -> Self {
        self.session_store = Some(session_store);
        self
    }

    pub fn with_mind_projection_store(
        mut self,
        mind_projection_store: Arc<dyn MindProjectionStore>,
    ) -> Self {
        self.mind_projection_store = Some(mind_projection_store);
        self
    }

    pub fn with_session_projection_store(
        mut self,
        session_projection_store: Arc<dyn SessionProjectionStore>,
    ) -> Self {
        self.session_projection_store = Some(session_projection_store);
        self
    }

    pub fn with_recall_projection_store(
        mut self,
        recall_projection_store: Arc<dyn RecallProjectionStore>,
    ) -> Self {
        self.recall_projection_store = Some(recall_projection_store);
        self
    }

    pub fn with_cognitive_clock_store(
        mut self,
        cognitive_clock_store: Arc<dyn CognitiveClockStore>,
    ) -> Self {
        self.cognitive_clock_store = Some(cognitive_clock_store);
        self
    }

    pub fn with_objective_store(mut self, objective_store: Arc<dyn ObjectiveStore>) -> Self {
        self.objective_store = Some(objective_store);
        self
    }

    pub fn with_execution_target_store(
        mut self,
        execution_target_store: Arc<dyn ExecutionTargetStore>,
    ) -> Self {
        self.execution_target_store = Some(execution_target_store);
        self
    }

    pub fn with_execution_target_authorization_store(
        mut self,
        store: Arc<dyn ExecutionTargetAuthorizationStore>,
    ) -> Self {
        self.execution_target_authorization_store = Some(store);
        self
    }

    pub fn with_worker_coordination_mode(mut self, mode: WorkerCoordinationMode) -> Self {
        self.worker_coordination_mode = mode;
        self
    }

    pub fn worker_coordination_mode(&self) -> WorkerCoordinationMode {
        self.worker_coordination_mode
    }

    pub fn capacity_metrics(&self) -> ContextCapacityMetricsSnapshot {
        self.capacity_metrics.snapshot()
    }

    pub fn session_store(&self) -> Option<Arc<dyn SessionStore>> {
        self.session_store.clone()
    }

    async fn context_id_for_session(&self, session_id: &str) -> Result<String, DynError> {
        let store = self
            .session_store
            .as_ref()
            .ok_or("ContextEngine 没有配置 SessionStore，不能从 Session 解析 Context")?;
        store
            .get_session(session_id)
            .await?
            .map(|session| session.context_id)
            .ok_or_else(|| format!("Session '{session_id}' 不存在").into())
    }

    /// Maximum event-text slice that a recall result can deliver without its
    /// JSON envelope being preview-truncated again by this Context engine.
    pub(crate) fn recall_chunk_chars(&self) -> usize {
        self.config
            .observation_preview_chars
            .saturating_sub(512)
            .clamp(4_000, 20_000)
    }

    fn validate_mind_projection(
        context_id: &str,
        projection: MindProjectionRecord,
    ) -> Result<MindState, DynError> {
        let state: MindState =
            serde_json::from_value(projection.state.clone()).map_err(|error| {
                format!("Context '{context_id}' 的 Mind Projection state 无法解析: {error}")
            })?;
        if state.version != projection.revision {
            return Err(format!(
                "Context '{context_id}' 的 Mind Projection revision 不一致：state={}，head={}",
                state.version, projection.revision
            )
            .into());
        }
        let actual_hash = mind_state_hash(&state)?;
        if !mind_state_hash_matches(&state, &projection.state_hash)? {
            return Err(format!(
                "Context '{context_id}' 的 Mind Projection hash 不一致：stored={}，actual={actual_hash}",
                projection.state_hash
            )
            .into());
        }
        Ok(state)
    }

    async fn recover_mind_from_latest_snapshot(
        &self,
        context_id: &str,
    ) -> Result<Option<SnapshotMindRecovery>, DynError> {
        let Some(store) = &self.mind_projection_store else {
            return Ok(None);
        };
        let Some(snapshot) = store.get_latest_mind_snapshot(context_id).await? else {
            return Ok(None);
        };
        if snapshot.context_id != context_id {
            return Err(format!(
                "Mind Snapshot '{}' 的 context_id '{}' 与请求 Context '{}' 不一致",
                snapshot.id, snapshot.context_id, context_id
            )
            .into());
        }
        let mut state: MindState =
            serde_json::from_value(snapshot.state.clone()).map_err(|error| {
                format!("Mind Snapshot '{}' 的 state 无法解析: {error}", snapshot.id)
            })?;
        if state.version != snapshot.revision {
            return Err(format!(
                "Mind Snapshot '{}' revision 不一致：state={}，snapshot={}",
                snapshot.id, state.version, snapshot.revision
            )
            .into());
        }
        let actual_snapshot_hash = mind_state_hash(&state)?;
        if !mind_state_hash_matches(&state, &snapshot.state_hash)? {
            return Err(format!(
                "Mind Snapshot '{}' hash 不一致：stored={}，actual={actual_snapshot_hash}",
                snapshot.id, snapshot.state_hash
            )
            .into());
        }

        let snapshot_head = self
            .store
            .query(QueryFilter {
                event_id: Some(snapshot.head_event_id.clone()),
                context_id: Some(context_id.to_string()),
                top_k: Some(1),
                ..Default::default()
            })
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| {
                format!(
                    "Mind Snapshot '{}' 指向的 head Event '{}' 不存在",
                    snapshot.id, snapshot.head_event_id
                )
            })?;
        let snapshot_head_sequence = snapshot_head.sequence.ok_or_else(|| {
            format!(
                "Mind Snapshot '{}' 指向的 head Event '{}' 没有持久化 Ledger sequence",
                snapshot.id, snapshot.head_event_id
            )
        })?;
        validate_snapshot_head_event(&snapshot, &snapshot_head)?;
        let transactions = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                after_sequence: Some(snapshot_head_sequence),
                topic: Some("chat/context_tx_committed".to_string()),
                ..Default::default()
            })
            .await?;
        let mut head_event_id = snapshot.head_event_id.clone();
        for event in &transactions {
            if event.event_type != TYPE_CONTEXT_TRANSACTION || event.actor != "Agent-Context" {
                return Err(format!(
                    "Snapshot 增量恢复遇到非法 Mind transaction Event '{}'",
                    event.id
                )
                .into());
            }
            let transaction = event
                .payload
                .get("transaction")
                .and_then(|value| value.as_str())
                .ok_or_else(|| format!("Context transaction '{}' 缺少 transaction", event.id))?;
            let parsed = parse_transaction(transaction).map_err(|error| {
                format!("Context transaction '{}' 无法增量重放: {error}", event.id)
            })?;
            let observations = self.transaction_observations(context_id, &parsed).await?;
            let transaction_sequence = event.sequence.ok_or_else(|| {
                format!(
                    "Context transaction '{}' 没有持久化 Ledger sequence",
                    event.id
                )
            })?;
            if let Some(future) = observations.iter().find(|observation| {
                observation
                    .sequence
                    .is_none_or(|sequence| sequence >= transaction_sequence)
            }) {
                return Err(format!(
                    "Context transaction '{}' 引用了不早于自身的 observation '{}'，拒绝违反因果顺序的 Snapshot 增量恢复",
                    event.id, future.id
                )
                .into());
            }
            let origins = observation_origins(&observations);
            state = replay_context_transaction_event(&state, event, &origins)?;
            head_event_id = event.id.clone();
        }
        Ok(Some(SnapshotMindRecovery {
            state,
            snapshot_revision: snapshot.revision,
            transactions_replayed: transactions.len(),
            head_event_id,
        }))
    }

    /// Reads the online Projection. Existing Ledgers are replayed exactly once
    /// for lazy migration, then every hot-path read uses the materialized Mind.
    async fn load_current_mind(
        &self,
        context_id: &str,
        known_events: Option<&[Event]>,
    ) -> Result<MindState, DynError> {
        let started = std::time::Instant::now();
        let result = self.load_current_mind_inner(context_id, known_events).await;
        self.capacity_metrics
            .record_projection_load(started.elapsed().as_micros() as u64);
        result
    }

    async fn load_current_mind_inner(
        &self,
        context_id: &str,
        known_events: Option<&[Event]>,
    ) -> Result<MindState, DynError> {
        let Some(store) = &self.mind_projection_store else {
            let events = match known_events {
                Some(events) => events.to_vec(),
                None => self.context_events(context_id).await?,
            };
            return Ok(load_mind_from_events(&events)?);
        };
        if let Some(projection) = store.get_mind_projection(context_id).await? {
            return Self::validate_mind_projection(context_id, projection);
        }

        if let Some(recovery) = self.recover_mind_from_latest_snapshot(context_id).await? {
            let state_hash = mind_state_hash(&recovery.state)?;
            let installed = store
                .initialize_mind_projection(NewMindProjection {
                    context_id: context_id.to_string(),
                    revision: recovery.state.version,
                    state: serde_json::to_value(&recovery.state)?,
                    state_hash,
                    head_event_id: Some(recovery.head_event_id),
                    recall_documents: all_frame_recall_documents(context_id, &recovery.state),
                })
                .await?;
            return Self::validate_mind_projection(context_id, installed);
        }

        let owned_events;
        let events = match known_events {
            Some(events) => events,
            None => {
                owned_events = self.context_events(context_id).await?;
                &owned_events
            }
        };
        let replayed = load_mind_from_events(events)?;
        let state_hash = mind_state_hash(&replayed)?;
        let head_event_id = events
            .iter()
            .rev()
            .find(|event| {
                (event.event_type == TYPE_CONTEXT_TRANSACTION
                    && event.topic == "chat/context_tx_committed"
                    && event.actor == "Agent-Context")
                    || (event.event_type == TYPE_CONTEXT_SEED
                        && event.topic == "runtime/context_seeded"
                        && event.actor == "System-ContextSeed")
            })
            .map(|event| event.id.clone());
        let installed = store
            .initialize_mind_projection(NewMindProjection {
                context_id: context_id.to_string(),
                revision: replayed.version,
                state: serde_json::to_value(&replayed)?,
                state_hash,
                head_event_id,
                recall_documents: all_frame_recall_documents(context_id, &replayed),
            })
            .await?;
        Self::validate_mind_projection(context_id, installed)
    }

    pub async fn apply_context_transaction(
        &self,
        context_id: &str,
        acting_session_id: &str,
        transaction: &str,
    ) -> Result<ContextCommit, DynError> {
        self.apply_context_transaction_authorized(
            context_id,
            acting_session_id,
            None,
            transaction,
            false,
            &BTreeSet::new(),
        )
        .await
    }

    pub async fn apply_context_transaction_protecting(
        &self,
        context_id: &str,
        acting_session_id: &str,
        transaction: &str,
        causally_protected_ids: &BTreeSet<String>,
    ) -> Result<ContextCommit, DynError> {
        self.apply_context_transaction_authorized(
            context_id,
            acting_session_id,
            None,
            transaction,
            false,
            causally_protected_ids,
        )
        .await
    }

    pub async fn apply_context_transaction_protecting_as_principal(
        &self,
        context_id: &str,
        acting_session_id: &str,
        acting_principal_id: Option<&str>,
        transaction: &str,
        causally_protected_ids: &BTreeSet<String>,
    ) -> Result<ContextCommit, DynError> {
        self.apply_context_transaction_authorized(
            context_id,
            acting_session_id,
            acting_principal_id,
            transaction,
            false,
            causally_protected_ids,
        )
        .await
    }

    async fn apply_context_transaction_authorized(
        &self,
        context_id: &str,
        acting_session_id: &str,
        acting_principal_id: Option<&str>,
        transaction: &str,
        allow_runtime_lifecycle_ops: bool,
        causally_protected_ids: &BTreeSet<String>,
    ) -> Result<ContextCommit, DynError> {
        const MAX_PROJECTION_CAS_RETRIES: usize = 64;

        self.capacity_metrics
            .context_transactions_total
            .fetch_add(1, Ordering::Relaxed);
        for attempt in 0..=MAX_PROJECTION_CAS_RETRIES {
            match self
                .apply_context_transaction_authorized_once(
                    context_id,
                    acting_session_id,
                    acting_principal_id,
                    transaction,
                    allow_runtime_lifecycle_ops,
                    causally_protected_ids,
                )
                .await
            {
                Err(error)
                    if error
                        .to_string()
                        .starts_with("Context transaction CAS 冲突")
                        && attempt < MAX_PROJECTION_CAS_RETRIES =>
                {
                    let backoff_millis = 1_u64 << attempt.min(3);
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_millis)).await;
                }
                outcome => return outcome,
            }
        }
        unreachable!("Context transaction CAS retry loop must return")
    }

    async fn apply_context_transaction_authorized_once(
        &self,
        context_id: &str,
        acting_session_id: &str,
        acting_principal_id: Option<&str>,
        transaction: &str,
        allow_runtime_lifecycle_ops: bool,
        causally_protected_ids: &BTreeSet<String>,
    ) -> Result<ContextCommit, DynError> {
        let transaction_started = std::time::Instant::now();
        let mut parsed = parse_transaction(transaction)?;
        if !allow_runtime_lifecycle_ops
            && parsed.operations.iter().any(|operation| {
                as_list(operation, "context operation")
                    .ok()
                    .and_then(|items| items.first())
                    .and_then(|item| as_atom(item, "operation").ok())
                    == Some("finalize-retirement")
            })
        {
            return Err("finalize-retirement 是 Runtime 私有生命周期操作".into());
        }
        let lock = self.context_lock(context_id);
        let _guard = lock.lock().await;

        let referenced_observations = self.transaction_observations(context_id, &parsed).await?;
        let references = ContextReferences::from_events(&referenced_observations);
        resolve_transaction_references(&mut parsed, &references)?;
        if let Some(unresolved) = transaction_reference_candidates(&parsed)?
            .into_iter()
            .find(|reference| reference.starts_with(EVENT_REFERENCE_PREFIX))
        {
            return Err(
                format!("Context transaction 仍包含未解析短引用 '{unresolved}'，拒绝提交").into(),
            );
        }
        reject_causally_protected_retirements(&parsed, causally_protected_ids)?;
        let current = self.load_current_mind(context_id, None).await?;
        let requested_base_version = parsed.base_version;
        let auto_rebased = if current.version != requested_base_version {
            self.capacity_metrics
                .context_tx_conflicts_total
                .fetch_add(1, Ordering::Relaxed);
            rebase_stale_frame_transaction(&current, &mut parsed)?;
            self.capacity_metrics
                .context_tx_auto_rebases_total
                .fetch_add(1, Ordering::Relaxed);
            true
        } else {
            false
        };
        let canonical_transaction = render_parsed_transaction(&parsed);
        let observation_ids = observation_ids(&referenced_observations);
        let cognitive_tick = match &self.cognitive_clock_store {
            Some(store) => store.get_context_cognitive_clock(context_id).await?.tick,
            None => 0,
        };
        let retirement_policy = FrameRetirementPolicy::cognitive(
            cognitive_tick,
            self.config.frame_retirement.cooling_ticks,
        );
        let observation_origins = observation_origins(&referenced_observations);
        let formation = FrameFormationContext {
            enabled: true,
            formed_principal_id: acting_principal_id,
            formed_session_id: Some(acting_session_id),
            observation_origins: Some(&observation_origins),
        };
        let (next, mut changes) = apply_parsed_transaction_with_policy_and_provenance(
            &current,
            &parsed,
            &observation_ids,
            retirement_policy,
            &formation,
        )?;
        attach_context_change_token_effects(
            &mut changes,
            &current,
            &next,
            &referenced_observations,
            &self.config,
        );
        let token_effect = context_transaction_token_effect(
            &current,
            &next,
            &referenced_observations,
            &self.config,
        );
        let session_projection = SessionProjectionMutation {
            retired_event_ids: next.retired.difference(&current.retired).cloned().collect(),
            restored_event_ids: current.retired.difference(&next.retired).cloned().collect(),
        };

        let tx_id = format!(
            "ctx_tx_{}_{}",
            context_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let attention_updates = self
            .prepare_session_attention_updates(context_id, acting_session_id, &parsed, &tx_id)
            .await?;
        let before_hash = mind_state_hash(&current)?;
        let after_hash = mind_state_hash(&next)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(acting_session_id)),
            ("principal_id".to_string(), json!(acting_principal_id)),
            ("frame_provenance_version".to_string(), json!(1)),
            ("transaction_id".to_string(), json!(tx_id)),
            ("transaction".to_string(), json!(&canonical_transaction)),
            (
                "requested_base_version".to_string(),
                json!(requested_base_version),
            ),
            ("auto_rebased".to_string(), json!(auto_rebased)),
            ("before_version".to_string(), json!(current.version)),
            ("after_version".to_string(), json!(next.version)),
            ("reason".to_string(), json!(&parsed.reason)),
            ("changes".to_string(), json!(changes)),
            ("token_effect".to_string(), json!(&token_effect)),
            ("before_hash".to_string(), json!(&before_hash)),
            ("after_hash".to_string(), json!(&after_hash)),
            (
                "frame_retirement_policy".to_string(),
                json!("cognitive-cooling-v1"),
            ),
            ("cognitive_tick".to_string(), json!(cognitive_tick)),
            (
                "frame_retirement_cooling_ticks".to_string(),
                json!(self.config.frame_retirement.cooling_ticks),
            ),
            ("text".to_string(), json!(&canonical_transaction)),
        ]
        .into_iter()
        .collect::<serde_json::Map<_, _>>();
        // Legacy stores have no durable Projection and therefore retain the
        // historical full-state receipt. Projection-backed production writes
        // use hashes plus periodic/explicit snapshots instead.
        if self.mind_projection_store.is_none() {
            payload.insert("state_after".to_string(), json!(&next));
        }

        let event = Event::new(
            tx_id.clone(),
            "Agent-Context".to_string(),
            TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            payload,
        );
        if let Some(projection_store) = &self.mind_projection_store {
            match projection_store
                .commit_mind_projection_transaction(
                    &event,
                    &attention_updates,
                    &session_projection,
                    current.version,
                    NewMindProjection {
                        context_id: context_id.to_string(),
                        revision: next.version,
                        state: serde_json::to_value(&next)?,
                        state_hash: after_hash,
                        head_event_id: Some(tx_id.clone()),
                        recall_documents: changed_frame_recall_documents(
                            context_id, &current, &next,
                        ),
                    },
                )
                .await?
            {
                MindProjectionCommit::Committed { .. } => {}
                MindProjectionCommit::Conflict { current_revision } => {
                    return Err(format!(
                        "Context transaction CAS 冲突：请求 base-version {}，当前 Projection revision {:?}；请基于最新 Context Encoding 重试",
                        current.version, current_revision
                    )
                    .into());
                }
            }
        } else if let Some(session_store) = &self.session_store {
            session_store
                .commit_context_transaction(&event, &attention_updates)
                .await?;
        } else if attention_updates.is_empty() {
            self.store.append(event).await?;
        } else {
            return Err(
                "ContextEngine 未配置 SessionStore，不能提交 Session attention 修改".into(),
            );
        }

        let commit_micros = transaction_started.elapsed().as_micros() as u64;
        self.capacity_metrics
            .context_commits_total
            .fetch_add(1, Ordering::Relaxed);
        self.capacity_metrics
            .context_commit_latency_micros_total
            .fetch_add(commit_micros, Ordering::Relaxed);
        record_atomic_max(
            &self.capacity_metrics.context_commit_latency_micros_max,
            commit_micros,
        );
        if auto_rebased {
            tracing::info!(
                context_id,
                session_id = acting_session_id,
                requested_base_version,
                effective_base_version = current.version,
                after_version = next.version,
                "Context transaction 按 Frame MVCC 自动 rebase"
            );
        }
        for change in &changes {
            match change.operation.as_str() {
                "retire-frame-requested" => tracing::info!(
                    context_id,
                    frame_id = %change.target,
                    detail = ?change.detail,
                    "Frame retirement entered its cognitive organizing window"
                ),
                "retire-frame-finalized" => tracing::info!(
                    context_id,
                    frame_id = %change.target,
                    detail = ?change.detail,
                    "Frame retirement became effective"
                ),
                "finalize-retirement-stale" => tracing::warn!(
                    context_id,
                    frame_id = %change.target,
                    detail = ?change.detail,
                    "Stale Frame retirement was fenced as a no-op"
                ),
                "revise" | "restore" | "protect"
                    if change
                        .detail
                        .as_deref()
                        .is_some_and(|detail| detail.contains("retirement-cancelled")) =>
                {
                    tracing::info!(
                        context_id,
                        frame_id = %change.target,
                        operation = %change.operation,
                        "Frame retirement intent was cancelled"
                    )
                }
                _ => {}
            }
        }
        tracing::debug!(
            context_id,
            transaction_id = %tx_id,
            before_version = current.version,
            after_version = next.version,
            estimated_before = token_effect.estimated_before,
            estimated_after = token_effect.estimated_after,
            estimated_immediate_relief = token_effect.estimated_immediate_relief,
            estimated_eventual_relief = token_effect.estimated_eventual_relief,
            commit_micros,
            "Context transaction committed with estimated Token effect"
        );

        Ok(ContextCommit {
            transaction_id: tx_id,
            before_version: current.version,
            after_version: next.version,
            reason: parsed.reason,
            token_effect,
            changes,
        })
    }

    async fn prepare_session_attention_updates(
        &self,
        context_id: &str,
        acting_session_id: &str,
        transaction: &ParsedTransaction,
        transaction_id: &str,
    ) -> Result<Vec<SessionAttentionUpdate>, DynError> {
        let attention_operations = transaction
            .operations
            .iter()
            .filter_map(|operation| as_list(operation, "context operation").ok())
            .filter(|operation| {
                operation
                    .first()
                    .and_then(|item| as_atom(item, "operation").ok())
                    .is_some_and(|name| matches!(name, "retire-session" | "restore-session"))
            })
            .collect::<Vec<_>>();
        if attention_operations.is_empty() {
            return Ok(Vec::new());
        }
        let store = self
            .session_store
            .as_ref()
            .ok_or("ContextEngine 未配置 SessionStore，不能修改 Session attention")?;
        let sessions = store.list_context_sessions(context_id, true).await?;
        let mut state = sessions
            .into_iter()
            .map(|session| (session.id.clone(), session))
            .collect::<HashMap<_, _>>();
        let active_activations = store
            .list_context_thread_activations(context_id, false)
            .await?;
        let active_objectives = match &self.objective_store {
            Some(store) => store.list_context_objectives(context_id, false).await?,
            None => Vec::new(),
        };
        let changed_at = Utc::now();
        let mut updates = Vec::new();
        for operation in attention_operations {
            let name = atom_at(operation, 0, "operation name")?;
            for item in operation.iter().skip(1) {
                let session_id = validated_id(as_atom(item, "session id")?)?;
                let session = state.get_mut(session_id).ok_or_else(|| {
                    format!(
                        "Session '{}' 不属于当前 Context '{}'",
                        session_id, context_id
                    )
                })?;
                let target = if name == "retire-session" {
                    if session_id == acting_session_id {
                        return Err(format!(
                            "当前 Session '{}' 尚未完成本轮 Reply，v1 拒绝 retire；请在后续 Session 中处理",
                            session_id
                        )
                        .into());
                    }
                    if active_activations
                        .iter()
                        .any(|item| item.session_id == session_id && !item.status.is_terminal())
                    {
                        return Err(format!(
                            "Session '{}' 存在 queued/running/waiting Evaluation，不能 retire",
                            session_id
                        )
                        .into());
                    }
                    if active_background_task_count(session_id, context_id) > 0 {
                        return Err(format!(
                            "Session '{}' 存在 running Background Task，不能 retire",
                            session_id
                        )
                        .into());
                    }
                    if active_objectives.iter().any(|objective| {
                        objective.coordinator_session_id == session_id
                            && !objective.status.is_terminal()
                    }) {
                        return Err(format!(
                            "Session '{}' 存在 active Objective，不能 retire",
                            session_id
                        )
                        .into());
                    }
                    if session.attention_state == SessionAttentionState::Retired {
                        return Err(format!("Session '{}' 已经 retired", session_id).into());
                    }
                    SessionAttentionState::Retired
                } else {
                    if session.attention_state == SessionAttentionState::Active {
                        return Err(format!("Session '{}' 已经 active", session_id).into());
                    }
                    SessionAttentionState::Active
                };
                let expected_revision = session.attention_revision;
                session.attention_revision = session.attention_revision.saturating_add(1);
                session.attention_state = target;
                session.attention_reason = transaction.reason.clone();
                updates.push(SessionAttentionUpdate {
                    session_id: session_id.to_string(),
                    context_id: context_id.to_string(),
                    expected_revision,
                    state: target,
                    reason: transaction.reason.clone(),
                    changed_at,
                    event_id: transaction_id.to_string(),
                });
            }
        }
        Ok(updates)
    }

    async fn transaction_observations(
        &self,
        context_id: &str,
        transaction: &ParsedTransaction,
    ) -> Result<Vec<Event>, DynError> {
        let mut events = Vec::new();
        for reference in transaction_reference_candidates(transaction)? {
            if events.iter().any(|event: &Event| event.id == reference) {
                continue;
            }
            if let Some(event) = self.find_event(context_id, &reference).await? {
                if is_observation(&event) {
                    events.push(event);
                }
            } else if reference.starts_with(EVENT_REFERENCE_PREFIX) {
                return Err(format!(
                    "Context 短引用 '{}' 不存在；请使用当前 Context Encoding 展示的 ref",
                    reference
                )
                .into());
            }
        }
        events.sort_by_key(|event| event.sequence);
        Ok(events)
    }

    pub async fn seed_context_from_mind(
        &self,
        source_context_id: &str,
        expected_source_version: Option<u64>,
        target_context_id: &str,
    ) -> Result<MindSeedReceipt, DynError> {
        if source_context_id == target_context_id {
            return Err("Mind Seed 的来源与目标 Context 不能相同".into());
        }
        let target_lock = self.context_lock(target_context_id);
        let _target_guard = target_lock.lock().await;
        let target_events = self.context_events(target_context_id).await?;
        if !target_events.is_empty() {
            return Err(format!(
                "目标 Context '{}' 已有 Ledger Event，不能再次 Seed",
                target_context_id
            )
            .into());
        }

        let source_events = self.context_events(source_context_id).await?;
        let source_state = self
            .load_current_mind(source_context_id, Some(&source_events))
            .await?;
        if let Some(expected) = expected_source_version {
            if source_state.version != expected {
                return Err(format!(
                    "Mind Seed 版本冲突：请求来源版本 {}，当前来源版本 {}",
                    expected, source_state.version
                )
                .into());
            }
        }
        let projected = project_mind_seed(&source_state);
        let snapshot_hash = mind_state_hash(&source_state)?;
        let projected_hash = mind_state_hash(&projected)?;
        let seed_id = format!(
            "context_seed_{}_{}",
            target_context_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let event = Event::new(
            seed_id.clone(),
            "System-ContextSeed".to_string(),
            TYPE_CONTEXT_SEED.to_string(),
            "runtime/context_seeded".to_string(),
            vec![
                ("context_id".to_string(), json!(target_context_id)),
                ("source_context_id".to_string(), json!(source_context_id)),
                ("source_version".to_string(), json!(source_state.version)),
                ("projection".to_string(), json!("mind_snapshot")),
                ("source_state".to_string(), json!(&source_state)),
                ("state_after".to_string(), json!(&projected)),
                ("snapshot_hash".to_string(), json!(&snapshot_hash)),
                ("projected_hash".to_string(), json!(&projected_hash)),
                (
                    "text".to_string(),
                    json!(format!(
                        "Context '{}' seeded from Mind snapshot '{}@{}'",
                        target_context_id, source_context_id, source_state.version
                    )),
                ),
            ]
            .into_iter()
            .collect(),
        );
        if let Some(projection_store) = &self.mind_projection_store {
            let empty = MindState::default();
            projection_store
                .initialize_mind_projection(NewMindProjection {
                    context_id: target_context_id.to_string(),
                    revision: 0,
                    state: serde_json::to_value(&empty)?,
                    state_hash: mind_state_hash(&empty)?,
                    head_event_id: None,
                    recall_documents: Vec::new(),
                })
                .await?;
            match projection_store
                .commit_mind_seed_projection(
                    &event,
                    source_context_id,
                    source_state.version,
                    &snapshot_hash,
                    "mind_snapshot",
                    NewMindProjection {
                        context_id: target_context_id.to_string(),
                        revision: 0,
                        state: serde_json::to_value(&projected)?,
                        state_hash: projected_hash.clone(),
                        head_event_id: Some(seed_id),
                        recall_documents: all_frame_recall_documents(target_context_id, &projected),
                    },
                )
                .await?
            {
                MindProjectionCommit::Committed { .. } => {}
                MindProjectionCommit::Conflict { current_revision } => {
                    return Err(format!(
                        "目标 Context '{}' 的 Mind Seed CAS 冲突，当前 revision {:?}",
                        target_context_id, current_revision
                    )
                    .into());
                }
            }
        } else {
            self.store.append(event).await?;
        }
        if self.mind_projection_store.is_none() {
            if let Some(session_store) = &self.session_store {
                session_store
                    .set_context_seed(
                        target_context_id,
                        source_context_id,
                        source_state.version,
                        &snapshot_hash,
                        "mind_snapshot",
                    )
                    .await?;
            }
        }
        Ok(MindSeedReceipt {
            source_context_id: source_context_id.to_string(),
            source_version: source_state.version,
            target_context_id: target_context_id.to_string(),
            snapshot_hash,
            projected_hash,
            inherited_frames: projected.frames.len(),
        })
    }

    pub async fn import_session_projection(
        &self,
        source_context_id: &str,
        source_session_id: &str,
        target_context_id: &str,
        target_session_id: &str,
    ) -> Result<usize, DynError> {
        let source_events = self.context_events(source_context_id).await?;
        let mut imported = 0usize;
        for (index, event) in source_events
            .iter()
            .filter(|event| event_session(event) == Some(source_session_id))
            .filter(|event| is_observation(event))
            .enumerate()
        {
            let mut payload = event.payload.clone();
            payload.insert("context_id".to_string(), json!(target_context_id));
            // The physical route belongs to the child Session. Keeping the
            // source Session here would make ordinary parent-session queries
            // return projected copies from another Context.
            payload.insert("session_id".to_string(), json!(target_session_id));
            payload.insert("source_context_id".to_string(), json!(source_context_id));
            payload.insert("source_session_id".to_string(), json!(source_session_id));
            payload.insert("source_event_id".to_string(), json!(&event.id));
            payload.insert("source_topic".to_string(), json!(&event.topic));
            payload.insert("projection".to_string(), json!("selected_session"));
            let source_sequence = event.sequence.unwrap_or(index as u64);
            self.store
                .append(Event::new(
                    format!(
                        "context_projection_{}_{}_{}",
                        target_context_id, source_sequence, index
                    ),
                    "System-ContextProjection".to_string(),
                    event.event_type.clone(),
                    "context/projected_observation".to_string(),
                    payload,
                ))
                .await?;
            imported += 1;
        }
        Ok(imported)
    }

    pub async fn build_view(&self, session_id: &str) -> Result<ContextView, DynError> {
        let context_id = self.context_id_for_session(session_id).await?;
        self.build_context_encoding(&context_id, session_id, &HashSet::new())
            .await
    }

    /// Compile the current Context while omitting observations that are being
    /// delivered through the standard turn-local `role=tool` channel.
    ///
    /// The observations remain persisted in the Ledger and active in Mind
    /// lifecycle state. A later independent Context snapshot will include them
    /// unless the Agent explicitly retires them.
    pub async fn build_view_excluding(
        &self,
        session_id: &str,
        excluded_observation_ids: &HashSet<String>,
    ) -> Result<ContextView, DynError> {
        let context_id = self.context_id_for_session(session_id).await?;
        self.build_context_encoding(&context_id, session_id, excluded_observation_ids)
            .await
    }

    pub async fn build_context_encoding(
        &self,
        context_id: &str,
        active_session_id: &str,
        excluded_observation_ids: &HashSet<String>,
    ) -> Result<ContextView, DynError> {
        self.build_context_encoding_for_session(
            context_id,
            active_session_id,
            excluded_observation_ids,
            None,
            true,
        )
        .await
    }

    /// Build the structured Context projection used by operator surfaces
    /// without rendering a second, potentially multi-megabyte S-expression.
    /// The model-facing encoding remains available through
    /// [`Self::build_context_encoding`] and is loaded explicitly by diagnostic
    /// clients when needed.
    pub async fn build_context_projection(
        &self,
        context_id: &str,
        active_session_id: &str,
        excluded_observation_ids: &HashSet<String>,
    ) -> Result<ContextView, DynError> {
        self.build_context_encoding_for_session(
            context_id,
            active_session_id,
            excluded_observation_ids,
            None,
            false,
        )
        .await
    }

    pub async fn build_context_encoding_for_activation(
        &self,
        context_id: &str,
        activation: &ThreadActivationRecord,
        excluded_observation_ids: &HashSet<String>,
    ) -> Result<ContextView, DynError> {
        self.build_context_encoding_for_session(
            context_id,
            &activation.session_id,
            excluded_observation_ids,
            Some(activation),
            true,
        )
        .await
    }

    async fn build_context_encoding_for_session(
        &self,
        context_id: &str,
        active_session_id: &str,
        excluded_observation_ids: &HashSet<String>,
        activation_record: Option<&ThreadActivationRecord>,
        include_encoding: bool,
    ) -> Result<ContextView, DynError> {
        self.finalize_due_frame_retirements(context_id, active_session_id)
            .await?;
        let state = self.load_current_mind(context_id, None).await?;
        let cognitive_clock = match &self.cognitive_clock_store {
            Some(store) => store.get_context_cognitive_clock(context_id).await?,
            None => ContextCognitiveClock {
                context_id: context_id.to_string(),
                tick: 0,
                last_signal_batch_id: None,
                revision: 0,
            },
        };
        let legacy_events = if self.session_store.is_none() {
            Some(self.context_events(context_id).await?)
        } else {
            None
        };
        let registry_sessions = match &self.session_store {
            Some(store) => store.list_context_sessions(context_id, true).await?,
            None => {
                self.context_sessions(context_id, legacy_events.as_deref().unwrap_or_default())
                    .await?
            }
        };
        let objectives = match &self.objective_store {
            Some(store) => store.list_context_objectives(context_id, false).await?,
            None => Vec::new(),
        };
        let active_activations = match &self.session_store {
            Some(store) => {
                store
                    .list_context_thread_activations(context_id, false)
                    .await?
            }
            None => Vec::new(),
        };
        let current_session_ids = [active_session_id.to_string()];
        let (mut sessions, mut session_working_set) = select_session_working_set(
            &registry_sessions,
            &current_session_ids,
            Utc::now(),
            &self.config.session_working_set,
            &objectives,
            &active_activations,
        );
        let principal_bindings = match &self.session_store {
            Some(store) => store.list_context_principal_bindings(context_id).await?,
            None => Vec::new(),
        };
        let mut principals_by_session = HashMap::<String, Vec<String>>::new();
        for binding in principal_bindings {
            principals_by_session
                .entry(binding.session_id)
                .or_default()
                .push(binding.principal_id);
        }
        for principal_ids in principals_by_session.values_mut() {
            principal_ids.sort();
            principal_ids.dedup();
        }
        for projected in &mut sessions {
            projected.principal_ids = principals_by_session
                .get(&projected.session.id)
                .cloned()
                .unwrap_or_default();
        }
        let full_session_ids = sessions
            .iter()
            .filter(|entry| entry.projection == SessionProjection::Full)
            .map(|entry| entry.session.id.clone())
            .collect::<Vec<_>>();
        let events = match legacy_events {
            Some(events) => events,
            None => {
                self.context_encoding_events(context_id, &full_session_ids)
                    .await?
            }
        };
        let delivery_snapshot_ids = activation_record
            .filter(|activation| activation.trigger_kind == "chat/thread_completion_ready")
            .and_then(|activation| {
                events
                    .iter()
                    .find(|event| event.id == activation.trigger_event_id)
            })
            .and_then(|event| event.payload.get("completed_thread_ids"))
            .and_then(serde_json::Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<HashSet<_>>()
            });
        let references = ContextReferences::from_events(&events);
        let metadata = observation_metadata(&events, &state);
        let (threads, schedules, thread_signals) = match &self.session_store {
            Some(store) => {
                let all_threads = store.list_context_threads(context_id, true).await?;
                let context_thread_ids = all_threads
                    .iter()
                    .map(|thread| thread.id.as_str())
                    .collect::<HashSet<_>>();
                let scheduled = store
                    .list_schedules(None, Some(ScheduleStatus::Queued))
                    .await?
                    .into_iter()
                    .filter(|intent| context_thread_ids.contains(intent.thread_id.as_str()))
                    .collect::<Vec<_>>();
                let mut projected = all_threads
                    .iter()
                    .filter(|thread| {
                        if matches!(
                            thread.delivery_status,
                            DeliveryStatus::Pending | DeliveryStatus::Deferred
                        ) {
                            delivery_snapshot_ids
                                .as_ref()
                                .is_none_or(|ids| ids.contains(&thread.id))
                        } else {
                            !thread.lifecycle.is_terminal()
                        }
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let mut recent_terminal = all_threads
                    .into_iter()
                    .filter(|thread| {
                        thread.lifecycle.is_terminal()
                            && !matches!(
                                thread.delivery_status,
                                DeliveryStatus::Pending | DeliveryStatus::Deferred
                            )
                    })
                    .rev()
                    .take(20)
                    .collect::<Vec<_>>();
                recent_terminal.reverse();
                projected.extend(recent_terminal);
                let pending_signals = store
                    .list_context_thread_signals(context_id, Some(ThreadSignalStatus::Pending))
                    .await?;
                (projected, scheduled, pending_signals)
            }
            None => (Vec::new(), Vec::new(), Vec::new()),
        };
        let activation_signals = match (&self.session_store, activation_record) {
            (Some(store), Some(activation)) => {
                store.list_activation_signals(&activation.id).await?
            }
            _ => Vec::new(),
        };
        let activation = activation_record
            .map(|activation| activation_focus(activation, &activation_signals, &events));
        let concurrent_activations = active_activations
            .iter()
            .filter(|item| !item.status.is_terminal())
            .filter(|item| activation_record.is_none_or(|current| current.id != item.id))
            .map(|item| concurrent_activation_view(item, &events))
            .collect::<Vec<_>>();
        let now = Utc::now();
        let background_tasks = get_tasks_map()
            .iter()
            .filter(|task| task.context_id == context_id && !task.status.is_terminal())
            .map(|task| {
                let (command_preview, _) = preview_text(&task.cmd_str, 320);
                BackgroundTaskView {
                    task_id: task.id.clone(),
                    session_id: task.session_id.clone(),
                    root_turn_id: task
                        .causal_route
                        .as_ref()
                        .map(|route| route.root_turn_id.clone()),
                    status: task.status.as_str().to_string(),
                    command_preview,
                    elapsed_secs: (now - task.started_at).num_seconds().max(0),
                    last_output_age_secs: (now - task.last_output_at).num_seconds().max(0),
                    next_wakeup_at: task.next_wakeup_at.map(|time| time.to_rfc3339()),
                }
            })
            .collect::<Vec<_>>();
        let thread_phases = threads
            .iter()
            .map(|thread| {
                (
                    thread.id.clone(),
                    derive_thread_phase(
                        thread,
                        &active_activations,
                        &thread_signals,
                        &schedules,
                        &background_tasks,
                    ),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let parent_session_id = registry_sessions
            .iter()
            .find(|session| session.id == active_session_id)
            .and_then(|session| session.parent_session_id.clone())
            .or_else(|| {
                events.iter().find_map(|event| {
                    (event_session(event) == Some(active_session_id))
                        .then(|| {
                            event
                                .payload
                                .get("parent_session_id")
                                .and_then(|value| value.as_str())
                                .filter(|parent| *parent != active_session_id)
                                .map(ToOwned::to_owned)
                        })
                        .flatten()
                })
            });

        let active_frames = state
            .frames
            .iter()
            .filter(|frame| !state.retired.contains(&frame.id))
            .collect::<Vec<_>>();
        let causal_frontiers = activation_record
            .into_iter()
            .map(|activation| {
                let root_sequence = events
                    .iter()
                    .find(|event| event.id == activation.root_turn_id)
                    .and_then(|event| event.sequence)
                    .unwrap_or(activation.trigger_sequence);
                (activation.session_id.as_str(), (activation, root_sequence))
            })
            .collect::<HashMap<_, _>>();
        let ready_set = current_session_ids.iter().cloned().collect::<HashSet<_>>();
        let (observations, estimated_tokens) = loop {
            let full_set = sessions
                .iter()
                .filter(|entry| entry.projection == SessionProjection::Full)
                .map(|entry| entry.session.id.as_str())
                .collect::<HashSet<_>>();
            let candidate_observations = events
                .iter()
                .filter(|event| is_observation(event))
                .filter(|event| !state.retired.contains(&event.id))
                .filter(|event| !excluded_observation_ids.contains(&event.id))
                .filter(|event| match event_session(event) {
                    Some(session_id) => full_set.contains(session_id),
                    None => context_wide_observation_allowed(event),
                })
                // An Activation evaluates a causal snapshot of its active Session. A newer
                // user turn may run concurrently, but must not appear retroactively in an
                // older turn's Inbox. Events from the same causal root remain visible even
                // when they are appended after the root event; other Sessions continue to
                // follow the configured shared Working Set policy.
                .filter(|event| {
                    let Some(session_id) = event_session(event) else {
                        return true;
                    };
                    let Some((activation, root_sequence)) = causal_frontiers.get(session_id) else {
                        return true;
                    };
                    event_visible_at_causal_frontier(event, activation, *root_sequence)
                })
                .map(|event| {
                    self.to_observation(
                        event,
                        &state,
                        metadata.get(&event.id).cloned().unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>();
            let candidate_tokens = active_frames
                .iter()
                .map(|frame| estimate_text_tokens(&frame.body) + 32)
                .sum::<usize>()
                + candidate_observations
                    .iter()
                    .map(|observation| estimate_text_tokens(&observation.preview) + 128)
                    .sum::<usize>()
                + 1_000;
            let work_budget = self
                .config
                .context_hard_token_limit
                .saturating_sub(self.config.context_maintenance_reserve_tokens)
                .max(1);
            if candidate_tokens <= work_budget {
                break (candidate_observations, candidate_tokens);
            }
            let Some(index) = sessions.iter().rposition(|entry| {
                entry.projection == SessionProjection::Full
                    && !ready_set.contains(&entry.session.id)
            }) else {
                break (candidate_observations, candidate_tokens);
            };
            let session_id = sessions[index].session.id.clone();
            sessions[index].projection = SessionProjection::MetadataOnly;
            session_working_set
                .full_session_ids
                .retain(|candidate| candidate != &session_id);
            if !session_working_set
                .metadata_only_session_ids
                .contains(&session_id)
            {
                session_working_set
                    .metadata_only_session_ids
                    .push(session_id);
            }
            session_working_set.excluded.token_budget += 1;
        };
        let pressure = pressure_for(
            estimated_tokens,
            active_frames.len(),
            observations.len(),
            &self.config,
        );
        let session_events = events
            .iter()
            .filter(|event| event_session(event) == Some(active_session_id))
            .cloned()
            .collect::<Vec<_>>();
        let causal_events = activation_record.map(|activation| {
            session_events
                .iter()
                .filter(|event| {
                    event.id == activation.root_turn_id
                        || event.id == activation.trigger_event_id
                        || event
                            .payload
                            .get("root_turn_id")
                            .and_then(|value| value.as_str())
                            == Some(activation.root_turn_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>()
        });
        let wake = activation_record
            .and_then(|activation| {
                session_events
                    .iter()
                    .find(|event| event.id == activation.trigger_event_id)
            })
            .map(wake_for_event)
            .unwrap_or_else(|| wake_for(&session_events));
        let turn_budget = turn_budget_for(
            causal_events.as_deref().unwrap_or(&session_events),
            &self.config,
        );
        let active_principal_id = match activation_record {
            Some(activation) => activation
                .initiating_principal_id
                .as_deref()
                .or_else(|| {
                    events
                        .iter()
                        .find(|event| event.id == activation.trigger_event_id)
                        .and_then(event_principal)
                })
                .or_else(|| {
                    events
                        .iter()
                        .find(|event| event.id == activation.root_turn_id)
                        .and_then(event_principal)
                })
                .map(ToOwned::to_owned),
            None => events
                .iter()
                .rev()
                .find(|event| {
                    event.event_type == TYPE_USER_MESSAGE
                        && event_session(event) == Some(active_session_id)
                })
                .and_then(event_principal)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    principals_by_session
                        .get(active_session_id)
                        .filter(|principals| principals.len() == 1)
                        .and_then(|principals| principals.first().cloned())
                }),
        };
        let mut execution_targets = match &self.execution_target_store {
            Some(store) => store
                .list_execution_targets(ExecutionTargetFilter {
                    limit: Some(16),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .filter(|target| {
                    target.owner_principal_id.is_none()
                        || target.owner_principal_id.as_deref() == active_principal_id.as_deref()
                })
                .collect::<Vec<_>>(),
            None => Vec::new(),
        };
        let target_authorizations = match (
            &self.execution_target_authorization_store,
            active_principal_id.as_deref(),
        ) {
            (Some(store), Some(principal_id)) => {
                store
                    .list_execution_target_authorizations(ExecutionTargetAuthorizationFilter {
                        owner_principal_id: Some(principal_id.to_string()),
                        limit: Some(1_000),
                        ..Default::default()
                    })
                    .await?
            }
            _ => Vec::new(),
        };
        let current_thread_id = activation_signals
            .first()
            .map(|signal| signal.thread_id.as_str())
            .or_else(|| {
                activation_record.and_then(|activation| {
                    threads
                        .iter()
                        .find(|thread| {
                            thread.root_turn_id == activation.root_turn_id
                                && thread.session_id == activation.session_id
                        })
                        .map(|thread| thread.id.as_str())
                })
            });
        let current_agent_id = activation_record.map(|activation| activation.agent_id.as_str());
        let mut execution_target_access = execution_targets
            .iter()
            .map(|target| {
                execution_target_access_view(
                    target,
                    &target_authorizations,
                    current_agent_id,
                    context_id,
                    current_thread_id,
                )
            })
            .collect::<Vec<_>>();
        if activation_record.is_some() {
            let allowed = execution_target_access
                .iter()
                .filter(|access| access.authorization_mode != "scoped_denied")
                .map(|access| access.target_id.clone())
                .collect::<HashSet<_>>();
            execution_targets.retain(|target| allowed.contains(target.id.as_str()));
            execution_target_access.retain(|access| access.authorization_mode != "scoped_denied");
        }
        let sexpr = if include_encoding {
            {
                render_context(ContextRenderInput {
                    context_id,
                    active_session_id,
                    active_principal_id: active_principal_id.as_deref(),
                    parent_session_id: parent_session_id.as_deref(),
                    sessions: &sessions,
                    session_working_set: &session_working_set,
                    active_activations: &active_activations,
                    threads: &threads,
                    thread_signals: &thread_signals,
                    schedules: &schedules,
                    activation: activation.as_ref(),
                    concurrent_activations: &concurrent_activations,
                    background_tasks: &background_tasks,
                    objectives: &objectives,
                    execution_targets: &execution_targets,
                    execution_target_access: &execution_target_access,
                    cognitive_clock: &cognitive_clock,
                    frame_retirement_cooling_ticks: self.config.frame_retirement.cooling_ticks,
                    state: &state,
                    observations: &observations,
                    pressure: &pressure,
                    turn_budget: &turn_budget,
                    wake: &wake,
                    references: &references,
                })
            }
        } else {
            Default::default()
        };

        Ok(ContextView {
            context_id: context_id.to_string(),
            active_session_id: active_session_id.to_string(),
            active_principal_id,
            parent_session_id,
            sessions,
            session_working_set,
            active_activations,
            threads,
            thread_signals,
            thread_phases,
            schedules,
            activation,
            concurrent_activations,
            background_tasks,
            objectives,
            execution_targets,
            execution_target_access,
            cognitive_clock,
            state,
            observations,
            pressure,
            attribution: ContextAttribution::default(),
            turn_budget,
            wake,
            sexpr,
            references,
        })
    }

    async fn finalize_due_frame_retirements(
        &self,
        context_id: &str,
        acting_session_id: &str,
    ) -> Result<(), DynError> {
        let Some(clock_store) = &self.cognitive_clock_store else {
            return Ok(());
        };
        for _ in 0..3 {
            let clock = clock_store.get_context_cognitive_clock(context_id).await?;
            let state = self.load_current_mind(context_id, None).await?;
            let due = state
                .retiring
                .values()
                .filter(|retirement| retirement.eligible_at_tick <= clock.tick)
                .cloned()
                .collect::<Vec<_>>();
            if due.is_empty() {
                return Ok(());
            }
            let mut items = vec![
                atom("context-tx"),
                list("base-version", vec![atom(state.version.to_string())]),
                list(
                    "reason",
                    vec![atom("认知活动整理窗口到期，Runtime 执行 fencing 后收口")],
                ),
            ];
            items.extend(due.iter().map(|retirement| {
                list(
                    "finalize-retirement",
                    vec![
                        atom(&retirement.frame_id),
                        atom(retirement.generation.to_string()),
                        atom(retirement.requested_frame_revision.to_string()),
                        atom(retirement.eligible_at_tick.to_string()),
                    ],
                )
            }));
            let transaction = SExpr::List(items).to_string();
            match self
                .apply_context_transaction_authorized(
                    context_id,
                    acting_session_id,
                    None,
                    &transaction,
                    true,
                    &BTreeSet::new(),
                )
                .await
            {
                Ok(commit) => {
                    tracing::info!(
                        context_id,
                        cognitive_tick = clock.tick,
                        transaction_id = %commit.transaction_id,
                        finalized = due.len(),
                        "Frame retirement cognitive window became effective"
                    );
                    return Ok(());
                }
                Err(error) if error.to_string().contains("版本冲突") => continue,
                Err(error) => return Err(error),
            }
        }
        Err(format!(
            "Context '{}' Frame retirement 收口连续发生版本冲突",
            context_id
        )
        .into())
    }

    /// 用模型客户端对“完整 Prompt”的计量结果替换 Context 局部字符估算，并重新
    /// 编码 Context，使 Agent 在本轮就能看到真实压力等级。
    pub async fn apply_prompt_token_count(
        &self,
        view: &mut ContextView,
        count: &crate::llm::PromptTokenCount,
    ) -> Result<(), DynError> {
        let active_frames = view
            .state
            .frames
            .iter()
            .filter(|frame| !view.state.retired.contains(&frame.id))
            .count();
        let mut pressure = pressure_for(
            count.tokens,
            active_frames,
            view.observations.len(),
            &self.config,
        );
        pressure.token_source = count.source.clone();
        pressure.token_accuracy = count.accuracy.as_str().to_string();
        pressure.token_scope = "full-work-prompt".to_string();
        pressure.token_model = Some(count.model.clone());
        view.pressure = pressure;
        if view.sexpr.is_empty() {
            return Ok(());
        }
        view.sexpr = render_context(ContextRenderInput {
            context_id: &view.context_id,
            active_session_id: &view.active_session_id,
            active_principal_id: view.active_principal_id.as_deref(),
            parent_session_id: view.parent_session_id.as_deref(),
            sessions: &view.sessions,
            session_working_set: &view.session_working_set,
            active_activations: &view.active_activations,
            threads: &view.threads,
            thread_signals: &view.thread_signals,
            schedules: &view.schedules,
            activation: view.activation.as_ref(),
            concurrent_activations: &view.concurrent_activations,
            background_tasks: &view.background_tasks,
            objectives: &view.objectives,
            execution_targets: &view.execution_targets,
            execution_target_access: &view.execution_target_access,
            cognitive_clock: &view.cognitive_clock,
            frame_retirement_cooling_ticks: self.config.frame_retirement.cooling_ticks,
            state: &view.state,
            observations: &view.observations,
            pressure: &view.pressure,
            turn_budget: &view.turn_budget,
            wake: &view.wake,
            references: &view.references,
        });
        Ok(())
    }

    /// Replace an over-limit Inbox with a bounded semantic-maintenance slice.
    ///
    /// This is a projection only: omitted observations remain active in the
    /// immutable Ledger and in Session Projection. The current causal root is
    /// always retained, while the remaining capacity is filled with the
    /// oldest unprotected observations so the model can summarize/retire them
    /// in deterministic batches. Runtime never decides their semantic value.
    pub fn apply_critical_maintenance_projection(
        &self,
        view: &mut ContextView,
        max_observations: usize,
        max_preview_chars: usize,
    ) -> (usize, usize) {
        let total = view.observations.len();
        let mut required_ids = HashSet::new();
        if let Some(activation) = &view.activation {
            required_ids.insert(activation.root_turn_id.as_str());
            required_ids.insert(activation.trigger_event_id.as_str());
            required_ids.extend(
                activation
                    .signal_batch
                    .iter()
                    .map(|signal| signal.event_id.as_str()),
            );
        }

        let limit = max_observations.max(required_ids.len()).max(1);
        let mut selected_ids = view
            .observations
            .iter()
            .filter(|observation| required_ids.contains(observation.id.as_str()))
            .map(|observation| observation.id.clone())
            .collect::<HashSet<_>>();
        let mut candidates = view
            .observations
            .iter()
            .filter(|observation| {
                !observation.protected && !selected_ids.contains(observation.id.as_str())
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|observation| observation.sequence);
        for observation in candidates {
            if selected_ids.len() >= limit {
                break;
            }
            selected_ids.insert(observation.id.clone());
        }

        let preview_limit = max_preview_chars.max(128);
        let mut projected = view
            .observations
            .iter()
            .filter(|observation| selected_ids.contains(observation.id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        projected.sort_by_key(|observation| observation.sequence);
        for observation in &mut projected {
            let (preview, truncated) =
                bounded_maintenance_preview(&observation.preview, preview_limit);
            if truncated {
                observation.preview = preview;
                observation.truncated = true;
                observation.representation = "preview".to_string();
                observation.visible_chars = observation.preview.chars().count();
                observation.retrievable = true;
            }
        }
        let visible = projected.len();
        view.observations = projected;
        view.sexpr = render_context(ContextRenderInput {
            context_id: &view.context_id,
            active_session_id: &view.active_session_id,
            active_principal_id: view.active_principal_id.as_deref(),
            parent_session_id: view.parent_session_id.as_deref(),
            sessions: &view.sessions,
            session_working_set: &view.session_working_set,
            active_activations: &view.active_activations,
            threads: &view.threads,
            thread_signals: &view.thread_signals,
            schedules: &view.schedules,
            activation: view.activation.as_ref(),
            concurrent_activations: &view.concurrent_activations,
            background_tasks: &view.background_tasks,
            objectives: &view.objectives,
            execution_targets: &view.execution_targets,
            execution_target_access: &view.execution_target_access,
            cognitive_clock: &view.cognitive_clock,
            frame_retirement_cooling_ticks: self.config.frame_retirement.cooling_ticks,
            state: &view.state,
            observations: &view.observations,
            pressure: &view.pressure,
            turn_budget: &view.turn_budget,
            wake: &view.wake,
            references: &view.references,
        });
        (total, visible)
    }

    pub async fn find_event(
        &self,
        context_id: &str,
        event_id: &str,
    ) -> Result<Option<Event>, DynError> {
        let by_reference = event_id.strip_prefix(EVENT_REFERENCE_PREFIX);
        let filter = match by_reference {
            Some(sequence) => QueryFilter {
                context_id: Some(context_id.to_string()),
                sequence: Some(sequence.parse::<u64>().map_err(|_| {
                    format!("Context 短引用 '{event_id}' 不是有效的 Ledger sequence")
                })?),
                top_k: Some(1),
                ..Default::default()
            },
            None => QueryFilter {
                event_id: Some(event_id.to_string()),
                context_id: Some(context_id.to_string()),
                top_k: Some(1),
                ..Default::default()
            },
        };
        let event = self.store.query(filter).await?.into_iter().next();
        if by_reference.is_some() && event.as_ref().is_some_and(|event| !is_observation(event)) {
            return Err(format!(
                "Context 短引用 '{event_id}' 不指向可见 observation；不能猜测控制面事件"
            )
            .into());
        }
        Ok(event)
    }

    pub fn event_reference(&self, event: &Event) -> String {
        event
            .sequence
            .map(|sequence| format!("{EVENT_REFERENCE_PREFIX}{sequence}"))
            .unwrap_or_else(|| event.id.clone())
    }

    pub async fn find_frame(
        &self,
        context_id: &str,
        frame_id: &str,
    ) -> Result<Option<ContextFrame>, DynError> {
        Ok(self
            .load_current_mind(context_id, None)
            .await?
            .frames
            .into_iter()
            .find(|frame| frame.id == frame_id))
    }

    pub async fn recall_frame_graph(
        &self,
        mut request: FrameRecallRequest,
    ) -> Result<FrameRecallPage, DynError> {
        let started = std::time::Instant::now();
        request.depth = request.depth.min(4);
        request.max_nodes = request.max_nodes.clamp(1, 128);
        let state = self.load_current_mind(&request.context_id, None).await?;
        let offset = if let Some(cursor) = &request.cursor {
            let cursor = self.decode_frame_recall_cursor(cursor)?;
            if cursor.context_id != request.context_id
                || cursor.frame_id != request.frame_id
                || cursor.depth != request.depth
                || cursor.direction != request.direction
                || cursor.include_bodies != request.include_bodies
                || cursor.include_events != request.include_events
                || cursor.max_nodes != request.max_nodes
            {
                return Err("Recall cursor 与当前查询参数不匹配".into());
            }
            if cursor.mind_version != state.version {
                return Err("Recall cursor 对应的 Mind revision 已变化；请从第一页重新召回".into());
            }
            cursor.offset
        } else {
            0
        };

        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        enum NodeKey {
            Frame(String),
            Event(String),
        }

        let frames = state
            .frames
            .iter()
            .map(|frame| (frame.id.as_str(), frame))
            .collect::<HashMap<_, _>>();
        if !frames.contains_key(request.frame_id.as_str()) {
            return Err(format!("frame '{}' 不存在", request.frame_id).into());
        }
        let mut queue = VecDeque::from([(NodeKey::Frame(request.frame_id.clone()), 0_usize)]);
        let mut visited = HashSet::new();
        let mut ordered = Vec::new();
        let mut edges = BTreeSet::new();
        while let Some((node, node_depth)) = queue.pop_front() {
            if node_depth > request.depth || !visited.insert(node.clone()) {
                continue;
            }
            ordered.push((node.clone(), node_depth));
            let NodeKey::Frame(frame_id) = node else {
                continue;
            };
            let Some(frame) = frames.get(frame_id.as_str()) else {
                continue;
            };
            let mut neighbors = BTreeSet::new();
            if matches!(
                request.direction,
                FrameRecallDirection::Ancestors | FrameRecallDirection::Both
            ) {
                for source in &frame.sources {
                    let key = if frames.contains_key(source.as_str()) {
                        NodeKey::Frame(source.clone())
                    } else {
                        NodeKey::Event(source.clone())
                    };
                    neighbors.insert(key);
                    edges.insert(FrameRecallEdge {
                        subject: frame_id.clone(),
                        relation: "source".to_string(),
                        object: source.clone(),
                    });
                }
                for relation in state
                    .relations
                    .iter()
                    .filter(|relation| relation.subject == frame_id)
                {
                    if frames.contains_key(relation.object.as_str()) {
                        neighbors.insert(NodeKey::Frame(relation.object.clone()));
                        edges.insert(FrameRecallEdge {
                            subject: relation.subject.clone(),
                            relation: relation.relation.clone(),
                            object: relation.object.clone(),
                        });
                    }
                }
            }
            if matches!(
                request.direction,
                FrameRecallDirection::Descendants | FrameRecallDirection::Both
            ) {
                for descendant in state
                    .frames
                    .iter()
                    .filter(|candidate| candidate.sources.iter().any(|source| source == &frame_id))
                {
                    neighbors.insert(NodeKey::Frame(descendant.id.clone()));
                    edges.insert(FrameRecallEdge {
                        subject: descendant.id.clone(),
                        relation: "source".to_string(),
                        object: frame_id.clone(),
                    });
                }
                for relation in state
                    .relations
                    .iter()
                    .filter(|relation| relation.object == frame_id)
                {
                    if frames.contains_key(relation.subject.as_str()) {
                        neighbors.insert(NodeKey::Frame(relation.subject.clone()));
                        edges.insert(FrameRecallEdge {
                            subject: relation.subject.clone(),
                            relation: relation.relation.clone(),
                            object: relation.object.clone(),
                        });
                    }
                }
            }
            if node_depth < request.depth {
                queue.extend(
                    neighbors
                        .into_iter()
                        .map(|neighbor| (neighbor, node_depth.saturating_add(1))),
                );
            }
        }

        if offset > ordered.len() {
            return Err("Recall cursor offset 超出稳定遍历结果".into());
        }
        let hard_end = offset.saturating_add(request.max_nodes).min(ordered.len());
        let mut nodes = Vec::with_capacity(hard_end.saturating_sub(offset));
        let mut rendered_chars = 0_usize;
        let mut end = offset;
        for (key, depth) in &ordered[offset..hard_end] {
            let node = match key {
                NodeKey::Frame(id) => {
                    let frame = frames
                        .get(id.as_str())
                        .ok_or_else(|| format!("遍历中的 frame '{id}' 已不存在"))?;
                    FrameRecallNode::Frame {
                        id: id.clone(),
                        revision: frame.revision,
                        lifecycle: if state.retired.contains(id) {
                            "retired".to_string()
                        } else if state.retiring.contains_key(id) {
                            "retiring".to_string()
                        } else {
                            "active".to_string()
                        },
                        depth: *depth,
                        sources: frame.sources.clone(),
                        provenance: frame.provenance.clone(),
                        body: request.include_bodies.then(|| frame.body.clone()),
                    }
                }
                NodeKey::Event(id) => {
                    let event = self
                        .find_event(&request.context_id, id)
                        .await?
                        .ok_or_else(|| format!("frame source event '{id}' 不存在或越权"))?;
                    let body = event_text(&event);
                    FrameRecallNode::Event {
                        id: id.clone(),
                        reference: self.event_reference(&event),
                        depth: *depth,
                        preview: body.chars().take(500).collect(),
                        body: request.include_events.then_some(body),
                    }
                }
            };
            let node_chars = serde_json::to_string(&node)?.chars().count();
            if !nodes.is_empty()
                && rendered_chars.saturating_add(node_chars) > FRAME_RECALL_PAGE_CHAR_BUDGET
            {
                break;
            }
            rendered_chars = rendered_chars.saturating_add(node_chars);
            nodes.push(node);
            end = end.saturating_add(1);
        }
        let selected_ids = nodes
            .iter()
            .map(|node| match node {
                FrameRecallNode::Frame { id, .. } | FrameRecallNode::Event { id, .. } => id.clone(),
            })
            .collect::<HashSet<_>>();
        let edges = edges
            .into_iter()
            .filter(|edge| {
                selected_ids.contains(&edge.subject) || selected_ids.contains(&edge.object)
            })
            .collect();
        let truncated = end < ordered.len();
        let next_cursor = if truncated {
            Some(self.encode_frame_recall_cursor(&FrameRecallCursor {
                context_id: request.context_id.clone(),
                frame_id: request.frame_id.clone(),
                mind_version: state.version,
                depth: request.depth,
                direction: request.direction,
                include_bodies: request.include_bodies,
                include_events: request.include_events,
                max_nodes: request.max_nodes,
                offset: end,
            })?)
        } else {
            None
        };
        let page = FrameRecallPage {
            root_frame_id: request.frame_id,
            mind_version: state.version,
            nodes,
            edges,
            truncated,
            next_cursor,
        };
        tracing::debug!(
            context_id = request.context_id,
            root_frame_id = page.root_frame_id,
            depth = request.depth,
            direction = ?request.direction,
            visited_nodes = visited.len(),
            returned_nodes = page.nodes.len(),
            returned_edges = page.edges.len(),
            truncated = page.truncated,
            latency_micros = started.elapsed().as_micros() as u64,
            "Frame Recall traversal completed"
        );
        Ok(page)
    }

    fn encode_frame_recall_cursor(&self, cursor: &FrameRecallCursor) -> Result<String, DynError> {
        let payload = serde_json::to_vec(cursor)?;
        let mut signed = Vec::with_capacity(self.recall_cursor_secret.len() + payload.len());
        signed.extend_from_slice(&self.recall_cursor_secret);
        signed.extend_from_slice(&payload);
        let signature = Sha256::digest(&signed);
        Ok(format!(
            "{}.{}",
            hex_encode(&payload),
            hex_encode(&signature)
        ))
    }

    fn decode_frame_recall_cursor(&self, cursor: &str) -> Result<FrameRecallCursor, DynError> {
        let (payload, signature) = cursor.split_once('.').ok_or("Recall cursor 格式无效")?;
        let payload = hex_decode(payload)?;
        let signature = hex_decode(signature)?;
        let mut signed = Vec::with_capacity(self.recall_cursor_secret.len() + payload.len());
        signed.extend_from_slice(&self.recall_cursor_secret);
        signed.extend_from_slice(&payload);
        if signature.as_slice() != Sha256::digest(&signed).as_slice() {
            return Err("Recall cursor 签名无效".into());
        }
        Ok(serde_json::from_slice(&payload)?)
    }

    pub async fn mind_version(&self, context_id: &str) -> Result<u64, DynError> {
        Ok(self.load_current_mind(context_id, None).await?.version)
    }

    /// Explicit integrity audit: replay the immutable Ledger and compare it
    /// with the online Projection. This never runs on the Context hot path.
    pub async fn audit_mind_projection(
        &self,
        context_id: &str,
    ) -> Result<MindProjectionAudit, DynError> {
        let projection_store = self
            .mind_projection_store
            .as_ref()
            .ok_or("ContextEngine 未配置 MindProjectionStore，不能执行 Projection 审计")?;
        let events = self.context_events(context_id).await?;
        // An old database may not have a materialized row yet. Audit is also
        // a safe explicit migration boundary, but never repairs a corrupt row.
        let _ = self.load_current_mind(context_id, Some(&events)).await?;
        let full_replay_started = std::time::Instant::now();
        let ledger = load_mind_from_events(&events)?;
        let full_replay_micros = full_replay_started.elapsed().as_micros() as u64;
        let ledger_hash = mind_state_hash(&ledger)?;
        let projection_validation_started = std::time::Instant::now();
        let projection = projection_store.get_mind_projection(context_id).await?;
        let (projection_revision, projection_hash, valid_projection) = match projection {
            Some(projection) => {
                let revision = projection.revision;
                let stored_hash = projection.state_hash.clone();
                let valid = Self::validate_mind_projection(context_id, projection)
                    .map(|state| state == ledger)
                    .unwrap_or(false);
                (Some(revision), Some(stored_hash), valid)
            }
            None => (None, None, false),
        };
        let projection_validation_micros =
            projection_validation_started.elapsed().as_micros() as u64;
        let incremental_replay_started = std::time::Instant::now();
        let incremental = self.recover_mind_from_latest_snapshot(context_id).await?;
        let incremental_replay_micros = incremental
            .as_ref()
            .map(|_| incremental_replay_started.elapsed().as_micros() as u64);
        let (snapshot_revision, incremental_transactions_scanned, incremental_matches) =
            match incremental {
                Some(recovery) => (
                    Some(recovery.snapshot_revision),
                    Some(recovery.transactions_replayed),
                    Some(recovery.state == ledger),
                ),
                None => (None, None, None),
            };
        Ok(MindProjectionAudit {
            context_id: context_id.to_string(),
            ledger_revision: ledger.version,
            projection_revision,
            snapshot_revision,
            ledger_hash: ledger_hash.clone(),
            projection_hash: projection_hash.clone(),
            events_scanned: events.len(),
            incremental_transactions_scanned,
            incremental_matches,
            full_replay_micros,
            incremental_replay_micros,
            projection_validation_micros,
            // A Projection written before a hash-schema extension can have a
            // different stored digest while still decoding to exactly the
            // same Mind. `validate_mind_projection` has already required the
            // digest to match one of the explicitly supported hash schemas.
            matches: valid_projection && incremental_matches.unwrap_or(true),
        })
    }

    pub async fn search_events(
        &self,
        context_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Event>, DynError> {
        let normalized = crate::memory::normalize_recall_text(query.trim());
        if normalized.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(recall_store) = &self.recall_projection_store {
            let event_ids = recall_store
                .search_recall_documents(context_id, &normalized, limit.clamp(1, 100))
                .await?
                .into_iter()
                .filter(|hit| hit.document_kind == RecallDocumentKind::Event)
                .map(|hit| hit.document_id)
                .collect::<Vec<_>>();
            if event_ids.is_empty() {
                return Ok(Vec::new());
            }
            return self
                .store
                .query(QueryFilter {
                    context_id: Some(context_id.to_string()),
                    event_ids,
                    excluded_topics: vec!["chat/context_inspect".to_string()],
                    latest_k: Some(limit.clamp(1, 100)),
                    ..Default::default()
                })
                .await;
        }

        // In-memory test stores do not always install the rebuildable Recall
        // projection. Keep their compatibility behavior bounded and in Rust;
        // production storage must never run a payload LIKE scan on the Event
        // Ledger.
        let candidates = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                excluded_topics: vec!["chat/context_inspect".to_string()],
                latest_k: Some(2_048),
                ..Default::default()
            })
            .await?;
        Ok(candidates
            .into_iter()
            .filter(|event| {
                crate::memory::normalize_recall_text(&event_text(event)).contains(&normalized)
            })
            .take(limit)
            .collect())
    }

    pub async fn search_recall_documents(
        &self,
        context_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RecallSearchHit>, DynError> {
        let started = std::time::Instant::now();
        let normalized = crate::memory::normalize_recall_text(query.trim());
        if normalized.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(store) = &self.recall_projection_store {
            let capability = store.recall_index_capability().await?;
            let matches = store
                .search_recall_documents(context_id, &normalized, limit.clamp(1, 100))
                .await?;
            tracing::debug!(
                context_id,
                backend = ?capability.mode,
                indexed = capability.indexed,
                query_chars = normalized.chars().count(),
                candidate_count = matches.len(),
                returned_count = matches.len(),
                requested_limit = limit,
                latency_micros = started.elapsed().as_micros() as u64,
                "Lexical Recall query completed"
            );
            return Ok(matches);
        }
        // In-memory/legacy test stores retain a bounded compatibility path;
        // production Runtime always wires RecallProjectionStore.
        let events = self.search_events(context_id, query, limit).await?;
        let matches = events
            .into_iter()
            .map(|event| {
                let preview = event_text(&event).chars().take(500).collect();
                RecallSearchHit {
                    document_kind: RecallDocumentKind::Event,
                    document_id: event.id,
                    revision: 0,
                    retired: false,
                    score: 1.0,
                    preview,
                    updated_sequence: event.sequence.unwrap_or_default(),
                }
            })
            .collect::<Vec<_>>();
        tracing::debug!(
            context_id,
            backend = "legacy-event-query",
            indexed = false,
            query_chars = normalized.chars().count(),
            candidate_count = matches.len(),
            returned_count = matches.len(),
            requested_limit = limit,
            latency_micros = started.elapsed().as_micros() as u64,
            "Lexical Recall query completed through compatibility fallback"
        );
        Ok(matches)
    }

    pub async fn inspect_recall_index(
        &self,
        context_id: &str,
    ) -> Result<RecallIndexAudit, DynError> {
        self.recall_projection_store
            .as_ref()
            .ok_or("ContextEngine 未配置 RecallProjectionStore")?
            .inspect_recall_index(context_id)
            .await
    }

    pub async fn rebuild_recall_index(
        &self,
        context_id: &str,
    ) -> Result<RecallIndexAudit, DynError> {
        let store = self
            .recall_projection_store
            .as_ref()
            .ok_or("ContextEngine 未配置 RecallProjectionStore")?;
        let state = self.load_current_mind(context_id, None).await?;
        let events = self.context_events(context_id).await?;
        let mut documents = all_frame_recall_documents(context_id, &state)
            .into_iter()
            .map(crate::memory::bound_recall_document)
            .collect::<Vec<_>>();
        documents.extend(
            events
                .iter()
                .filter(|event| crate::memory::event_has_recall_value(event))
                .map(|event| {
                    crate::memory::event_recall_document_with_retired(
                        event,
                        context_id,
                        event.sequence.unwrap_or_default(),
                        state.retired.contains(&event.id),
                    )
                }),
        );
        store.replace_recall_documents(context_id, &documents).await
    }

    fn context_lock(&self, context_id: &str) -> Arc<Mutex<()>> {
        self.context_locks
            .entry(context_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Bounded online Ledger read for Context Encoding. Shared Mind state is
    /// read from the Projection; only the selected Session working set and
    /// Context-wide observations are materialized here.
    async fn context_encoding_events(
        &self,
        context_id: &str,
        session_ids: &[String],
    ) -> Result<Vec<Event>, DynError> {
        let mut events = if let Some(store) = &self.session_projection_store {
            store
                .query_session_projections(context_id, session_ids, true)
                .await?
        } else {
            let mut events = self
                .store
                .query(QueryFilter {
                    context_id: Some(context_id.to_string()),
                    session_ids: session_ids.to_vec(),
                    include_context_wide: true,
                    topic: Some("chat/*".to_string()),
                    excluded_topics: vec![
                        "chat/context_inspect".to_string(),
                        "chat/context_tx_committed".to_string(),
                    ],
                    ..Default::default()
                })
                .await?;
            events.extend(
                self.store
                    .query(QueryFilter {
                        context_id: Some(context_id.to_string()),
                        session_ids: session_ids.to_vec(),
                        include_context_wide: true,
                        topic: Some("context/projected_observation".to_string()),
                        ..Default::default()
                    })
                    .await?,
            );
            events
        };
        events.sort_by_key(|event| event.sequence);
        events.dedup_by(|left, right| left.id == right.id);
        self.capacity_metrics.record_encoding(events.len());
        Ok(events)
    }

    /// Full Context Ledger read reserved for lazy Projection migration,
    /// integrity audit, seed export and explicit historical operations.
    async fn context_events(&self, context_id: &str) -> Result<Vec<Event>, DynError> {
        let mut events = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                topic: Some("chat/*".to_string()),
                // Context inspection is a diagnostic artifact containing a
                // rendered snapshot, not cognitive input. Loading it here used
                // to recursively materialize hundreds of historical prompts.
                excluded_topics: vec!["chat/context_inspect".to_string()],
                ..Default::default()
            })
            .await?;
        events.extend(
            self.store
                .query(QueryFilter {
                    context_id: Some(context_id.to_string()),
                    topic: Some("runtime/context_seeded".to_string()),
                    ..Default::default()
                })
                .await?,
        );
        events.extend(
            self.store
                .query(QueryFilter {
                    context_id: Some(context_id.to_string()),
                    topic: Some("context/projected_observation".to_string()),
                    ..Default::default()
                })
                .await?,
        );
        events.sort_by_key(|event| event.sequence);
        Ok(events)
    }

    async fn context_sessions(
        &self,
        context_id: &str,
        events: &[Event],
    ) -> Result<Vec<SessionRecord>, DynError> {
        if let Some(store) = &self.session_store {
            return store.list_context_sessions(context_id, true).await;
        }
        let mut ids = BTreeSet::new();
        for event in events {
            if let Some(id) = event_session(event) {
                ids.insert(id.to_string());
            }
        }
        Ok(ids
            .into_iter()
            .map(|id| SessionRecord {
                context_id: context_id.to_string(),
                agent_id: "unknown".to_string(),
                parent_session_id: None,
                title: id.clone(),
                status: crate::memory::SessionStatus::Active,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                last_activity_at: Utc::now(),
                attention_state: crate::memory::SessionAttentionState::Active,
                attention_revision: 0,
                attention_reason: None,
                attention_changed_at: None,
                attention_event_id: None,
                id,
            })
            .collect())
    }

    fn to_observation(
        &self,
        event: &Event,
        state: &MindState,
        metadata: ObservationMetadata,
    ) -> ContextObservation {
        let text = event_text(event);
        let total_chars = text.chars().count();
        let full_recall_chunk = event
            .payload
            .get("tool_name")
            .and_then(|value| value.as_str())
            == Some("recall")
            && serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| {
                    value
                        .get("context_delivery")
                        .and_then(|marker| marker.as_str())
                        .map(ToOwned::to_owned)
                })
                .as_deref()
                == Some("full-event-chunk");
        let (preview, truncated) = if full_recall_chunk {
            (text, false)
        } else {
            preview_text(&text, self.config.observation_preview_chars)
        };
        let visible_chars = preview.chars().count();
        let representation = if full_recall_chunk {
            "recalled-chunk"
        } else if truncated {
            "preview"
        } else {
            "full"
        };
        ContextObservation {
            id: event.id.clone(),
            reference: self.event_reference(event),
            session_id: event
                .payload
                .get("source_session_id")
                .and_then(|value| value.as_str())
                .or_else(|| event_session(event))
                .map(ToOwned::to_owned),
            principal_id: event_principal(event).map(ToOwned::to_owned),
            sequence: metadata.sequence,
            turn: metadata.turn,
            attempt: metadata.attempt,
            caused_by: metadata.caused_by,
            kind: event.event_type.clone(),
            topic: event.topic.clone(),
            actor: event.actor.clone(),
            timestamp: event.timestamp.to_rfc3339(),
            preview,
            truncated,
            representation: representation.to_string(),
            visible_chars,
            total_chars,
            retrievable: true,
            protected: state.protected.contains(&event.id),
            tool_name: event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
            tool_status: event
                .payload
                .get("tool_status")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
            output_empty: event
                .payload
                .get("output_empty")
                .and_then(|value| value.as_bool()),
            resource: metadata.resource,
            freshness: metadata.freshness,
            usage: metadata.usage,
        }
    }
}

#[async_trait::async_trait]
impl ContextRecallService for ContextEngine {
    async fn search_recall(
        &self,
        request: RecallSearchRequest,
    ) -> Result<RecallSearchPage, DynError> {
        let matches = self
            .search_recall_documents(&request.context_id, &request.query, request.limit)
            .await?;
        Ok(RecallSearchPage {
            context_id: request.context_id,
            query: request.query,
            matches,
        })
    }

    async fn recall_frame(&self, request: FrameRecallRequest) -> Result<FrameRecallPage, DynError> {
        self.recall_frame_graph(request).await
    }

    async fn inspect_recall_index(&self, context_id: &str) -> Result<RecallIndexAudit, DynError> {
        ContextEngine::inspect_recall_index(self, context_id).await
    }

    async fn rebuild_recall_index(&self, context_id: &str) -> Result<RecallIndexAudit, DynError> {
        ContextEngine::rebuild_recall_index(self, context_id).await
    }
}

#[derive(Debug, Clone, Default)]
struct ObservationMetadata {
    sequence: u64,
    turn: usize,
    attempt: Option<usize>,
    caused_by: Option<String>,
    resource: Option<ContextResource>,
    freshness: ContextFreshness,
    usage: ContextUsage,
}

type ResourceVersions = BTreeMap<(String, String), Vec<(String, u64, Option<String>)>>;

fn observation_metadata(
    events: &[Event],
    state: &MindState,
) -> HashMap<String, ObservationMetadata> {
    let references = ContextReferences::from_events(events);
    let mut event_turns = HashMap::new();
    let mut attempt_ids = HashMap::new();
    let mut current_turn = 0usize;
    let mut current_attempt = 0usize;
    for event in events {
        if event.event_type == TYPE_USER_MESSAGE {
            current_turn += 1;
            current_attempt = 0;
        }
        if event.topic == "chat/assistant_call" {
            current_attempt += 1;
            if let Some(attempt_id) = event
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
            {
                attempt_ids.insert(attempt_id.to_string(), current_attempt);
            }
        }
        event_turns.insert(event.id.clone(), current_turn);
    }

    let latest_turn = current_turn;
    let mut metadata = events
        .iter()
        .enumerate()
        .filter(|(_, event)| is_observation(event))
        .map(|(index, event)| {
            let sequence = event.sequence.unwrap_or((index + 1) as u64);
            let attempt = event
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
                .and_then(|id| attempt_ids.get(id).copied());
            let caused_by = ["source_event_id", "tool_call_id", "attempt_id"]
                .iter()
                .find_map(|key| {
                    event
                        .payload
                        .get(*key)
                        .and_then(|value| value.as_str())
                        .map(ToOwned::to_owned)
                });
            (
                event.id.clone(),
                ObservationMetadata {
                    sequence,
                    turn: event_turns.get(&event.id).copied().unwrap_or(0),
                    attempt,
                    caused_by,
                    resource: context_resource(event),
                    ..Default::default()
                },
            )
        })
        .collect::<HashMap<_, _>>();

    for relation in &state.relations {
        if relation.relation != "supersedes" {
            continue;
        }
        if let Some(subject) = metadata.get_mut(&relation.subject) {
            subject.freshness.latest.get_or_insert(true);
            subject.freshness.supersedes.push(relation.object.clone());
        }
        if let Some(object) = metadata.get_mut(&relation.object) {
            object.freshness.latest = Some(false);
            object
                .freshness
                .superseded_by
                .push(relation.subject.clone());
        }
    }

    let mut resources = ResourceVersions::new();
    for (id, item) in &metadata {
        if state.retired.contains(id) {
            continue;
        }
        if let Some(resource) = &item.resource {
            resources
                .entry((resource.kind.clone(), resource.key.clone()))
                .or_default()
                .push((id.clone(), item.sequence, resource.version.clone()));
        }
    }
    for entries in resources.values_mut() {
        entries.sort_by_key(|(_, sequence, _)| *sequence);
        let Some((latest_id, _, latest_version)) = entries.last().cloned() else {
            continue;
        };
        if let Some(latest) = metadata.get_mut(&latest_id) {
            latest.freshness.latest = Some(true);
        }
        for (id, _, version) in entries.iter().take(entries.len().saturating_sub(1)) {
            if version == &latest_version {
                continue;
            }
            if let Some(older) = metadata.get_mut(id) {
                older.freshness.latest = Some(false);
                if !older.freshness.superseded_by.contains(&latest_id) {
                    older.freshness.superseded_by.push(latest_id.clone());
                }
            }
        }
    }

    let mut usage = HashMap::<String, ContextUsage>::new();
    for (index, event) in events.iter().enumerate() {
        let sequence = event.sequence.unwrap_or((index + 1) as u64);
        let event_turn = event_turns.get(&event.id).copied().unwrap_or(0);
        let recent = event_turn.saturating_add(2) >= latest_turn;
        if event.event_type == TYPE_TOOL_OUTPUT
            && event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("recall")
        {
            let recalled_id = event
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                .and_then(|value| {
                    value
                        .get("event_id")
                        .and_then(|id| id.as_str())
                        .and_then(|id| references.resolve(id).ok())
                });
            if let Some(recalled_id) = recalled_id {
                let item = usage.entry(recalled_id).or_default();
                item.recall_count_total += 1;
                item.recall_count_recent += usize::from(recent);
                item.last_recalled_sequence = Some(sequence);
            }
        }
        if event.event_type == TYPE_CONTEXT_TRANSACTION
            && event.topic == "chat/context_tx_committed"
        {
            let parsed = event
                .payload
                .get("transaction")
                .and_then(|value| value.as_str())
                .and_then(|transaction| parse_transaction(transaction).ok());
            if let Some(parsed) = parsed {
                for source in transaction_sources(&parsed) {
                    let item = usage.entry(source).or_default();
                    item.reference_count_total += 1;
                    item.reference_count_recent += usize::from(recent);
                    item.last_referenced_sequence = Some(sequence);
                }
            }
        }
    }
    for frame in state
        .frames
        .iter()
        .filter(|frame| !state.retired.contains(&frame.id))
    {
        for source in &frame.sources {
            usage
                .entry(source.clone())
                .or_default()
                .referenced_by_active_frames += 1;
        }
    }
    for (id, item) in usage {
        if let Some(target) = metadata.get_mut(&id) {
            target.usage = item;
        }
    }
    metadata
}

fn transaction_sources(transaction: &ParsedTransaction) -> Vec<String> {
    transaction
        .operations
        .iter()
        .filter_map(|operation| as_list(operation, "context operation").ok())
        .filter(|operation| {
            operation
                .first()
                .and_then(|item| as_atom(item, "operation").ok())
                .is_some_and(|name| name == "derive" || name == "revise")
        })
        .filter_map(|operation| operation.get(2))
        .filter_map(|item| parse_sources(item).ok())
        .flatten()
        .collect()
}

fn context_resource(event: &Event) -> Option<ContextResource> {
    let value = event.payload.get("context_resource")?.as_object()?;
    Some(ContextResource {
        kind: value.get("kind")?.as_str()?.to_string(),
        key: value.get("key")?.as_str()?.to_string(),
        version: value
            .get("version")
            .and_then(|version| version.as_str())
            .map(ToOwned::to_owned),
    })
}

fn parse_transaction(input: &str) -> Result<ParsedTransaction, String> {
    let expr = parse(input).map_err(|error| error.to_string())?;
    let list = as_list(&expr, "context transaction")?;
    expect_head(list, "context-tx")?;

    let mut base_version = None;
    let mut reason = None;
    let mut operations = Vec::new();
    for item in list.iter().skip(1) {
        let child = as_list(item, "context-tx child")?;
        let head = atom_at(child, 0, "operation")?;
        if head == "base-version" {
            if child.len() != 2 || base_version.is_some() {
                return Err("context-tx 必须且只能包含一个 (base-version N)".to_string());
            }
            base_version = Some(
                atom_at(child, 1, "base-version")?
                    .parse::<u64>()
                    .map_err(|_| "base-version 必须是非负整数".to_string())?,
            );
        } else if head == "reason" {
            if child.len() != 2 || reason.is_some() {
                return Err("context-tx 最多包含一个 (reason \"...\")".to_string());
            }
            reason = Some(atom_at(child, 1, "reason")?.to_string());
        } else {
            operations.push(item.clone());
        }
    }

    if operations.is_empty() {
        return Err("context-tx 至少需要一个修改操作".to_string());
    }
    let mut transaction = ParsedTransaction {
        base_version: base_version.ok_or("缺少 (base-version N)")?,
        reason,
        operations,
    };
    normalize_transaction_bodies(&mut transaction)?;
    Ok(transaction)
}

fn normalize_transaction_bodies(transaction: &mut ParsedTransaction) -> Result<(), String> {
    for operation in &mut transaction.operations {
        let items = match operation {
            SExpr::List(items) => items,
            _ => return Err("context operation 必须是 SExpr List".to_string()),
        };
        let name = atom_at(items, 0, "operation name")?.to_string();
        match name.as_str() {
            "create" => {
                if items.len() < 3 {
                    return Err("create 至少需要一个 BODY：(create ID BODY...)".to_string());
                }
                if items.iter().skip(2).any(is_from_expression) {
                    return Err(
                        "create 不接受 (from SOURCE...)；有证据来源时请使用 (derive ID (from SOURCE...) BODY...)"
                            .to_string(),
                    );
                }
                reject_nested_context_operations(&items[2..])?;
                normalize_body_tail(items, 2);
            }
            "derive" => {
                if items.len() < 4 || !items.get(2).is_some_and(is_from_expression) {
                    return Err(
                        "derive 必须把来源放在 ID 后，并至少提供一个 BODY：(derive ID (from SOURCE...) BODY...)"
                            .to_string(),
                    );
                }
                reject_nested_context_operations(&items[3..])?;
                normalize_body_tail(items, 3);
            }
            "revise" => {
                if items.len() < 3 {
                    return Err(
                        "revise 至少需要一个 BODY：(revise ID BODY...) 或 (revise ID (from SOURCE...) BODY...)"
                            .to_string(),
                    );
                }
                let body_start = if items.get(2).is_some_and(is_from_expression) {
                    if items.len() < 4 {
                        return Err("revise 的 (from SOURCE...) 后至少需要一个 BODY".to_string());
                    }
                    3
                } else {
                    2
                };
                reject_nested_context_operations(&items[body_start..])?;
                normalize_body_tail(items, body_start);
            }
            _ => {}
        }
    }
    Ok(())
}

fn reject_nested_context_operations(bodies: &[SExpr]) -> Result<(), String> {
    fn nested_operation(expression: &SExpr) -> Option<&str> {
        let SExpr::List(items) = expression else {
            return None;
        };
        if let Some(SExpr::Atom(head)) = items.first() {
            if CONTEXT_OPERATIONS.iter().any(|spec| spec.name == head)
                || head == "finalize-retirement"
            {
                return Some(head.as_str());
            }
        }
        items.iter().find_map(nested_operation)
    }

    if let Some(operation) = bodies.iter().find_map(nested_operation) {
        return Err(format!(
            "Context operation '({operation} ...)' 被嵌套进 create/derive/revise BODY，因此不会执行；请关闭 BODY 括号，并把该 operation 放到 context-tx 顶层"
        ));
    }
    Ok(())
}

fn normalize_body_tail(items: &mut Vec<SExpr>, body_start: usize) {
    if items.len().saturating_sub(body_start) <= 1 {
        return;
    }
    let bodies = items.drain(body_start..).collect::<Vec<_>>();
    items.push(list("context-body", bodies));
}

fn is_from_expression(expression: &SExpr) -> bool {
    matches!(
        expression,
        SExpr::List(items)
            if matches!(items.first(), Some(SExpr::Atom(head)) if head == "from")
    )
}

fn resolve_transaction_references(
    transaction: &mut ParsedTransaction,
    references: &ContextReferences,
) -> Result<(), String> {
    for operation in &mut transaction.operations {
        let items = match operation {
            SExpr::List(items) => items,
            _ => return Err("context operation 必须是 SExpr List".to_string()),
        };
        let name = atom_at(items, 0, "operation name")?.to_string();
        match name.as_str() {
            "derive" => resolve_from_references(
                items.get_mut(2).ok_or("derive 缺少 (from SOURCE...)")?,
                references,
            )?,
            "revise" if items.len() == 4 => resolve_from_references(
                items.get_mut(2).ok_or("revise 缺少 (from SOURCE...)")?,
                references,
            )?,
            "retire" | "restore" | "protect" | "unprotect" => {
                for item in items.iter_mut().skip(1) {
                    resolve_reference_atom(item, references)?;
                }
            }
            "relate" | "unrelate" => {
                for index in [1, 3] {
                    let item = items.get_mut(index).ok_or_else(|| {
                        format!("{} 缺少引用参数，需提供 SUBJECT RELATION OBJECT", name)
                    })?;
                    resolve_reference_atom(item, references)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Returns only identifiers that the transaction can semantically read or
/// collide with. This keeps Observation validation proportional to the actual
/// SExpr instead of the total Context Ledger size.
fn transaction_reference_candidates(
    transaction: &ParsedTransaction,
) -> Result<BTreeSet<String>, String> {
    let mut candidates = BTreeSet::new();
    for operation in &transaction.operations {
        let items = as_list(operation, "context operation")?;
        let name = atom_at(items, 0, "operation name")?;
        match name {
            "create" | "checkpoint" | "rollback" => {
                candidates.insert(atom_at(items, 1, "Context ID")?.to_string());
            }
            "derive" => {
                candidates.insert(atom_at(items, 1, "frame ID")?.to_string());
                let sources = as_list(items.get(2).ok_or("derive 缺少 from")?, "from")?;
                expect_head(sources, "from")?;
                for source in sources.iter().skip(1) {
                    candidates.insert(as_atom(source, "source")?.to_string());
                }
            }
            "revise" => {
                candidates.insert(atom_at(items, 1, "frame ID")?.to_string());
                if items.len() == 4 {
                    let sources = as_list(items.get(2).ok_or("revise 缺少 from")?, "from")?;
                    expect_head(sources, "from")?;
                    for source in sources.iter().skip(1) {
                        candidates.insert(as_atom(source, "source")?.to_string());
                    }
                }
            }
            "retire" | "restore" | "protect" | "unprotect" | "drop-checkpoint" => {
                for item in items.iter().skip(1) {
                    candidates.insert(as_atom(item, "Context ID")?.to_string());
                }
            }
            "finalize-retirement" => {
                candidates.insert(atom_at(items, 1, "frame ID")?.to_string());
            }
            "relate" | "unrelate" => {
                candidates.insert(atom_at(items, 1, "relation subject")?.to_string());
                candidates.insert(atom_at(items, 3, "relation object")?.to_string());
            }
            "place" => {
                candidates.insert(atom_at(items, 1, "frame ID")?.to_string());
            }
            // Session attention targets belong to SessionStore, not the Event
            // Ledger, and therefore must never be interpreted as observations.
            "retire-session" | "restore-session" => {}
            _ => {}
        }
    }
    Ok(candidates)
}

fn reject_causally_protected_retirements(
    transaction: &ParsedTransaction,
    causally_protected_ids: &BTreeSet<String>,
) -> Result<(), String> {
    if causally_protected_ids.is_empty() {
        return Ok(());
    }
    for operation in &transaction.operations {
        let items = as_list(operation, "context operation")?;
        if atom_at(items, 0, "operation name")? != "retire" {
            continue;
        }
        for item in items.iter().skip(1) {
            let id = as_atom(item, "retire target")?;
            if causally_protected_ids.contains(id) {
                return Err(format!(
                    "'{}' 是当前 Activation 尚未交付的根请求，受 Runtime 因果保护；完成当前回复或工作交付前不能 retire",
                    id
                ));
            }
        }
    }
    Ok(())
}

fn resolve_from_references(
    expression: &mut SExpr,
    references: &ContextReferences,
) -> Result<(), String> {
    let items = match expression {
        SExpr::List(items) => items,
        _ => return Err("from 必须是 SExpr List".to_string()),
    };
    expect_head(items, "from")?;
    for item in items.iter_mut().skip(1) {
        resolve_reference_atom(item, references)?;
    }
    Ok(())
}

fn resolve_reference_atom(
    expression: &mut SExpr,
    references: &ContextReferences,
) -> Result<(), String> {
    let SExpr::Atom(reference) = expression else {
        return Err("Context 引用必须是 Atom".to_string());
    };
    *reference = references.resolve(reference)?;
    Ok(())
}

fn render_parsed_transaction(transaction: &ParsedTransaction) -> String {
    let mut items = vec![
        atom("context-tx"),
        list(
            "base-version",
            vec![atom(transaction.base_version.to_string())],
        ),
    ];
    if let Some(reason) = &transaction.reason {
        items.push(list("reason", vec![atom(reason)]));
    }
    items.extend(transaction.operations.iter().cloned());
    SExpr::List(items).to_string()
}

/// Rebase a stale transaction when its semantic read/write set is confined to
/// Frames that have not changed since the model's Context Encoding. The global
/// Mind version remains the physical commit sequence; Frame `updated_version`
/// is the MVCC conflict boundary for cognition authored by the model.
///
/// Lifecycle, ordering, relationship, checkpoint and Session-attention
/// operations intentionally remain conservative because their state is not
/// fully represented by `ContextFrame::updated_version`.
fn rebase_stale_frame_transaction(
    current: &MindState,
    transaction: &mut ParsedTransaction,
) -> Result<(), String> {
    let requested_base = transaction.base_version;
    if requested_base > current.version {
        return Err(format!(
            "Context transaction 基于未来版本 {}，当前 Mind version 为 {}",
            requested_base, current.version
        ));
    }
    if requested_base == current.version {
        return Ok(());
    }

    let mut frames_created_in_transaction = BTreeSet::new();
    for operation in &transaction.operations {
        let items = as_list(operation, "context operation")?;
        let name = atom_at(items, 0, "operation name")?;
        match name {
            "create" => {
                let id = atom_at(items, 1, "frame id")?;
                if current.frames.iter().any(|frame| frame.id == id) {
                    return Err(format!(
                        "Frame MVCC 冲突：事务准备 create '{}'，但该 ID 已在 Mind version {} 中存在",
                        id, current.version
                    ));
                }
                frames_created_in_transaction.insert(id.to_string());
            }
            "derive" => {
                let id = atom_at(items, 1, "frame id")?;
                if current.frames.iter().any(|frame| frame.id == id) {
                    return Err(format!(
                        "Frame MVCC 冲突：事务准备 derive '{}'，但该 ID 已在 Mind version {} 中存在",
                        id, current.version
                    ));
                }
                let sources = parse_sources(items.get(2).ok_or("derive 缺少 from")?)?;
                for source in &sources {
                    ensure_frame_read_is_current(
                        current,
                        source,
                        requested_base,
                        &frames_created_in_transaction,
                    )?;
                }
                frames_created_in_transaction.insert(id.to_string());
            }
            "revise" => {
                let id = atom_at(items, 1, "frame id")?;
                ensure_frame_write_is_current(
                    current,
                    id,
                    requested_base,
                    &frames_created_in_transaction,
                )?;
                if items.len() == 4 {
                    let sources = parse_sources(items.get(2).ok_or("revise 缺少 from")?)?;
                    for source in &sources {
                        ensure_frame_read_is_current(
                            current,
                            source,
                            requested_base,
                            &frames_created_in_transaction,
                        )?;
                    }
                }
            }
            other => {
                return Err(format!(
                    "Context version 已从 {} 前进到 {}；事务包含全局或生命周期操作 '{}'，Runtime 不能按 Frame MVCC 自动合并，请基于最新 Context Encoding 重试",
                    requested_base, current.version, other
                ));
            }
        }
    }

    transaction.base_version = current.version;
    Ok(())
}

fn ensure_frame_read_is_current(
    current: &MindState,
    id: &str,
    requested_base: u64,
    frames_created_in_transaction: &BTreeSet<String>,
) -> Result<(), String> {
    if frames_created_in_transaction.contains(id) {
        return Ok(());
    }
    let Some(frame) = current.frames.iter().find(|frame| frame.id == id) else {
        // Observation IDs are immutable Ledger references and are validated by
        // the normal transaction application path after rebase.
        return Ok(());
    };
    if frame.created_version > requested_base || frame.updated_version > requested_base {
        return Err(format!(
            "Frame MVCC 冲突：来源 Frame '{}' 在事务读取的 Mind version {} 之后已变为 r{}（updated at version {}），请重新读取后做语义合并",
            id, requested_base, frame.revision, frame.updated_version
        ));
    }
    Ok(())
}

fn ensure_frame_write_is_current(
    current: &MindState,
    id: &str,
    requested_base: u64,
    frames_created_in_transaction: &BTreeSet<String>,
) -> Result<(), String> {
    if frames_created_in_transaction.contains(id) {
        return Ok(());
    }
    let frame = current
        .frames
        .iter()
        .find(|frame| frame.id == id)
        .ok_or_else(|| format!("Frame MVCC 冲突：revise 目标 '{}' 已不存在", id))?;
    if frame.created_version > requested_base || frame.updated_version > requested_base {
        return Err(format!(
            "Frame MVCC 冲突：目标 Frame '{}' 在事务读取的 Mind version {} 之后已变为 r{}（updated at version {}），请重新读取后做语义合并",
            id, requested_base, frame.revision, frame.updated_version
        ));
    }
    if current
        .retiring
        .get(id)
        .is_some_and(|retirement| retirement.generation > requested_base)
    {
        return Err(format!(
            "Frame MVCC 冲突：目标 Frame '{}' 在 Mind version {} 之后进入 retiring 状态，请基于最新生命周期状态决策",
            id, requested_base
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct FrameRetirementPolicy {
    staged: bool,
    cognitive_tick: u64,
    cooling_ticks: u64,
}

impl FrameRetirementPolicy {
    fn legacy_immediate() -> Self {
        Self {
            staged: false,
            cognitive_tick: 0,
            cooling_ticks: 0,
        }
    }

    fn cognitive(cognitive_tick: u64, cooling_ticks: u64) -> Self {
        Self {
            staged: true,
            cognitive_tick,
            cooling_ticks,
        }
    }
}

#[cfg(test)]
fn apply_parsed_transaction(
    current: &MindState,
    tx: &ParsedTransaction,
    observation_ids: &HashSet<String>,
) -> Result<(MindState, Vec<ContextChange>), String> {
    apply_parsed_transaction_with_policy(
        current,
        tx,
        observation_ids,
        FrameRetirementPolicy::legacy_immediate(),
    )
}

#[derive(Debug, Clone, Default)]
struct ContextSourceOrigin {
    principal_id: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Default)]
struct FrameFormationContext<'a> {
    enabled: bool,
    formed_principal_id: Option<&'a str>,
    formed_session_id: Option<&'a str>,
    observation_origins: Option<&'a HashMap<String, ContextSourceOrigin>>,
}

fn direct_frame_provenance(formation: &FrameFormationContext<'_>) -> FrameIdentityProvenance {
    if !formation.enabled {
        return FrameIdentityProvenance::default();
    }
    FrameIdentityProvenance {
        formed_principal_id: formation.formed_principal_id.map(ToOwned::to_owned),
        formed_session_id: formation.formed_session_id.map(ToOwned::to_owned),
        state: FrameProvenanceState::Unattributed,
        ..Default::default()
    }
}

fn derived_frame_provenance(
    state: &MindState,
    sources: &[String],
    formation: &FrameFormationContext<'_>,
) -> FrameIdentityProvenance {
    if !formation.enabled {
        return FrameIdentityProvenance::default();
    }
    let mut principal_ids = BTreeSet::new();
    let mut session_ids = BTreeSet::new();
    for source in sources {
        if let Some(origin) = formation
            .observation_origins
            .and_then(|origins| origins.get(source))
        {
            if let Some(principal_id) = &origin.principal_id {
                principal_ids.insert(principal_id.clone());
            }
            if let Some(session_id) = &origin.session_id {
                session_ids.insert(session_id.clone());
            }
            continue;
        }
        let Some(frame) = state.frames.iter().find(|frame| frame.id == *source) else {
            continue;
        };
        principal_ids.extend(frame.provenance.source_principal_ids.iter().cloned());
        session_ids.extend(frame.provenance.source_session_ids.iter().cloned());
        // A directly created Frame has no evidence sources of its own. When it
        // becomes evidence for another Frame, its formation site is the best
        // Runtime-known causal origin and must not be lost.
        if frame.provenance.source_principal_ids.is_empty() {
            if let Some(principal_id) = &frame.provenance.formed_principal_id {
                principal_ids.insert(principal_id.clone());
            }
        }
        if frame.provenance.source_session_ids.is_empty() {
            if let Some(session_id) = &frame.provenance.formed_session_id {
                session_ids.insert(session_id.clone());
            }
        }
    }
    let attributed = !principal_ids.is_empty() || !session_ids.is_empty();
    FrameIdentityProvenance {
        formed_principal_id: formation.formed_principal_id.map(ToOwned::to_owned),
        formed_session_id: formation.formed_session_id.map(ToOwned::to_owned),
        source_principal_ids: principal_ids.into_iter().collect(),
        source_session_ids: session_ids.into_iter().collect(),
        state: if attributed {
            FrameProvenanceState::Attributed
        } else {
            FrameProvenanceState::Unknown
        },
    }
}

#[cfg(test)]
fn apply_parsed_transaction_with_policy(
    current: &MindState,
    tx: &ParsedTransaction,
    observation_ids: &HashSet<String>,
    retirement_policy: FrameRetirementPolicy,
) -> Result<(MindState, Vec<ContextChange>), String> {
    apply_parsed_transaction_with_policy_and_provenance(
        current,
        tx,
        observation_ids,
        retirement_policy,
        &FrameFormationContext::default(),
    )
}

fn apply_parsed_transaction_with_policy_and_provenance(
    current: &MindState,
    tx: &ParsedTransaction,
    observation_ids: &HashSet<String>,
    retirement_policy: FrameRetirementPolicy,
    formation: &FrameFormationContext<'_>,
) -> Result<(MindState, Vec<ContextChange>), String> {
    if current.version != tx.base_version {
        return Err(format!(
            "Context 版本冲突：transaction 基于版本 {}，当前版本为 {}。请读取最新 kernel.version 后重新提交。",
            tx.base_version, current.version
        ));
    }

    let mut next = current.clone();
    let next_version = current.version + 1;
    let mut changes = Vec::new();

    for operation in &tx.operations {
        let op = as_list(operation, "context operation")?;
        let name = atom_at(op, 0, "operation name")?;
        match name {
            "create" => {
                if op.len() != 3 {
                    return Err("create BODY 规范化失败；期望 (create ID BODY)".to_string());
                }
                let id = validated_id(atom_at(op, 1, "frame id")?)?;
                ensure_unknown(&next, observation_ids, id)?;
                let body = canonical_body(&op[2])?;
                next.frames.push(ContextFrame {
                    id: id.to_string(),
                    body,
                    sources: Vec::new(),
                    provenance: direct_frame_provenance(formation),
                    revision: 1,
                    created_version: next_version,
                    updated_version: next_version,
                });
                changes.push(change("create", id, None));
            }
            "derive" => {
                if op.len() != 4 {
                    return Err(
                        "derive BODY 规范化失败；期望 (derive ID (from SOURCE...) BODY)"
                            .to_string(),
                    );
                }
                let id = validated_id(atom_at(op, 1, "frame id")?)?;
                ensure_unknown(&next, observation_ids, id)?;
                let sources = parse_sources(&op[2])?;
                ensure_sources_exist(&next, observation_ids, &sources)?;
                let body = canonical_body(&op[3])?;
                let provenance = derived_frame_provenance(&next, &sources, formation);
                next.frames.push(ContextFrame {
                    id: id.to_string(),
                    body,
                    sources: sources.clone(),
                    provenance,
                    revision: 1,
                    created_version: next_version,
                    updated_version: next_version,
                });
                changes.push(change("derive", id, Some(sources.join(","))));
            }
            "revise" => {
                if op.len() != 3 && op.len() != 4 {
                    return Err(
                        "revise BODY 规范化失败；期望 (revise ID BODY) 或 (revise ID (from SOURCE...) BODY)"
                            .to_string(),
                    );
                }
                let id = validated_id(atom_at(op, 1, "frame id")?)?;
                if next.retired.contains(id) {
                    return Err(format!("frame '{}' 已退役；请先 restore 再 revise", id));
                }
                let cancelled_retirement = next.retiring.remove(id).is_some();
                let (sources, body_expr) = if op.len() == 4 {
                    let sources = parse_sources(&op[2])?;
                    ensure_sources_exist(&next, observation_ids, &sources)?;
                    (Some(sources), &op[3])
                } else {
                    (None, &op[2])
                };
                let body = canonical_body(body_expr)?;
                let revised_provenance = sources
                    .as_ref()
                    .map(|sources| derived_frame_provenance(&next, sources, formation));
                let frame = next
                    .frames
                    .iter_mut()
                    .find(|frame| frame.id == id)
                    .ok_or_else(|| format!("revise 目标 '{}' 不是已存在的 frame", id))?;
                frame.body = body;
                if let Some(sources) = sources {
                    frame.sources = sources;
                }
                if let Some(provenance) = revised_provenance {
                    // Revision changes evidence lineage but not the original
                    // site where this stable Frame identity was formed.
                    let formed_principal_id = frame.provenance.formed_principal_id.clone();
                    let formed_session_id = frame.provenance.formed_session_id.clone();
                    frame.provenance = provenance;
                    frame.provenance.formed_principal_id = formed_principal_id;
                    frame.provenance.formed_session_id = formed_session_id;
                }
                frame.revision += 1;
                frame.updated_version = next_version;
                changes.push(change(
                    "revise",
                    id,
                    Some(if cancelled_retirement {
                        format!("r{}; retirement-cancelled", frame.revision)
                    } else {
                        format!("r{}", frame.revision)
                    }),
                ));
            }
            "retire" => {
                let reason = tx
                    .reason
                    .as_ref()
                    .ok_or("retire 会改变当前注意力，transaction 必须提供 (reason \"...\")")?;
                require_min_len(op, 2, "(retire ID...)")?;
                for item in op.iter().skip(1) {
                    let raw_id = as_atom(item, "retire target")?;
                    let id = validated_id(raw_id).map_err(|error| {
                        format!(
                            "retire 参数只能是 Context ID；reason 必须写在事务级 (reason \"...\")，不能放进 retire。{error}"
                        )
                    })?;
                    ensure_known(&next, observation_ids, id).map_err(|error| {
                        format!(
                            "{error}。如果该参数是在说明退休原因，请移到事务级 (reason \"...\")"
                        )
                    })?;
                    if next.protected.contains(id) {
                        return Err(format!(
                            "'{}' 已被 protect；必须先显式 unprotect 才能 retire",
                            id
                        ));
                    }
                    let is_frame = next.frames.iter().any(|frame| frame.id == id);
                    if retirement_policy.staged && is_frame {
                        if next.retired.contains(id) {
                            return Err(format!("frame '{}' 已经处于 retired 状态", id));
                        }
                        if let Some(existing) = next.retiring.get(id) {
                            changes.push(change(
                                "retire-frame-existing",
                                id,
                                Some(format!(
                                    "eligible-at-tick={}; reason={}",
                                    existing.eligible_at_tick, existing.reason
                                )),
                            ));
                            continue;
                        }
                        let frame = next
                            .frames
                            .iter()
                            .find(|frame| frame.id == id)
                            .ok_or_else(|| format!("frame '{}' 不存在", id))?;
                        let eligible_at_tick = retirement_policy
                            .cognitive_tick
                            .saturating_add(retirement_policy.cooling_ticks);
                        next.retiring.insert(
                            id.to_string(),
                            FrameRetirement {
                                frame_id: id.to_string(),
                                requested_frame_revision: frame.revision,
                                requested_mind_version: current.version,
                                requested_at_tick: retirement_policy.cognitive_tick,
                                eligible_at_tick,
                                generation: next_version,
                                reason: reason.clone(),
                            },
                        );
                        changes.push(change(
                            "retire-frame-requested",
                            id,
                            Some(format!(
                                "state=retiring; eligible-at-tick={eligible_at_tick}; immediate-token-relief=0"
                            )),
                        ));
                    } else {
                        next.retired.insert(id.to_string());
                        changes.push(change("retire", id, Some(reason.clone())));
                    }
                }
            }
            "restore" => {
                require_min_len(op, 2, "(restore ID...)")?;
                for item in op.iter().skip(1) {
                    let id = validated_id(as_atom(item, "restore target")?)?;
                    ensure_known(&next, observation_ids, id)?;
                    if next.retiring.remove(id).is_some() {
                        changes.push(change(
                            "restore",
                            id,
                            Some("retirement-cancelled".to_string()),
                        ));
                        continue;
                    }
                    if !next.retired.remove(id) {
                        return Err(format!("'{}' 当前没有处于 retired 状态", id));
                    }
                    changes.push(change("restore", id, None));
                }
            }
            "finalize-retirement" => {
                require_len(
                    op,
                    5,
                    "(finalize-retirement ID GENERATION FRAME-REVISION ELIGIBLE-TICK)",
                )?;
                if !retirement_policy.staged {
                    return Err("finalize-retirement 需要 cognitive retirement policy".to_string());
                }
                let id = validated_id(atom_at(op, 1, "frame id")?)?;
                let generation = atom_at(op, 2, "retirement generation")?
                    .parse::<u64>()
                    .map_err(|_| "retirement generation 必须是非负整数".to_string())?;
                let frame_revision = atom_at(op, 3, "frame revision")?
                    .parse::<u64>()
                    .map_err(|_| "frame revision 必须是非负整数".to_string())?;
                let eligible_at_tick = atom_at(op, 4, "eligible tick")?
                    .parse::<u64>()
                    .map_err(|_| "eligible tick 必须是非负整数".to_string())?;
                let Some(retirement) = next.retiring.get(id) else {
                    changes.push(change(
                        "finalize-retirement-stale",
                        id,
                        Some("intent-missing".to_string()),
                    ));
                    continue;
                };
                let frame_is_current = next
                    .frames
                    .iter()
                    .any(|frame| frame.id == id && frame.revision == frame_revision);
                if retirement.generation != generation
                    || retirement.requested_frame_revision != frame_revision
                    || retirement.eligible_at_tick != eligible_at_tick
                    || retirement_policy.cognitive_tick < eligible_at_tick
                    || next.protected.contains(id)
                    || !frame_is_current
                {
                    changes.push(change(
                        "finalize-retirement-stale",
                        id,
                        Some("fencing-mismatch".to_string()),
                    ));
                    continue;
                }
                next.retiring.remove(id);
                next.retired.insert(id.to_string());
                changes.push(change(
                    "retire-frame-finalized",
                    id,
                    Some(format!(
                        "eligible-at-tick={eligible_at_tick}; state=retired"
                    )),
                ));
            }
            "retire-session" | "restore-session" => {
                if name == "retire-session" && tx.reason.is_none() {
                    return Err(
                        "retire-session 会改变 Session 注意力，transaction 必须提供 (reason \"...\")"
                            .to_string(),
                    );
                }
                require_min_len(
                    op,
                    2,
                    "(retire-session SESSION-ID...) / (restore-session SESSION-ID...)",
                )?;
                for item in op.iter().skip(1) {
                    let id = validated_id(as_atom(item, "session id")?)?;
                    changes.push(change(name, id, tx.reason.clone()));
                }
            }
            "protect" | "unprotect" => {
                if name == "unprotect" && tx.reason.is_none() {
                    return Err(
                        "unprotect 会解除遗忘保护，transaction 必须提供 (reason \"...\")"
                            .to_string(),
                    );
                }
                require_min_len(op, 2, "(protect ID...) / (unprotect ID...)")?;
                for item in op.iter().skip(1) {
                    let raw_id = as_atom(item, "protection target")?;
                    let id = validated_id(raw_id).map_err(|error| {
                        if name == "unprotect" {
                            format!(
                                "unprotect 参数只能是 Context ID；reason 必须写在事务级 (reason \"...\")。{error}"
                            )
                        } else {
                            error
                        }
                    })?;
                    ensure_known(&next, observation_ids, id).map_err(|error| {
                        if name == "unprotect" {
                            format!(
                                "{error}。如果该参数是在说明解除保护原因，请移到事务级 (reason \"...\")"
                            )
                        } else {
                            error
                        }
                    })?;
                    if name == "protect" {
                        next.retiring.remove(id);
                        next.protected.insert(id.to_string());
                    } else if !next.protected.remove(id) {
                        return Err(format!("'{}' 当前没有被 protect", id));
                    }
                    changes.push(change(name, id, tx.reason.clone()));
                }
            }
            "place" => {
                require_len(
                    op,
                    3,
                    "(place FRAME first|last|(before FRAME)|(after FRAME))",
                )?;
                let id = validated_id(atom_at(op, 1, "frame id")?)?;
                place_frame(&mut next, id, &op[2])?;
                changes.push(change("place", id, Some(op[2].to_string())));
            }
            "relate" | "unrelate" => {
                require_len(
                    op,
                    4,
                    "(relate SUBJECT RELATION OBJECT) / (unrelate SUBJECT RELATION OBJECT)",
                )?;
                if name == "unrelate" && tx.reason.is_none() {
                    return Err(
                        "unrelate 会撤销既有语义关系，transaction 必须提供 (reason \"...\")"
                            .to_string(),
                    );
                }
                let subject = validated_id(atom_at(op, 1, "relation subject")?)?;
                let relation = validated_id(atom_at(op, 2, "relation name")?)?;
                let object = validated_id(atom_at(op, 3, "relation object")?)?;
                ensure_known(&next, observation_ids, subject)?;
                ensure_known(&next, observation_ids, object)?;
                let existing = next.relations.iter().position(|candidate| {
                    candidate.subject == subject
                        && candidate.relation == relation
                        && candidate.object == object
                });
                if name == "relate" {
                    if existing.is_some() {
                        return Err(format!(
                            "关系 '{} {} {}' 已存在，无需重复建立",
                            subject, relation, object
                        ));
                    }
                    next.relations.push(ContextRelation {
                        subject: subject.to_string(),
                        relation: relation.to_string(),
                        object: object.to_string(),
                        created_version: next_version,
                    });
                } else if let Some(index) = existing {
                    next.relations.remove(index);
                } else {
                    return Err(format!(
                        "关系 '{} {} {}' 不存在，无法撤销",
                        subject, relation, object
                    ));
                }
                changes.push(change(
                    name,
                    subject,
                    Some(format!("{} {}", relation, object)),
                ));
            }
            "checkpoint" => {
                require_len(op, 2, "(checkpoint ID)")?;
                let id = validated_id(atom_at(op, 1, "checkpoint id")?)?;
                if next
                    .checkpoints
                    .iter()
                    .any(|checkpoint| checkpoint.id == id)
                    || next.frames.iter().any(|frame| frame.id == id)
                    || observation_ids.contains(id)
                {
                    return Err(format!("Checkpoint ID '{}' 已存在", id));
                }
                next.checkpoints.push(MindCheckpoint {
                    id: id.to_string(),
                    frames: next.frames.clone(),
                    relations: next.relations.clone(),
                    retired: next.retired.clone(),
                    retiring: next.retiring.clone(),
                    protected: next.protected.clone(),
                    created_version: next_version,
                });
                changes.push(change(
                    "checkpoint",
                    id,
                    Some(format!("frames={}", next.frames.len())),
                ));
            }
            "rollback" => {
                require_len(op, 2, "(rollback CHECKPOINT_ID)")?;
                let reason = tx
                    .reason
                    .as_ref()
                    .ok_or("rollback 会恢复旧 Mind，transaction 必须提供 (reason \"...\")")?;
                let id = validated_id(atom_at(op, 1, "checkpoint id")?)?;
                let checkpoint = next
                    .checkpoints
                    .iter()
                    .find(|checkpoint| checkpoint.id == id)
                    .cloned()
                    .ok_or_else(|| format!("checkpoint '{}' 不存在", id))?;
                next.frames = checkpoint.frames;
                next.relations = checkpoint.relations;
                next.retired = checkpoint.retired;
                next.retiring = checkpoint.retiring;
                next.protected = checkpoint.protected;
                changes.push(change("rollback", id, Some(reason.clone())));
            }
            "drop-checkpoint" => {
                require_min_len(op, 2, "(drop-checkpoint ID...)")?;
                let reason = tx
                    .reason
                    .as_ref()
                    .ok_or("drop-checkpoint 会删除恢复点，transaction 必须提供 (reason \"...\")")?;
                for item in op.iter().skip(1) {
                    let id = validated_id(as_atom(item, "checkpoint id")?)?;
                    let index = next
                        .checkpoints
                        .iter()
                        .position(|checkpoint| checkpoint.id == id)
                        .ok_or_else(|| format!("checkpoint '{}' 不存在", id))?;
                    next.checkpoints.remove(index);
                    changes.push(change("drop-checkpoint", id, Some(reason.clone())));
                }
            }
            other => {
                return Err(format!(
                    "未知 Context 原语 '{}'。当前支持 create/derive/revise/retire/restore/retire-session/restore-session/protect/unprotect/place/relate/unrelate/checkpoint/rollback/drop-checkpoint",
                    other
                ));
            }
        }
    }

    if retirement_policy.staged {
        let retiring_ids = next.retiring.keys().cloned().collect::<Vec<_>>();
        for target in retiring_ids {
            let successor = next.relations.iter().find_map(|relation| {
                (relation.relation == "supersedes" && relation.object == target)
                    .then(|| {
                        next.frames.iter().find(|frame| {
                            frame.id == relation.subject
                                && frame.sources.iter().any(|source| source == &target)
                                && !next.retired.contains(&frame.id)
                        })
                    })
                    .flatten()
            });
            if let Some(successor) = successor {
                let successor_id = successor.id.clone();
                next.retiring.remove(&target);
                next.retired.insert(target.clone());
                changes.push(change(
                    "retire-frame-finalized",
                    &target,
                    Some(format!("successor={successor_id}; state=retired")),
                ));
            }
        }
    }

    next.version = next_version;
    Ok((next, changes))
}

fn place_frame(state: &mut MindState, id: &str, position: &SExpr) -> Result<(), String> {
    let index = state
        .frames
        .iter()
        .position(|frame| frame.id == id)
        .ok_or_else(|| format!("place 目标 '{}' 不是已存在的 frame", id))?;
    let frame = state.frames.remove(index);

    match position {
        SExpr::Atom(value) if value == "first" => state.frames.insert(0, frame),
        SExpr::Atom(value) if value == "last" => state.frames.push(frame),
        SExpr::List(items) if items.len() == 2 => {
            let relation = atom_at(items, 0, "place relation")?;
            let anchor = atom_at(items, 1, "place anchor")?;
            let anchor_index = state
                .frames
                .iter()
                .position(|candidate| candidate.id == anchor)
                .ok_or_else(|| format!("place 锚点 frame '{}' 不存在", anchor))?;
            match relation {
                "before" => state.frames.insert(anchor_index, frame),
                "after" => state.frames.insert(anchor_index + 1, frame),
                _ => return Err("place 关系只支持 before 或 after".to_string()),
            }
        }
        _ => return Err("place 位置只支持 first、last、(before ID)、(after ID)".to_string()),
    }
    Ok(())
}

struct ContextRenderInput<'a> {
    context_id: &'a str,
    active_session_id: &'a str,
    active_principal_id: Option<&'a str>,
    parent_session_id: Option<&'a str>,
    sessions: &'a [ProjectedSession],
    session_working_set: &'a SessionWorkingSetView,
    active_activations: &'a [ThreadActivationRecord],
    threads: &'a [ThreadRecord],
    thread_signals: &'a [ThreadSignalRecord],
    schedules: &'a [ScheduleRecord],
    activation: Option<&'a ActivationFocus>,
    concurrent_activations: &'a [ConcurrentActivationView],
    background_tasks: &'a [BackgroundTaskView],
    objectives: &'a [ObjectiveRecord],
    execution_targets: &'a [ExecutionTargetRecord],
    execution_target_access: &'a [ExecutionTargetAccessView],
    cognitive_clock: &'a ContextCognitiveClock,
    frame_retirement_cooling_ticks: u64,
    state: &'a MindState,
    observations: &'a [ContextObservation],
    pressure: &'a ContextPressure,
    turn_budget: &'a TurnBudget,
    wake: &'a WakeSignal,
    references: &'a ContextReferences,
}

fn render_current_activation(
    evaluation: &ActivationFocus,
    references: &ContextReferences,
) -> SExpr {
    let mut fields = vec![
        pair("id", atom(&evaluation.activation_id)),
        pair("session", atom(&evaluation.session_id)),
        list(
            "root-turn",
            vec![
                pair("event", atom(references.display(&evaluation.root_turn_id))),
                pair("kind", atom(&evaluation.root_kind)),
                pair("input", atom(&evaluation.root_preview)),
            ],
        ),
        list(
            "trigger",
            vec![
                pair(
                    "event",
                    atom(references.display(&evaluation.trigger_event_id)),
                ),
                pair("kind", atom(&evaluation.trigger_kind)),
                pair("input", atom(&evaluation.trigger_preview)),
            ],
        ),
        list(
            "signal-batch",
            evaluation
                .signal_batch
                .iter()
                .map(|signal| {
                    list(
                        "signal",
                        vec![
                            pair("event", atom(references.display(&signal.event_id))),
                            pair("kind", atom(&signal.kind)),
                            pair("sequence", atom(signal.sequence.to_string())),
                        ],
                    )
                })
                .collect(),
        ),
    ];
    if let Some(objective_id) = &evaluation.objective_id {
        let mut binding = vec![pair("id", atom(objective_id))];
        if let Some(evaluation_id) = &evaluation.objective_evaluation_id {
            binding.push(pair("evaluation", atom(evaluation_id)));
        }
        fields.push(list("objective-binding", binding));
    } else {
        fields.push(pair("objective-binding", atom("none")));
    }
    fields.extend([
        pair(
            "responsibility",
            atom("本次模型请求只推进 root-turn 表达的任务，并只为这条因果链选择工具动作或提交终态输出"),
        ),
        pair(
            "shared-state-boundary",
            atom("Mind、Objective、其他 Session 与 concurrent-activations 是可读取的共享背景，不会自动变成本次任务；除非 root-turn 明确要求，不得接管、重复或继续它们的动作"),
        ),
        pair(
            "progress-query",
            atom("若 root-turn 询问另一分支的进度，只根据 concurrent-activations 与 background-tasks 的物理状态回答；不得为推进被询问分支而重复调用其工具"),
        ),
    ]);
    list("current-activation", fields)
}

/// The final form is repeated after Inbox on purpose. Kernel already carries
/// the same facts, but a very large Encoding can weaken attention to an early
/// routing field. The VM should treat this final `evaluate` form as its single
/// execution entry point; all preceding forms are state.
fn render_evaluation_directive(
    evaluation: &ActivationFocus,
    objectives: &[ObjectiveRecord],
    references: &ContextReferences,
) -> SExpr {
    let mode = if evaluation.objective_id.is_some() {
        "objective-evaluation"
    } else if evaluation.thread_kind == "delivery" {
        "completion-delivery"
    } else if evaluation.root_kind == "chat/user_message" {
        "user-request"
    } else {
        "runtime-continuation"
    };
    let objective_context = objectives
        .iter()
        .filter(|objective| objective.coordinator_session_id == evaluation.session_id)
        .map(|objective| {
            let role = if evaluation.objective_id.as_deref() == Some(objective.id.as_str()) {
                "bound"
            } else {
                "background-read-only"
            };
            let mut fields = vec![
                pair("id", atom(&objective.id)),
                pair("status", atom(objective.status.as_str())),
                pair("revision", atom(objective.revision.to_string())),
                pair("role", atom(role)),
                pair("goal", atom(&objective.stated_objective)),
            ];
            if let Some(active_evaluation_id) = &objective.active_evaluation_id {
                fields.push(pair("active-evaluation", atom(active_evaluation_id)));
            }
            if let Some(reason) = &objective.status_reason {
                fields.push(pair("status-reason", atom(reason)));
            }
            list("objective", fields)
        })
        .collect::<Vec<_>>();
    let thread_kind = activation_thread_kind(evaluation);
    let thread = if thread_kind == "objective" {
        list(
            "thread",
            vec![
                pair("kind", atom("objective")),
                pair(
                    "id",
                    atom(evaluation.objective_id.as_deref().unwrap_or("unknown")),
                ),
                pair("session", atom(&evaluation.session_id)),
                pair("causal-root", atom(&evaluation.root_turn_id)),
            ],
        )
    } else if thread_kind == "dialogue_turn" {
        list(
            "thread",
            vec![
                pair("kind", atom("dialogue-turn")),
                pair("id", atom(&evaluation.session_id)),
                pair("turn", atom(&evaluation.root_turn_id)),
            ],
        )
    } else if thread_kind == "delivery" {
        list(
            "thread",
            vec![
                pair("kind", atom("delivery")),
                pair("id", atom(&evaluation.root_turn_id)),
                pair("session", atom(&evaluation.session_id)),
            ],
        )
    } else {
        list(
            "thread",
            vec![
                pair("kind", atom("execution")),
                pair("id", atom(&evaluation.root_turn_id)),
                pair("parent-dialogue", atom(&evaluation.session_id)),
                pair("origin-turn", atom(&evaluation.root_turn_id)),
            ],
        )
    };
    let mut fields = vec![
            list(
                "activation",
                vec![
                    pair("id", atom(&evaluation.activation_id)),
                    list(
                        "caused-by",
                        vec![list(
                            "signal-batch",
                            evaluation
                                .signal_batch
                                .iter()
                                .map(|signal| atom(references.display(&signal.event_id)))
                                .collect(),
                        )],
                    ),
                ],
            ),
            thread,
            pair("mode", atom(mode)),
            pair(
                "objective-binding",
                atom(evaluation.objective_id.as_deref().unwrap_or("none")),
            ),
            pair("root-kind", atom(&evaluation.root_kind)),
            pair("root-input", atom(&evaluation.root_preview)),
            pair(
                "instruction",
                atom(if thread_kind == "delivery" {
                    "这是完成交付求值。只读取本次 completion snapshot 在 kernel.thread-scheduler 中呈现的 delivery=pending/deferred 结果，并结合最新并发状态；可把本批结果合并为一条普通文本。本次求值开始后新完成的结果属于下一批。不要调用物理工具，不要重复 delivery=delivered 的结果；确实无需通知时独占调用 no_reply"
                } else {
                    "现在只求值 root-input。DialogueTurn Thread 处理当前对话；工具结果只延续其所属 Execution Thread。共享 Mind、历史、其他 Thread 与未绑定的 Objective 只提供背景，不得取代 root-input 成为行动目标"
                }),
            ),
            pair(
                "tool-gate",
                atom(if thread_kind == "delivery" {
                    "delivery composer 只做复杂结果的语义编排与交付，不得调用物理工具；普通文本会原子覆盖本次可见的 pending completion"
                } else {
                    "仅当完成 root-input 确实需要尚不存在的新外部结果时调用工具；可由当前 Encoding 直接回答时必须立即返回普通文本，不得为未绑定 Objective 调用工具"
                }),
            ),
            pair(
                "terminal",
                atom("每个 user-request 都必须独立产生面向当前 Session 的普通文本回复，除非语义上确实应静默并显式调用 no_reply"),
            ),
        ];
    if !objective_context.is_empty() {
        fields.push(list("objective-context", objective_context));
    }
    list("evaluate", fields)
}

fn render_concurrent_activations(
    evaluations: &[ConcurrentActivationView],
    references: &ContextReferences,
) -> SExpr {
    list(
        "concurrent-activations",
        evaluations
            .iter()
            .map(|evaluation| {
                let mut fields = vec![
                    pair("id", atom(&evaluation.activation_id)),
                    pair("session", atom(&evaluation.session_id)),
                    pair(
                        "root-turn",
                        atom(references.display(&evaluation.root_turn_id)),
                    ),
                    pair("thread-kind", atom(&evaluation.thread_kind)),
                    pair("thread-id", atom(&evaluation.thread_id)),
                    pair("status", atom(&evaluation.status)),
                    pair("root-input", atom(&evaluation.root_preview)),
                ];
                if !evaluation.pending_tools.is_empty() {
                    fields.push(list(
                        "pending-tools",
                        evaluation.pending_tools.iter().map(atom).collect(),
                    ));
                }
                list("activation", fields)
            })
            .collect(),
    )
}

fn render_background_tasks(tasks: &[BackgroundTaskView], references: &ContextReferences) -> SExpr {
    list(
        "background-tasks",
        tasks
            .iter()
            .map(|task| {
                let mut fields = vec![
                    pair("id", atom(&task.task_id)),
                    pair("session", atom(&task.session_id)),
                    pair("status", atom(&task.status)),
                    pair("command", atom(&task.command_preview)),
                    pair("elapsed-seconds", atom(task.elapsed_secs.to_string())),
                    pair(
                        "last-output-age-seconds",
                        atom(task.last_output_age_secs.to_string()),
                    ),
                ];
                if let Some(root_turn_id) = &task.root_turn_id {
                    fields.push(pair("root-turn", atom(references.display(root_turn_id))));
                }
                if let Some(next_wakeup_at) = &task.next_wakeup_at {
                    fields.push(pair("next-wakeup-at", atom(next_wakeup_at)));
                }
                list("task", fields)
            })
            .collect(),
    )
}

fn render_thread_scheduler(
    threads: &[ThreadRecord],
    activations: &[ThreadActivationRecord],
    signals: &[ThreadSignalRecord],
    scheduled: &[ScheduleRecord],
    background_tasks: &[BackgroundTaskView],
) -> SExpr {
    let thread_entries = threads
        .iter()
        .map(|thread| {
            let mut fields = vec![
                pair("id", atom(&thread.id)),
                pair("root-turn", atom(&thread.root_turn_id)),
                pair("session", atom(&thread.session_id)),
                pair("kind", atom(thread.kind.as_str())),
                pair("lifecycle", atom(thread.lifecycle.as_str())),
                pair(
                    "phase",
                    atom(
                        derive_thread_phase(
                            thread,
                            activations,
                            signals,
                            scheduled,
                            background_tasks,
                        )
                        .as_str(),
                    ),
                ),
                pair("revision", atom(thread.revision.to_string())),
                pair("executor", atom(&thread.executor_kind)),
                pair("delivery", atom(thread.delivery_status.as_str())),
            ];
            if let Some(executor_id) = &thread.executor_id {
                fields.push(pair("executor-id", atom(executor_id)));
            }
            if let Some(target_id) = &thread.target_id {
                fields.push(pair("execution-target", atom(target_id)));
            }
            if let Some(result) = &thread.result_text {
                let (preview, truncated) = preview_text(result, 640);
                fields.push(pair("result", atom(&preview)));
                if truncated {
                    fields.push(pair("result-truncated", atom("true")));
                }
            }
            list("thread", fields)
        })
        .collect::<Vec<_>>();
    let scheduled_entries = scheduled
        .iter()
        .map(|intent| {
            let (intent_preview, truncated) = preview_text(&intent.intent, 640);
            let mut fields = vec![
                pair("id", atom(&intent.id)),
                pair("thread", atom(&intent.thread_id)),
                pair("status", atom(intent.status.as_str())),
                pair("intent", atom(&intent_preview)),
            ];
            if truncated {
                fields.push(pair("intent-truncated", atom("true")));
            }
            if let Some(not_before) = intent.not_before {
                fields.push(pair("not-before", atom(not_before.to_rfc3339())));
            }
            if let Some(interval_seconds) = intent.interval_seconds {
                fields.push(pair("every-seconds", atom(interval_seconds.to_string())));
            }
            if !intent.dependency_thread_ids.is_empty() {
                fields.push(list(
                    "after",
                    intent.dependency_thread_ids.iter().map(atom).collect(),
                ));
            }
            list("scheduled", fields)
        })
        .collect::<Vec<_>>();
    list(
        "thread-scheduler",
        vec![
            list("threads", thread_entries),
            list("queue", scheduled_entries),
        ],
    )
}

fn derive_thread_phase(
    thread: &ThreadRecord,
    activations: &[ThreadActivationRecord],
    signals: &[ThreadSignalRecord],
    scheduled: &[ScheduleRecord],
    background_tasks: &[BackgroundTaskView],
) -> ThreadPhase {
    if thread.lifecycle.is_terminal() {
        return ThreadPhase::Idle;
    }
    if activations.iter().any(|activation| {
        activation.root_turn_id == thread.root_turn_id
            && activation.status == crate::memory::ThreadActivationStatus::Running
    }) {
        return ThreadPhase::Running;
    }
    if signals
        .iter()
        .any(|signal| signal.thread_id == thread.id && signal.status == ThreadSignalStatus::Pending)
        || activations.iter().any(|activation| {
            activation.root_turn_id == thread.root_turn_id
                && activation.status == crate::memory::ThreadActivationStatus::Queued
        })
    {
        return ThreadPhase::Runnable;
    }
    if scheduled
        .iter()
        .any(|intent| intent.thread_id == thread.id && intent.status == ScheduleStatus::Queued)
        || background_tasks.iter().any(|task| {
            task.root_turn_id.as_deref() == Some(thread.root_turn_id.as_str())
                && !matches!(task.status.as_str(), "completed" | "failed" | "cancelled")
        })
    {
        return ThreadPhase::Waiting;
    }
    ThreadPhase::Idle
}

fn render_wake(wake: &WakeSignal, references: &ContextReferences) -> SExpr {
    let mut fields = vec![
        pair("cause", atom(&wake.cause)),
        pair(
            "visible-in-inbox",
            atom(if wake.visible_in_inbox {
                "true"
            } else {
                "false"
            }),
        ),
    ];
    if let Some(event_id) = &wake.event_id {
        fields.push(pair("event", atom(references.display(event_id))));
    }
    if let Some(tool_name) = &wake.tool_name {
        fields.push(pair("tool", atom(tool_name)));
    }
    list("wake", fields)
}

fn render_turn_control(turn_budget: &TurnBudget) -> SExpr {
    list(
        "turn-control",
        vec![
            pair("attempt", atom(turn_budget.attempt.to_string())),
            pair(
                "checkpoint-interval",
                atom(turn_budget.checkpoint_interval.to_string()),
            ),
            pair(
                "next-checkpoint-at",
                atom(turn_budget.next_checkpoint_at.to_string()),
            ),
            pair(
                "attempts-until-checkpoint",
                atom(turn_budget.attempts_until_checkpoint.to_string()),
            ),
            pair(
                "checkpoint-due",
                atom(if turn_budget.checkpoint_due {
                    "true"
                } else {
                    "false"
                }),
            ),
            pair(
                "context-transactions-used",
                atom(turn_budget.context_transactions_used.to_string()),
            ),
            pair(
                "context-transactions-limit",
                atom(turn_budget.context_transactions_limit.to_string()),
            ),
            pair(
                "context-tx-available",
                atom(if turn_budget.context_tx_available {
                    "true"
                } else {
                    "false"
                }),
            ),
            pair("phase", atom(&turn_budget.phase)),
        ],
    )
}

fn render_objectives(objectives: &[ObjectiveRecord]) -> SExpr {
    list(
        "objectives",
        objectives
            .iter()
            .map(|objective| {
                let mut fields = vec![
                    pair("id", atom(&objective.id)),
                    pair("status", atom(objective.status.as_str())),
                    pair("revision", atom(objective.revision.to_string())),
                    pair("statement", atom(&objective.stated_objective)),
                    pair(
                        "coordinator-session",
                        atom(&objective.coordinator_session_id),
                    ),
                    pair("delivery-session", atom(&objective.delivery_session_id)),
                    pair(
                        "wait",
                        objective
                            .wait_condition
                            .as_ref()
                            .map(render_objective_wait)
                            .unwrap_or_else(|| atom("none")),
                    ),
                ];
                if let Some(evaluation_id) = &objective.active_evaluation_id {
                    fields.push(pair("evaluation", atom(evaluation_id)));
                }
                if let Some(reason) = &objective.status_reason {
                    fields.push(pair("status-reason", atom(reason)));
                }
                if let Some(token_budget) = objective.token_budget {
                    fields.push(pair("token-budget", atom(token_budget.to_string())));
                    fields.push(pair("tokens-used", atom(objective.tokens_used.to_string())));
                }
                list("objective", fields)
            })
            .collect(),
    )
}

fn render_objective_wait(wait: &crate::memory::ObjectiveWaitCondition) -> SExpr {
    use crate::memory::ObjectiveWaitCondition;
    match wait {
        ObjectiveWaitCondition::ToolTask { task_id } => {
            list("tool-task", vec![pair("task-id", atom(task_id))])
        }
        ObjectiveWaitCondition::Delegation { delegation_id } => list(
            "delegation",
            vec![pair("delegation-id", atom(delegation_id))],
        ),
        ObjectiveWaitCondition::Timer { deadline } => {
            list("timer", vec![pair("deadline", atom(deadline.to_rfc3339()))])
        }
        ObjectiveWaitCondition::Permission { request_id } => {
            list("permission", vec![pair("request-id", atom(request_id))])
        }
        ObjectiveWaitCondition::UserInput { session_id } => {
            list("user-input", vec![pair("session-id", atom(session_id))])
        }
        ObjectiveWaitCondition::ExternalEvent {
            topic,
            correlation_id,
        } => list(
            "external-event",
            vec![
                pair("topic", atom(topic)),
                pair("correlation-id", atom(correlation_id)),
            ],
        ),
        ObjectiveWaitCondition::ResourceAvailable { resource } => {
            list("resource-available", vec![pair("resource", atom(resource))])
        }
    }
}

fn execution_target_access_view(
    target: &ExecutionTargetRecord,
    authorizations: &[ExecutionTargetAuthorizationRecord],
    agent_id: Option<&str>,
    context_id: &str,
    thread_id: Option<&str>,
) -> ExecutionTargetAccessView {
    if target.owner_principal_id.is_none() {
        return ExecutionTargetAccessView {
            target_id: target.id.clone(),
            authorization_mode: "global".to_string(),
            matching_scopes: Vec::new(),
        };
    }
    let target_authorizations = authorizations
        .iter()
        .filter(|authorization| authorization.target_id == target.id)
        .collect::<Vec<_>>();
    if target_authorizations.is_empty() {
        return ExecutionTargetAccessView {
            target_id: target.id.clone(),
            authorization_mode: "owner_wide".to_string(),
            matching_scopes: Vec::new(),
        };
    }
    let mut matching_scopes = target_authorizations
        .into_iter()
        .filter(|authorization| authorization.status == ExecutionTargetAuthorizationStatus::Active)
        .filter_map(|authorization| {
            let matches = match authorization.scope {
                ExecutionTargetAuthorizationScope::Agent => {
                    agent_id.is_some_and(|id| id == authorization.scope_id)
                }
                ExecutionTargetAuthorizationScope::Context => context_id == authorization.scope_id,
                ExecutionTargetAuthorizationScope::Thread => {
                    thread_id.is_some_and(|id| id == authorization.scope_id)
                }
            };
            matches.then_some(authorization.scope)
        })
        .collect::<Vec<_>>();
    matching_scopes.sort_by_key(|scope| scope.as_str());
    matching_scopes.dedup();
    ExecutionTargetAccessView {
        target_id: target.id.clone(),
        authorization_mode: if agent_id.is_none() {
            "scoped_unknown"
        } else if matching_scopes.is_empty() {
            "scoped_denied"
        } else {
            "scoped_authorized"
        }
        .to_string(),
        matching_scopes,
    }
}

fn render_execution_targets(
    targets: &[ExecutionTargetRecord],
    access: &[ExecutionTargetAccessView],
) -> SExpr {
    let default_id = targets
        .iter()
        .find(|target| target.id == crate::execution_target::DEFAULT_EXECUTION_TARGET_ID)
        .map(|target| target.id.as_str())
        .unwrap_or("none");
    let mut fields = vec![pair("default", atom(default_id))];
    fields.extend(targets.iter().map(|target| {
        let access = access.iter().find(|entry| entry.target_id == target.id);
        let mut target_fields = vec![
            pair("id", atom(&target.id)),
            pair("status", atom(target.status.as_str())),
            pair("kind", atom(target.kind.as_str())),
            pair(
                "authorization",
                atom(
                    access
                        .map(|entry| entry.authorization_mode.as_str())
                        .unwrap_or("unknown"),
                ),
            ),
        ];
        if let Some(access) = access.filter(|entry| !entry.matching_scopes.is_empty()) {
            target_fields.push(list(
                "matching-scopes",
                access
                    .matching_scopes
                    .iter()
                    .map(|scope| atom(scope.as_str()))
                    .collect(),
            ));
        }
        if let Some(platform) = target.platform.as_deref() {
            target_fields.push(pair("platform", atom(platform)));
        }
        if let Some(provider_node_id) = target.provider_node_id.as_deref() {
            target_fields.push(pair("provider-node", atom(provider_node_id)));
        }
        if !target.capabilities.is_empty() {
            target_fields.push(list(
                "capabilities",
                target.capabilities.iter().map(atom).collect(),
            ));
        }
        list("target", target_fields)
    }));
    list("execution-targets", fields)
}

fn render_context(input: ContextRenderInput<'_>) -> String {
    let ContextRenderInput {
        context_id,
        active_session_id,
        active_principal_id,
        parent_session_id,
        sessions,
        session_working_set,
        active_activations,
        threads,
        thread_signals,
        schedules,
        activation,
        concurrent_activations,
        background_tasks,
        objectives,
        execution_targets,
        execution_target_access,
        cognitive_clock,
        frame_retirement_cooling_ticks,
        state,
        observations,
        pressure,
        turn_budget,
        wake,
        references,
    } = input;
    let mut kernel = vec![atom("kernel"), pair("context", atom(context_id))];
    kernel.push(pair("active-session", atom(active_session_id)));
    kernel.push(list(
        "active-principal",
        vec![
            pair("id", atom(active_principal_id.unwrap_or("unknown"))),
            pair("authority", atom("runtime")),
            pair(
                "binding",
                atom(if active_principal_id.is_some() {
                    "verified"
                } else {
                    "unknown"
                }),
            ),
        ],
    ));
    if let Some(parent) = parent_session_id {
        kernel.push(pair("parent-session", atom(parent)));
    }
    kernel.push(pair("version", atom(state.version.to_string())));
    if !execution_targets.is_empty() {
        kernel.push(render_execution_targets(
            execution_targets,
            execution_target_access,
        ));
    }
    kernel.push(list(
        "cognitive-clock",
        vec![
            pair("tick", atom(cognitive_clock.tick.to_string())),
            pair("source", atom("signal-batch")),
            pair(
                "last-advanced-by",
                cognitive_clock
                    .last_signal_batch_id
                    .as_deref()
                    .map(atom)
                    .unwrap_or_else(|| atom("none")),
            ),
        ],
    ));
    kernel.push(list(
        "frame-retirement-policy",
        vec![
            pair("clock", atom("cognitive-activity")),
            pair(
                "cooling-ticks",
                atom(frame_retirement_cooling_ticks.to_string()),
            ),
            pair("observation-retire", atom("immediate")),
            pair(
                "capacity-relief-priority",
                atom("discard-absorbed-observations-first"),
            ),
            pair("ordinary-frame-retire", atom("organizing-window")),
            pair("ordinary-frame-immediate-token-relief", atom("0")),
            pair(
                "frame-selection",
                atom("semantic-value-validity-usage-and-relations"),
            ),
            pair("frame-size-alone", atom("never-a-retirement-reason")),
            pair("successor-fast-path", atom("sources-and-supersedes")),
        ],
    ));
    if let Some(evaluation) = activation {
        kernel.push(render_current_activation(evaluation, references));
    }
    kernel.push(pair(
        "in-flight-activations",
        atom(
            active_activations
                .iter()
                .filter(|item| !item.status.is_terminal())
                .count()
                .to_string(),
        ),
    ));
    if !threads.is_empty() || !schedules.is_empty() {
        kernel.push(render_thread_scheduler(
            threads,
            active_activations,
            thread_signals,
            schedules,
            background_tasks,
        ));
    }
    if !concurrent_activations.is_empty() {
        kernel.push(render_concurrent_activations(
            concurrent_activations,
            references,
        ));
    }
    if !background_tasks.is_empty() {
        kernel.push(render_background_tasks(background_tasks, references));
    }
    if !objectives.is_empty() {
        kernel.push(render_objectives(objectives));
    }
    kernel.push(render_wake(wake, references));
    kernel.push(list(
        "context-pressure",
        vec![
            pair("level", atom(&pressure.level)),
            pair(
                "estimated-tokens",
                atom(pressure.estimated_tokens.to_string()),
            ),
            pair("token-source", atom(&pressure.token_source)),
            pair("token-accuracy", atom(&pressure.token_accuracy)),
            pair("token-scope", atom(&pressure.token_scope)),
            pressure
                .token_model
                .as_deref()
                .map(|model| pair("token-model", atom(model)))
                .unwrap_or_else(|| pair("token-model", atom("unknown"))),
            pair("soft-limit", atom(pressure.soft_limit.to_string())),
            pair("hard-limit", atom(pressure.hard_limit.to_string())),
            pair(
                "maintenance-reserve",
                atom(pressure.maintenance_reserve.to_string()),
            ),
            pair("active-frames", atom(pressure.active_frames.to_string())),
            pair(
                "active-observations",
                atom(pressure.active_observations.to_string()),
            ),
        ],
    ));
    kernel.push(render_turn_control(turn_budget));

    kernel.push(list(
        "session-working-set",
        vec![
            pair(
                "active-window-seconds",
                atom(session_working_set.active_window_secs.to_string()),
            ),
            pair(
                "max-sessions",
                atom(session_working_set.max_sessions.to_string()),
            ),
            list(
                "current",
                session_working_set
                    .current_session_ids
                    .iter()
                    .map(atom)
                    .collect(),
            ),
            pair(
                "included-count",
                atom(session_working_set.full_session_ids.len().to_string()),
            ),
            list(
                "excluded",
                vec![
                    pair(
                        "archived",
                        atom(session_working_set.excluded.archived.to_string()),
                    ),
                    pair(
                        "retired",
                        atom(session_working_set.excluded.retired.to_string()),
                    ),
                    pair(
                        "outside-window",
                        atom(session_working_set.excluded.outside_window.to_string()),
                    ),
                    pair(
                        "over-count",
                        atom(session_working_set.excluded.over_count.to_string()),
                    ),
                    pair(
                        "token-budget",
                        atom(session_working_set.excluded.token_budget.to_string()),
                    ),
                ],
            ),
            pair("selection", atom(&session_working_set.selection)),
            pair(
                "absence-semantics",
                atom("not projected does not mean nonexistent; use recall or Session control metadata when evidence is required"),
            ),
        ],
    ));

    let session_directory = list(
        "session-directory",
        sessions
            .iter()
            .map(|entry| {
                let session = &entry.session;
                let mut fields = vec![
                    pair("id", atom(&session.id)),
                    pair("status", atom(session.status.as_str())),
                    pair("attention", atom(session.attention_state.as_str())),
                    pair(
                        "attention-revision",
                        atom(session.attention_revision.to_string()),
                    ),
                    pair(
                        "projection",
                        atom(match entry.projection {
                            SessionProjection::Full => "full",
                            SessionProjection::MetadataOnly => "metadata-only",
                        }),
                    ),
                    pair("title", atom(&session.title)),
                    pair("last-activity", atom(session.last_activity_at.to_rfc3339())),
                ];
                fields.push(list(
                    "principals",
                    entry.principal_ids.iter().map(atom).collect(),
                ));
                if let Some(parent) = &session.parent_session_id {
                    fields.push(pair("parent-session", atom(parent)));
                }
                if let Some(reason) = &session.attention_reason {
                    fields.push(pair("attention-reason", atom(reason)));
                }
                if !entry.active_activation_ids.is_empty() {
                    fields.push(list(
                        "active-activations",
                        entry.active_activation_ids.iter().map(atom).collect(),
                    ));
                }
                if !entry.active_objective_ids.is_empty() {
                    fields.push(list(
                        "active-objectives",
                        entry.active_objective_ids.iter().map(atom).collect(),
                    ));
                }
                list("session", fields)
            })
            .collect(),
    );

    let mut mind = vec![atom("mind")];
    for frame in state
        .frames
        .iter()
        .filter(|frame| !state.retired.contains(&frame.id))
    {
        let body = parse(&frame.body).unwrap_or_else(|_| atom(&frame.body));
        let sources = list(
            "sources",
            frame
                .sources
                .iter()
                .map(|source| atom(references.display(source)))
                .collect::<Vec<SExpr>>(),
        );
        let provenance = list(
            "provenance",
            vec![
                pair(
                    "state",
                    atom(match frame.provenance.state {
                        FrameProvenanceState::Unknown => "unknown",
                        FrameProvenanceState::Unattributed => "unattributed",
                        FrameProvenanceState::Attributed => "attributed",
                    }),
                ),
                pair("authority", atom("runtime-derived")),
                list(
                    "formation",
                    vec![
                        pair(
                            "principal",
                            atom(
                                frame
                                    .provenance
                                    .formed_principal_id
                                    .as_deref()
                                    .unwrap_or("unknown"),
                            ),
                        ),
                        pair(
                            "session",
                            atom(
                                frame
                                    .provenance
                                    .formed_session_id
                                    .as_deref()
                                    .unwrap_or("unknown"),
                            ),
                        ),
                    ],
                ),
                list(
                    "source-principals",
                    frame
                        .provenance
                        .source_principal_ids
                        .iter()
                        .map(atom)
                        .collect(),
                ),
                list(
                    "source-sessions",
                    frame
                        .provenance
                        .source_session_ids
                        .iter()
                        .map(atom)
                        .collect(),
                ),
            ],
        );
        let mut fields = vec![
            pair("id", atom(&frame.id)),
            pair("revision", atom(frame.revision.to_string())),
            pair("created-version", atom(frame.created_version.to_string())),
            pair("updated-version", atom(frame.updated_version.to_string())),
            pair(
                "protected",
                atom(if state.protected.contains(&frame.id) {
                    "true"
                } else {
                    "false"
                }),
            ),
            sources,
            provenance,
            pair("body", body),
        ];
        let lifecycle = if let Some(retirement) = state.retiring.get(&frame.id) {
            list(
                "lifecycle",
                vec![
                    pair("state", atom("retiring")),
                    pair(
                        "requested-at-tick",
                        atom(retirement.requested_at_tick.to_string()),
                    ),
                    pair(
                        "eligible-at-tick",
                        atom(retirement.eligible_at_tick.to_string()),
                    ),
                    pair(
                        "remaining-ticks",
                        atom(
                            retirement
                                .eligible_at_tick
                                .saturating_sub(cognitive_clock.tick)
                                .to_string(),
                        ),
                    ),
                    pair("reason", atom(&retirement.reason)),
                ],
            )
        } else {
            list("lifecycle", vec![pair("state", atom("active"))])
        };
        fields.insert(2, lifecycle);
        let freshness = freshness_for_id(state, &frame.id);
        if freshness.latest.is_some()
            || !freshness.supersedes.is_empty()
            || !freshness.superseded_by.is_empty()
        {
            fields.insert(5, render_freshness(&freshness, references));
        }
        let active_references = state
            .frames
            .iter()
            .filter(|candidate| !state.retired.contains(&candidate.id))
            .filter(|candidate| candidate.sources.contains(&frame.id))
            .count();
        if active_references > 0 {
            fields.insert(
                5,
                list(
                    "usage",
                    vec![pair(
                        "referenced-by-active-frames",
                        atom(active_references.to_string()),
                    )],
                ),
            );
        }
        mind.push(list("frame", fields));
    }
    if !state.relations.is_empty() {
        mind.push(list(
            "relations",
            state
                .relations
                .iter()
                .map(|relation| {
                    list(
                        "relation",
                        vec![
                            pair("subject", atom(references.display(&relation.subject))),
                            pair("type", atom(&relation.relation)),
                            pair("object", atom(references.display(&relation.object))),
                            pair(
                                "created-version",
                                atom(relation.created_version.to_string()),
                            ),
                        ],
                    )
                })
                .collect(),
        ));
    }
    if !state.checkpoints.is_empty() {
        mind.push(list(
            "checkpoints",
            state
                .checkpoints
                .iter()
                .map(|checkpoint| {
                    list(
                        "checkpoint",
                        vec![
                            pair("id", atom(&checkpoint.id)),
                            pair(
                                "created-version",
                                atom(checkpoint.created_version.to_string()),
                            ),
                            pair("frames", atom(checkpoint.frames.len().to_string())),
                            pair("relations", atom(checkpoint.relations.len().to_string())),
                        ],
                    )
                })
                .collect(),
        ));
    }

    let mut inbox = vec![atom("inbox")];
    let mut observation_state = vec![atom("observation-state")];
    for observation in observations {
        let mut fields = vec![
            pair("ref", atom(&observation.reference)),
            pair("seq", atom(observation.sequence.to_string())),
            pair("turn", atom(observation.turn.to_string())),
        ];
        if let Some(session_id) = &observation.session_id {
            fields.push(pair("session", atom(session_id)));
        }
        if let Some(principal_id) = &observation.principal_id {
            fields.push(pair("principal", atom(principal_id)));
        }
        if let Some(attempt) = observation.attempt {
            fields.push(pair("attempt", atom(attempt.to_string())));
        }
        if let Some(caused_by) = &observation.caused_by {
            fields.push(pair("caused-by", atom(caused_by)));
        }
        if let Some(tool_name) = &observation.tool_name {
            fields.push(pair("tool", atom(tool_name)));
        }
        fields.extend([
            pair("kind", atom(&observation.kind)),
            pair("topic", atom(&observation.topic)),
            pair("actor", atom(&observation.actor)),
            pair("timestamp", atom(&observation.timestamp)),
            list(
                "content",
                vec![
                    pair("representation", atom(&observation.representation)),
                    pair("visible-chars", atom(observation.visible_chars.to_string())),
                    pair("total-chars", atom(observation.total_chars.to_string())),
                    pair("text", atom(&observation.preview)),
                ],
            ),
        ]);
        if let Some(tool_status) = &observation.tool_status {
            fields.push(pair("tool-status", atom(tool_status)));
        }
        if let Some(output_empty) = observation.output_empty {
            fields.push(pair(
                "output-empty",
                atom(if output_empty { "true" } else { "false" }),
            ));
        }
        if let Some(resource) = &observation.resource {
            let mut resource_fields = vec![
                pair("kind", atom(&resource.kind)),
                pair("key", atom(&resource.key)),
            ];
            if let Some(version) = &resource.version {
                resource_fields.push(pair("version", atom(version)));
            }
            fields.push(list("resource", resource_fields));
        }
        inbox.push(list("observation", fields));

        // Observation payload and causal identity are immutable Ledger facts.
        // Mutable projection metadata lives after the long Inbox so changes
        // in protection, residency, freshness, or usage do not invalidate the
        // cached prefix containing earlier observations.
        let mut state_fields = vec![
            pair("ref", atom(&observation.reference)),
            pair(
                "protected",
                atom(if observation.protected {
                    "true"
                } else {
                    "false"
                }),
            ),
            list(
                "residency",
                vec![
                    pair("state", atom("active")),
                    pair(
                        "retrievable",
                        atom(if observation.retrievable {
                            "true"
                        } else {
                            "false"
                        }),
                    ),
                ],
            ),
        ];
        if observation.freshness.latest.is_some()
            || !observation.freshness.supersedes.is_empty()
            || !observation.freshness.superseded_by.is_empty()
        {
            state_fields.push(render_freshness(&observation.freshness, references));
        }
        if observation.usage != ContextUsage::default() {
            state_fields.push(render_usage(&observation.usage));
        }
        observation_state.push(list("state", state_fields));
    }

    // Prefix-cache order is a physical request invariant. The immutable
    // protocol and append-mostly Inbox must precede all ordinary per-request
    // state. Retiring an old observation intentionally changes the Inbox and
    // starts a new cache lineage; ordinary wake/budget/Mind changes do not.
    let mut context = vec![
        atom("context"),
        render_protocol(),
        list("evaluation-profile", vec![atom("none")]),
        SExpr::List(inbox),
        SExpr::List(observation_state),
        SExpr::List(mind),
        session_directory,
        SExpr::List(kernel),
        list("evaluation-environment", Vec::new()),
    ];
    if let Some(evaluation) = activation {
        context.push(render_evaluation_directive(
            evaluation, objectives, references,
        ));
    }
    SExpr::List(context).to_string()
}

fn freshness_for_id(state: &MindState, id: &str) -> ContextFreshness {
    let mut freshness = ContextFreshness::default();
    for relation in &state.relations {
        if relation.relation != "supersedes" {
            continue;
        }
        if relation.subject == id {
            freshness.latest.get_or_insert(true);
            freshness.supersedes.push(relation.object.clone());
        }
        if relation.object == id {
            freshness.latest = Some(false);
            freshness.superseded_by.push(relation.subject.clone());
        }
    }
    freshness
}

fn render_freshness(freshness: &ContextFreshness, references: &ContextReferences) -> SExpr {
    let mut fields = Vec::new();
    if let Some(latest) = freshness.latest {
        fields.push(pair("latest", atom(if latest { "true" } else { "false" })));
    }
    if !freshness.supersedes.is_empty() {
        fields.push(list(
            "supersedes",
            freshness
                .supersedes
                .iter()
                .map(|id| atom(references.display(id)))
                .collect(),
        ));
    }
    if !freshness.superseded_by.is_empty() {
        fields.push(list(
            "superseded-by",
            freshness
                .superseded_by
                .iter()
                .map(|id| atom(references.display(id)))
                .collect(),
        ));
    }
    list("freshness", fields)
}

fn render_usage(usage: &ContextUsage) -> SExpr {
    let mut fields = Vec::new();
    for (name, value) in [
        ("recall-count-total", usage.recall_count_total),
        ("recall-count-recent", usage.recall_count_recent),
        ("reference-count-total", usage.reference_count_total),
        ("reference-count-recent", usage.reference_count_recent),
        (
            "referenced-by-active-frames",
            usage.referenced_by_active_frames,
        ),
    ] {
        if value > 0 {
            fields.push(pair(name, atom(value.to_string())));
        }
    }
    if let Some(sequence) = usage.last_recalled_sequence {
        fields.push(pair("last-recalled-seq", atom(sequence.to_string())));
    }
    if let Some(sequence) = usage.last_referenced_sequence {
        fields.push(pair("last-referenced-seq", atom(sequence.to_string())));
    }
    list("usage", fields)
}

fn render_protocol() -> SExpr {
    let operations = CONTEXT_OPERATIONS
        .iter()
        .map(|operation| {
            list(
                "operation",
                vec![
                    pair("name", atom(operation.name)),
                    pair("syntax", atom(operation.syntax)),
                    pair("meaning", atom(operation.meaning)),
                ],
            )
        })
        .collect::<Vec<_>>();

    list(
        "protocol",
        vec![
            pair("version", atom(CONTEXT_PROTOCOL_VERSION.to_string())),
            list(
                "layout-contract",
                vec![
                    pair(
                        "physical-order",
                        atom("protocol → evaluation-profile → inbox → observation-state → mind → session-directory → kernel → evaluation-environment → evaluate"),
                    ),
                    pair(
                        "prefix",
                        atom("protocol 与 evaluation-profile 是当前协议/能力谱系；inbox 是按 Ledger 顺序投影的追加式证据前缀"),
                    ),
                    pair(
                        "dynamic-tail",
                        atom("observation-state、mind、session-directory、kernel、evaluation-environment 与 evaluate 是当前求值状态；evaluate 始终是最后且唯一的执行入口"),
                    ),
                    pair(
                        "retirement",
                        atom("retire 旧 observation 会重写 inbox 投影并有意开启新的缓存谱系；普通 wake、预算或 active-session 变化不得改写此前的稳定证据字节"),
                    ),
                    pair(
                        "profile",
                        atom("evaluation-profile 是内容寻址的稳定 Harness 定义；本轮绑定只允许出现在 evaluation-environment"),
                    ),
                ],
            ),
            list(
                "routing-contract",
                vec![
                    pair("ownership", atom("一个 Cognitive Context 持有一个共享 Mind 与多个 Session")),
                    pair("session-role", atom("Session 是输入输出连接与进展边界，不拥有独立 Mind")),
                    pair("active-session", atom("本次求值唯一的输入来源与普通文本回复目标；不是 Context 的全局唯一活动 Session")),
                    pair("concurrency", atom("同一 Context 可有多个 Session 同时进行各自求值与回复")),
                    pair("shared-evidence", atom("inbox observation 按 session 标记来源，但均属于当前 Context，可跨 Session 推理与复用")),
                    pair("reply-routing", atom("无工具普通 assistant 文本与可见 progress 必须对应 kernel.active-session；其他 Session 使用 send_message")),
                    pair("write-serialization", atom("context_tx 修改共享 Mind；Runtime 按 Context 串行提交并执行 version 检查")),
                ],
            ),
            list(
                "evaluation-responsibility-contract",
                vec![
                    pair(
                        "current",
                        atom("Context 最后的 evaluate 是本次模型请求唯一的执行入口；kernel.current-activation 提供同一事实的详细机器状态"),
                    ),
                    pair(
                        "thread-model",
                        atom("Session 的 Dialogue Lane 只排序普通对话的首次求值；每条用户输入创建有限的 DialogueTurn Thread；从该 turn 发起并由工具结果延续的工作属于独立 Execution Thread；Objective 使用 Objective Thread"),
                    ),
                    pair(
                        "root-turn",
                        atom("root-turn 是一个 Thread 的稳定因果根；它不是整个 Session 的对话历史"),
                    ),
                    pair(
                        "trigger",
                        atom("trigger 是唤醒本次 Activation 的最新 Signal；用户消息进入新的 DialogueTurn Thread，工具结果只延续其所属 Execution Thread，不会把其他 Thread 合并进来"),
                    ),
                    pair(
                        "concurrent",
                        atom("kernel.concurrent-activations 是同一 Context 中其他 Execution / Objective Thread 的只读运行状态，不是当前 DialogueTurn Thread 的待办列表"),
                    ),
                    pair(
                        "pending-tool",
                        atom("pending-tools 表示其他分支已经发起且尚未收到结果的工具调用；不得从本次 Activation 重复发起"),
                    ),
                    pair(
                        "progress",
                        atom("进度询问应直接依据 Thread、Activation、pending-tools 与 background-tasks 的物理状态作答；未知就明确说未知，不得虚构结果"),
                    ),
                    pair(
                        "objective-binding",
                        atom("evaluate.objective-binding=none 时，Objective 状态只用于理解背景和回答进度，不得推进 Objective 或为它调用工具；只有显式 bound 的 Objective Thread 才能推进目标"),
                    ),
                ],
            ),
            list(
                "session-concurrency-contract",
                vec![
                    pair(
                        "identity",
                        atom("Agent 可同时运行多个 Thread Activation；Session 只是 IO 路由和局部连续性边界"),
                    ),
                    pair(
                        "ordering",
                        atom("Ledger seq 表示物理写入顺序；thread/activation/caused-by 表示计算与工具因果链"),
                    ),
                    pair(
                        "tool-wait",
                        atom("等待某个 Tool 不会阻塞同一或其他 Session 的新用户消息求值"),
                    ),
                    pair(
                        "late-result",
                        atom("迟到结果必须结合后续 Ledger 与最新 Shared Mind 重新判断，不得静默恢复已被取代的旧计划"),
                    ),
                    pair(
                        "reply-uniqueness",
                        atom("每个 session + root-turn 最多提交一次终态 Reply；重复提交由 Runtime 抑制"),
                    ),
                ],
            ),
            list(
                "session-attention-contract",
                vec![
                    pair(
                        "working-set",
                        atom("时间窗口、数量与 token budget 只控制本轮投影；未出现不等于 Session 不存在"),
                    ),
                    pair(
                        "retire-session",
                        atom("Agent 主动移出自动认知候选；不删除 Session、Ledger 或 Shared Mind Frame"),
                    ),
                    pair(
                        "restore-session",
                        atom("重新允许 Session 进入自动 Working Set 候选"),
                    ),
                    pair(
                        "auto-restore",
                        atom("retired Session 收到新定向事件时 Runtime 确定性恢复，并强制作为 current full projection"),
                    ),
                ],
            ),
            render_contract(
                "reality-contract",
                REALITY_CONTRACT_NAME,
                REALITY_CONTRACT,
            ),
            render_contract(
                "epistemic-contract",
                EPISTEMIC_CONTRACT_NAME,
                EPISTEMIC_CONTRACT,
            ),
            list(
                "metadata-semantics",
                vec![
                    pair(
                        "ref",
                        atom("@eN 是由 Ledger sequence 派生的稳定短引用；recall 与 context_tx 原样使用，Runtime 提交前解析为完整 ID"),
                    ),
                    pair("seq", atom("全局稳定顺序号；越大表示越晚写入 Ledger")),
                    pair("turn", atom("所属用户回合；用于区分近期与历史")),
                    pair("attempt", atom("所属模型执行尝试")),
                    pair("caused-by", atom("产生本 observation 的调用或事件")),
                    pair(
                        "residency",
                        atom("observation-state 中的当前投影状态；content.representation 表示 full 全文、preview 预览或 recalled-chunk 召回片段"),
                    ),
                    pair(
                        "freshness",
                        atom("新旧关系；latest 只表示较新，不自动代表更正确"),
                    ),
                    pair(
                        "usage",
                        atom("只统计主动 recall 与 from 语义引用；被动展示不算有效使用"),
                    ),
                    pair(
                        "resource",
                        atom("工具可选提供的通用资源 kind/key/version；不限定为代码文件"),
                    ),
                    pair(
                        "observation-state",
                        atom("按 ref 覆盖 Inbox observation 的可变保护、驻留、新旧关系与使用统计；Inbox 中的因果身份和 content 是 Ledger 投影事实"),
                    ),
                ],
            ),
            list(
                "objective-contract",
                vec![
                    pair(
                        "identity",
                        atom("Objective 是属于 Cognitive Context 的持久 Runtime 控制对象；Mind 仍由 Agent 自由表达目标的计划、经验与认识"),
                    ),
                    pair(
                        "creation",
                        atom("Agent 可用 objective_create 把当前 Session 中真正需要跨 Evaluation、异步等待或重启恢复的工作升级为 First-Class Objective；Runtime 生成 ID 并绑定当前 Agent/Context/Session，普通问答或一次求值可完成的动作不得创建，existing 回执后不得重复创建"),
                    ),
                    pair(
                        "evaluation",
                        atom("一次 Thread Activation 只是 Objective 的一个执行切片；普通文本或 no_reply 只结束本次 Activation，不表示长期 Objective 已完成"),
                    ),
                    pair(
                        "completion",
                        atom("只有调用 objective_update(status=completed) 并通过 revision 与证据引用校验，才会把 Objective 提交为完成；不得从回复文本猜测完成"),
                    ),
                    pair(
                        "continuation",
                        atom("active 且 wait=none 时，ObjectiveSupervisor 会在当前 Activation 终态后产生下一次 Signal；软检查点、Context 压力或单次错误都不能冒充完成"),
                    ),
                    pair(
                        "waiting",
                        atom("等待工具任务、Delegation、审批、定时器、用户输入或外部事件时，用 objective_update(status=active, wait_condition=...) 登记精确条件；Runtime 事件驱动唤醒，禁止轮询"),
                    ),
                    pair(
                        "blocked",
                        atom("blocked 只表示没有确定可等待事件且当前确实没有可靠进展路径；存在 wait_condition 时必须保持 active"),
                    ),
                    pair(
                        "control-authority",
                        atom("Agent 可创建当前路由内的 Objective，并提交 active-wait、blocked、completed；pause、resume、cancel 属于用户或 Runtime 控制面"),
                    ),
                    pair(
                        "revision",
                        atom("每次 objective_update 必须使用 kernel.objectives 中最新 base_revision；冲突时重新读取，不得覆盖并发控制状态"),
                    ),
                    pair(
                        "evidence",
                        atom("evidence_refs 必须引用当前 Context 中真实 Ledger 事件；Runtime 验证存在性与时序，业务充分性仍由 Agent 判断"),
                    ),
                ],
            ),
            list(
                "thread-scheduler-contract",
                vec![
                    pair(
                        "authority",
                        atom("Runtime 提供持久化、单飞、顺序、依赖和定时机制；Agent 负责判断串行、并行、依赖与何时交付"),
                    ),
                    pair(
                        "current-thread",
                        atom("直接物理工具调用继承 kernel.current-activation 的 Thread；任意数量工具结果都回到同一 mailbox，不创建新 Thread"),
                    ),
                    pair(
                        "enqueue",
                        atom("schedule_tx enqueue 把 intent 串行加入 thread_id；省略 thread_id 时延续当前 Thread"),
                    ),
                    pair(
                        "spawn",
                        atom("schedule_tx spawn 创建可与当前工作并行的独立 Thread；client_id 可被同一事务的 after 以 $client_id 引用"),
                    ),
                    pair(
                        "dependency",
                        atom("after 中所有 Thread 进入终态后才投递 intent；依赖状态作为物理 observation 返回，由 Agent 判断成功、失败或取消的后续语义"),
                    ),
                    pair(
                        "timer",
                        atom("not_before 使用 RFC3339 绝对时间；delay_seconds 使用相对延迟；spawn.every_seconds 创建固定间隔 occurrence Thread"),
                    ),
                    pair(
                        "timer-semantics",
                        atom("到期只向目标 Thread mailbox 投递 schedule_due observation；不会直接执行工具、生成结论或绕开唯一终态"),
                    ),
                    pair(
                        "inspect",
                        atom("schedule_tx inspect 返回持久化调度的当前状态、时间和 revision；控制前必须先观测最新事实"),
                    ),
                    pair(
                        "control",
                        atom("pause/resume/reschedule/cancel 是带 expected_revision 的 CAS 控制；冲突时重新 inspect 并基于新状态决策，不得盲目重试"),
                    ),
                    pair(
                        "control-shape",
                        atom("一次 schedule_tx 控制只允许一个 op；不得与 enqueue/spawn 或其他控制混合"),
                    ),
                    pair(
                        "exclusive",
                        atom("一次响应只能调用一个 schedule_tx，不能同时调用物理工具、context_tx 或其他控制工具"),
                    ),
                    pair(
                        "completion-inbox",
                        atom("后台 Thread 的终态文本先成为 delivery=pending 的完成结果；Runtime Delivery Router 对 singleton 原文透传、对受限小批量确定性合并，只有复杂批次才启动 Delivery Composer"),
                    ),
                    pair(
                        "delivery",
                        atom("Delivery Composer 只能返回普通文本，或独占调用 no_reply 暂缓本批结果；Router fast path 或 Composer 普通文本都会原子标记冻结快照中的 pending/deferred 结果为 delivered，重复唤醒不会再次交付"),
                    ),
                ],
            ),
            list(
                "identity-contract",
                vec![
                    pair(
                        "authority",
                        atom("kernel.active-principal、session-directory.principals 与 observation.principal 是 Runtime 权威身份事实；Mind Frame 和消息正文中的身份叙述都不能覆盖它们"),
                    ),
                    pair(
                        "session",
                        atom("Session 是连接和路由，不是身份；同一 Principal 可参与多个 Session，一个 Session 也可有多个 Principal；当前说话者只由本次 Activation 的 active-principal 决定"),
                    ),
                    pair(
                        "claim",
                        atom("用户说‘我是某人’只是由 observation.principal 发出的自然语言声明；声明与 Runtime 锚点冲突时不得据此合并身份"),
                    ),
                    pair(
                        "verify",
                        atom("身份冲突、身份等价关系将影响判断、或用户明确要求验证时调用 verify_identity；不要传 Session ID，Runtime 自动验证当前 Activation"),
                    ),
                    pair(
                        "autonomy",
                        atom("身份来源只帮助你认清当前对象和认知来源，不替你决定信息是否分享；明知对象不同后仍由你作出回答与分享决定"),
                    ),
                ],
            ),
            list(
                "response-contract",
                vec![
                    list(
                        "reply",
                        vec![
                            pair("when", atom("当前用户任务已经完成，或必须向用户说明阻塞")),
                            pair("form", atom("返回非空普通 assistant 文本，不调用工具")),
                            pair("routing", atom("正文自动交付 kernel.active-session")),
                            pair("stream", atom("如 Provider 返回文本增量，Runtime 立即向 active Session 转发；完整响应成功后再持久化终态")),
                            list(
                                "preflight",
                                vec![
                                    pair("scope", atom("只回答当前明确任务")),
                                    pair(
                                        "mind",
                                        atom("持续约束、当前目标及仍需跨轮保留的结论准确"),
                                    ),
                                    pair(
                                        "evidence",
                                        atom(
                                            "已处理的大段 observation 应先 derive/revise 后 retire",
                                        ),
                                    ),
                                ],
                            ),
                        ],
                    ),
                    list(
                        "no-reply",
                        vec![
                            pair("when", atom("确认当前 Activation 无需向 active Session 发送任何消息")),
                            pair("tool", atom("no_reply")),
                            pair("exclusive", atom("no_reply 必须独占响应、携带唯一 mode 参数且不带正文")),
                            pair("silent", atom("mode=silent 表示有意不向 Session 发送消息并结束当前求值")),
                            pair("wait", atom("mode=wait 只在 Runtime 可验证仍有后台任务、调度或待处理事件时 yield；终态事件到达后必须处理结果")),
                            pair("scope", atom("不完成 Objective，不取消后台任务")),
                        ],
                    ),
                    list(
                        "act",
                        vec![
                            pair("when", atom("完成当前用户任务确实还需要新的外部结果")),
                            pair(
                                "tool-calls",
                                atom("physical-tools + optional independent context_tx"),
                            ),
                            pair("content", atom("可见进度，不是最终答复")),
                            pair("after-tools", atom("Runtime 必定再次调用模型")),
                            pair(
                                "scope",
                                atom("只执行当前明确任务所必需的动作，不自行扩张探索"),
                            ),
                        ],
                    ),
                    list(
                        "maintain",
                        vec![
                            pair(
                                "when",
                                atom("需要先修改 Mind；normal/notice 不得仅为降低体积而维护"),
                            ),
                            pair("tool", atom("context_tx")),
                            pair("content", atom("empty | visible progress; 不是最终答复")),
                            pair(
                                "after-commit",
                                atom("Runtime 必定再次调用；非 critical 时冷却 context_tx，必须返回普通文本、调用 no_reply 或执行 act"),
                            ),
                        ],
                    ),
                    list(
                        "schedule",
                        vec![
                            pair(
                                "when",
                                atom("需要显式决定串行、并行、依赖或定时执行"),
                            ),
                            pair("tool", atom("schedule_tx")),
                            pair(
                                "exclusive",
                                atom("schedule_tx 必须是响应中唯一的一次工具调用"),
                            ),
                            pair(
                                "after-commit",
                                atom("Runtime 返回持久化调度回执并再次调用模型；再向 active Session 说明安排"),
                            ),
                        ],
                    ),
                    list(
                        "deliver-completions",
                        vec![
                            pair(
                                "when",
                                atom("current-activation.thread.kind=delivery；一个或多个 Execution Thread 已完成并等待面向 Session 交付"),
                            ),
                            pair(
                                "input",
                                atom("只读取本次 completion snapshot 在 kernel.thread-scheduler 中可见的 delivery=pending/deferred result，并结合当前 Session 与其他并发 Thread 的物理状态；新完成结果留给下一次 Delivery"),
                            ),
                            pair(
                                "form",
                                atom("返回一条可合并多个完成结果的普通 assistant 文本；不得调用物理工具"),
                            ),
                            pair(
                                "defer",
                                atom("确实暂不应通知时独占调用 no_reply，结果保留为 deferred，可由后续完成事件再次编排"),
                            ),
                        ],
                    ),
                ],
            ),
            list(
                "session-output-contract",
                vec![
                    pair("current", atom("无工具的普通文本只回复 kernel.active-session")),
                    pair("other-session-tool", atom("send_message {session_id,content}")),
                    pair("other-session", atom("send_message 只向同一 Agent 的其他 Session 主动投递，不结束当前 Activation，不触发目标 Session 求值")),
                    pair("current-session-guard", atom("不得用 send_message 回复 active Session；Runtime 会拒绝")),
                    pair("context-boundary", atom("context_tx 只修改共享 Mind，不能向用户发送消息")),
                ],
            ),
            list(
                "tool-result-contract",
                vec![
                    pair(
                        "immediate-delivery",
                        atom("当前用户回合内按标准 assistant.tool_calls → role=tool/tool_call_id 返回"),
                    ),
                    pair(
                        "persistence",
                        atom("物理工具结果在返回前已写入 Ledger，并在 tool result 中提供 observation_ref"),
                    ),
                    pair(
                        "no-duplicate",
                        atom("同一模型请求中，经 role=tool 交付的结果正文不会同时重复出现在 inbox"),
                    ),
                    pair(
                        "later-context",
                        atom("下一独立 Context 快照会按 active/retired 状态重新展示历史工具 observation"),
                    ),
                    pair(
                        "empty-output",
                        atom("status=success 且 output_state=empty 表示工具已完成但无文本；不得仅因空输出重复调用"),
                    ),
                ],
            ),
            list(
                "skill-discovery-contract",
                vec![
                    pair(
                        "scope",
                        atom("仅当本轮 Function Calling 提供 list_skills 时适用；Skill 是按需读取的能力说明，不是自动执行的工具"),
                    ),
                    pair(
                        "intent",
                        atom("以 evaluate.root-input 表达的当前意图为检索条件，不绑定平台、领域或具体 Skill 名称"),
                    ),
                    list(
                        "fallback",
                        vec![
                            pair(
                                "primary",
                                atom("优先使用本轮已有且能直接满足当前意图的 Function Calling 工具"),
                            ),
                            pair(
                                "backup",
                                atom("primary 没有适用能力或明确失败时，调用 list_skills 取得紧凑目录；只选择最相关的 Skill，用 read 读取其 SKILL.md，再按说明调用真实工具"),
                            ),
                        ],
                    ),
                    pair(
                        "failure-boundary",
                        atom("只有直接能力与按需 Skill 发现都不能满足当前意图后，才能向 Session 声明能力不可用"),
                    ),
                    pair(
                        "token-policy",
                        atom("不得预读全部 SKILL.md；目录只用于选择，选择后只读取完成当前意图所需的最少 Skill"),
                    ),
                ],
            ),
            list(
                "context-tx-contract",
                vec![
                    pair("tool", atom("context_tx")),
                    pair("argument", atom("transaction")),
                    pair(
                        "syntax",
                        atom("(context-tx (base-version N) (reason \"...\") OP...)"),
                    ),
                    pair("reason-scope", atom("transaction-only")),
                    pair("body-arity", atom("create derive revise one-or-more")),
                    pair(
                        "body-normalization",
                        atom("多个 BODY 由 Runtime 确定性保存为 (context-body BODY...)；单 BODY 保持原样"),
                    ),
                    pair(
                        "revise-semantics",
                        atom("完整替换 frame body，不是局部 merge；所有仍需保留的字段必须重述"),
                    ),
                    pair(
                        "source-placement",
                        atom("create 不接受 from；derive/revise 的可选 (from SOURCE...) 必须紧跟 ID，且 from 之后至少有一个 BODY"),
                    ),
                    pair(
                        "body-example",
                        atom("(create task (goal x) (constraints y) (status active))"),
                    ),
                    pair(
                        "compound-example",
                        atom("(context-tx (base-version 3) (reason \"完成收口\") (revise task (status completed) (next none)) (derive result (from @e27) (tests passed) (confidence high)) (protect task result) (retire @e21 @e22))"),
                    ),
                    pair(
                        "reason-required-for",
                        atom("retire unprotect unrelate rollback drop-checkpoint"),
                    ),
                    pair(
                        "checkpoint-policy",
                        atom("由 Agent 在高风险重组前显式建立；Runtime 不自动回滚或修补语义"),
                    ),
                    pair(
                        "relation-policy",
                        atom("Runtime 只解释 supersedes 的新旧关系；其他 relation 保持 Agent 语义"),
                    ),
                    list(
                        "frame-retirement-policy",
                        vec![
                            pair(
                                "observation",
                                atom("retire 立即生效并在下一次编码释放其活动块 Token"),
                            ),
                            pair(
                                "ordinary-frame",
                                atom("retire 只进入整理期；正文仍在活动 Context，当前 Token 释放量为 0"),
                            ),
                            pair(
                                "organizing-window",
                                atom("优先 revise 精简，或 derive/relate 形成更高阶 successor；revise、restore、protect 会取消旧退休意图"),
                            ),
                            pair(
                                "successor",
                                atom("活跃 successor 同时以 sources 引用旧 Frame 并声明 supersedes 后，旧 Frame 可在同一事务立即退休"),
                            ),
                            pair(
                                "selection",
                                atom("Frame 数量本身不是退休理由；重复、失效、已被取代或已形成更高抽象才是整理理由"),
                            ),
                            pair(
                                "critical-pressure",
                                atom("先清理已消化 observation；若仍不足，应精简 Frame 或建立 successor，不要依赖批量普通 Frame retire 立即释放容量"),
                            ),
                            pair(
                                "retrieval",
                                atom("retired 不等于删除；可通过关键词、Frame ID、sources 与 relation 链 recall 和 restore"),
                            ),
                        ],
                    ),
                    list("operations", operations),
                ],
            ),
        ],
    )
}

fn render_contract(section: &str, contract_name: &str, clauses: &[ContractClause]) -> SExpr {
    list(
        section,
        vec![
            pair("name", atom(contract_name)),
            list(
                "clauses",
                clauses
                    .iter()
                    .map(|clause| {
                        list(
                            "clause",
                            vec![
                                pair("name", atom(clause.key)),
                                pair("meaning", atom(clause.meaning)),
                            ],
                        )
                    })
                    .collect(),
            ),
        ],
    )
}

fn pressure_for(
    estimated_tokens: usize,
    active_frames: usize,
    active_observations: usize,
    config: &OrchestratorConfig,
) -> ContextPressure {
    let critical_at = config
        .context_hard_token_limit
        .saturating_sub(config.context_maintenance_reserve_tokens);
    let notice_at = config.context_soft_token_limit.saturating_mul(3) / 4;
    let level = if estimated_tokens >= critical_at {
        "critical"
    } else if estimated_tokens >= config.context_soft_token_limit {
        "warning"
    } else if estimated_tokens >= notice_at {
        "notice"
    } else {
        "normal"
    };
    ContextPressure {
        level: level.to_string(),
        estimated_tokens,
        token_source: default_context_token_source(),
        token_accuracy: default_context_token_accuracy(),
        token_scope: default_context_token_scope(),
        token_model: None,
        soft_limit: config.context_soft_token_limit,
        hard_limit: config.context_hard_token_limit,
        maintenance_reserve: config.context_maintenance_reserve_tokens,
        active_frames,
        active_observations,
    }
}

fn turn_budget_for(events: &[Event], config: &OrchestratorConfig) -> TurnBudget {
    let checkpoint_interval = config.attempt_soft_checkpoint_interval.max(1);
    let context_transactions_limit = config.max_context_transactions_per_turn.max(1);
    let after_cycle_boundary = events
        .iter()
        // Objective evaluations are continuations of the same user-owned work,
        // not fresh maintenance budgets. Resetting here allowed a stuck
        // Objective to receive another emergency allowance indefinitely.
        .rposition(|event| event.event_type == TYPE_USER_MESSAGE)
        .map(|index| &events[index + 1..])
        .unwrap_or(events);
    let assistant_calls = after_cycle_boundary
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .collect::<Vec<_>>();
    let context_transactions_used = assistant_calls
        .iter()
        .filter(|event| {
            event
                .payload
                .get("continuation_tool_calls")
                // Backward compatibility for calls persisted before the
                // one-shot continuation envelope rename.
                .or_else(|| event.payload.get("transcript_tool_calls"))
                .or_else(|| event.payload.get("tool_calls"))
                .and_then(|value| value.as_array())
                .is_some_and(|calls| {
                    calls.iter().any(|call| {
                        call.get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(|value| value.as_str())
                            == Some("context_tx")
                    })
                })
        })
        .count();
    // Attempt 表示本用户回合或 Objective continuation cycle 内的模型求值次数，
    // 而不是工具调用数量；一次响应中
    // 并行发起多个工具仍只算一次。检查点仅在整倍数的求值上出现一次，下一次
    // 求值自动恢复 work，不会形成需要额外状态解除的硬门槛。
    let attempt = assistant_calls.len().saturating_add(1);
    let checkpoint_due = attempt % checkpoint_interval == 0;
    let next_checkpoint_at = if checkpoint_due {
        attempt
    } else {
        attempt
            .saturating_div(checkpoint_interval)
            .saturating_add(1)
            .saturating_mul(checkpoint_interval)
    };
    let phase = if checkpoint_due {
        "soft-checkpoint"
    } else {
        "work"
    };
    TurnBudget {
        attempt,
        checkpoint_interval,
        next_checkpoint_at,
        attempts_until_checkpoint: next_checkpoint_at.saturating_sub(attempt),
        checkpoint_due,
        context_transactions_used,
        context_transactions_limit,
        context_tx_available: context_transactions_used < context_transactions_limit,
        phase: phase.to_string(),
    }
}

fn wake_for(events: &[Event]) -> WakeSignal {
    let latest = events.iter().rev().find(|event| {
        event.event_type == TYPE_USER_MESSAGE
            || event.event_type == TYPE_TOOL_OUTPUT
            || event.event_type == TYPE_INFER_REQUEST
    });
    let Some(event) = latest else {
        return WakeSignal {
            cause: "session-start".to_string(),
            event_id: None,
            tool_name: None,
            visible_in_inbox: false,
        };
    };
    wake_for_event(event)
}

fn wake_for_event(event: &Event) -> WakeSignal {
    let tool_name = event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    let cause = if event.event_type == TYPE_USER_MESSAGE {
        "user-message"
    } else if event.topic == "chat/dialogue_retry" {
        // This is the same logical DialogueTurn with a new fenced generation,
        // not a new user utterance or an unrelated infer program.
        "dialogue-retry"
    } else if event.event_type == TYPE_INFER_REQUEST {
        // The Agent has to be able to tell that its own half-evaluated program
        // is what is waiting, not a person.
        "infer-request"
    } else if tool_name.as_deref() == Some("context_tx") {
        "context-transaction-result"
    } else if tool_name.as_deref() == Some("objective_supervisor") {
        "objective-continuation"
    } else {
        "tool-output"
    };
    WakeSignal {
        cause: cause.to_string(),
        event_id: Some(event.id.clone()),
        tool_name,
        visible_in_inbox: is_observation(event),
    }
}

fn project_mind_seed(source: &MindState) -> MindState {
    let frame_ids = source
        .frames
        .iter()
        .map(|frame| frame.id.clone())
        .collect::<HashSet<_>>();
    let frames = source
        .frames
        .iter()
        .cloned()
        .map(|mut frame| {
            frame
                .sources
                .retain(|source_id| frame_ids.contains(source_id));
            frame.created_version = 0;
            frame.updated_version = 0;
            frame
        })
        .collect::<Vec<_>>();
    let relations = source
        .relations
        .iter()
        .filter(|relation| {
            frame_ids.contains(&relation.subject) && frame_ids.contains(&relation.object)
        })
        .cloned()
        .map(|mut relation| {
            relation.created_version = 0;
            relation
        })
        .collect::<Vec<_>>();
    MindState {
        version: 0,
        frames,
        relations,
        retired: source
            .retired
            .iter()
            .filter(|id| frame_ids.contains(*id))
            .cloned()
            .collect(),
        // Retirement windows belong to the source Context's cognitive clock;
        // a newly seeded Context starts with no inherited pending intent.
        retiring: BTreeMap::new(),
        protected: source
            .protected
            .iter()
            .filter(|id| frame_ids.contains(*id))
            .cloned()
            .collect(),
        checkpoints: Vec::new(),
    }
}

fn mind_state_hash(state: &MindState) -> Result<String, String> {
    let bytes =
        serde_json::to_vec(state).map_err(|error| format!("Mind Snapshot 无法序列化: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

/// Hash view used before Context protocol v22 introduced Runtime-derived
/// Frame provenance. `serde(default)` makes those records readable, but the
/// added field still changes their serialized bytes and therefore their
/// projection fence. Keep the exact legacy field order for hash validation.
#[derive(Serialize)]
struct ContextFrameHashV21<'a> {
    id: &'a str,
    body: &'a str,
    sources: &'a [String],
    revision: u64,
    created_version: u64,
    updated_version: u64,
}

impl<'a> From<&'a ContextFrame> for ContextFrameHashV21<'a> {
    fn from(frame: &'a ContextFrame) -> Self {
        Self {
            id: &frame.id,
            body: &frame.body,
            sources: &frame.sources,
            revision: frame.revision,
            created_version: frame.created_version,
            updated_version: frame.updated_version,
        }
    }
}

#[derive(Serialize)]
struct MindCheckpointHashV21<'a> {
    id: &'a str,
    frames: Vec<ContextFrameHashV21<'a>>,
    relations: &'a [ContextRelation],
    retired: &'a BTreeSet<String>,
    retiring: &'a BTreeMap<String, FrameRetirement>,
    protected: &'a BTreeSet<String>,
    created_version: u64,
}

#[derive(Serialize)]
struct MindStateHashV21<'a> {
    version: u64,
    frames: Vec<ContextFrameHashV21<'a>>,
    relations: &'a [ContextRelation],
    retired: &'a BTreeSet<String>,
    retiring: &'a BTreeMap<String, FrameRetirement>,
    protected: &'a BTreeSet<String>,
    checkpoints: Vec<MindCheckpointHashV21<'a>>,
}

fn context_frames_hash_v21(frames: &[ContextFrame]) -> Vec<ContextFrameHashV21<'_>> {
    frames.iter().map(Into::into).collect()
}

fn has_only_legacy_frame_provenance(state: &MindState) -> bool {
    let legacy = FrameIdentityProvenance::default();
    state.frames.iter().all(|frame| frame.provenance == legacy)
        && state.checkpoints.iter().all(|checkpoint| {
            checkpoint
                .frames
                .iter()
                .all(|frame| frame.provenance == legacy)
        })
}

fn mind_state_hash_v21(state: &MindState) -> Result<Option<String>, String> {
    if !has_only_legacy_frame_provenance(state) {
        return Ok(None);
    }
    let legacy = MindStateHashV21 {
        version: state.version,
        frames: context_frames_hash_v21(&state.frames),
        relations: &state.relations,
        retired: &state.retired,
        retiring: &state.retiring,
        protected: &state.protected,
        checkpoints: state
            .checkpoints
            .iter()
            .map(|checkpoint| MindCheckpointHashV21 {
                id: &checkpoint.id,
                frames: context_frames_hash_v21(&checkpoint.frames),
                relations: &checkpoint.relations,
                retired: &checkpoint.retired,
                retiring: &checkpoint.retiring,
                protected: &checkpoint.protected,
                created_version: checkpoint.created_version,
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&legacy)
        .map_err(|error| format!("Mind v21 Snapshot 无法序列化: {error}"))?;
    Ok(Some(format!("{:x}", Sha256::digest(bytes))))
}

/// Hash schema used by Context protocol v20, before cognitive Frame
/// retirement added the `retiring` maps to Mind and checkpoint state.
///
/// Projection hashes fence serialized state, so adding a serde-defaulted field
/// changes the digest even when its semantic value is empty. Keep the old
/// schema explicit instead of weakening validation or rewriting a database on
/// read. New writes always use `mind_state_hash`; this candidate is accepted
/// only for states which can be represented losslessly by v20.
#[derive(Serialize)]
struct MindCheckpointHashV20<'a> {
    id: &'a str,
    frames: Vec<ContextFrameHashV21<'a>>,
    relations: &'a [ContextRelation],
    retired: &'a BTreeSet<String>,
    protected: &'a BTreeSet<String>,
    created_version: u64,
}

#[derive(Serialize)]
struct MindStateHashV20<'a> {
    version: u64,
    frames: Vec<ContextFrameHashV21<'a>>,
    relations: &'a [ContextRelation],
    retired: &'a BTreeSet<String>,
    protected: &'a BTreeSet<String>,
    checkpoints: Vec<MindCheckpointHashV20<'a>>,
}

fn mind_state_hash_v20(state: &MindState) -> Result<Option<String>, String> {
    if !state.retiring.is_empty()
        || !has_only_legacy_frame_provenance(state)
        || state
            .checkpoints
            .iter()
            .any(|checkpoint| !checkpoint.retiring.is_empty())
    {
        return Ok(None);
    }
    let legacy = MindStateHashV20 {
        version: state.version,
        frames: context_frames_hash_v21(&state.frames),
        relations: &state.relations,
        retired: &state.retired,
        protected: &state.protected,
        checkpoints: state
            .checkpoints
            .iter()
            .map(|checkpoint| MindCheckpointHashV20 {
                id: &checkpoint.id,
                frames: context_frames_hash_v21(&checkpoint.frames),
                relations: &checkpoint.relations,
                retired: &checkpoint.retired,
                protected: &checkpoint.protected,
                created_version: checkpoint.created_version,
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&legacy)
        .map_err(|error| format!("Mind v20 Snapshot 无法序列化: {error}"))?;
    Ok(Some(format!("{:x}", Sha256::digest(bytes))))
}

fn mind_state_hash_matches(state: &MindState, recorded_hash: &str) -> Result<bool, String> {
    if mind_state_hash(state)? == recorded_hash {
        return Ok(true);
    }
    if mind_state_hash_v21(state)?.as_deref() == Some(recorded_hash) {
        return Ok(true);
    }
    Ok(mind_state_hash_v20(state)?.as_deref() == Some(recorded_hash))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn hex_decode(value: &str) -> Result<Vec<u8>, DynError> {
    if !value.len().is_multiple_of(2) {
        return Err("十六进制 cursor 长度无效".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| {
            let text = std::str::from_utf8(chunk)?;
            Ok(u8::from_str_radix(text, 16)?)
        })
        .collect()
}

fn frame_recall_document(
    context_id: &str,
    state: &MindState,
    frame: &ContextFrame,
    retired_override: Option<bool>,
) -> RecallDocument {
    let mut text = format!("{} {}", frame.id, frame.body);
    if let Some(retirement) = state.retiring.get(&frame.id) {
        text.push_str(" retiring ");
        text.push_str(&retirement.reason);
    }
    for source in &frame.sources {
        text.push(' ');
        text.push_str(source);
    }
    if let Some(principal_id) = &frame.provenance.formed_principal_id {
        text.push(' ');
        text.push_str(principal_id);
    }
    if let Some(session_id) = &frame.provenance.formed_session_id {
        text.push(' ');
        text.push_str(session_id);
    }
    for principal_id in &frame.provenance.source_principal_ids {
        text.push(' ');
        text.push_str(principal_id);
    }
    for session_id in &frame.provenance.source_session_ids {
        text.push(' ');
        text.push_str(session_id);
    }
    for relation in state
        .relations
        .iter()
        .filter(|relation| relation.subject == frame.id || relation.object == frame.id)
    {
        text.push(' ');
        text.push_str(&relation.subject);
        text.push(' ');
        text.push_str(&relation.relation);
        text.push(' ');
        text.push_str(&relation.object);
    }
    let searchable_text = crate::memory::segment_recall_text(&text);
    let retired = retired_override.unwrap_or_else(|| state.retired.contains(&frame.id));
    let state_hash = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}:{}:{}:{}",
                frame.revision, retired, searchable_text, state.version
            )
            .as_bytes()
        )
    );
    RecallDocument {
        context_id: context_id.to_string(),
        document_kind: RecallDocumentKind::Frame,
        document_id: frame.id.clone(),
        revision: frame.revision,
        searchable_text,
        preview: frame.body.chars().take(500).collect(),
        retired,
        updated_sequence: state.version,
        state_hash,
    }
}

fn all_frame_recall_documents(context_id: &str, state: &MindState) -> Vec<RecallDocument> {
    state
        .frames
        .iter()
        .map(|frame| frame_recall_document(context_id, state, frame, None))
        .collect()
}

fn changed_frame_recall_documents(
    context_id: &str,
    current: &MindState,
    next: &MindState,
) -> Vec<RecallDocument> {
    let current_frames = current
        .frames
        .iter()
        .map(|frame| (frame.id.as_str(), frame))
        .collect::<HashMap<_, _>>();
    let next_frames = next
        .frames
        .iter()
        .map(|frame| (frame.id.as_str(), frame))
        .collect::<HashMap<_, _>>();
    let mut affected = BTreeSet::new();
    for id in current_frames.keys().chain(next_frames.keys()) {
        if current_frames.get(id) != next_frames.get(id)
            || current.retired.contains(*id) != next.retired.contains(*id)
            || current.retiring.get(*id) != next.retiring.get(*id)
        {
            affected.insert((*id).to_string());
        }
    }
    if current.relations != next.relations {
        for relation in current.relations.iter().chain(&next.relations) {
            affected.insert(relation.subject.clone());
            affected.insert(relation.object.clone());
        }
    }
    affected
        .into_iter()
        .filter_map(|id| {
            next_frames
                .get(id.as_str())
                .map(|frame| frame_recall_document(context_id, next, frame, None))
                .or_else(|| {
                    current_frames.get(id.as_str()).map(|frame| {
                        // Rollback may remove a Frame from the current Mind. Its
                        // immutable history remains searchable as inactive.
                        frame_recall_document(context_id, current, frame, Some(true))
                    })
                })
        })
        .collect()
}

fn replay_context_transaction_event(
    state: &MindState,
    event: &Event,
    observation_origins: &HashMap<String, ContextSourceOrigin>,
) -> Result<MindState, String> {
    let transaction = event
        .payload
        .get("transaction")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("Context transaction '{}' 缺少 transaction", event.id))?;
    let parsed = parse_transaction(transaction)
        .map_err(|error| format!("Context transaction '{}' 无法重放: {}", event.id, error))?;
    if let Some(recorded_before_hash) = event
        .payload
        .get("before_hash")
        .and_then(|value| value.as_str())
    {
        if !mind_state_hash_matches(state, recorded_before_hash)? {
            return Err(format!(
                "Context transaction '{}' 的 before_hash 不一致",
                event.id
            ));
        }
    }
    let retirement_policy = if event
        .payload
        .get("frame_retirement_policy")
        .and_then(|value| value.as_str())
        == Some("cognitive-cooling-v1")
    {
        FrameRetirementPolicy::cognitive(
            event
                .payload
                .get("cognitive_tick")
                .and_then(|value| value.as_u64())
                .ok_or_else(|| format!("Context transaction '{}' 缺少 cognitive_tick", event.id))?,
            event
                .payload
                .get("frame_retirement_cooling_ticks")
                .and_then(|value| value.as_u64())
                .ok_or_else(|| {
                    format!(
                        "Context transaction '{}' 缺少 frame_retirement_cooling_ticks",
                        event.id
                    )
                })?,
        )
    } else {
        FrameRetirementPolicy::legacy_immediate()
    };
    let observation_ids = observation_origins.keys().cloned().collect::<HashSet<_>>();
    let provenance_enabled = event
        .payload
        .get("frame_provenance_version")
        .and_then(|value| value.as_u64())
        == Some(1);
    let formation = FrameFormationContext {
        enabled: provenance_enabled,
        formed_principal_id: event_principal(event),
        formed_session_id: event_session(event),
        observation_origins: Some(observation_origins),
    };
    let (candidate, replayed_changes) = apply_parsed_transaction_with_policy_and_provenance(
        state,
        &parsed,
        &observation_ids,
        retirement_policy,
        &formation,
    )
    .map_err(|error| {
        format!(
            "Context transaction '{}' 确定性重放失败: {}",
            event.id, error
        )
    })?;

    match event
        .payload
        .get("after_hash")
        .and_then(|value| value.as_str())
    {
        Some(recorded_after_hash) if !mind_state_hash_matches(&candidate, recorded_after_hash)? => {
            return Err(format!(
                "Context transaction '{}' 的 after_hash 不一致",
                event.id
            ));
        }
        None if !event.payload.contains_key("state_after") => {
            return Err(format!(
                "Context transaction '{}' 同时缺少 after_hash 与 legacy state_after",
                event.id
            ));
        }
        _ => {}
    }
    if let Some(recorded_state) = event.payload.get("state_after") {
        let recorded_state: MindState = serde_json::from_value(recorded_state.clone())
            .map_err(|error| format!("Context transaction '{}' 状态损坏: {}", event.id, error))?;
        if recorded_state != candidate {
            return Err(format!(
                "Context transaction '{}' 的 state_after 与 SExpr 重放结果不一致: {}",
                event.id,
                mind_state_mismatch(&recorded_state, &candidate)
            ));
        }
    }
    if let Some(recorded_changes) = event.payload.get("changes") {
        let recorded_changes: Vec<ContextChange> = serde_json::from_value(recorded_changes.clone())
            .map_err(|error| format!("Context transaction '{}' Diff 损坏: {}", event.id, error))?;
        // Per-item Token effects are receipt annotations calculated from the
        // actually rendered observation/Frame blocks. They do not participate
        // in Mind state transition replay, whose input deliberately contains
        // only stable Context IDs. Validate the semantic Diff here; Projection
        // hashes independently fence the resulting state.
        if recorded_changes.len() != replayed_changes.len()
            || recorded_changes
                .iter()
                .zip(&replayed_changes)
                .any(|(recorded, replayed)| {
                    recorded.operation != replayed.operation
                        || recorded.target != replayed.target
                        || recorded.detail != replayed.detail
                })
        {
            return Err(format!(
                "Context transaction '{}' 的 Diff 与 SExpr 重放结果不一致",
                event.id
            ));
        }
    }
    Ok(candidate)
}

fn load_mind_from_events(events: &[Event]) -> Result<MindState, String> {
    let mut state = MindState::default();
    let mut observation_origins = HashMap::new();
    let mut seed_seen = false;
    for event in events {
        if is_observation(event) {
            observation_origins.insert(
                event.id.clone(),
                ContextSourceOrigin {
                    principal_id: event_principal(event).map(ToOwned::to_owned),
                    session_id: event_session(event).map(ToOwned::to_owned),
                },
            );
            continue;
        }
        if event.event_type == TYPE_CONTEXT_SEED
            && event.topic == "runtime/context_seeded"
            && event.actor == "System-ContextSeed"
        {
            if seed_seen || state != MindState::default() || !observation_origins.is_empty() {
                return Err(format!(
                    "Context Seed '{}' 不是目标 Ledger 的唯一 Genesis",
                    event.id
                ));
            }
            let source_state: MindState = serde_json::from_value(
                event
                    .payload
                    .get("source_state")
                    .ok_or_else(|| format!("Context Seed '{}' 缺少 source_state", event.id))?
                    .clone(),
            )
            .map_err(|error| format!("Context Seed '{}' 来源状态损坏: {error}", event.id))?;
            let recorded_state: MindState = serde_json::from_value(
                event
                    .payload
                    .get("state_after")
                    .ok_or_else(|| format!("Context Seed '{}' 缺少 state_after", event.id))?
                    .clone(),
            )
            .map_err(|error| format!("Context Seed '{}' 投影状态损坏: {error}", event.id))?;
            let projected = project_mind_seed(&source_state);
            if recorded_state != projected {
                return Err(format!(
                    "Context Seed '{}' 的 state_after 与 mind_snapshot 投影不一致: {}",
                    event.id,
                    mind_state_mismatch(&recorded_state, &projected)
                ));
            }
            let recorded_snapshot_hash = event
                .payload
                .get("snapshot_hash")
                .and_then(|value| value.as_str());
            let recorded_projected_hash = event
                .payload
                .get("projected_hash")
                .and_then(|value| value.as_str());
            let snapshot_hash_valid = match recorded_snapshot_hash {
                Some(hash) => mind_state_hash_matches(&source_state, hash)?,
                None => false,
            };
            let projected_hash_valid = match recorded_projected_hash {
                Some(hash) => mind_state_hash_matches(&projected, hash)?,
                None => false,
            };
            if !snapshot_hash_valid || !projected_hash_valid {
                return Err(format!(
                    "Context Seed '{}' 的 Snapshot Hash 不一致",
                    event.id
                ));
            }
            state = projected;
            seed_seen = true;
            continue;
        }
        if event.event_type != TYPE_CONTEXT_TRANSACTION
            || event.topic != "chat/context_tx_committed"
            || event.actor != "Agent-Context"
        {
            continue;
        }

        state = replay_context_transaction_event(&state, event, &observation_origins)?;
    }
    Ok(state)
}

fn mind_state_mismatch(recorded: &MindState, replayed: &MindState) -> String {
    if recorded.version != replayed.version {
        return format!(
            "version recorded={} replayed={}",
            recorded.version, replayed.version
        );
    }
    if recorded.frames != replayed.frames {
        let differing_index = recorded
            .frames
            .iter()
            .zip(&replayed.frames)
            .position(|(left, right)| left != right);
        return match differing_index {
            Some(index) => format!(
                "frame[{index}] recorded={:?} replayed={:?}",
                recorded.frames[index], replayed.frames[index]
            ),
            None => format!(
                "frames length recorded={} replayed={}",
                recorded.frames.len(),
                replayed.frames.len()
            ),
        };
    }
    if recorded.relations != replayed.relations {
        return format!(
            "relations recorded={:?} replayed={:?}",
            recorded.relations, replayed.relations
        );
    }
    if recorded.retired != replayed.retired {
        return format!(
            "retired recorded_only={:?} replayed_only={:?}",
            recorded
                .retired
                .difference(&replayed.retired)
                .collect::<Vec<_>>(),
            replayed
                .retired
                .difference(&recorded.retired)
                .collect::<Vec<_>>()
        );
    }
    if recorded.protected != replayed.protected {
        return format!(
            "protected recorded_only={:?} replayed_only={:?}",
            recorded
                .protected
                .difference(&replayed.protected)
                .collect::<Vec<_>>(),
            replayed
                .protected
                .difference(&recorded.protected)
                .collect::<Vec<_>>()
        );
    }
    if recorded.checkpoints != replayed.checkpoints {
        return format!(
            "checkpoints recorded={:?} replayed={:?}",
            recorded.checkpoints, replayed.checkpoints
        );
    }
    "unknown field mismatch".to_string()
}

fn observation_ids(events: &[Event]) -> HashSet<String> {
    events
        .iter()
        .filter(|event| is_observation(event))
        .map(|event| event.id.clone())
        .collect()
}

fn observation_origins(events: &[Event]) -> HashMap<String, ContextSourceOrigin> {
    events
        .iter()
        .filter(|event| is_observation(event))
        .map(|event| {
            (
                event.id.clone(),
                ContextSourceOrigin {
                    principal_id: event_principal(event).map(ToOwned::to_owned),
                    session_id: event_session(event).map(ToOwned::to_owned),
                },
            )
        })
        .collect()
}

fn is_observation(event: &Event) -> bool {
    crate::event::is_context_observation(event)
}

fn context_wide_observation_allowed(event: &Event) -> bool {
    event.topic == "chat/context_observation"
        && event
            .payload
            .get("context_wide")
            .and_then(|value| value.as_bool())
            == Some(true)
}

fn event_belongs_to_activation(event: &Event, activation: &ThreadActivationRecord) -> bool {
    event.id == activation.root_turn_id
        || event.id == activation.trigger_event_id
        || event
            .payload
            .get("activation_id")
            .and_then(|value| value.as_str())
            == Some(activation.id.as_str())
        || event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            == Some(activation.root_turn_id.as_str())
}

fn bounded_event_preview(event: Option<&Event>, max_chars: usize) -> String {
    event.map_or_else(
        || "[event unavailable]".to_string(),
        |event| preview_text(&event_text(event), max_chars).0,
    )
}

fn activation_focus(
    activation: &ThreadActivationRecord,
    signals: &[ThreadSignalRecord],
    events: &[Event],
) -> ActivationFocus {
    let root = events
        .iter()
        .find(|event| event.id == activation.root_turn_id);
    let trigger = events
        .iter()
        .find(|event| event.id == activation.trigger_event_id);
    let effective_root = root.or(trigger);
    let objective_id = root
        .and_then(|event| event.payload.get("objective_id"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            trigger
                .and_then(|event| event.payload.get("objective_id"))
                .and_then(|value| value.as_str())
        })
        .map(ToOwned::to_owned);
    let objective_evaluation_id = root
        .and_then(|event| event.payload.get("objective_evaluation_id"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            trigger
                .and_then(|event| event.payload.get("objective_evaluation_id"))
                .and_then(|value| value.as_str())
        })
        .map(ToOwned::to_owned);
    let root_kind = effective_root
        .map(|event| event.topic.clone())
        .unwrap_or_else(|| activation.trigger_kind.clone());
    let thread_kind = if objective_id.is_some() {
        "objective"
    } else if root_kind == "chat/thread_completion_ready" {
        "delivery"
    } else if root_kind == "chat/user_message"
        && !causal_root_has_physical_tool_plan(&activation.root_turn_id, events)
    {
        "dialogue_turn"
    } else {
        "execution"
    };
    ActivationFocus {
        activation_id: activation.id.clone(),
        session_id: activation.session_id.clone(),
        root_turn_id: activation.root_turn_id.clone(),
        thread_kind: thread_kind.to_string(),
        root_kind,
        root_preview: bounded_event_preview(effective_root, 1_200),
        trigger_event_id: activation.trigger_event_id.clone(),
        trigger_kind: activation.trigger_kind.clone(),
        trigger_preview: if trigger.is_some_and(|event| event.event_type == TYPE_TOOL_OUTPUT) {
            "[result delivered through the standard function-call transcript]".to_string()
        } else {
            bounded_event_preview(trigger, 800)
        },
        signal_batch: signals
            .iter()
            .map(|signal| ActivationSignalFocus {
                event_id: signal.event_id.clone(),
                kind: signal.kind.clone(),
                sequence: signal.sequence,
            })
            .collect(),
        objective_id,
        objective_evaluation_id,
    }
}

fn activation_thread_kind(evaluation: &ActivationFocus) -> &'static str {
    match evaluation.thread_kind.as_str() {
        "objective" => "objective",
        "execution" => "execution",
        "delivery" => "delivery",
        _ => "dialogue_turn",
    }
}

fn causal_root_has_physical_tool_plan(root_turn_id: &str, events: &[Event]) -> bool {
    events.iter().any(|event| {
        if event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            != Some(root_turn_id)
        {
            return false;
        }
        let calls = if event.topic == "chat/assistant_call" {
            event.payload.get("tool_calls")
        } else if event.topic == "runtime/tool_calls_selected" {
            event.payload.get("calls")
        } else {
            None
        };
        calls
            .and_then(|value| value.as_array())
            .is_some_and(|calls| {
                calls.iter().any(|call| {
                    let name = call
                        .get("name")
                        .and_then(|value| value.as_str())
                        .or_else(|| {
                            call.get("function")
                                .and_then(|value| value.get("name"))
                                .and_then(|value| value.as_str())
                        });
                    name.is_some_and(|name| name != "context_tx" && name != "no_reply")
                })
            })
    })
}

fn pending_tool_names(activation: &ThreadActivationRecord, events: &[Event]) -> Vec<String> {
    let delivered = events
        .iter()
        .filter(|event| event.event_type == TYPE_TOOL_OUTPUT)
        .filter(|event| event_belongs_to_activation(event, activation))
        .filter_map(|event| {
            event
                .payload
                .get("tool_call_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
        .collect::<HashSet<_>>();
    let mut pending = Vec::new();
    for event in events
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .filter(|event| event_belongs_to_activation(event, activation))
    {
        let Some(calls) = event
            .payload
            .get("continuation_tool_calls")
            .or_else(|| event.payload.get("transcript_tool_calls"))
            .or_else(|| event.payload.get("tool_calls"))
        else {
            continue;
        };
        let Ok(calls) = serde_json::from_value::<Vec<crate::llm::ToolCall>>(calls.clone()) else {
            continue;
        };
        for call in calls {
            if !delivered.contains(&call.id) {
                pending.push(call.function.name);
            }
        }
    }
    pending.sort();
    pending.dedup();
    pending
}

fn concurrent_activation_view(
    activation: &ThreadActivationRecord,
    events: &[Event],
) -> ConcurrentActivationView {
    let root = events
        .iter()
        .find(|event| event.id == activation.root_turn_id);
    let focus = activation_focus(activation, &[], events);
    let thread_kind = activation_thread_kind(&focus).to_string();
    let thread_id = match thread_kind.as_str() {
        "dialogue_turn" => activation.session_id.clone(),
        "objective" => focus
            .objective_id
            .clone()
            .unwrap_or_else(|| activation.root_turn_id.clone()),
        _ => activation.root_turn_id.clone(),
    };
    ConcurrentActivationView {
        activation_id: activation.id.clone(),
        session_id: activation.session_id.clone(),
        root_turn_id: activation.root_turn_id.clone(),
        thread_kind,
        thread_id,
        status: activation.status.as_str().to_string(),
        root_preview: bounded_event_preview(root, 500),
        pending_tools: pending_tool_names(activation, events),
    }
}

fn event_visible_at_causal_frontier(
    event: &Event,
    activation: &ThreadActivationRecord,
    root_sequence: u64,
) -> bool {
    if event.id == activation.root_turn_id || event.id == activation.trigger_event_id {
        return true;
    }
    if event
        .payload
        .get("root_turn_id")
        .and_then(|value| value.as_str())
        == Some(activation.root_turn_id.as_str())
    {
        return true;
    }
    event
        .sequence
        .is_some_and(|sequence| sequence <= root_sequence)
}

fn event_session(event: &Event) -> Option<&str> {
    event
        .payload
        .get("session_id")
        .and_then(|value| value.as_str())
}

fn event_principal(event: &Event) -> Option<&str> {
    event
        .payload
        .get("principal_id")
        .and_then(|value| value.as_str())
}

fn event_text(event: &Event) -> String {
    if event.topic == "chat/spawn" {
        if let Some(delegation) = event
            .payload
            .get("delegation")
            .and_then(|value| value.as_str())
        {
            return delegation.to_string();
        }
    }
    let text = event
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !text.is_empty() {
        return text.to_string();
    }
    event
        .payload
        .get("tool_calls")
        .map(ToString::to_string)
        .unwrap_or_else(|| "[event has no text payload]".to_string())
}

fn preview_text(text: &str, max_chars: usize) -> (String, bool) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_string(), false);
    }
    if max_chars == 0 {
        return (String::new(), true);
    }
    let head_chars = max_chars / 2;
    let tail_chars = max_chars.saturating_sub(head_chars);
    let head = text.chars().take(head_chars).collect::<String>();
    let tail = text
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    (
        format!(
            "{}\n...[原文共 {} 字符，使用 recall 按 ref 分段读取]...\n{}",
            head, total, tail
        ),
        true,
    )
}

/// Unlike the ordinary preview helper, this cap includes the truncation
/// marker itself. Critical recovery uses it as a physical request bound, so a
/// collection of previews must not exceed its declared budget by accumulating
/// one marker overhead per observation.
fn bounded_maintenance_preview(text: &str, max_chars: usize) -> (String, bool) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_string(), false);
    }
    if max_chars == 0 {
        return (String::new(), true);
    }
    let marker = format!("\n...[原文共 {total} 字符，可按 ref 使用 recall]...\n");
    let marker_chars = marker.chars().count();
    if marker_chars >= max_chars {
        return (text.chars().take(max_chars).collect(), true);
    }
    let content_budget = max_chars - marker_chars;
    let head_chars = content_budget / 2;
    let tail_chars = content_budget - head_chars;
    let head = text.chars().take(head_chars).collect::<String>();
    let tail = text
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    (format!("{head}{marker}{tail}"), true)
}

fn estimate_text_tokens(text: &str) -> usize {
    let (ascii, non_ascii) = text.chars().fold((0usize, 0usize), |counts, ch| {
        if ch.is_ascii() {
            (counts.0 + 1, counts.1)
        } else {
            (counts.0, counts.1 + 1)
        }
    });
    ascii.saturating_add(3) / 4 + non_ascii
}

/// Stable fixed-point text weight used only for relative Prompt attribution.
/// One ASCII character is one unit and one non-ASCII character is four units;
/// unlike per-component token rounding, the weights remain additive.
fn text_weight_units(text: &str) -> u64 {
    text.chars().fold(0u64, |weight, ch| {
        weight.saturating_add(if ch.is_ascii() { 1 } else { 4 })
    })
}

fn active_frame_representation(frame: &ContextFrame, state: &MindState) -> String {
    let sources = frame.sources.join(" ");
    let provenance = format!(
        "{} {} {} {}",
        frame
            .provenance
            .formed_principal_id
            .as_deref()
            .unwrap_or("unknown"),
        frame
            .provenance
            .formed_session_id
            .as_deref()
            .unwrap_or("unknown"),
        frame.provenance.source_principal_ids.join(" "),
        frame.provenance.source_session_ids.join(" ")
    );
    let lifecycle = if state.retiring.contains_key(&frame.id) {
        "retiring"
    } else {
        "active"
    };
    format!(
        "(frame (id {}) (revision {}) (lifecycle (state {})) (sources {}) (provenance {}) (body {}))",
        frame.id, frame.revision, lifecycle, sources, provenance, frame.body
    )
}

/// Attribute a complete candidate request to its visible components. The
/// Provider-observed or calibrated Prompt total is distributed by local
/// additive weights; consumers must present these component values as
/// estimates while keeping `runtime/model_usage` as the exact accounting fact.
pub fn attribute_prompt_components(
    view: &ContextView,
    messages: &[crate::llm::Message],
    tools: &[crate::llm::ToolDefinition],
    estimated_total_tokens: usize,
) -> ContextAttribution {
    #[derive(Debug)]
    struct Weighted {
        kind: String,
        id: String,
        label: String,
        weight: u64,
    }

    let mut components = Vec::<Weighted>::new();
    let system_weight = messages
        .first()
        .and_then(|message| serde_json::to_string(message).ok())
        .map(|text| text_weight_units(&text))
        .unwrap_or(0);
    components.push(Weighted {
        kind: "system".to_string(),
        id: "system-contract".to_string(),
        label: "System / VM contract".to_string(),
        weight: system_weight,
    });

    let mut context_children_weight = 0u64;
    for frame in view
        .state
        .frames
        .iter()
        .filter(|frame| !view.state.retired.contains(&frame.id))
    {
        let weight = text_weight_units(&active_frame_representation(frame, &view.state));
        context_children_weight = context_children_weight.saturating_add(weight);
        components.push(Weighted {
            kind: "frame".to_string(),
            id: frame.id.clone(),
            label: frame.id.clone(),
            weight,
        });
    }
    for observation in &view.observations {
        let weight = text_weight_units(&observation.representation);
        context_children_weight = context_children_weight.saturating_add(weight);
        components.push(Weighted {
            kind: "observation".to_string(),
            id: observation.id.clone(),
            label: observation.reference.clone(),
            weight,
        });
    }
    for projected in &view.sessions {
        // Session 的对话事实通常已作为 observation 单独归因；这里衡量的是
        // Runtime 投影进 Context Encoding 的 Session 目录、身份、状态与调度
        // 元数据。使用稳定序列化只作为相对权重，不声称复刻 Provider 模板。
        let weight = serde_json::to_string(projected)
            .ok()
            .map(|text| text_weight_units(&text))
            .unwrap_or(0);
        context_children_weight = context_children_weight.saturating_add(weight);
        components.push(Weighted {
            kind: "session_projection".to_string(),
            id: projected.session.id.clone(),
            label: projected.session.title.clone(),
            weight,
        });
    }
    let encoded_context_weight = messages
        .get(1)
        .map(|message| text_weight_units(&message.content))
        .unwrap_or(0);
    let context_partition_weight = encoded_context_weight.max(context_children_weight);
    components.push(Weighted {
        kind: "context_structure".to_string(),
        id: "context-structure".to_string(),
        label: "Context structure and scheduler state".to_string(),
        weight: context_partition_weight.saturating_sub(context_children_weight),
    });

    let history_weight = serde_json::to_string(messages.get(2..).unwrap_or_default())
        .ok()
        .map(|text| text_weight_units(&text))
        .unwrap_or(0);
    components.push(Weighted {
        kind: "tool_transcript".to_string(),
        id: view
            .activation
            .as_ref()
            .map(|activation| activation.root_turn_id.clone())
            .unwrap_or_else(|| view.active_session_id.clone()),
        label: "Current turn tool-call transcript".to_string(),
        weight: history_weight,
    });
    let tools_weight = serde_json::to_string(tools)
        .ok()
        .map(|text| text_weight_units(&text))
        .unwrap_or(0);
    components.push(Weighted {
        kind: "tool_definitions".to_string(),
        id: "tool-definitions".to_string(),
        label: "Tool definitions".to_string(),
        weight: tools_weight,
    });

    let known_weight = system_weight
        .saturating_add(context_partition_weight)
        .saturating_add(history_weight)
        .saturating_add(tools_weight);
    let complete_request_weight = serde_json::to_string(&json!({
        "messages": messages,
        "tools": tools,
    }))
    .ok()
    .map(|text| text_weight_units(&text))
    .unwrap_or(known_weight)
    .max(known_weight);
    components.push(Weighted {
        kind: "request_wrapper".to_string(),
        id: "request-wrapper".to_string(),
        label: "Protocol wrapper / unattributed".to_string(),
        weight: complete_request_weight.saturating_sub(known_weight),
    });

    let total_weight_units = components
        .iter()
        .map(|component| component.weight)
        .fold(0u64, u64::saturating_add);
    let denominator = total_weight_units.max(1);
    let mut attributed = components
        .into_iter()
        .map(|component| {
            let estimated_tokens = ((estimated_total_tokens as u128)
                .saturating_mul(component.weight as u128)
                / denominator as u128) as usize;
            ContextAttributionComponent {
                kind: component.kind,
                id: component.id,
                label: component.label,
                weight_units: component.weight,
                estimated_tokens,
                share: component.weight as f64 / denominator as f64,
            }
        })
        .collect::<Vec<_>>();
    let allocated = attributed
        .iter()
        .map(|component| component.estimated_tokens)
        .sum::<usize>();
    if let Some(component) = attributed.last_mut() {
        component.estimated_tokens = component
            .estimated_tokens
            .saturating_add(estimated_total_tokens.saturating_sub(allocated));
    }
    ContextAttribution {
        estimated_total_tokens,
        total_weight_units,
        weight_algorithm: "fixed-point-char-weight-v1:ascii=1,non-ascii=4".to_string(),
        components: attributed,
    }
}

fn estimate_active_frame_tokens(frame: &ContextFrame, state: &MindState) -> usize {
    estimate_text_tokens(&active_frame_representation(frame, state))
}

fn estimate_active_mind_tokens(state: &MindState) -> usize {
    state
        .frames
        .iter()
        .filter(|frame| !state.retired.contains(&frame.id))
        .map(|frame| estimate_active_frame_tokens(frame, state))
        .sum()
}

fn estimate_observation_event_tokens(event: &Event, config: &OrchestratorConfig) -> usize {
    let text = event_text(event);
    let (preview, _) = preview_text(&text, config.observation_preview_chars);
    estimate_text_tokens(&format!(
        "(observation (ref {}) (kind {}) (topic {}) (actor {}) (preview {}))",
        event.id, event.event_type, event.topic, event.actor, preview
    ))
}

fn context_transaction_token_effect(
    current: &MindState,
    next: &MindState,
    referenced_observations: &[Event],
    config: &OrchestratorConfig,
) -> ContextTokenEffect {
    let referenced_cost = |state: &MindState| {
        referenced_observations
            .iter()
            .filter(|event| !state.retired.contains(&event.id))
            .map(|event| estimate_observation_event_tokens(event, config))
            .sum::<usize>()
    };
    let estimated_before = estimate_active_mind_tokens(current) + referenced_cost(current);
    let estimated_after = estimate_active_mind_tokens(next) + referenced_cost(next);
    let estimated_eventual_relief = next
        .retiring
        .keys()
        .filter(|id| !current.retiring.contains_key(*id))
        .filter_map(|id| next.frames.iter().find(|frame| &frame.id == id))
        .map(|frame| estimate_active_frame_tokens(frame, next))
        .sum();
    ContextTokenEffect {
        accounting: "local-unified-estimate".to_string(),
        scope: "active-mind-plus-referenced-observations".to_string(),
        estimated_before,
        estimated_after,
        estimated_immediate_relief: estimated_before.saturating_sub(estimated_after),
        estimated_eventual_relief,
    }
}

fn attach_context_change_token_effects(
    changes: &mut [ContextChange],
    current: &MindState,
    next: &MindState,
    referenced_observations: &[Event],
    config: &OrchestratorConfig,
) {
    let observation_costs = referenced_observations
        .iter()
        .map(|event| {
            (
                event.id.as_str(),
                estimate_observation_event_tokens(event, config),
            )
        })
        .collect::<HashMap<_, _>>();

    let active_cost = |state: &MindState, target: &str| -> Option<usize> {
        if let Some(cost) = observation_costs.get(target) {
            return Some(if state.retired.contains(target) {
                0
            } else {
                *cost
            });
        }
        state
            .frames
            .iter()
            .find(|frame| frame.id == target)
            .map(|frame| {
                if state.retired.contains(target) {
                    0
                } else {
                    estimate_active_frame_tokens(frame, state)
                }
            })
    };

    for change in changes {
        let Some(before) = active_cost(current, &change.target) else {
            continue;
        };
        let after = active_cost(next, &change.target).unwrap_or(0);
        let eventual = if next.retiring.contains_key(&change.target) {
            after
        } else {
            0
        };
        change.token_effect = Some(ContextChangeTokenEffect {
            accounting: "local-unified-estimate".to_string(),
            estimated_active_before: before,
            estimated_active_after: after,
            estimated_immediate_relief: before.saturating_sub(after),
            estimated_eventual_relief: eventual,
        });
    }
}

fn canonical_body(expr: &SExpr) -> Result<String, String> {
    let body = expr.to_string();
    parse(&body).map_err(|error| format!("frame body 无法稳定往返解析: {}", error))?;
    Ok(body)
}

fn parse_sources(expr: &SExpr) -> Result<Vec<String>, String> {
    let list = as_list(expr, "from")?;
    expect_head(list, "from")?;
    if list.len() < 2 {
        return Err("(from ...) 至少需要一个来源 ID".to_string());
    }
    list.iter()
        .skip(1)
        .map(|item| validated_id(as_atom(item, "source id")?).map(ToOwned::to_owned))
        .collect()
}

fn ensure_sources_exist(
    state: &MindState,
    observation_ids: &HashSet<String>,
    sources: &[String],
) -> Result<(), String> {
    for source in sources {
        ensure_known(state, observation_ids, source)?;
    }
    Ok(())
}

fn ensure_known(
    state: &MindState,
    observation_ids: &HashSet<String>,
    id: &str,
) -> Result<(), String> {
    if state.frames.iter().any(|frame| frame.id == id) || observation_ids.contains(id) {
        Ok(())
    } else {
        Err(format!("Context 引用 '{}' 不存在", id))
    }
}

fn ensure_unknown(
    state: &MindState,
    observation_ids: &HashSet<String>,
    id: &str,
) -> Result<(), String> {
    if state.frames.iter().any(|frame| frame.id == id)
        || state
            .checkpoints
            .iter()
            .any(|checkpoint| checkpoint.id == id)
        || observation_ids.contains(id)
    {
        Err(format!(
            "Context ID '{}' 已存在，不能重复 create/derive/checkpoint",
            id
        ))
    } else {
        Ok(())
    }
}

fn validated_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 512 {
        return Err("Context ID 长度必须在 1..=512 之间".to_string());
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err(format!(
            "Context ID '{}' 含非法字符；只允许字母、数字、-、_、:、.",
            id
        ));
    }
    Ok(id)
}

fn change(operation: &str, target: &str, detail: Option<String>) -> ContextChange {
    ContextChange {
        operation: operation.to_string(),
        target: target.to_string(),
        detail,
        token_effect: None,
    }
}

fn as_list<'a>(expr: &'a SExpr, label: &str) -> Result<&'a [SExpr], String> {
    match expr {
        SExpr::List(items) => Ok(items),
        _ => Err(format!("{} 必须是 SExpr List", label)),
    }
}

fn as_atom<'a>(expr: &'a SExpr, label: &str) -> Result<&'a str, String> {
    match expr {
        SExpr::Atom(value) => Ok(value),
        _ => Err(format!("{} 必须是 Atom", label)),
    }
}

fn atom_at<'a>(items: &'a [SExpr], index: usize, label: &str) -> Result<&'a str, String> {
    items
        .get(index)
        .ok_or_else(|| format!("缺少 {}", label))
        .and_then(|item| as_atom(item, label))
}

fn expect_head(items: &[SExpr], expected: &str) -> Result<(), String> {
    let actual = atom_at(items, 0, "list head")?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!("期望 '{}'，实际为 '{}'", expected, actual))
    }
}

fn require_len(items: &[SExpr], expected: usize, usage: &str) -> Result<(), String> {
    if items.len() == expected {
        Ok(())
    } else {
        Err(format!("格式错误，应为 {}", usage))
    }
}

fn require_min_len(items: &[SExpr], expected: usize, usage: &str) -> Result<(), String> {
    if items.len() >= expected {
        Ok(())
    } else {
        Err(format!("格式错误，应为 {}", usage))
    }
}

fn atom(value: impl ToString) -> SExpr {
    SExpr::Atom(value.to_string())
}

fn pair(key: &str, value: SExpr) -> SExpr {
    SExpr::List(vec![atom(key), value])
}

fn list(key: &str, values: Vec<SExpr>) -> SExpr {
    let mut items = Vec::with_capacity(values.len() + 1);
    items.push(atom(key));
    items.extend(values);
    SExpr::List(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::TYPE_AGENT_CALL;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{
        ActivationStore as _, DeliveryIngressStore as _, NewAgent, NewCognitiveContext,
        NewPrincipal, NewSession, NewThread, NewThreadActivation, ObjectiveStatus,
        SessionDirectoryStore as _, SessionMountKind, SessionStore, ThreadKind, ThreadStore as _,
    };
    use tempfile::TempDir;

    #[test]
    fn attribution_weight_is_additive_across_ascii_and_non_ascii_text() {
        assert_eq!(text_weight_units("ab中"), 6);
        assert_eq!(
            text_weight_units("ascii中文"),
            text_weight_units("ascii") + text_weight_units("中文")
        );
    }

    #[tokio::test]
    async fn actual_context_encoding_anchors_active_and_observation_principals() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("identity-encoding.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .create_agent_bundle(
                NewAgent {
                    id: "encoding-agent".to_string(),
                    title: "Encoding Agent".to_string(),
                    root_context_id: "encoding-context".to_string(),
                },
                NewCognitiveContext {
                    id: "encoding-context".to_string(),
                    agent_id: "encoding-agent".to_string(),
                    title: "Encoding Context".to_string(),
                },
                NewSession {
                    id: "session:a".to_string(),
                    agent_id: "encoding-agent".to_string(),
                    context_id: "encoding-context".to_string(),
                    parent_session_id: None,
                    title: "A".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "session:b".to_string(),
                agent_id: "encoding-agent".to_string(),
                context_id: "encoding-context".to_string(),
                parent_session_id: None,
                title: "B".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        for principal in ["principal:a", "principal:b"] {
            store
                .ensure_principal(NewPrincipal {
                    id: principal.to_string(),
                    provider_id: "test".to_string(),
                    assurance: "verified".to_string(),
                    display_name: Some("same display name".to_string()),
                })
                .await
                .unwrap();
        }
        store
            .bind_session_principal("session:a", "principal:a")
            .await
            .unwrap();
        store
            .bind_session_principal("session:b", "principal:b")
            .await
            .unwrap();
        for (id, session, principal, text) in [
            ("event:a", "session:a", "principal:a", "A says private fact"),
            ("event:b", "session:b", "principal:b", "I am A"),
        ] {
            store
                .append(Event::new(
                    id.to_string(),
                    "User".to_string(),
                    TYPE_USER_MESSAGE.to_string(),
                    "chat/user_message".to_string(),
                    serde_json::json!({
                        "context_id": "encoding-context",
                        "session_id": session,
                        "principal_id": principal,
                        "text": text
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ))
                .await
                .unwrap();
        }
        let event_b = store
            .query(QueryFilter {
                event_id: Some("event:b".to_string()),
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread:b".to_string(),
                agent_id: "encoding-agent".to_string(),
                context_id: "encoding-context".to_string(),
                session_id: "session:b".to_string(),
                initiating_principal_id: Some("principal:b".to_string()),
                root_turn_id: "event:b".to_string(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();
        let activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: "activation:b".to_string(),
                agent_id: "encoding-agent".to_string(),
                context_id: "encoding-context".to_string(),
                session_id: "session:b".to_string(),
                initiating_principal_id: Some("principal:b".to_string()),
                trigger_event_id: "event:b".to_string(),
                trigger_sequence: event_b.sequence.unwrap(),
                trigger_kind: "chat/user_message".to_string(),
                parent_activation_id: None,
                root_turn_id: "event:b".to_string(),
            })
            .await
            .unwrap();
        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>);
        let view = engine
            .build_context_encoding_for_activation("encoding-context", &activation, &HashSet::new())
            .await
            .unwrap();

        assert_eq!(view.active_principal_id.as_deref(), Some("principal:b"));
        assert!(view.sexpr.contains("(active-principal (id principal:b)"));
        assert!(view.sexpr.contains("(id session:a)"));
        assert!(view.sexpr.contains("(principals principal:a)"));
        assert!(view.sexpr.contains("(id session:b)"));
        assert!(view.sexpr.contains("(principals principal:b)"));
        assert!(view
            .observations
            .iter()
            .any(|observation| observation.principal_id.as_deref() == Some("principal:a")));
        assert!(view
            .observations
            .iter()
            .any(|observation| observation.principal_id.as_deref() == Some("principal:b")));

        let legacy_event = Event::new(
            "event:legacy-unattributed".to_string(),
            "Legacy Adapter".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::json!({
                "context_id": "encoding-context",
                "session_id": "session:b",
                "text": "legacy message without authenticated principal"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        store.append(legacy_event.clone()).await.unwrap();
        let legacy_sequence = store
            .query(QueryFilter {
                event_id: Some(legacy_event.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap()
            .pop()
            .and_then(|event| event.sequence)
            .unwrap();
        store
            .ensure_thread(NewThread {
                id: "thread:legacy-unattributed".to_string(),
                agent_id: "encoding-agent".to_string(),
                context_id: "encoding-context".to_string(),
                session_id: "session:b".to_string(),
                initiating_principal_id: None,
                root_turn_id: legacy_event.id.clone(),
                kind: ThreadKind::DialogueTurn,
                executor_kind: "self".to_string(),
                executor_id: None,
                target_id: None,
            })
            .await
            .unwrap();
        let legacy_activation = store
            .ensure_thread_activation(NewThreadActivation {
                id: "activation:legacy-unattributed".to_string(),
                agent_id: "encoding-agent".to_string(),
                context_id: "encoding-context".to_string(),
                session_id: "session:b".to_string(),
                initiating_principal_id: None,
                trigger_event_id: legacy_event.id.clone(),
                trigger_sequence: legacy_sequence,
                trigger_kind: "chat/user_message".to_string(),
                parent_activation_id: None,
                root_turn_id: legacy_event.id,
            })
            .await
            .unwrap();
        let legacy_view = engine
            .build_context_encoding_for_activation(
                "encoding-context",
                &legacy_activation,
                &HashSet::new(),
            )
            .await
            .unwrap();
        assert_eq!(legacy_view.active_principal_id, None);
        assert!(legacy_view
            .sexpr
            .contains("(active-principal (id unknown) (authority runtime) (binding unknown))"));
    }

    #[test]
    fn v20_projection_hash_remains_valid_after_retiring_schema_extension() {
        let mut state = MindState {
            version: 7,
            ..MindState::default()
        };
        state.frames.push(ContextFrame {
            id: "durable-fact".to_string(),
            body: "(fact stable)".to_string(),
            sources: vec!["event-1".to_string()],
            provenance: FrameIdentityProvenance::default(),
            revision: 1,
            created_version: 1,
            updated_version: 7,
        });
        state.protected.insert("durable-fact".to_string());
        state.checkpoints.push(MindCheckpoint {
            id: "before-schema-change".to_string(),
            frames: state.frames.clone(),
            relations: Vec::new(),
            retired: BTreeSet::new(),
            retiring: BTreeMap::new(),
            protected: state.protected.clone(),
            created_version: 6,
        });

        let legacy_hash = mind_state_hash_v20(&state).unwrap().unwrap();
        assert_ne!(legacy_hash, mind_state_hash(&state).unwrap());

        let mut legacy_state = serde_json::to_value(&state).unwrap();
        legacy_state.as_object_mut().unwrap().remove("retiring");
        for checkpoint in legacy_state["checkpoints"].as_array_mut().unwrap() {
            checkpoint.as_object_mut().unwrap().remove("retiring");
        }
        let projection = MindProjectionRecord {
            context_id: "context-v20".to_string(),
            revision: state.version,
            state: legacy_state,
            state_hash: legacy_hash,
            head_event_id: Some("tx-7".to_string()),
            updated_at: Utc::now(),
        };
        assert_eq!(
            ContextEngine::validate_mind_projection("context-v20", projection).unwrap(),
            state
        );
    }

    #[test]
    fn v20_hash_cannot_hide_non_empty_retirement_state() {
        let mut state = MindState::default();
        state.retiring.insert(
            "frame-a".to_string(),
            FrameRetirement {
                frame_id: "frame-a".to_string(),
                requested_frame_revision: 1,
                requested_mind_version: 2,
                requested_at_tick: 3,
                eligible_at_tick: 4,
                generation: 1,
                reason: "cooling".to_string(),
            },
        );
        assert_eq!(mind_state_hash_v20(&state).unwrap(), None);
    }

    #[test]
    fn v20_transaction_hashes_remain_replayable() {
        let initial = MindState::default();
        let transaction = "(context-tx (base-version 0) (create durable-fact (fact stable)))";
        let parsed = parse_transaction(transaction).unwrap();
        let (expected, _) = apply_parsed_transaction(&initial, &parsed, &HashSet::new()).unwrap();
        let event = Event::new(
            "tx-v20".to_string(),
            "Agent-Context".to_string(),
            TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({
                "context_id": "context-v20",
                "transaction": transaction,
                "before_hash": mind_state_hash_v20(&initial).unwrap().unwrap(),
                "after_hash": mind_state_hash_v20(&expected).unwrap().unwrap(),
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(
            replay_context_transaction_event(&initial, &event, &HashMap::new()).unwrap(),
            expected
        );
    }

    #[test]
    fn v21_projection_hash_remains_valid_but_cannot_mask_new_provenance() {
        let mut state = MindState {
            version: 3,
            ..MindState::default()
        };
        state.frames.push(ContextFrame {
            id: "legacy-frame".to_string(),
            body: "(fact legacy)".to_string(),
            sources: vec!["event-a".to_string()],
            provenance: FrameIdentityProvenance::default(),
            revision: 1,
            created_version: 1,
            updated_version: 3,
        });
        state.retiring.insert(
            "legacy-frame".to_string(),
            FrameRetirement {
                frame_id: "legacy-frame".to_string(),
                requested_frame_revision: 1,
                requested_mind_version: 3,
                requested_at_tick: 4,
                eligible_at_tick: 6,
                generation: 3,
                reason: "legacy cooling".to_string(),
            },
        );

        let legacy_hash = mind_state_hash_v21(&state).unwrap().unwrap();
        assert!(mind_state_hash_matches(&state, &legacy_hash).unwrap());

        state.frames[0].provenance = FrameIdentityProvenance {
            formed_principal_id: Some("principal:a".to_string()),
            formed_session_id: Some("session:a".to_string()),
            source_principal_ids: vec!["principal:a".to_string()],
            source_session_ids: vec!["session:a".to_string()],
            state: FrameProvenanceState::Attributed,
        };
        assert_eq!(mind_state_hash_v21(&state).unwrap(), None);
        assert!(!mind_state_hash_matches(&state, &legacy_hash).unwrap());
    }

    #[test]
    fn legacy_frame_without_provenance_deserializes_as_unknown() {
        let frame: ContextFrame = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "body": "(fact old)",
            "sources": [],
            "revision": 1,
            "created_version": 1,
            "updated_version": 1
        }))
        .unwrap();
        assert_eq!(frame.provenance, FrameIdentityProvenance::default());
        assert_eq!(frame.provenance.state, FrameProvenanceState::Unknown);
    }

    #[test]
    fn frame_provenance_separates_formation_from_multi_source_evidence() {
        let origins = HashMap::from([
            (
                "event-a".to_string(),
                ContextSourceOrigin {
                    principal_id: Some("principal:a".to_string()),
                    session_id: Some("session:a".to_string()),
                },
            ),
            (
                "event-c".to_string(),
                ContextSourceOrigin {
                    principal_id: Some("principal:c".to_string()),
                    session_id: Some("session:c".to_string()),
                },
            ),
        ]);
        let observation_ids = origins.keys().cloned().collect::<HashSet<_>>();
        let formed_in_b = FrameFormationContext {
            enabled: true,
            formed_principal_id: Some("principal:b"),
            formed_session_id: Some("session:b"),
            observation_origins: Some(&origins),
        };
        let derive = parse_transaction(
            "(context-tx (base-version 0) (derive learned (from event-a event-c) (fact shared)))",
        )
        .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy_and_provenance(
            &MindState::default(),
            &derive,
            &observation_ids,
            FrameRetirementPolicy::legacy_immediate(),
            &formed_in_b,
        )
        .unwrap();
        let frame = &state.frames[0];
        assert_eq!(
            frame.provenance.formed_principal_id.as_deref(),
            Some("principal:b")
        );
        assert_eq!(
            frame.provenance.formed_session_id.as_deref(),
            Some("session:b")
        );
        assert_eq!(
            frame.provenance.source_principal_ids,
            ["principal:a", "principal:c"]
        );
        assert_eq!(
            frame.provenance.source_session_ids,
            ["session:a", "session:c"]
        );
        assert_eq!(frame.provenance.state, FrameProvenanceState::Attributed);
        let original_provenance = frame.provenance.clone();

        let revise_without_sources =
            parse_transaction("(context-tx (base-version 1) (revise learned (fact clarified)))")
                .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy_and_provenance(
            &state,
            &revise_without_sources,
            &observation_ids,
            FrameRetirementPolicy::legacy_immediate(),
            &FrameFormationContext {
                enabled: true,
                formed_principal_id: Some("principal:c"),
                formed_session_id: Some("session:c"),
                observation_origins: Some(&origins),
            },
        )
        .unwrap();
        assert_eq!(state.frames[0].provenance, original_provenance);

        let revise_sources = parse_transaction(
            "(context-tx (base-version 2) (revise learned (from event-c) (fact corrected)))",
        )
        .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy_and_provenance(
            &state,
            &revise_sources,
            &observation_ids,
            FrameRetirementPolicy::legacy_immediate(),
            &FrameFormationContext {
                enabled: true,
                formed_principal_id: Some("principal:c"),
                formed_session_id: Some("session:c"),
                observation_origins: Some(&origins),
            },
        )
        .unwrap();
        let revised = &state.frames[0].provenance;
        assert_eq!(revised.formed_principal_id.as_deref(), Some("principal:b"));
        assert_eq!(revised.source_principal_ids, ["principal:c"]);
        assert_eq!(revised.source_session_ids, ["session:c"]);
    }

    #[test]
    fn mind_seed_keeps_provenance_after_observation_sources_are_detached() {
        let state = MindState {
            version: 9,
            frames: vec![ContextFrame {
                id: "portable-experience".to_string(),
                body: "(lesson verified)".to_string(),
                sources: vec!["old-observation".to_string()],
                provenance: FrameIdentityProvenance {
                    formed_principal_id: Some("principal:b".to_string()),
                    formed_session_id: Some("session:b".to_string()),
                    source_principal_ids: vec!["principal:a".to_string()],
                    source_session_ids: vec!["session:a".to_string()],
                    state: FrameProvenanceState::Attributed,
                },
                revision: 4,
                created_version: 2,
                updated_version: 8,
            }],
            ..MindState::default()
        };
        let seeded = project_mind_seed(&state);
        assert!(seeded.frames[0].sources.is_empty());
        assert_eq!(seeded.frames[0].provenance, state.frames[0].provenance);
        assert_eq!(seeded.frames[0].created_version, 0);
        assert_eq!(seeded.frames[0].updated_version, 0);
    }

    #[test]
    fn snapshot_head_must_anchor_matching_context_revision_and_hash() {
        let snapshot = MindSnapshotRecord {
            id: "snapshot-1".to_string(),
            context_id: "context-a".to_string(),
            revision: 7,
            state: serde_json::json!({"version": 7}),
            state_hash: "hash-7".to_string(),
            head_event_id: "tx-7".to_string(),
            created_at: Utc::now(),
        };
        let event = Event::new(
            "tx-7".to_string(),
            "Agent-Context".to_string(),
            TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            serde_json::json!({
                "context_id": "context-a",
                "after_version": 7,
                "after_hash": "hash-7"
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        validate_snapshot_head_event(&snapshot, &event).unwrap();

        let mut wrong = event.clone();
        wrong
            .payload
            .insert("after_version".to_string(), serde_json::json!(8));
        assert!(validate_snapshot_head_event(&snapshot, &wrong).is_err());
    }

    fn observations(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn working_set_session(
        id: impl Into<String>,
        last_activity_at: chrono::DateTime<Utc>,
    ) -> SessionRecord {
        let id = id.into();
        SessionRecord {
            id: id.clone(),
            agent_id: "agent-test".to_string(),
            context_id: "context-test".to_string(),
            parent_session_id: None,
            title: id,
            status: SessionStatus::Active,
            created_at: last_activity_at,
            updated_at: last_activity_at,
            last_activity_at,
            attention_state: SessionAttentionState::Active,
            attention_revision: 0,
            attention_reason: None,
            attention_changed_at: None,
            attention_event_id: None,
        }
    }

    #[test]
    fn working_set_is_bounded_current_first_and_deterministic() {
        let now = Utc::now();
        let config = crate::config::SessionWorkingSetConfig {
            active_window: crate::config::HumanDuration::from_secs(86_400),
            max_sessions: 50,
        };
        let sessions = (0..70)
            .map(|index| {
                working_set_session(
                    format!("session-{index:02}"),
                    now - chrono::Duration::seconds(index),
                )
            })
            .collect::<Vec<_>>();
        let (projected, view) = select_session_working_set(
            &sessions,
            &["session-69".to_string()],
            now,
            &config,
            &[],
            &[],
        );
        assert_eq!(view.full_session_ids.len(), 50);
        assert_eq!(view.full_session_ids[0], "session-69");
        assert_eq!(view.excluded.over_count, 20);
        assert_eq!(
            projected
                .iter()
                .filter(|entry| entry.projection == SessionProjection::Full)
                .count(),
            50
        );
        assert!(view.full_session_ids.contains(&"session-00".to_string()));
        assert!(!view.full_session_ids.contains(&"session-49".to_string()));

        let tied = vec![
            working_set_session("session-z", now),
            working_set_session("session-a", now),
            working_set_session("session-current", now),
        ];
        let (_, tied_view) = select_session_working_set(
            &tied,
            &["session-current".to_string()],
            now,
            &config,
            &[],
            &[],
        );
        assert_eq!(
            tied_view.full_session_ids,
            vec!["session-current", "session-a", "session-z"]
        );
    }

    #[test]
    fn working_set_max_one_and_large_registry_do_not_expand_projection() {
        let now = Utc::now();
        let config = crate::config::SessionWorkingSetConfig {
            active_window: crate::config::HumanDuration::from_secs(60),
            max_sessions: 1,
        };
        let mut sessions = (0..10_000)
            .map(|index| {
                working_set_session(
                    format!("session-{index:05}"),
                    now - chrono::Duration::hours(48),
                )
            })
            .collect::<Vec<_>>();
        sessions[9_999].last_activity_at = now;
        let (projected, view) = select_session_working_set(
            &sessions,
            &["session-00000".to_string()],
            now,
            &config,
            &[],
            &[],
        );
        assert_eq!(view.full_session_ids, vec!["session-00000"]);
        assert_eq!(projected.len(), 1);
        assert_eq!(view.excluded.outside_window, 9_998);
        assert_eq!(view.excluded.over_count, 1);
    }

    #[tokio::test]
    async fn token_budget_evicts_old_non_current_sessions_before_current_session() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("working-set-token-budget.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        store
            .create_agent_bundle(
                NewAgent {
                    id: "budget-agent".to_string(),
                    title: "Budget Agent".to_string(),
                    root_context_id: "budget-context".to_string(),
                },
                NewCognitiveContext {
                    id: "budget-context".to_string(),
                    agent_id: "budget-agent".to_string(),
                    title: "Budget Context".to_string(),
                },
                NewSession {
                    id: "budget-current".to_string(),
                    agent_id: "budget-agent".to_string(),
                    context_id: "budget-context".to_string(),
                    parent_session_id: None,
                    title: "Current".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        for session_id in ["budget-newer", "budget-older"] {
            store
                .create_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: "budget-agent".to_string(),
                    context_id: "budget-context".to_string(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }
        let now = Utc::now();
        store.touch_session("budget-current", now).await.unwrap();
        store
            .touch_session("budget-newer", now - chrono::Duration::seconds(1))
            .await
            .unwrap();
        store
            .touch_session("budget-older", now - chrono::Duration::seconds(2))
            .await
            .unwrap();
        for (index, session_id) in ["budget-current", "budget-newer", "budget-older"]
            .into_iter()
            .enumerate()
        {
            let text = if session_id == "budget-current" {
                "current input".to_string()
            } else {
                "x".repeat(16_000)
            };
            store
                .append(Event::new(
                    format!("budget-event-{index}"),
                    "User".to_string(),
                    TYPE_USER_MESSAGE.to_string(),
                    "chat/user_message".to_string(),
                    vec![
                        ("context_id".to_string(), json!("budget-context")),
                        ("session_id".to_string(), json!(session_id)),
                        ("text".to_string(), json!(text)),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }
        let config = OrchestratorConfig {
            context_soft_token_limit: 4_000,
            context_hard_token_limit: 5_000,
            context_maintenance_reserve_tokens: 1_000,
            session_working_set: crate::config::SessionWorkingSetConfig {
                active_window: crate::config::HumanDuration::from_secs(86_400),
                max_sessions: 3,
            },
            ..Default::default()
        };
        let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config)
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>);
        let view = engine
            .build_context_encoding("budget-context", "budget-current", &HashSet::new())
            .await
            .unwrap();

        assert!(view
            .session_working_set
            .full_session_ids
            .contains(&"budget-current".to_string()));
        assert!(view.session_working_set.excluded.token_budget >= 1);
        assert!(!view
            .session_working_set
            .metadata_only_session_ids
            .is_empty());
        let metadata_only = view
            .session_working_set
            .metadata_only_session_ids
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        assert!(view
            .observations
            .iter()
            .any(|observation| observation.session_id.as_deref() == Some("budget-current")));
        assert!(view.observations.iter().all(|observation| observation
            .session_id
            .as_ref()
            .is_none_or(|session_id| !metadata_only.contains(session_id))));
    }

    #[test]
    fn create_derive_revise_and_retire_are_transactional() {
        let state = MindState::default();
        let tx = parse_transaction(
            r#"(context-tx
                (base-version 0)
                (reason "将原始约束提炼为受保护 frame")
                (derive objective (from event:1) (goal "Ship v1"))
                (protect objective)
                (create scratch (hypothesis "mailbox"))
                (revise scratch (hypothesis "single writer mailbox"))
                (retire event:1))"#,
        )
        .unwrap();
        let (next, changes) =
            apply_parsed_transaction(&state, &tx, &observations(&["event:1"])).unwrap();

        assert_eq!(next.version, 1);
        assert_eq!(next.frames.len(), 2);
        assert!(next.protected.contains("objective"));
        assert!(next.retired.contains("event:1"));
        assert_eq!(next.frames[1].revision, 2);
        assert_eq!(changes.len(), 5);
    }

    #[test]
    fn failed_operation_rolls_back_whole_transaction() {
        let state = MindState::default();
        let tx = parse_transaction(
            r#"(context-tx
                (base-version 0)
                (reason "测试事务整体回滚")
                (create objective (goal "A"))
                (retire missing-id))"#,
        )
        .unwrap();

        let result = apply_parsed_transaction(&state, &tx, &HashSet::new());
        assert!(result.is_err());
        assert_eq!(state, MindState::default());
    }

    #[test]
    fn protected_content_requires_explicit_unprotect() {
        let mut state = MindState::default();
        state.frames.push(ContextFrame {
            id: "constraint".to_string(),
            body: "(constraint keep-me)".to_string(),
            sources: Vec::new(),
            provenance: FrameIdentityProvenance::default(),
            revision: 1,
            created_version: 1,
            updated_version: 1,
        });
        state.version = 1;
        state.protected.insert("constraint".to_string());

        let rejected = parse_transaction(
            "(context-tx (base-version 1) (reason \"attempt retire\") (retire constraint))",
        )
        .unwrap();
        assert!(apply_parsed_transaction(&state, &rejected, &HashSet::new()).is_err());

        let accepted = parse_transaction(
            "(context-tx (base-version 1) (reason \"constraint obsolete\") (unprotect constraint) (retire constraint))",
        )
        .unwrap();
        let (next, _) = apply_parsed_transaction(&state, &accepted, &HashSet::new()).unwrap();
        assert!(next.retired.contains("constraint"));
    }

    #[test]
    fn retiring_frame_repeat_revise_restore_and_protect_are_fenced() {
        let create =
            parse_transaction("(context-tx (base-version 0) (create memory (fact detailed)))")
                .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy(
            &MindState::default(),
            &create,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(10, 8),
        )
        .unwrap();
        let retire =
            parse_transaction("(context-tx (base-version 1) (reason organize) (retire memory))")
                .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy(
            &state,
            &retire,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(10, 8),
        )
        .unwrap();
        assert_eq!(state.retiring["memory"].eligible_at_tick, 18);

        let repeated = parse_transaction(
            "(context-tx (base-version 2) (reason still-organize) (retire memory))",
        )
        .unwrap();
        let (state, changes) = apply_parsed_transaction_with_policy(
            &state,
            &repeated,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(15, 8),
        )
        .unwrap();
        assert_eq!(state.retiring["memory"].eligible_at_tick, 18);
        assert!(changes
            .iter()
            .any(|change| change.operation == "retire-frame-existing"));

        let revise =
            parse_transaction("(context-tx (base-version 3) (revise memory (fact compact)))")
                .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy(
            &state,
            &revise,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(15, 8),
        )
        .unwrap();
        assert!(!state.retiring.contains_key("memory"));
        assert_eq!(state.frames[0].revision, 2);

        let retire_again =
            parse_transaction("(context-tx (base-version 4) (reason reconsider) (retire memory))")
                .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy(
            &state,
            &retire_again,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(20, 8),
        )
        .unwrap();
        let restore = parse_transaction("(context-tx (base-version 5) (restore memory))").unwrap();
        let (state, _) = apply_parsed_transaction_with_policy(
            &state,
            &restore,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(20, 8),
        )
        .unwrap();
        assert!(!state.retiring.contains_key("memory"));

        let retire_once_more =
            parse_transaction("(context-tx (base-version 6) (reason final-check) (retire memory))")
                .unwrap();
        let (state, _) = apply_parsed_transaction_with_policy(
            &state,
            &retire_once_more,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(30, 8),
        )
        .unwrap();
        let protect = parse_transaction("(context-tx (base-version 7) (protect memory))").unwrap();
        let (state, _) = apply_parsed_transaction_with_policy(
            &state,
            &protect,
            &HashSet::new(),
            FrameRetirementPolicy::cognitive(30, 8),
        )
        .unwrap();
        assert!(!state.retiring.contains_key("memory"));
        assert!(state.protected.contains("memory"));
    }

    #[test]
    fn stale_base_version_is_rejected() {
        let state = MindState {
            version: 4,
            ..Default::default()
        };
        let tx = parse_transaction("(context-tx (base-version 3) (create x (note y)))").unwrap();
        let error = apply_parsed_transaction(&state, &tx, &HashSet::new()).unwrap_err();
        assert!(error.contains("版本冲突"));
    }

    #[test]
    fn stale_create_is_rebased_onto_latest_mind_version() {
        let state = MindState {
            version: 4,
            frames: vec![ContextFrame {
                id: "concurrent-frame".to_string(),
                body: "(fact concurrent)".to_string(),
                sources: Vec::new(),
                provenance: FrameIdentityProvenance::default(),
                revision: 1,
                created_version: 4,
                updated_version: 4,
            }],
            ..Default::default()
        };
        let mut tx =
            parse_transaction("(context-tx (base-version 3) (create mine (fact independent)))")
                .unwrap();

        rebase_stale_frame_transaction(&state, &mut tx).unwrap();
        assert_eq!(tx.base_version, 4);
        let (next, _) = apply_parsed_transaction(&state, &tx, &HashSet::new()).unwrap();
        assert_eq!(next.version, 5);
        assert!(next.frames.iter().any(|frame| frame.id == "mine"));
    }

    #[test]
    fn stale_revise_of_unchanged_frame_is_rebased() {
        let state = MindState {
            version: 7,
            frames: vec![
                ContextFrame {
                    id: "mine".to_string(),
                    body: "(status old)".to_string(),
                    sources: Vec::new(),
                    provenance: FrameIdentityProvenance::default(),
                    revision: 1,
                    created_version: 2,
                    updated_version: 2,
                },
                ContextFrame {
                    id: "other".to_string(),
                    body: "(status concurrent)".to_string(),
                    sources: Vec::new(),
                    provenance: FrameIdentityProvenance::default(),
                    revision: 1,
                    created_version: 7,
                    updated_version: 7,
                },
            ],
            ..Default::default()
        };
        let mut tx =
            parse_transaction("(context-tx (base-version 6) (revise mine (status new)))").unwrap();

        rebase_stale_frame_transaction(&state, &mut tx).unwrap();
        let (next, _) = apply_parsed_transaction(&state, &tx, &HashSet::new()).unwrap();
        let mine = next.frames.iter().find(|frame| frame.id == "mine").unwrap();
        assert_eq!(mine.revision, 2);
        assert_eq!(mine.body, "(status new)");
    }

    #[test]
    fn stale_revise_of_changed_frame_is_a_semantic_conflict() {
        let state = MindState {
            version: 7,
            frames: vec![ContextFrame {
                id: "shared".to_string(),
                body: "(status concurrent-update)".to_string(),
                sources: Vec::new(),
                provenance: FrameIdentityProvenance::default(),
                revision: 3,
                created_version: 2,
                updated_version: 7,
            }],
            ..Default::default()
        };
        let mut tx =
            parse_transaction("(context-tx (base-version 6) (revise shared (status mine)))")
                .unwrap();

        let error = rebase_stale_frame_transaction(&state, &mut tx).unwrap_err();
        assert!(error.contains("Frame MVCC 冲突"));
        assert!(error.contains("shared"));
        assert_eq!(tx.base_version, 6);
    }

    #[test]
    fn stale_global_lifecycle_operation_remains_conservative() {
        let state = MindState {
            version: 7,
            frames: vec![ContextFrame {
                id: "shared".to_string(),
                body: "(status current)".to_string(),
                sources: Vec::new(),
                provenance: FrameIdentityProvenance::default(),
                revision: 1,
                created_version: 2,
                updated_version: 2,
            }],
            ..Default::default()
        };
        let mut tx =
            parse_transaction("(context-tx (base-version 6) (reason cleanup) (retire shared))")
                .unwrap();

        let error = rebase_stale_frame_transaction(&state, &mut tx).unwrap_err();
        assert!(error.contains("不能按 Frame MVCC 自动合并"));
        assert!(error.contains("retire"));
    }

    #[test]
    fn canonical_transaction_replays_multilingual_body_atoms() {
        let input = r#"(context-tx (base-version 0) (reason "从案例 A 提炼可复用证据优先级策略，长期维护") (create EVIDENCE-AUTHORITY-BEFORE-RECENCY (context-body (strategy "判断相互冲突的证据时，按以下优先级排序：1) 明确取代关系（supersedes）最优先；2) 权威性与批准状态高于单纯到达顺序；3) 到达先后仅作为同权威同批准状态下的次要参考。") (applicability 适用于来源权威性或批准状态可明确区分的证据冲突场景。) (boundary 本策略不否定已批准的更新证据合法取代旧结论——当新证据同样获得同等或更高权威批准时，应采信新证据。权威与批准状态始终是核心判据，到达顺序仅在权威和批准状态均相当时才作为参考。) (non-absolute "不可将权威优先绝对化为'旧权威永远正确'；若新证据已获同等或更高批准，则取代有效。") (derived-from case-a-decision))))"#;
        let parsed = parse_transaction(input).unwrap();
        let canonical = render_parsed_transaction(&parsed);
        let replayed = parse_transaction(&canonical).unwrap();
        let (recorded, recorded_changes) =
            apply_parsed_transaction(&MindState::default(), &parsed, &HashSet::new()).unwrap();
        let (candidate, replayed_changes) =
            apply_parsed_transaction(&MindState::default(), &replayed, &HashSet::new()).unwrap();

        assert_eq!(recorded, candidate, "canonical={canonical}");
        assert_eq!(recorded_changes, replayed_changes);
    }

    #[test]
    fn transaction_rejects_maintenance_operations_accidentally_nested_in_frame_body() {
        let error = parse_transaction(
            r#"(context-tx
                (base-version 7)
                (reason "critical maintenance")
                (derive compact-v2 (from compact-v1)
                    (context-body
                        (context-body (status active))
                        (protect compact-v2)
                        (retire compact-v1 @e42))))"#,
        )
        .unwrap_err();

        assert!(error.contains("被嵌套"), "{error}");
        assert!(error.contains("context-tx 顶层"), "{error}");
    }

    #[test]
    fn render_has_kernel_mind_and_inbox_without_fixed_cognitive_schema() {
        let mut state = MindState::default();
        state.frames.push(ContextFrame {
            id: "free-form".to_string(),
            body: "(whatever (the agent invents))".to_string(),
            sources: Vec::new(),
            provenance: FrameIdentityProvenance::default(),
            revision: 1,
            created_version: 1,
            updated_version: 1,
        });
        state.version = 1;
        let pressure = ContextPressure {
            level: "normal".to_string(),
            estimated_tokens: 10,
            token_source: default_context_token_source(),
            token_accuracy: default_context_token_accuracy(),
            token_scope: default_context_token_scope(),
            token_model: None,
            soft_limit: 100,
            hard_limit: 200,
            maintenance_reserve: 20,
            active_frames: 1,
            active_observations: 0,
        };
        let mut budget = TurnBudget {
            attempt: 1,
            checkpoint_interval: 90,
            next_checkpoint_at: 90,
            attempts_until_checkpoint: 89,
            checkpoint_due: false,
            context_transactions_used: 0,
            context_transactions_limit: 6,
            context_tx_available: true,
            phase: "work".to_string(),
        };
        let wake = WakeSignal {
            cause: "user-message".to_string(),
            event_id: Some("user:1".to_string()),
            tool_name: None,
            visible_in_inbox: true,
        };
        let references = ContextReferences::default();
        let observations = vec![ContextObservation {
            id: "user:1".to_string(),
            reference: "@e7".to_string(),
            session_id: Some("s1".to_string()),
            principal_id: Some("principal-default".to_string()),
            sequence: 7,
            turn: 1,
            attempt: None,
            caused_by: None,
            kind: "user_message".to_string(),
            topic: "chat/user_message".to_string(),
            actor: "User".to_string(),
            timestamp: "2026-07-26T00:00:00Z".to_string(),
            preview: "先回答我".to_string(),
            truncated: false,
            representation: "full".to_string(),
            visible_chars: 4,
            total_chars: 4,
            retrievable: true,
            protected: true,
            tool_name: None,
            tool_status: None,
            output_empty: None,
            resource: None,
            freshness: ContextFreshness::default(),
            usage: ContextUsage::default(),
        }];
        let evaluation = ActivationFocus {
            activation_id: "work-current".to_string(),
            session_id: "s1".to_string(),
            root_turn_id: "user:1".to_string(),
            thread_kind: "dialogue_turn".to_string(),
            root_kind: "chat/user_message".to_string(),
            root_preview: "先回答我".to_string(),
            trigger_event_id: "user:1".to_string(),
            trigger_kind: "chat/user_message".to_string(),
            trigger_preview: "先回答我".to_string(),
            signal_batch: vec![ActivationSignalFocus {
                event_id: "user:1".to_string(),
                kind: "chat/user_message".to_string(),
                sequence: 7,
            }],
            objective_id: None,
            objective_evaluation_id: None,
        };
        let concurrent_activations = vec![ConcurrentActivationView {
            activation_id: "work-existing".to_string(),
            session_id: "s1".to_string(),
            root_turn_id: "user:old".to_string(),
            thread_kind: "execution".to_string(),
            thread_id: "user:old".to_string(),
            status: "running".to_string(),
            root_preview: "运行长任务".to_string(),
            pending_tools: vec!["exec".to_string()],
        }];
        let working_set = SessionWorkingSetView {
            active_window_secs: 86_400,
            max_sessions: 50,
            current_session_ids: vec!["s1".to_string()],
            full_session_ids: Vec::new(),
            metadata_only_session_ids: Vec::new(),
            excluded: SessionWorkingSetExclusions::default(),
            selection: "test".to_string(),
        };
        let cognitive_clock = ContextCognitiveClock {
            context_id: "context-1".to_string(),
            tick: 142,
            last_signal_batch_id: Some("work-current".to_string()),
            revision: 142,
        };
        let rendered = render_context(ContextRenderInput {
            context_id: "context-1",
            active_session_id: "s1",
            active_principal_id: None,
            parent_session_id: None,
            sessions: &[],
            session_working_set: &working_set,
            active_activations: &[],
            threads: &[],
            thread_signals: &[],
            schedules: &[],
            activation: Some(&evaluation),
            concurrent_activations: &concurrent_activations,
            background_tasks: &[],
            objectives: &[],
            execution_targets: &[],
            execution_target_access: &[],
            cognitive_clock: &cognitive_clock,
            frame_retirement_cooling_ticks: 8,
            state: &state,
            observations: &observations,
            pressure: &pressure,
            turn_budget: &budget,
            wake: &wake,
            references: &references,
        });
        let parsed = parse(&rendered).unwrap();
        assert_eq!(
            parsed.get_path(&["protocol", "version"]),
            Some(&SExpr::Atom(CONTEXT_PROTOCOL_VERSION.to_string()))
        );
        assert_eq!(
            parsed.get_path(&["kernel", "version"]),
            Some(&SExpr::Atom("1".to_string()))
        );
        assert_eq!(
            parsed.get_path(&["kernel", "cognitive-clock", "tick"]),
            Some(&SExpr::Atom("142".to_string()))
        );
        assert_eq!(
            parsed.get_path(&["kernel", "wake", "cause"]),
            Some(&SExpr::Atom("user-message".to_string()))
        );
        assert_eq!(
            parsed.get_path(&["kernel", "current-activation", "root-turn", "input"]),
            Some(&SExpr::Atom("先回答我".to_string()))
        );
        assert!(rendered.contains("只推进 root-turn 表达的任务"));
        assert!(rendered.contains(
            "(signal-batch (signal (event user:1) (kind chat/user_message) (sequence 7)))"
        ));
        assert!(
            rendered.contains("(activation (id work-current) (caused-by (signal-batch user:1)))")
        );
        assert!(!rendered.contains("current-evaluation"));
        assert!(rendered.contains("(pending-tools exec)"));
        assert!(rendered.contains("(thread-kind execution)"));
        assert!(rendered.contains("(thread-id user:old)"));
        assert!(rendered.contains("其他 Execution / Objective Thread 的只读运行状态"));
        assert!(rendered.contains("(evaluate"));
        assert!(rendered.contains("(thread (kind dialogue-turn) (id s1) (turn user:1))"));
        assert!(rendered.contains("(objective-binding none)"));
        assert!(rendered.contains("(root-input 先回答我)"));
        assert!(rendered.rfind("(evaluate").unwrap() > rendered.rfind("(inbox").unwrap());
        assert!(rendered.contains("(response-contract"));
        assert!(rendered.contains("(skill-discovery-contract"));
        assert!(rendered.contains("(fallback"));
        assert!(rendered.contains("不绑定平台、领域或具体 Skill 名称"));
        assert!(rendered.contains("只有直接能力与按需 Skill 发现都不能满足当前意图后"));
        assert!(rendered.contains("(reality-contract"));
        assert!(rendered.contains("(name reality-contract-v1)"));
        assert!(rendered.contains("(epistemic-contract"));
        assert!(rendered.contains("(name epistemic-contract-v1)"));
        for clause in REALITY_CONTRACT.iter().chain(EPISTEMIC_CONTRACT.iter()) {
            assert!(rendered.contains(clause.key));
            assert!(rendered.contains(clause.meaning));
        }
        assert!(rendered.contains("(context-tx-contract"));
        assert!(rendered.contains("(objective-contract"));
        assert!(rendered.contains("objective_create"));
        assert!(rendered.contains("Runtime 生成 ID 并绑定当前 Agent/Context/Session"));
        assert!(rendered.contains("(body-arity \"create derive revise one-or-more\")"));
        assert!(rendered.contains("(body-normalization"));
        assert!(rendered.contains("(revise-semantics"));
        assert!(rendered.contains("(checkpoint-policy"));
        assert!(rendered.contains("(source-placement"));
        assert!(rendered.contains("(syntax \"(retire ID...)\")"));
        assert!(rendered.contains("(mind (frame"));
        assert!(rendered.contains("(inbox (observation (ref @e7)"));
        assert!(rendered.contains("(observation-state (state (ref @e7)"));
        assert!(!rendered.contains("todo_stack"));
        assert!(!rendered.contains("(maintenance-candidates"));
        assert!(rendered.contains("(capacity-relief-priority discard-absorbed-observations-first)"));
        assert!(rendered.contains("(frame-selection semantic-value-validity-usage-and-relations)"));
        assert!(rendered.contains("(frame-size-alone never-a-retirement-reason)"));

        let mut warning_pressure = pressure.clone();
        warning_pressure.level = "warning".to_string();
        let warning = render_context(ContextRenderInput {
            context_id: "context-1",
            active_session_id: "s1",
            active_principal_id: None,
            parent_session_id: None,
            sessions: &[],
            session_working_set: &working_set,
            active_activations: &[],
            threads: &[],
            thread_signals: &[],
            schedules: &[],
            activation: Some(&evaluation),
            concurrent_activations: &concurrent_activations,
            background_tasks: &[],
            objectives: &[],
            execution_targets: &[],
            execution_target_access: &[],
            cognitive_clock: &cognitive_clock,
            frame_retirement_cooling_ticks: 8,
            state: &state,
            observations: &observations,
            pressure: &warning_pressure,
            turn_budget: &budget,
            wake: &wake,
            references: &references,
        });
        assert!(warning.contains("(level warning)"));
        assert!(!warning.contains("(maintenance-candidates"));
        assert!(!warning.contains("active-token-cost-estimate"));

        assert!(rendered.starts_with("(context (protocol"));
        let top_level_names = match parse(&rendered).unwrap() {
            SExpr::List(items) => items
                .iter()
                .filter_map(|item| match item {
                    SExpr::Atom(name) => Some(name.clone()),
                    SExpr::List(values) => values.first().and_then(|value| match value {
                        SExpr::Atom(name) => Some(name.clone()),
                        _ => None,
                    }),
                })
                .collect::<Vec<_>>(),
            _ => unreachable!(),
        };
        assert_eq!(
            top_level_names,
            vec![
                "context",
                "protocol",
                "evaluation-profile",
                "inbox",
                "observation-state",
                "mind",
                "session-directory",
                "kernel",
                "evaluation-environment",
                "evaluate",
            ]
        );
        let kernel_offset = rendered.find(" (kernel (context context-1)").unwrap();
        budget.attempt = 2;
        let changed = render_context(ContextRenderInput {
            context_id: "context-1",
            active_session_id: "s2",
            active_principal_id: None,
            parent_session_id: None,
            sessions: &[],
            session_working_set: &working_set,
            active_activations: &[],
            threads: &[],
            thread_signals: &[],
            schedules: &[],
            activation: Some(&evaluation),
            concurrent_activations: &concurrent_activations,
            background_tasks: &[],
            objectives: &[],
            execution_targets: &[],
            execution_target_access: &[],
            cognitive_clock: &cognitive_clock,
            frame_retirement_cooling_ticks: 8,
            state: &state,
            observations: &observations,
            pressure: &pressure,
            turn_budget: &budget,
            wake: &wake,
            references: &references,
        });
        assert_ne!(rendered, changed);
        assert_eq!(
            &rendered[..kernel_offset],
            &changed[..changed.find(" (kernel (context context-1)").unwrap()],
            "ordinary active-session/turn changes must not invalidate the protocol + Inbox + observation-state + Mind + Session prefix",
        );

        let mut observations_with_new_projection_state = observations.clone();
        observations_with_new_projection_state[0].protected = false;
        observations_with_new_projection_state[0]
            .usage
            .recall_count_total = 1;
        let state_changed = render_context(ContextRenderInput {
            context_id: "context-1",
            active_session_id: "s1",
            active_principal_id: None,
            parent_session_id: None,
            sessions: &[],
            session_working_set: &working_set,
            active_activations: &[],
            threads: &[],
            thread_signals: &[],
            schedules: &[],
            activation: Some(&evaluation),
            concurrent_activations: &concurrent_activations,
            background_tasks: &[],
            objectives: &[],
            execution_targets: &[],
            execution_target_access: &[],
            cognitive_clock: &cognitive_clock,
            frame_retirement_cooling_ticks: 8,
            state: &state,
            observations: &observations_with_new_projection_state,
            pressure: &pressure,
            turn_budget: &budget,
            wake: &wake,
            references: &references,
        });
        let observation_state_offset = rendered.find(" (observation-state").unwrap();
        assert_eq!(
            &rendered[..observation_state_offset],
            &state_changed[..state_changed.find(" (observation-state").unwrap()],
            "mutable Observation projection metadata must not rewrite the append-mostly Inbox prefix",
        );
        assert_ne!(rendered, state_changed);
    }

    #[test]
    fn final_dialogue_directive_keeps_objective_visible_but_read_only() {
        let evaluation = ActivationFocus {
            activation_id: "work-dialogue".to_string(),
            session_id: "session-a".to_string(),
            root_turn_id: "message-new".to_string(),
            thread_kind: "dialogue_turn".to_string(),
            root_kind: "chat/user_message".to_string(),
            root_preview: "人呢？".to_string(),
            trigger_event_id: "message-new".to_string(),
            trigger_kind: "chat/user_message".to_string(),
            trigger_preview: "人呢？".to_string(),
            signal_batch: Vec::new(),
            objective_id: None,
            objective_evaluation_id: None,
        };
        let now = Utc::now();
        let objectives = vec![ObjectiveRecord {
            id: "objective-background".to_string(),
            agent_id: "agent-a".to_string(),
            context_id: "context-a".to_string(),
            coordinator_session_id: "session-a".to_string(),
            delivery_session_id: "session-a".to_string(),
            parent_objective_id: None,
            source_event_id: "objective-source".to_string(),
            initiating_principal_id: None,
            stated_objective: "继续后台编码任务".to_string(),
            revision: 3,
            status: ObjectiveStatus::Active,
            status_reason: Some("等待后台工具".to_string()),
            wait_condition: None,
            active_evaluation_id: Some("objective-evaluation".to_string()),
            evaluation_lease_expires_at: None,
            continuation_sequence: 2,
            token_budget: None,
            tokens_used: 100,
            time_used_seconds: 12,
            created_at: now,
            updated_at: now,
        }];

        let rendered =
            render_evaluation_directive(&evaluation, &objectives, &ContextReferences::default())
                .to_string();
        assert!(rendered.contains("(thread (kind dialogue-turn)"));
        assert!(rendered.contains("(objective-binding none)"));
        assert!(rendered.contains("(status active)"));
        assert!(rendered.contains("(role background-read-only)"));
        assert!(rendered.contains("(goal 继续后台编码任务)"));
    }

    #[test]
    fn turn_control_emits_a_non_terminal_periodic_soft_checkpoint() {
        let user = Event::new(
            "user:1".to_string(),
            "User".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::Map::new(),
        );
        let call = |id: &str| {
            Event::new(
                id.to_string(),
                "Agent".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                serde_json::Map::new(),
            )
        };
        let config = OrchestratorConfig {
            attempt_soft_checkpoint_interval: 3,
            max_context_transactions_per_turn: 2,
            ..Default::default()
        };
        let events = vec![call("old"), user, call("new-1"), call("new-2")];
        let checkpoint = turn_budget_for(&events, &config);
        assert_eq!(checkpoint.attempt, 3);
        assert_eq!(checkpoint.checkpoint_interval, 3);
        assert_eq!(checkpoint.next_checkpoint_at, 3);
        assert_eq!(checkpoint.attempts_until_checkpoint, 0);
        assert!(checkpoint.checkpoint_due);
        assert_eq!(checkpoint.phase, "soft-checkpoint");

        let continued = turn_budget_for(
            &[
                call("old"),
                events[1].clone(),
                call("new-1"),
                call("new-2"),
                call("new-3"),
            ],
            &config,
        );
        assert_eq!(continued.attempt, 4);
        assert_eq!(continued.phase, "work");
        assert!(!continued.checkpoint_due);
        assert_eq!(continued.next_checkpoint_at, 6);
        assert_eq!(continued.attempts_until_checkpoint, 2);
    }

    #[test]
    fn objective_evaluation_started_does_not_reset_context_tx_cycle_budget() {
        let event = |id: &str, event_type: &str, topic: &str, payload: serde_json::Value| {
            Event::new(
                id.to_string(),
                "test".to_string(),
                event_type.to_string(),
                topic.to_string(),
                payload.as_object().unwrap().clone(),
            )
        };
        let context_tx_call = |id: &str| {
            event(
                id,
                TYPE_AGENT_CALL,
                "chat/assistant_call",
                json!({
                    "continuation_tool_calls": [{
                        "function": {"name": "context_tx", "arguments": "{}"}
                    }]
                }),
            )
        };
        let events = vec![
            event("user-1", TYPE_USER_MESSAGE, "chat/user_message", json!({})),
            context_tx_call("call-old-1"),
            context_tx_call("call-old-2"),
            event(
                "objective-cycle-2",
                crate::objective::TYPE_OBJECTIVE_CONTROL,
                "objective/evaluation_started",
                json!({"objective_id":"objective-1"}),
            ),
            context_tx_call("call-current"),
        ];
        let config = OrchestratorConfig {
            max_context_transactions_per_turn: 2,
            ..OrchestratorConfig::default()
        };
        let budget = turn_budget_for(&events, &config);
        assert_eq!(budget.attempt, 4);
        assert_eq!(budget.context_transactions_used, 3);
        assert!(!budget.context_tx_available);
    }

    #[test]
    fn context_only_calls_use_an_independent_budget() {
        let user = Event::new(
            "user:1".to_string(),
            "User".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::Map::new(),
        );
        let context_call = |id: &str| {
            Event::new(
                id.to_string(),
                "Agent".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                vec![(
                    "tool_calls".to_string(),
                    json!([{"function": {"name": "context_tx"}}]),
                )]
                .into_iter()
                .collect(),
            )
        };
        let physical_call = Event::new(
            "read".to_string(),
            "Agent".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/assistant_call".to_string(),
            vec![(
                "tool_calls".to_string(),
                json!([{"function": {"name": "read"}}]),
            )]
            .into_iter()
            .collect(),
        );
        let config = OrchestratorConfig {
            attempt_soft_checkpoint_interval: 4,
            max_context_transactions_per_turn: 2,
            ..Default::default()
        };
        let budget = turn_budget_for(
            &[
                user,
                context_call("context-1"),
                context_call("context-2"),
                physical_call,
            ],
            &config,
        );
        assert_eq!(budget.attempt, 4);
        assert!(budget.checkpoint_due);
        assert_eq!(budget.attempts_until_checkpoint, 0);
        assert_eq!(budget.context_transactions_used, 2);
        assert!(!budget.context_tx_available);
        assert_eq!(budget.phase, "soft-checkpoint");
    }

    #[test]
    fn wake_signal_distinguishes_user_external_tool_and_context_receipt() {
        let user = Event::new(
            "user:1".to_string(),
            "User".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::Map::new(),
        );
        assert_eq!(wake_for(std::slice::from_ref(&user)).cause, "user-message");

        let read_output = Event::new(
            "output:read".to_string(),
            "Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![("tool_name".to_string(), json!("read"))]
                .into_iter()
                .collect(),
        );
        let external = wake_for(&[user.clone(), read_output]);
        assert_eq!(external.cause, "tool-output");
        assert_eq!(external.tool_name.as_deref(), Some("read"));
        assert!(external.visible_in_inbox);

        let context_output = Event::new(
            "output:context".to_string(),
            "Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("context_tx")),
                ("text".to_string(), json!(r#"{"status":"committed"}"#)),
            ]
            .into_iter()
            .collect(),
        );
        let receipt = wake_for(&[user.clone(), context_output]);
        assert_eq!(receipt.cause, "context-transaction-result");
        assert!(!receipt.visible_in_inbox);

        let failure = Event::new(
            "output:context-failure".to_string(),
            "Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("context_tx")),
                ("text".to_string(), json!("执行失败: stale version")),
            ]
            .into_iter()
            .collect(),
        );
        let failure_wake = wake_for(&[user.clone(), failure]);
        assert_eq!(failure_wake.cause, "context-transaction-result");
        assert!(failure_wake.visible_in_inbox);

        // A question raised by the Agent's own half-evaluated program must not
        // look like someone speaking: mistaking it for a user message would
        // send the answer to the user instead of to the waiting `infer`.
        let infer_request = Event::new(
            "infer:1".to_string(),
            "Runtime-Evaluator".to_string(),
            crate::event::TYPE_INFER_REQUEST.to_string(),
            "chat/infer_request".to_string(),
            vec![("task".to_string(), json!("铜印现在是什么形态"))]
                .into_iter()
                .collect(),
        );
        let inference = wake_for(&[user.clone(), infer_request]);
        assert_eq!(inference.cause, "infer-request");
        assert!(inference.visible_in_inbox);

        let dialogue_retry = Event::new(
            "retry:1".to_string(),
            "Runtime-DialogueRetry".to_string(),
            crate::event::TYPE_INFER_REQUEST.to_string(),
            "chat/dialogue_retry".to_string(),
            vec![("root_turn_id".to_string(), json!("user:1"))]
                .into_iter()
                .collect(),
        );
        let retry_wake = wake_for(&[user.clone(), dialogue_retry]);
        assert_eq!(retry_wake.cause, "dialogue-retry");
        assert!(retry_wake.visible_in_inbox);

        let policy = Event::new(
            "output:context-policy".to_string(),
            "Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("context_tx")),
                (
                    "context_tx_status".to_string(),
                    json!("attachment-required"),
                ),
                (
                    "text".to_string(),
                    json!("执行拒绝: CONTEXT_TX_ATTACHMENT_REQUIRED"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let policy_wake = wake_for(&[user, policy]);
        assert_eq!(policy_wake.cause, "context-transaction-result");
        assert!(policy_wake.visible_in_inbox);
    }

    #[test]
    fn retire_inline_reason_returns_actionable_error() {
        let tx = parse_transaction(
            "(context-tx (base-version 0) (reason \"cleanup\") (retire event:1 \"inline reason\"))",
        )
        .unwrap();
        let error =
            apply_parsed_transaction(&MindState::default(), &tx, &observations(&["event:1"]))
                .unwrap_err();
        assert!(error.contains("reason 必须写在事务级"));
        assert!(error.contains("不能放进 retire"));
    }

    #[test]
    fn derive_multiple_bodies_are_canonicalized_without_losing_sources() {
        let tx = parse_transaction(
            "(context-tx (base-version 0) (derive task (from user:1) (goal x) (status active)))",
        )
        .unwrap();
        let (state, _) =
            apply_parsed_transaction(&MindState::default(), &tx, &observations(&["user:1"]))
                .unwrap();
        assert_eq!(state.frames[0].sources, vec!["user:1"]);
        assert_eq!(
            state.frames[0].body,
            "(context-body (goal x) (status active))"
        );
    }

    #[test]
    fn create_multiple_bodies_are_canonicalized_and_single_body_stays_compatible() {
        let tx = parse_transaction(
            "(context-tx (base-version 0) (create task (goal x) (status active)) (create note (note y)))",
        )
        .unwrap();
        let (state, _) =
            apply_parsed_transaction(&MindState::default(), &tx, &HashSet::new()).unwrap();
        assert_eq!(
            state.frames[0].body,
            "(context-body (goal x) (status active))"
        );
        assert_eq!(state.frames[1].body, "(note y)");
    }

    #[test]
    fn revise_multiple_bodies_supports_optional_sources() {
        let mut state = MindState::default();
        state.frames.push(ContextFrame {
            id: "task".to_string(),
            body: "(status pending)".to_string(),
            sources: Vec::new(),
            provenance: FrameIdentityProvenance::default(),
            revision: 1,
            created_version: 0,
            updated_version: 0,
        });
        let tx = parse_transaction(
            "(context-tx (base-version 0) (revise task (from user:1) (status completed) (next none)))",
        )
        .unwrap();
        let (state, _) = apply_parsed_transaction(&state, &tx, &observations(&["user:1"])).unwrap();
        assert_eq!(state.frames[0].sources, vec!["user:1"]);
        assert_eq!(
            state.frames[0].body,
            "(context-body (status completed) (next none))"
        );
        assert_eq!(state.frames[0].revision, 2);
    }

    #[test]
    fn create_with_from_is_rejected_in_favor_of_explicit_derive() {
        let error = parse_transaction(
            "(context-tx (base-version 0) (create task (from user:1) (status active)))",
        )
        .unwrap_err();
        assert!(error.contains("create 不接受"));
        assert!(error.contains("derive"));
    }

    #[test]
    fn preview_keeps_head_and_tail_without_semantic_rewrite() {
        let (preview, truncated) = preview_text("abcdefghij", 6);
        assert!(truncated);
        assert!(preview.starts_with("abc"));
        assert!(preview.ends_with("hij"));
    }

    #[test]
    fn supersedes_relation_marks_freshness_without_deleting_history() {
        let old = Event::new(
            "config:old".to_string(),
            "Tool".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("configuration")),
                ("text".to_string(), json!("port=8080")),
                (
                    "context_resource".to_string(),
                    json!({"kind":"configuration", "key":"service-port", "version":"v1"}),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let new = Event::new(
            "config:new".to_string(),
            "Tool".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("configuration")),
                ("text".to_string(), json!("port=9090")),
                (
                    "context_resource".to_string(),
                    json!({"kind":"configuration", "key":"service-port", "version":"v2"}),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let tx = parse_transaction(
            "(context-tx (base-version 0) (relate config:new supersedes config:old))",
        )
        .unwrap();
        let ids = observations(&["config:old", "config:new"]);
        let (state, _) = apply_parsed_transaction(&MindState::default(), &tx, &ids).unwrap();
        let metadata = observation_metadata(&[old, new], &state);

        assert_eq!(metadata["config:new"].freshness.latest, Some(true));
        assert_eq!(metadata["config:old"].freshness.latest, Some(false));
        assert_eq!(
            metadata["config:old"].freshness.superseded_by,
            vec!["config:new"]
        );
        assert!(!state.retired.contains("config:old"));

        let remove = parse_transaction(
            "(context-tx (base-version 1) (reason \"关系判断已撤销\") (unrelate config:new supersedes config:old))",
        )
        .unwrap();
        let (state, _) = apply_parsed_transaction(&state, &remove, &ids).unwrap();
        assert!(state.relations.is_empty());
    }

    #[test]
    fn usage_counts_only_active_recall_and_semantic_sources() {
        let source = Event::new(
            "evidence:1".to_string(),
            "Tool".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("source")),
                ("text".to_string(), json!("important evidence")),
            ]
            .into_iter()
            .collect(),
        );
        let recall = Event::new(
            "recall:1".to_string(),
            "System-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("recall")),
                (
                    "text".to_string(),
                    json!(
                        json!({"event_id":"evidence:1", "text":"important evidence"}).to_string()
                    ),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let transaction =
            "(context-tx (base-version 0) (derive finding (from evidence:1) (fact verified)))";
        let committed = Event::new(
            "context:1".to_string(),
            "Agent-Context".to_string(),
            TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            vec![("transaction".to_string(), json!(transaction))]
                .into_iter()
                .collect(),
        );
        let mut state = MindState::default();
        state.frames.push(ContextFrame {
            id: "finding".to_string(),
            body: "(fact verified)".to_string(),
            sources: vec!["evidence:1".to_string()],
            provenance: FrameIdentityProvenance::default(),
            revision: 1,
            created_version: 1,
            updated_version: 1,
        });
        let metadata = observation_metadata(&[source, recall, committed], &state);
        let usage = &metadata["evidence:1"].usage;
        assert_eq!(usage.recall_count_total, 1);
        assert_eq!(usage.reference_count_total, 1);
        assert_eq!(usage.referenced_by_active_frames, 1);

        let merely_present = Event::new(
            "evidence:2".to_string(),
            "Tool".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![("text".to_string(), json!("only shown"))]
                .into_iter()
                .collect(),
        );
        let metadata = observation_metadata(&[merely_present], &MindState::default());
        assert_eq!(metadata["evidence:2"].usage, ContextUsage::default());
    }

    #[test]
    fn chronology_and_causality_are_runtime_facts() {
        let mut user = Event::new(
            "user:1".to_string(),
            "User".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::Map::new(),
        );
        user.sequence = Some(41);
        let call = Event::new(
            "call:1".to_string(),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/assistant_call".to_string(),
            vec![("attempt_id".to_string(), json!("attempt:1"))]
                .into_iter()
                .collect(),
        );
        let mut output = Event::new(
            "output:1".to_string(),
            "System-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("attempt_id".to_string(), json!("attempt:1")),
                ("tool_call_id".to_string(), json!("tool-call:1")),
                ("text".to_string(), json!("result")),
            ]
            .into_iter()
            .collect(),
        );
        output.sequence = Some(43);

        let metadata = observation_metadata(&[user, call, output], &MindState::default());
        assert_eq!(metadata["output:1"].sequence, 43);
        assert_eq!(metadata["output:1"].turn, 1);
        assert_eq!(metadata["output:1"].attempt, Some(1));
        assert_eq!(
            metadata["output:1"].caused_by.as_deref(),
            Some("tool-call:1")
        );
    }

    #[test]
    fn mind_state_defaults_optional_relation_collections() {
        let state: MindState = serde_json::from_value(json!({
            "version": 2,
            "frames": [],
            "retired": [],
            "protected": []
        }))
        .unwrap();
        assert_eq!(state.version, 2);
        assert!(state.relations.is_empty());
        assert!(state.checkpoints.is_empty());
    }

    #[test]
    fn checkpoint_rollback_restores_complete_frame_after_lossy_revision() {
        let observations = HashSet::new();
        let create = parse_transaction(
            "(context-tx (base-version 0) (create project (project ORBIT-42) (port 9090) (timezone UTC)) (protect project))",
        )
        .unwrap();
        let (state, _) =
            apply_parsed_transaction(&MindState::default(), &create, &observations).unwrap();
        let checkpoint =
            parse_transaction("(context-tx (base-version 1) (checkpoint before-policy-change))")
                .unwrap();
        let (state, _) = apply_parsed_transaction(&state, &checkpoint, &observations).unwrap();
        assert_eq!(state.checkpoints.len(), 1);

        let lossy = parse_transaction(
            "(context-tx (base-version 2) (revise project (timezone Asia/Shanghai)))",
        )
        .unwrap();
        let (state, _) = apply_parsed_transaction(&state, &lossy, &observations).unwrap();
        assert!(!state.frames[0].body.contains("ORBIT-42"));

        let rollback = parse_transaction(
            "(context-tx (base-version 3) (reason \"stable identity was lost\") (rollback before-policy-change))",
        )
        .unwrap();
        let (state, changes) = apply_parsed_transaction(&state, &rollback, &observations).unwrap();
        assert!(state.frames[0].body.contains("ORBIT-42"));
        assert!(state.frames[0].body.contains("9090"));
        assert!(state.protected.contains("project"));
        assert_eq!(state.checkpoints.len(), 1);
        assert_eq!(changes[0].operation, "rollback");

        let drop_checkpoint = parse_transaction(
            "(context-tx (base-version 4) (reason \"recovery verified\") (drop-checkpoint before-policy-change))",
        )
        .unwrap();
        let (state, _) = apply_parsed_transaction(&state, &drop_checkpoint, &observations).unwrap();
        assert!(state.checkpoints.is_empty());
    }

    #[test]
    fn runtime_generated_long_event_ids_remain_valid_context_references() {
        let id = format!(
            "output_attempt_{}_call_{}",
            "session".repeat(35),
            "a".repeat(64)
        );
        assert!(id.len() > 128);
        assert_eq!(validated_id(&id).unwrap(), id);
    }

    #[tokio::test]
    async fn short_event_references_are_rendered_resolved_and_canonicalized_for_replay() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("short-event-references.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let session_id = "short-reference-session";
        let long_id = format!(
            "output_attempt_{}_call_{}",
            "session".repeat(25),
            "a".repeat(48)
        );
        store
            .append(Event::new(
                long_id.clone(),
                "System-Executor".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    ("session_id".to_string(), json!(session_id)),
                    ("text".to_string(), json!("stable evidence")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        let config = OrchestratorConfig::default();
        let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config.clone());

        let before = engine
            .build_context_encoding(session_id, session_id, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(before.observations[0].reference, "@e1");
        assert!(before.sexpr.contains("(ref @e1)"));
        assert!(before.sexpr.contains("(event @e1)"));
        assert!(!before.sexpr.contains(&long_id));

        engine
            .apply_context_transaction(
                session_id,
                session_id,
                r#"(context-tx (base-version 0) (reason "evidence absorbed")
                    (derive finding (from @e1) (finding stable) (confidence high))
                    (relate finding supersedes @e1)
                    (protect finding)
                    (retire @e1))"#,
            )
            .await
            .unwrap();

        let after = engine
            .build_context_encoding(session_id, session_id, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(after.state.frames[0].sources, vec![long_id.clone()]);
        assert_eq!(
            after.state.frames[0].body,
            "(context-body (finding stable) (confidence high))"
        );
        assert_eq!(after.state.relations[0].object, long_id);
        assert!(after
            .state
            .retired
            .contains(&after.state.frames[0].sources[0]));
        assert!(after.sexpr.contains("(sources @e1)"));
        assert!(after.sexpr.contains("(object @e1)"));
        assert!(!after.sexpr.contains(&after.state.frames[0].sources[0]));
        let committed = store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                topic: Some("chat/context_tx_committed".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let canonical = committed[0].payload["transaction"].as_str().unwrap();
        assert!(canonical.contains(&after.state.frames[0].sources[0]));
        assert!(!canonical.contains("@e1"));

        let restarted = ContextEngine::new(store, config);
        assert_eq!(
            restarted
                .build_context_encoding(session_id, session_id, &HashSet::new())
                .await
                .unwrap()
                .state,
            after.state
        );
    }

    #[tokio::test]
    async fn context_engine_auto_rebases_disjoint_frame_commits() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("frame-mvcc.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        );

        engine
            .apply_context_transaction(
                "frame-mvcc-context",
                "session-a",
                "(context-tx (base-version 0) (create frame-a (fact a)))",
            )
            .await
            .unwrap();
        let rebased = engine
            .apply_context_transaction(
                "frame-mvcc-context",
                "session-b",
                "(context-tx (base-version 0) (create frame-b (fact b)))",
            )
            .await
            .unwrap();

        assert_eq!(rebased.before_version, 1);
        assert_eq!(rebased.after_version, 2);
        let state = engine
            .load_current_mind("frame-mvcc-context", None)
            .await
            .unwrap();
        assert_eq!(state.version, 2);
        assert!(state.frames.iter().any(|frame| frame.id == "frame-a"));
        assert!(state.frames.iter().any(|frame| frame.id == "frame-b"));
        let committed = store
            .query(QueryFilter {
                topic: Some("chat/context_tx_committed".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        let rebased_event = committed
            .iter()
            .find(|event| event.payload["after_version"] == json!(2))
            .unwrap();
        assert_eq!(rebased_event.payload["requested_base_version"], json!(0));
        assert_eq!(rebased_event.payload["before_version"], json!(1));
        assert_eq!(rebased_event.payload["auto_rebased"], json!(true));
        assert!(rebased_event.payload["transaction"]
            .as_str()
            .unwrap()
            .contains("(base-version 1)"));
        let metrics = engine.capacity_metrics();
        assert_eq!(metrics.context_tx_conflicts_total, 1);
        assert_eq!(metrics.context_tx_auto_rebases_total, 1);
    }

    #[tokio::test]
    async fn event_recall_chunks_are_not_previewed_a_second_time() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("recall-preview.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let config = OrchestratorConfig {
            observation_preview_chars: 1_200,
            ..Default::default()
        };
        let engine = ContextEngine::new(store, config);
        assert_eq!(engine.recall_chunk_chars(), 4_000);

        let text = serde_json::json!({
            "context_delivery": "full-event-chunk",
            "event_id": "source-event",
            "text": "x".repeat(1_500),
        })
        .to_string();
        let event = Event::new(
            "recall-output".to_string(),
            "System-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("recall")),
                ("text".to_string(), json!(text)),
            ]
            .into_iter()
            .collect(),
        );
        let observation = engine.to_observation(
            &event,
            &MindState::default(),
            ObservationMetadata::default(),
        );
        assert!(!observation.truncated);
        assert!(observation.preview.contains(&"x".repeat(1_500)));
    }

    #[test]
    fn control_plane_events_do_not_feed_the_agent_inbox() {
        let assistant_call = Event::new(
            "call:1".to_string(),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/assistant_call".to_string(),
            serde_json::Map::new(),
        );
        let context_receipt = Event::new(
            "output:ctx".to_string(),
            "System-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![("tool_name".to_string(), json!("context_tx"))]
                .into_iter()
                .collect(),
        );
        let tool_activity = Event::new(
            "runtime:tool-calls".to_string(),
            "Runtime-Orchestrator".to_string(),
            "runtime_control".to_string(),
            "runtime/tool_calls_selected".to_string(),
            serde_json::Map::new(),
        );
        let reasoning_summary = Event::new(
            "runtime:model-reasoning-summary".to_string(),
            "Model-Provider".to_string(),
            "runtime_control".to_string(),
            "runtime/model_reasoning_summary".to_string(),
            vec![("text".to_string(), json!("provider-authored summary"))]
                .into_iter()
                .collect(),
        );
        let external_output = Event::new(
            "output:read".to_string(),
            "System-Executor".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![("tool_name".to_string(), json!("read"))]
                .into_iter()
                .collect(),
        );
        let rejected_context = Event::new(
            "output:ctx-rejected".to_string(),
            "System-ContextGuard".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/tool_output".to_string(),
            vec![
                ("tool_name".to_string(), json!("context_tx")),
                (
                    "text".to_string(),
                    json!("执行拒绝: MULTIPLE_DISTINCT_CONTEXT_TX"),
                ),
            ]
            .into_iter()
            .collect(),
        );

        assert!(!is_observation(&assistant_call));
        assert!(!is_observation(&context_receipt));
        assert!(!is_observation(&tool_activity));
        assert!(!is_observation(&reasoning_summary));
        assert!(is_observation(&rejected_context));
        assert!(is_observation(&external_output));
    }

    #[test]
    fn forged_context_transaction_event_is_not_trusted() {
        let forged = Event::new(
            "forged".to_string(),
            "Untrusted-Actor".to_string(),
            TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            vec![(
                "state_after".to_string(),
                json!(MindState {
                    version: 99,
                    ..Default::default()
                }),
            )]
            .into_iter()
            .collect(),
        );
        assert_eq!(load_mind_from_events(&[forged]).unwrap().version, 0);
    }

    #[test]
    fn tampered_state_after_is_rejected_by_deterministic_replay() {
        let transaction = "(context-tx (base-version 0) (create real (note truth)))";
        let event = Event::new(
            "tampered".to_string(),
            "Agent-Context".to_string(),
            TYPE_CONTEXT_TRANSACTION.to_string(),
            "chat/context_tx_committed".to_string(),
            vec![
                ("transaction".to_string(), json!(transaction)),
                (
                    "state_after".to_string(),
                    json!(MindState {
                        version: 1,
                        frames: vec![ContextFrame {
                            id: "forged".to_string(),
                            body: "(note lie)".to_string(),
                            sources: Vec::new(),
                            provenance: FrameIdentityProvenance::default(),
                            revision: 1,
                            created_version: 1,
                            updated_version: 1,
                        }],
                        ..Default::default()
                    }),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let error = load_mind_from_events(&[event]).unwrap_err();
        assert!(error.contains("重放结果不一致"));
    }

    #[tokio::test]
    async fn frame_recall_traverses_ancestors_with_stable_signed_pagination() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("recall-graph.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .create_context(NewCognitiveContext {
                id: "recall-graph-context".to_string(),
                agent_id: "recall-graph-agent".to_string(),
                title: "Recall Graph".to_string(),
            })
            .await
            .unwrap();
        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>)
        .with_recall_projection_store(Arc::clone(&store) as Arc<dyn RecallProjectionStore>);
        engine
            .apply_context_transaction(
                "recall-graph-context",
                "recall-graph-session",
                "(context-tx (base-version 0) (create A (fact a)) (create B (fact b)) (create D (fact d)))",
            )
            .await
            .unwrap();
        engine
            .apply_context_transaction(
                "recall-graph-context",
                "recall-graph-session",
                "(context-tx (base-version 1) (derive C (from A B) (summary c)) (derive E (from C D) (summary e)) (retire A B) (reason \"consolidated\"))",
            )
            .await
            .unwrap();

        let request = |depth, max_nodes, cursor| FrameRecallRequest {
            context_id: "recall-graph-context".to_string(),
            frame_id: "E".to_string(),
            depth,
            direction: FrameRecallDirection::Ancestors,
            include_bodies: true,
            include_events: false,
            max_nodes,
            cursor,
        };
        let depth_zero = engine
            .recall_frame_graph(request(0, 32, None))
            .await
            .unwrap();
        assert_eq!(depth_zero.nodes.len(), 1);
        assert_eq!(
            depth_zero
                .edges
                .iter()
                .map(|edge| edge.object.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["C", "D"]),
            "depth=0 still exposes the root's direct addressing edges"
        );
        let depth_one = engine
            .recall_frame_graph(request(1, 32, None))
            .await
            .unwrap();
        assert_eq!(depth_one.nodes.len(), 3);
        let depth_two = engine
            .recall_frame_graph(request(2, 32, None))
            .await
            .unwrap();
        let ids = depth_two
            .nodes
            .iter()
            .map(|node| match node {
                FrameRecallNode::Frame { id, .. } | FrameRecallNode::Event { id, .. } => id.clone(),
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            ids,
            ["A", "B", "C", "D", "E"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
        assert!(depth_two.nodes.iter().any(|node| matches!(
            node,
            FrameRecallNode::Frame { id, lifecycle, .. }
                if id == "A" && lifecycle == "retiring"
        )));

        let descendants = engine
            .recall_frame_graph(FrameRecallRequest {
                context_id: "recall-graph-context".to_string(),
                frame_id: "A".to_string(),
                depth: 2,
                direction: FrameRecallDirection::Descendants,
                include_bodies: false,
                include_events: false,
                max_nodes: 32,
                cursor: None,
            })
            .await
            .unwrap();
        assert_eq!(
            descendants
                .nodes
                .iter()
                .map(|node| match node {
                    FrameRecallNode::Frame { id, .. } | FrameRecallNode::Event { id, .. } => {
                        id.as_str()
                    }
                })
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["A", "C", "E"])
        );

        let first = engine
            .recall_frame_graph(request(2, 2, None))
            .await
            .unwrap();
        assert!(first.truncated);
        let second = engine
            .recall_frame_graph(request(2, 2, first.next_cursor.clone()))
            .await
            .unwrap();
        let third = engine
            .recall_frame_graph(request(2, 2, second.next_cursor.clone()))
            .await
            .unwrap();
        let paged = first
            .nodes
            .iter()
            .chain(&second.nodes)
            .chain(&third.nodes)
            .map(|node| match node {
                FrameRecallNode::Frame { id, .. } | FrameRecallNode::Event { id, .. } => id.clone(),
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(paged, ids);
        let mut tampered = first.next_cursor.unwrap();
        tampered.replace_range(0..1, if tampered.starts_with('0') { "1" } else { "0" });
        assert!(engine
            .recall_frame_graph(request(2, 2, Some(tampered)))
            .await
            .unwrap_err()
            .to_string()
            .contains("签名"));

        engine
            .apply_context_transaction(
                "recall-graph-context",
                "recall-graph-session",
                "(context-tx (base-version 2) (relate C related-to E) (relate E related-to C))",
            )
            .await
            .unwrap();
        let cyclic = engine
            .recall_frame_graph(FrameRecallRequest {
                context_id: "recall-graph-context".to_string(),
                frame_id: "E".to_string(),
                depth: 4,
                direction: FrameRecallDirection::Both,
                include_bodies: false,
                include_events: false,
                max_nodes: 128,
                cursor: None,
            })
            .await
            .unwrap();
        let cyclic_ids = cyclic
            .nodes
            .iter()
            .map(|node| match node {
                FrameRecallNode::Frame { id, .. } | FrameRecallNode::Event { id, .. } => id,
            })
            .collect::<HashSet<_>>();
        assert_eq!(
            cyclic_ids.len(),
            cyclic.nodes.len(),
            "cycles must not revisit nodes"
        );
    }

    #[tokio::test]
    async fn frame_retirement_uses_cognitive_ticks_and_successor_fast_path() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("frame-retirement.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .create_context(NewCognitiveContext {
                id: "retirement-context".to_string(),
                agent_id: "retirement-agent".to_string(),
                title: "Retirement Context".to_string(),
            })
            .await
            .unwrap();
        store
            .create_session(NewSession {
                id: "retirement-session".to_string(),
                agent_id: "retirement-agent".to_string(),
                context_id: "retirement-context".to_string(),
                parent_session_id: None,
                title: "Retirement Session".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let mut config = OrchestratorConfig::default();
        config.frame_retirement.cooling_ticks = 2;
        let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config)
            .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
            .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>)
            .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>)
            .with_recall_projection_store(Arc::clone(&store) as Arc<dyn RecallProjectionStore>)
            .with_cognitive_clock_store(Arc::clone(&store) as Arc<dyn CognitiveClockStore>);

        engine
            .apply_context_transaction(
                "retirement-context",
                "retirement-session",
                "(context-tx (base-version 0) (create recent-memory (fact recent)))",
            )
            .await
            .unwrap();
        let requested = engine
            .apply_context_transaction(
                "retirement-context",
                "retirement-session",
                "(context-tx (base-version 1) (reason organize) (retire recent-memory))",
            )
            .await
            .unwrap();
        assert!(requested
            .changes
            .iter()
            .any(|change| change.operation == "retire-frame-requested"));
        let requested_effect = requested
            .changes
            .iter()
            .find(|change| change.operation == "retire-frame-requested")
            .and_then(|change| change.token_effect.as_ref())
            .expect("ordinary Frame retirement must report a per-item estimate");
        assert_eq!(requested_effect.estimated_immediate_relief, 0);
        assert!(requested_effect.estimated_eventual_relief > 0);
        let state = engine
            .load_current_mind("retirement-context", None)
            .await
            .unwrap();
        assert!(state.retiring.contains_key("recent-memory"));
        assert!(!state.retired.contains("recent-memory"));

        for tick in 1_u64..=2 {
            let event_id = format!("retirement-signal-{tick}");
            let root_turn_id = format!("retirement-root-{tick}");
            store
                .append(Event::new(
                    event_id.clone(),
                    "User".to_string(),
                    TYPE_USER_MESSAGE.to_string(),
                    "chat/user_message".to_string(),
                    serde_json::json!({
                        "context_id": "retirement-context",
                        "session_id": "retirement-session",
                        "root_turn_id": root_turn_id,
                        "text": format!("new fact {tick}")
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                ))
                .await
                .unwrap();
            let sequence = store
                .query(QueryFilter {
                    event_id: Some(event_id.clone()),
                    ..Default::default()
                })
                .await
                .unwrap()[0]
                .sequence
                .unwrap();
            let thread_id = format!("retirement-thread-{tick}");
            store
                .ensure_thread(crate::memory::NewThread {
                    id: thread_id.clone(),
                    agent_id: "retirement-agent".to_string(),
                    context_id: "retirement-context".to_string(),
                    session_id: "retirement-session".to_string(),
                    initiating_principal_id: None,
                    root_turn_id: root_turn_id.clone(),
                    kind: crate::memory::ThreadKind::DialogueTurn,
                    executor_kind: "self".to_string(),
                    executor_id: None,
                    target_id: None,
                })
                .await
                .unwrap();
            store
                .claim_thread_signal_batch(
                    crate::memory::NewThreadSignal {
                        id: format!("retirement-mail-{tick}"),
                        thread_id,
                        event_id: event_id.clone(),
                        principal_id: None,
                        sequence,
                        kind: "chat/user_message".to_string(),
                        parent_activation_id: None,
                    },
                    crate::memory::NewThreadActivation {
                        id: format!("retirement-activation-{tick}"),
                        agent_id: "retirement-agent".to_string(),
                        context_id: "retirement-context".to_string(),
                        session_id: "retirement-session".to_string(),
                        initiating_principal_id: None,
                        trigger_event_id: event_id,
                        trigger_sequence: sequence,
                        trigger_kind: "chat/user_message".to_string(),
                        parent_activation_id: None,
                        root_turn_id,
                    },
                    32,
                )
                .await
                .unwrap()
                .unwrap();
            let view = engine
                .build_context_encoding("retirement-context", "retirement-session", &HashSet::new())
                .await
                .unwrap();
            assert_eq!(view.cognitive_clock.tick, tick);
            if tick == 1 {
                assert!(view.state.retiring.contains_key("recent-memory"));
                assert!(view.sexpr.contains("(state retiring)"));
                assert!(view.sexpr.contains("(remaining-ticks 1)"));
            } else {
                assert!(!view.state.retiring.contains_key("recent-memory"));
                assert!(view.state.retired.contains("recent-memory"));
            }
        }

        engine
            .apply_context_transaction(
                "retirement-context",
                "retirement-session",
                "(context-tx (base-version 3) (create case-a (fact a)))",
            )
            .await
            .unwrap();
        let consolidated = engine
            .apply_context_transaction(
                "retirement-context",
                "retirement-session",
                "(context-tx (base-version 4) (reason consolidate) (derive general-model (from case-a) (knowledge general)) (relate general-model supersedes case-a) (retire case-a))",
            )
            .await
            .unwrap();
        let state = engine
            .load_current_mind("retirement-context", None)
            .await
            .unwrap();
        assert!(state.retired.contains("case-a"));
        assert!(!state.retiring.contains_key("case-a"));
        assert!(consolidated.changes.iter().any(|change| {
            change.operation == "retire-frame-finalized"
                && change
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("general-model"))
        }));
        let consolidated_effect = consolidated
            .changes
            .iter()
            .find(|change| {
                change.operation == "retire-frame-finalized" && change.target == "case-a"
            })
            .and_then(|change| change.token_effect.as_ref())
            .expect("successor retirement must report its source Frame relief");
        assert!(consolidated_effect.estimated_immediate_relief > 0);
        assert_eq!(consolidated_effect.estimated_eventual_relief, 0);
    }

    #[tokio::test]
    async fn committed_mind_survives_engine_restart_and_observation_retirement() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-persistence.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let session_id = "persistent-session";
        store
            .create_context(NewCognitiveContext {
                id: session_id.to_string(),
                agent_id: "persistent-agent".to_string(),
                title: "Persistent Context".to_string(),
            })
            .await
            .unwrap();
        store
            .append(Event::new(
                "event:constraint".to_string(),
                "User".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                vec![
                    ("context_id".to_string(), json!(session_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("text".to_string(), json!("Never lose this constraint")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();

        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>)
        .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>);
        let before = engine
            .build_context_encoding(session_id, session_id, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(
            before
                .observations
                .iter()
                .map(|observation| observation.id.as_str())
                .collect::<Vec<_>>(),
            vec!["event:constraint"]
        );
        let committed = engine
            .apply_context_transaction(
                session_id,
                session_id,
                r#"(context-tx
                    (base-version 0)
                    (reason "由原始用户消息形成持久约束")
                    (derive durable-constraint (from event:constraint)
                        (constraint "Never lose this constraint"))
                    (protect durable-constraint)
                    (retire event:constraint))"#,
            )
            .await
            .unwrap();
        let retired_observation_effect = committed
            .changes
            .iter()
            .find(|change| change.operation == "retire" && change.target == "event:constraint")
            .and_then(|change| change.token_effect.as_ref())
            .expect("Observation retirement must report immediate per-item relief");
        assert!(retired_observation_effect.estimated_immediate_relief > 0);
        assert_eq!(retired_observation_effect.estimated_eventual_relief, 0);

        let restarted = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>)
        .with_session_projection_store(Arc::clone(&store) as Arc<dyn SessionProjectionStore>);
        let view = restarted
            .build_context_encoding(session_id, session_id, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(view.state.version, 1);
        assert_eq!(view.state.frames[0].id, "durable-constraint");
        assert!(view.state.protected.contains("durable-constraint"));
        assert!(view.observations.is_empty());
        assert!(restarted
            .find_event(session_id, "event:constraint")
            .await
            .unwrap()
            .is_some());
        assert!(
            restarted
                .audit_mind_projection(session_id)
                .await
                .unwrap()
                .matches
        );
    }

    #[tokio::test]
    async fn mind_update_and_session_retirement_commit_atomically_and_message_restores_once() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("session-attention.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        store
            .create_agent_bundle(
                NewAgent {
                    id: "attention-agent".to_string(),
                    title: "Attention Agent".to_string(),
                    root_context_id: "attention-context".to_string(),
                },
                NewCognitiveContext {
                    id: "attention-context".to_string(),
                    agent_id: "attention-agent".to_string(),
                    title: "Attention Context".to_string(),
                },
                NewSession {
                    id: "session-current".to_string(),
                    agent_id: "attention-agent".to_string(),
                    context_id: "attention-context".to_string(),
                    parent_session_id: None,
                    title: "Current".to_string(),
                    mount_kind: SessionMountKind::NewBlankContext,
                },
            )
            .await
            .unwrap();
        for id in ["session-b", "session-c"] {
            store
                .create_session(NewSession {
                    id: id.to_string(),
                    agent_id: "attention-agent".to_string(),
                    context_id: "attention-context".to_string(),
                    parent_session_id: None,
                    title: id.to_string(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }
        store
            .append(Event::new(
                "attention-evidence".to_string(),
                "User".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                vec![
                    ("context_id".to_string(), json!("attention-context")),
                    ("session_id".to_string(), json!("session-b")),
                    ("text".to_string(), json!("reusable evidence")),
                ]
                .into_iter()
                .collect(),
            ))
            .await
            .unwrap();
        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>);
        engine
            .apply_context_transaction(
                "attention-context",
                "session-current",
                r#"(context-tx
                    (base-version 0)
                    (reason "保留共享经验并释放两个陈旧会话")
                    (derive shared-experience (from attention-evidence)
                        (lesson "reusable evidence"))
                    (retire-session session-b session-c))"#,
            )
            .await
            .unwrap();

        assert_eq!(engine.mind_version("attention-context").await.unwrap(), 1);
        assert_eq!(
            engine
                .find_frame("attention-context", "shared-experience")
                .await
                .unwrap()
                .unwrap()
                .id,
            "shared-experience"
        );
        for id in ["session-b", "session-c"] {
            let session = store.get_session(id).await.unwrap().unwrap();
            assert_eq!(session.attention_state, SessionAttentionState::Retired);
            assert_eq!(session.attention_revision, 1);
        }

        let message = Event::new(
            "restoring-message".to_string(),
            "User".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            vec![
                ("context_id".to_string(), json!("attention-context")),
                ("session_id".to_string(), json!("session-b")),
                ("text".to_string(), json!("I am back")),
            ]
            .into_iter()
            .collect(),
        );
        store
            .claim_message("session-b", "client-restore-1", &message)
            .await
            .unwrap();
        store
            .claim_message("session-b", "client-restore-1", &message)
            .await
            .unwrap();
        let restored = store.get_session("session-b").await.unwrap().unwrap();
        assert_eq!(restored.attention_state, SessionAttentionState::Active);
        assert_eq!(restored.attention_revision, 2);
        let restore_events = store
            .query(QueryFilter {
                context_id: Some("attention-context".to_string()),
                topic: Some("runtime/session_restored".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(restore_events.len(), 1);
    }

    #[tokio::test]
    async fn concurrent_disjoint_frame_transactions_rebase_across_engines() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-concurrency.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        store
            .create_context(NewCognitiveContext {
                id: "shared-context".to_string(),
                agent_id: "shared-agent".to_string(),
                title: "Shared Context".to_string(),
            })
            .await
            .unwrap();
        let engine_left = Arc::new(
            ContextEngine::new(
                Arc::clone(&store) as Arc<dyn EventStore>,
                OrchestratorConfig::default(),
            )
            .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>),
        );
        let engine_right = Arc::new(
            ContextEngine::new(
                Arc::clone(&store) as Arc<dyn EventStore>,
                OrchestratorConfig::default(),
            )
            .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>),
        );

        let left = {
            let engine = Arc::clone(&engine_left);
            tokio::spawn(async move {
                engine
                    .apply_context_transaction(
                        "shared-context",
                        "session-left",
                        "(context-tx (base-version 0) (create left (note left)))",
                    )
                    .await
            })
        };
        let right = {
            let engine = Arc::clone(&engine_right);
            tokio::spawn(async move {
                engine
                    .apply_context_transaction(
                        "shared-context",
                        "session-right",
                        "(context-tx (base-version 0) (create right (note right)))",
                    )
                    .await
            })
        };

        let outcomes = [left.await.unwrap(), right.await.unwrap()];
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 2);
        assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 0);
        let view = engine_left
            .build_context_encoding("shared-context", "session-left", &HashSet::new())
            .await
            .unwrap();
        assert_eq!(view.state.version, 2);
        assert_eq!(view.state.frames.len(), 2);
        assert!(view.state.frames.iter().any(|frame| frame.id == "left"));
        assert!(view.state.frames.iter().any(|frame| frame.id == "right"));
        let left_metrics = engine_left.capacity_metrics();
        let right_metrics = engine_right.capacity_metrics();
        assert_eq!(
            left_metrics.context_transactions_total + right_metrics.context_transactions_total,
            2
        );
        assert_eq!(
            left_metrics.context_commits_total + right_metrics.context_commits_total,
            2
        );
        assert_eq!(
            left_metrics.context_tx_conflicts_total + right_metrics.context_tx_conflicts_total,
            1
        );
        assert_eq!(
            left_metrics.context_tx_auto_rebases_total
                + right_metrics.context_tx_auto_rebases_total,
            1
        );
        assert!(left_metrics.mind_projection_loads_total >= 2);
        assert!(
            engine_left
                .audit_mind_projection("shared-context")
                .await
                .unwrap()
                .matches
        );
    }

    #[tokio::test]
    async fn many_concurrent_disjoint_frame_transactions_converge_without_model_retries() {
        const WRITERS: usize = 12;

        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("context-many-writers.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        store
            .create_context(NewCognitiveContext {
                id: "many-writers-context".to_string(),
                agent_id: "many-writers-agent".to_string(),
                title: "Many Writers Context".to_string(),
            })
            .await
            .unwrap();

        let mut handles = Vec::with_capacity(WRITERS);
        for index in 0..WRITERS {
            let engine = Arc::new(
                ContextEngine::new(
                    Arc::clone(&store) as Arc<dyn EventStore>,
                    OrchestratorConfig::default(),
                )
                .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>),
            );
            handles.push(tokio::spawn(async move {
                engine
                    .apply_context_transaction(
                        "many-writers-context",
                        &format!("session-{index}"),
                        &format!(
                            "(context-tx (base-version 0) (create frame-{index} (writer {index})))"
                        ),
                    )
                    .await
            }));
        }

        for handle in handles {
            handle.await.unwrap().unwrap();
        }
        let verifier = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>);
        let view = verifier
            .build_context_encoding("many-writers-context", "session-0", &HashSet::new())
            .await
            .unwrap();
        assert_eq!(view.state.version, WRITERS as u64);
        assert_eq!(view.state.frames.len(), WRITERS);
        assert!(
            verifier
                .audit_mind_projection("many-writers-context")
                .await
                .unwrap()
                .matches
        );
    }

    #[tokio::test]
    async fn mind_seed_inherits_cognition_without_parent_sessions_or_observations() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-mind-seed.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        for context_id in ["seed-source", "seed-target"] {
            store
                .create_context(NewCognitiveContext {
                    id: context_id.to_string(),
                    agent_id: "seed-agent".to_string(),
                    title: context_id.to_string(),
                })
                .await
                .unwrap();
        }
        for (session_id, context_id) in [
            ("seed-session-a", "seed-source"),
            ("seed-session-b", "seed-source"),
            ("seed-session-c", "seed-target"),
        ] {
            store
                .create_session(NewSession {
                    id: session_id.to_string(),
                    agent_id: "seed-agent".to_string(),
                    context_id: context_id.to_string(),
                    parent_session_id: None,
                    title: session_id.to_string(),
                    mount_kind: crate::memory::SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
        }
        for (event_id, session_id, text) in [
            ("seed-event-a", "seed-session-a", "private A message"),
            ("seed-event-b", "seed-session-b", "private B message"),
        ] {
            store
                .append(Event::new(
                    event_id.to_string(),
                    "User".to_string(),
                    TYPE_USER_MESSAGE.to_string(),
                    "chat/user_message".to_string(),
                    vec![
                        ("context_id".to_string(), json!("seed-source")),
                        ("session_id".to_string(), json!(session_id)),
                        ("text".to_string(), json!(text)),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }
        let engine = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>);
        engine
            .apply_context_transaction(
                "seed-source",
                "seed-session-a",
                r#"(context-tx
                    (base-version 0)
                    (reason "建立可继承认知")
                    (create stable-principle (rule verify-first))
                    (derive evidence-frame (from seed-event-a) (finding alpha))
                    (relate stable-principle supports evidence-frame)
                    (protect stable-principle)
                    (retire evidence-frame))"#,
            )
            .await
            .unwrap();
        let source_before_seed = engine
            .build_context_encoding("seed-source", "seed-session-a", &HashSet::new())
            .await
            .unwrap();
        let source_transactions = store
            .query(QueryFilter {
                context_id: Some("seed-source".to_string()),
                topic: Some("chat/context_tx_committed".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(source_transactions.len(), 1);
        assert!(!source_transactions[0].payload.contains_key("state_after"));
        assert!(source_transactions[0].payload.contains_key("before_hash"));
        assert!(source_transactions[0].payload.contains_key("after_hash"));
        assert!(source_before_seed
            .state
            .protected
            .contains("stable-principle"));
        assert!(source_before_seed
            .state
            .retiring
            .contains_key("evidence-frame"));
        assert!(project_mind_seed(&source_before_seed.state)
            .protected
            .contains("stable-principle"));
        assert!(project_mind_seed(&source_before_seed.state)
            .retiring
            .is_empty());

        let receipt = engine
            .seed_context_from_mind("seed-source", Some(1), "seed-target")
            .await
            .unwrap();
        assert_eq!(receipt.source_version, 1);
        assert_eq!(receipt.inherited_frames, 2);
        let seed_snapshot = store
            .get_latest_mind_snapshot("seed-target")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(seed_snapshot.revision, 0);
        assert_eq!(seed_snapshot.state_hash, receipt.projected_hash);
        let target_events = engine.context_events("seed-target").await.unwrap();
        assert_eq!(target_events.len(), 1);
        let replayed_seed = load_mind_from_events(&target_events).unwrap();
        assert!(replayed_seed.protected.contains("stable-principle"));
        let child = engine
            .build_context_encoding("seed-target", "seed-session-c", &HashSet::new())
            .await
            .unwrap();
        assert_eq!(child.state.version, 0);
        assert_eq!(child.sessions.len(), 1);
        assert_eq!(child.sessions[0].session.id, "seed-session-c");
        assert!(child.observations.is_empty());
        assert!(child.state.protected.contains("stable-principle"));
        assert!(!child.state.retired.contains("evidence-frame"));
        assert!(!child.state.retiring.contains_key("evidence-frame"));
        let inherited = child
            .state
            .frames
            .iter()
            .find(|frame| frame.id == "evidence-frame")
            .unwrap();
        assert!(inherited.sources.is_empty());

        engine
            .apply_context_transaction(
                "seed-target",
                "seed-session-c",
                "(context-tx (base-version 0) (create child-only (note isolated)))",
            )
            .await
            .unwrap();
        let parent = engine
            .build_context_encoding("seed-source", "seed-session-a", &HashSet::new())
            .await
            .unwrap();
        assert_eq!(parent.state.version, 1);
        assert!(!parent
            .state
            .frames
            .iter()
            .any(|frame| frame.id == "child-only"));

        // Simulate a rebuildable Projection being deliberately removed while
        // retaining the immutable Ledger and its latest Snapshot. A new
        // Runtime must install r1 from Snapshot@0 plus exactly one transaction.
        let maintenance_pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db)
                    .create_if_missing(false),
            )
            .await
            .unwrap();
        let mut maintenance = maintenance_pool.begin().await.unwrap();
        sqlx::query("DELETE FROM mind_projections WHERE context_id = ?")
            .bind("seed-target")
            .execute(&mut *maintenance)
            .await
            .unwrap();
        sqlx::query("DELETE FROM context_heads WHERE context_id = ?")
            .bind("seed-target")
            .execute(&mut *maintenance)
            .await
            .unwrap();
        maintenance.commit().await.unwrap();
        maintenance_pool.close().await;

        let restarted = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>)
        .with_mind_projection_store(Arc::clone(&store) as Arc<dyn MindProjectionStore>);
        let restored = restarted
            .build_context_encoding("seed-target", "seed-session-c", &HashSet::new())
            .await
            .unwrap();
        assert_eq!(restored.state.version, 1);
        assert!(restored
            .state
            .frames
            .iter()
            .any(|frame| frame.id == "child-only"));
        let incremental = restarted
            .recover_mind_from_latest_snapshot("seed-target")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(incremental.snapshot_revision, 0);
        assert_eq!(incremental.transactions_replayed, 1);
        assert_eq!(incremental.state, restored.state);
        let audit = restarted
            .audit_mind_projection("seed-target")
            .await
            .unwrap();
        assert!(audit.matches);
        assert_eq!(audit.snapshot_revision, Some(0));
        assert_eq!(audit.incremental_transactions_scanned, Some(1));
        assert_eq!(audit.incremental_matches, Some(true));
    }

    #[tokio::test]
    async fn pressure_reports_all_active_observations_without_silent_trimming() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-pressure.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let session_id = "pressure-session";
        // Mirror the production incident: concurrent work accumulated 542
        // active observations in one Session before the next evaluation.
        for index in 0..542 {
            store
                .append(Event::new(
                    format!("event:{}", index),
                    "User".to_string(),
                    TYPE_USER_MESSAGE.to_string(),
                    "chat/user_message".to_string(),
                    vec![
                        ("session_id".to_string(), json!(session_id)),
                        ("text".to_string(), json!("x".repeat(200))),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await
                .unwrap();
        }
        let config = OrchestratorConfig {
            context_soft_token_limit: 100,
            context_hard_token_limit: 200,
            context_maintenance_reserve_tokens: 20,
            ..OrchestratorConfig::default()
        };
        let engine = ContextEngine::new(Arc::clone(&store) as Arc<dyn EventStore>, config);
        let mut view = engine
            .build_context_encoding(session_id, session_id, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(view.observations.len(), 542);
        assert_eq!(view.pressure.level, "critical");

        let full_pressure = view.pressure.clone();
        let (total, visible) = engine.apply_critical_maintenance_projection(&mut view, 3, 128);
        assert_eq!((total, visible), (542, 3));
        assert_eq!(
            view.observations
                .iter()
                .map(|observation| observation.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3],
            "recovery projection should expose the oldest maintenance candidates first"
        );
        assert!(view
            .observations
            .iter()
            .all(|observation| observation.visible_chars <= 128 && observation.retrievable));
        assert_eq!(
            view.pressure.estimated_tokens,
            full_pressure.estimated_tokens
        );
        assert_eq!(view.pressure.level, full_pressure.level);
        assert_eq!(view.pressure.active_observations, 542);

        let rebuilt = engine
            .build_context_encoding(session_id, session_id, &HashSet::new())
            .await
            .unwrap();
        assert_eq!(
            rebuilt.observations.len(),
            542,
            "bounded recovery is a request projection and must not retire Ledger observations"
        );
    }

    #[test]
    fn target_access_is_derived_from_runtime_scopes_not_model_text() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-a".to_string(),
            revision: 1,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: Some("node-a".to_string()),
            kind: crate::memory::ExecutionTargetKind::EdgeNode,
            name: "Laptop".to_string(),
            status: crate::memory::ExecutionTargetStatus::Online,
            platform: Some("macos-arm64".to_string()),
            workspace_root: None,
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({}),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };
        let grant = ExecutionTargetAuthorizationRecord {
            id: "authorization-a".to_string(),
            revision: 1,
            target_id: target.id.clone(),
            owner_principal_id: "principal-a".to_string(),
            scope: ExecutionTargetAuthorizationScope::Thread,
            scope_id: "thread-a".to_string(),
            status: ExecutionTargetAuthorizationStatus::Active,
            created_at: now,
            updated_at: now,
            revoked_at: None,
            revoke_reason: None,
        };

        let allowed = execution_target_access_view(
            &target,
            std::slice::from_ref(&grant),
            Some("agent-a"),
            "context-a",
            Some("thread-a"),
        );
        assert_eq!(allowed.authorization_mode, "scoped_authorized");
        assert_eq!(
            allowed.matching_scopes,
            vec![ExecutionTargetAuthorizationScope::Thread]
        );

        let denied = execution_target_access_view(
            &target,
            &[grant],
            Some("agent-a"),
            "context-a",
            Some("thread-b"),
        );
        assert_eq!(denied.authorization_mode, "scoped_denied");
    }
}
