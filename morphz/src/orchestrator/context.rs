use crate::config::OrchestratorConfig;
use crate::event::{
    Event, TYPE_AGENT_CALL, TYPE_CONTEXT_SEED, TYPE_CONTEXT_TRANSACTION, TYPE_EXCEPTION,
    TYPE_FILE_CHANGE, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
};
use crate::memory::{EventStore, QueryFilter, SessionRecord, SessionStore};
use crate::orchestrator::context_contract::{
    render_context_tx_epistemic_guidance, ContractClause, EPISTEMIC_CONTRACT,
    EPISTEMIC_CONTRACT_NAME, REALITY_CONTRACT, REALITY_CONTRACT_NAME,
};
use crate::sexpr::{parse, SExpr};
use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const CONTEXT_PROTOCOL_VERSION: u64 = 12;
const EVENT_REFERENCE_PREFIX: &str = "@e";

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
        meaning: "移出当前 Context；原因只能写在事务级 reason 中",
    },
    ContextOperationSpec {
        name: "restore",
        syntax: "(restore ID...)",
        meaning: "恢复已 retire 的 frame/observation",
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
        "原子修改你拥有的 Mind Context。参数 transaction 是版本化 SExpr：(context-tx (base-version N) (reason \"...\") OP...)。支持：{operations}。Context observation 使用 @eN 形式的确定性短引用；在 from/retire/restore/protect/unprotect/relate/unrelate 中原样使用 ref，Runtime 会在提交前解析为完整 Ledger ID。create/derive/revise 可直接并列一个或多个 BODY；多项会被确定性规范化为 (context-body BODY...)。重要：revise 是完整替换 frame body，绝不是局部 merge；仍需保留的旧字段必须在新 BODY 中重述。create 不接受 from；有证据来源必须写 (derive ID (from SOURCE...) BODY...)。高风险改组前可先 (checkpoint ID)；需要恢复时用带 reason 的 (rollback ID)，确认不再需要时用 (drop-checkpoint ID...)。一个 transaction 可以顺序包含多个不同 operation，并且整体成功或整体回滚。不要为了表达多个修改而并行调用多次 context_tx。reason 是事务级字段，retire/unprotect/unrelate/rollback/drop-checkpoint 必须提供；不要把 reason 放进操作参数。Context 修改不是给用户的最终回复。提交 BODY 时还必须遵守由协议单一事实源生成的认识契约：{}",
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
    pub revision: u64,
    pub created_version: u64,
    pub updated_version: u64,
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

/// Agent 显式建立的 Mind 恢复点。快照不包含其他 checkpoint，
/// 避免递归复制；Runtime 只在 Context 中展示元数据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindCheckpoint {
    pub id: String,
    pub frames: Vec<ContextFrame>,
    pub relations: Vec<ContextRelation>,
    pub retired: BTreeSet<String>,
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
    pub protected: BTreeSet<String>,
    #[serde(default)]
    pub checkpoints: Vec<MindCheckpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContextChange {
    pub operation: String,
    pub target: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextCommit {
    pub transaction_id: String,
    pub before_version: u64,
    pub after_version: u64,
    pub reason: Option<String>,
    pub changes: Vec<ContextChange>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextObservation {
    pub id: String,
    /// 当前 Context 内由 Ledger sequence 派生的确定性短引用，例如 @e27。
    pub reference: String,
    pub session_id: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadySessionEvaluation {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub work_item_id: Option<String>,
    pub input_preview: Option<String>,
    pub turn_budget: TurnBudget,
    pub wake: WakeSignal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextView {
    pub context_id: String,
    pub active_session_id: String,
    /// Compatibility alias for clients written before Context-owned Sessions.
    pub session_id: String,
    pub parent_session_id: Option<String>,
    /// One entry in normal evaluation; multiple entries in a merged
    /// Context-level evaluation batch.
    pub ready_sessions: Vec<ReadySessionEvaluation>,
    pub sessions: Vec<SessionRecord>,
    pub state: MindState,
    pub observations: Vec<ContextObservation>,
    pub pressure: ContextPressure,
    pub turn_budget: TurnBudget,
    pub wake: WakeSignal,
    pub sexpr: String,
}

/// Agent-Owned Context v1 的唯一状态入口。
///
/// Context transaction 在每个 Cognitive Context 的互斥锁内校验、提交并写入 Event Ledger。
/// Orchestrator 与 context_tx 工具共享同一个实例。
pub struct ContextEngine {
    store: Arc<dyn EventStore>,
    session_store: Option<Arc<dyn SessionStore>>,
    config: OrchestratorConfig,
    context_locks: DashMap<String, Arc<Mutex<()>>>,
}

impl ContextEngine {
    pub fn new(store: Arc<dyn EventStore>, config: OrchestratorConfig) -> Self {
        Self {
            store,
            session_store: None,
            config,
            context_locks: DashMap::new(),
        }
    }

    pub fn with_session_store(mut self, session_store: Arc<dyn SessionStore>) -> Self {
        self.session_store = Some(session_store);
        self
    }

    pub fn session_store(&self) -> Option<Arc<dyn SessionStore>> {
        self.session_store.clone()
    }

    async fn context_id_for_session(&self, session_id: &str) -> Result<String, DynError> {
        let Some(store) = self.session_store.as_ref() else {
            return Ok(session_id.to_string());
        };
        Ok(store
            .get_session(session_id)
            .await?
            .map(|session| session.context_id)
            // Compatibility for legacy fixtures whose Context and Session
            // intentionally shared one identifier and had no Session registry.
            .unwrap_or_else(|| session_id.to_string()))
    }

    /// Maximum event-text slice that a recall result can deliver without its
    /// JSON envelope being preview-truncated again by this Context engine.
    pub(crate) fn recall_chunk_chars(&self) -> usize {
        self.config
            .observation_preview_chars
            .saturating_sub(512)
            .clamp(4_000, 20_000)
    }

    pub async fn apply_transaction(
        &self,
        legacy_scope_id: &str,
        transaction: &str,
    ) -> Result<ContextCommit, DynError> {
        self.apply_context_transaction(legacy_scope_id, legacy_scope_id, transaction)
            .await
    }

    pub async fn apply_context_transaction(
        &self,
        context_id: &str,
        acting_session_id: &str,
        transaction: &str,
    ) -> Result<ContextCommit, DynError> {
        let mut parsed = parse_transaction(transaction)?;
        let lock = self.context_lock(context_id);
        let _guard = lock.lock().await;

        let events = self.context_events(context_id).await?;
        let references = ContextReferences::from_events(&events);
        resolve_transaction_references(&mut parsed, &references)?;
        let canonical_transaction = render_parsed_transaction(&parsed);
        let current = load_mind_from_events(&events)?;
        let observation_ids = observation_ids(&events);
        let (next, changes) = apply_parsed_transaction(&current, &parsed, &observation_ids)?;

        let tx_id = format!(
            "ctx_tx_{}_{}",
            context_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(acting_session_id)),
            ("transaction_id".to_string(), json!(tx_id)),
            ("transaction".to_string(), json!(&canonical_transaction)),
            ("before_version".to_string(), json!(current.version)),
            ("after_version".to_string(), json!(next.version)),
            ("reason".to_string(), json!(&parsed.reason)),
            ("changes".to_string(), json!(changes)),
            ("state_after".to_string(), json!(next)),
            ("text".to_string(), json!(&canonical_transaction)),
        ]
        .into_iter()
        .collect();

        self.store
            .append(Event::new(
                tx_id.clone(),
                "Agent-Context".to_string(),
                TYPE_CONTEXT_TRANSACTION.to_string(),
                "chat/context_tx_committed".to_string(),
                payload,
            ))
            .await?;

        Ok(ContextCommit {
            transaction_id: tx_id,
            before_version: current.version,
            after_version: next.version,
            reason: parsed.reason,
            changes,
        })
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
        let source_state = load_mind_from_events(&source_events)?;
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
        self.store
            .append(Event::new(
                seed_id,
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
            ))
            .await?;
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
        self.build_context_encoding_for_sessions(
            context_id,
            &[active_session_id.to_string()],
            excluded_observation_ids,
        )
        .await
    }

    pub async fn build_batch_context_encoding(
        &self,
        context_id: &str,
        ready_session_ids: &[String],
    ) -> Result<ContextView, DynError> {
        self.build_batch_context_encoding_excluding(context_id, ready_session_ids, &HashSet::new())
            .await
    }

    pub async fn build_batch_context_encoding_excluding(
        &self,
        context_id: &str,
        ready_session_ids: &[String],
        excluded_observation_ids: &HashSet<String>,
    ) -> Result<ContextView, DynError> {
        if ready_session_ids.is_empty() {
            return Err("batch Context Encoding 至少需要一个 ready Session".into());
        }
        self.build_context_encoding_for_sessions(
            context_id,
            ready_session_ids,
            excluded_observation_ids,
        )
        .await
    }

    async fn build_context_encoding_for_sessions(
        &self,
        context_id: &str,
        ready_session_ids: &[String],
        excluded_observation_ids: &HashSet<String>,
    ) -> Result<ContextView, DynError> {
        let active_session_id = ready_session_ids
            .first()
            .ok_or("Context Encoding 缺少 active Session")?;
        let events = self.context_events(context_id).await?;
        let references = ContextReferences::from_events(&events);
        let state = load_mind_from_events(&events)?;
        let metadata = observation_metadata(&events, &state);
        let sessions = self.context_sessions(context_id, &events).await?;
        let parent_session_id = sessions
            .iter()
            .find(|session| session.id == *active_session_id)
            .and_then(|session| session.parent_session_id.clone())
            .or_else(|| {
                events.iter().find_map(|event| {
                    (event_session(event) == Some(active_session_id.as_str()))
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

        let observations = events
            .iter()
            .filter(|event| is_observation(event))
            .filter(|event| !state.retired.contains(&event.id))
            .filter(|event| !excluded_observation_ids.contains(&event.id))
            .map(|event| {
                self.to_observation(
                    event,
                    &state,
                    metadata.get(&event.id).cloned().unwrap_or_default(),
                )
            })
            .collect::<Vec<_>>();

        let active_frames = state
            .frames
            .iter()
            .filter(|frame| !state.retired.contains(&frame.id))
            .collect::<Vec<_>>();
        let estimated_tokens = active_frames
            .iter()
            .map(|frame| estimate_text_tokens(&frame.body) + 32)
            .sum::<usize>()
            + observations
                .iter()
                .map(|observation| estimate_text_tokens(&observation.preview) + 128)
                .sum::<usize>()
            + 1_000; // Kernel、DSL contract 与工具定义的保守固定开销
        let pressure = pressure_for(
            estimated_tokens,
            active_frames.len(),
            observations.len(),
            &self.config,
        );
        let ready_sessions = ready_session_ids
            .iter()
            .map(|session_id| {
                let session_events = events
                    .iter()
                    .filter(|event| event_session(event) == Some(session_id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                let parent_session_id = sessions
                    .iter()
                    .find(|session| session.id == *session_id)
                    .and_then(|session| session.parent_session_id.clone())
                    .or_else(|| {
                        session_events.iter().find_map(|event| {
                            event
                                .payload
                                .get("parent_session_id")
                                .and_then(|value| value.as_str())
                                .map(ToOwned::to_owned)
                        })
                    });
                let wake = wake_for(&session_events);
                let ready_observation = wake.event_id.as_deref().and_then(|event_id| {
                    observations
                        .iter()
                        .find(|observation| observation.id == event_id)
                });
                ReadySessionEvaluation {
                    session_id: session_id.clone(),
                    parent_session_id,
                    work_item_id: ready_observation
                        .map(|observation| observation.reference.clone()),
                    input_preview: ready_observation
                        .map(|observation| preview_text(&observation.preview, 4_000).0),
                    turn_budget: turn_budget_for(&session_events, &self.config),
                    wake,
                }
            })
            .collect::<Vec<_>>();
        let turn_budget = ready_sessions[0].turn_budget.clone();
        let wake = ready_sessions[0].wake.clone();
        let sexpr = render_context(ContextRenderInput {
            context_id,
            active_session_id: active_session_id.as_str(),
            parent_session_id: parent_session_id.as_deref(),
            ready_sessions: &ready_sessions,
            sessions: &sessions,
            state: &state,
            observations: &observations,
            pressure: &pressure,
            turn_budget: &turn_budget,
            wake: &wake,
            references: &references,
        });

        Ok(ContextView {
            context_id: context_id.to_string(),
            active_session_id: active_session_id.clone(),
            session_id: active_session_id.clone(),
            parent_session_id,
            ready_sessions,
            sessions,
            state,
            observations,
            pressure,
            turn_budget,
            wake,
            sexpr,
        })
    }

    /// 用模型客户端对“完整 Prompt”的计量结果替换 Context 局部字符估算，并重新
    /// 编码 Context，使 Agent 在本轮就能看到真实压力等级。
    pub async fn apply_prompt_token_count(
        &self,
        view: &mut ContextView,
        count: &crate::llm::PromptTokenCount,
    ) -> Result<(), DynError> {
        let events = self.context_events(&view.context_id).await?;
        let references = ContextReferences::from_events(&events);
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
        view.sexpr = render_context(ContextRenderInput {
            context_id: &view.context_id,
            active_session_id: &view.active_session_id,
            parent_session_id: view.parent_session_id.as_deref(),
            ready_sessions: &view.ready_sessions,
            sessions: &view.sessions,
            state: &view.state,
            observations: &view.observations,
            pressure: &view.pressure,
            turn_budget: &view.turn_budget,
            wake: &view.wake,
            references: &references,
        });
        Ok(())
    }

    pub async fn find_event(
        &self,
        context_id: &str,
        event_id: &str,
    ) -> Result<Option<Event>, DynError> {
        let events = self.context_events(context_id).await?;
        let references = ContextReferences::from_events(&events);
        let canonical_id = references.resolve(event_id)?;
        Ok(events.into_iter().find(|event| event.id == canonical_id))
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
        let events = self.context_events(context_id).await?;
        Ok(load_mind_from_events(&events)?
            .frames
            .into_iter()
            .find(|frame| frame.id == frame_id))
    }

    pub async fn mind_version(&self, context_id: &str) -> Result<u64, DynError> {
        Ok(load_mind_from_events(&self.context_events(context_id).await?)?.version)
    }

    pub async fn search_events(
        &self,
        context_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Event>, DynError> {
        let events = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                search_query: Some(query.to_string()),
                ..Default::default()
            })
            .await?;
        Ok(events.into_iter().take(limit).collect())
    }

    fn context_lock(&self, context_id: &str) -> Arc<Mutex<()>> {
        self.context_locks
            .entry(context_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn context_events(&self, context_id: &str) -> Result<Vec<Event>, DynError> {
        let mut events = self
            .store
            .query(QueryFilter {
                context_id: Some(context_id.to_string()),
                topic: Some("chat/*".to_string()),
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
                normalize_body_tail(items, 2);
            }
            "derive" => {
                if items.len() < 4 || !items.get(2).is_some_and(is_from_expression) {
                    return Err(
                        "derive 必须把来源放在 ID 后，并至少提供一个 BODY：(derive ID (from SOURCE...) BODY...)"
                            .to_string(),
                    );
                }
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
                normalize_body_tail(items, body_start);
            }
            _ => {}
        }
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

fn apply_parsed_transaction(
    current: &MindState,
    tx: &ParsedTransaction,
    observation_ids: &HashSet<String>,
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
                next.frames.push(ContextFrame {
                    id: id.to_string(),
                    body,
                    sources: sources.clone(),
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
                let (sources, body_expr) = if op.len() == 4 {
                    let sources = parse_sources(&op[2])?;
                    ensure_sources_exist(&next, observation_ids, &sources)?;
                    (Some(sources), &op[3])
                } else {
                    (None, &op[2])
                };
                let body = canonical_body(body_expr)?;
                let frame = next
                    .frames
                    .iter_mut()
                    .find(|frame| frame.id == id)
                    .ok_or_else(|| format!("revise 目标 '{}' 不是已存在的 frame", id))?;
                frame.body = body;
                if let Some(sources) = sources {
                    frame.sources = sources;
                }
                frame.revision += 1;
                frame.updated_version = next_version;
                changes.push(change("revise", id, Some(format!("r{}", frame.revision))));
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
                    next.retired.insert(id.to_string());
                    changes.push(change("retire", id, Some(reason.clone())));
                }
            }
            "restore" => {
                require_min_len(op, 2, "(restore ID...)")?;
                for item in op.iter().skip(1) {
                    let id = validated_id(as_atom(item, "restore target")?)?;
                    ensure_known(&next, observation_ids, id)?;
                    if !next.retired.remove(id) {
                        return Err(format!("'{}' 当前没有处于 retired 状态", id));
                    }
                    changes.push(change("restore", id, None));
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
                    "未知 Context 原语 '{}'。当前支持 create/derive/revise/retire/restore/protect/unprotect/place/relate/unrelate/checkpoint/rollback/drop-checkpoint",
                    other
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
    parent_session_id: Option<&'a str>,
    ready_sessions: &'a [ReadySessionEvaluation],
    sessions: &'a [SessionRecord],
    state: &'a MindState,
    observations: &'a [ContextObservation],
    pressure: &'a ContextPressure,
    turn_budget: &'a TurnBudget,
    wake: &'a WakeSignal,
    references: &'a ContextReferences,
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

fn render_context(input: ContextRenderInput<'_>) -> String {
    let ContextRenderInput {
        context_id,
        active_session_id,
        parent_session_id,
        ready_sessions,
        sessions,
        state,
        observations,
        pressure,
        turn_budget,
        wake,
        references,
    } = input;
    let mut kernel = vec![atom("kernel"), pair("context", atom(context_id))];
    if ready_sessions.len() > 1 {
        kernel.push(pair("evaluation-mode", atom("batch")));
        kernel.push(list(
            "ready-sessions",
            ready_sessions
                .iter()
                .map(|ready| {
                    let mut fields = vec![pair("id", atom(&ready.session_id))];
                    if let Some(parent) = &ready.parent_session_id {
                        fields.push(pair("parent-session", atom(parent)));
                    }
                    if let Some(work_item_id) = &ready.work_item_id {
                        fields.push(pair("work-item", atom(work_item_id)));
                    }
                    if let Some(input_preview) = &ready.input_preview {
                        fields.push(pair("input-preview", atom(input_preview)));
                    }
                    fields.push(render_wake(&ready.wake, references));
                    fields.push(render_turn_control(&ready.turn_budget));
                    list("session", fields)
                })
                .collect(),
        ));
    } else {
        kernel.push(pair("evaluation-mode", atom("single")));
        kernel.push(pair("active-session", atom(active_session_id)));
        if let Some(parent) = parent_session_id {
            kernel.push(pair("parent-session", atom(parent)));
        }
    }
    kernel.push(pair("version", atom(state.version.to_string())));
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

    let session_directory = list(
        "session-directory",
        sessions
            .iter()
            .map(|session| {
                let mut fields = vec![
                    pair("id", atom(&session.id)),
                    pair("status", atom(session.status.as_str())),
                    pair("title", atom(&session.title)),
                    pair("last-activity", atom(session.last_activity_at.to_rfc3339())),
                ];
                if let Some(parent) = &session.parent_session_id {
                    fields.push(pair("parent-session", atom(parent)));
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
            pair("body", body),
        ];
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
    for observation in observations {
        let mut fields = vec![
            pair("ref", atom(&observation.reference)),
            pair("seq", atom(observation.sequence.to_string())),
            pair("turn", atom(observation.turn.to_string())),
            pair("kind", atom(&observation.kind)),
            pair("topic", atom(&observation.topic)),
            pair("actor", atom(&observation.actor)),
            pair("timestamp", atom(&observation.timestamp)),
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
                    pair("representation", atom(&observation.representation)),
                    pair("visible-chars", atom(observation.visible_chars.to_string())),
                    pair("total-chars", atom(observation.total_chars.to_string())),
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
            pair("preview", atom(&observation.preview)),
        ];
        if let Some(session_id) = &observation.session_id {
            fields.insert(2, pair("session", atom(session_id)));
        }
        if let Some(attempt) = observation.attempt {
            fields.insert(3, pair("attempt", atom(attempt.to_string())));
        }
        if let Some(caused_by) = &observation.caused_by {
            fields.insert(4, pair("caused-by", atom(caused_by)));
        }
        if let Some(tool_name) = &observation.tool_name {
            fields.insert(5, pair("tool", atom(tool_name)));
        }
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
        if observation.freshness.latest.is_some()
            || !observation.freshness.supersedes.is_empty()
            || !observation.freshness.superseded_by.is_empty()
        {
            fields.push(render_freshness(&observation.freshness, references));
        }
        if observation.usage != ContextUsage::default() {
            fields.push(render_usage(&observation.usage));
        }
        inbox.push(list("observation", fields));
    }

    // Prefix-cache order is intentional: protocol is immutable, the shared
    // Mind usually changes less often than routing/turn state, the Session
    // directory changes less often than wake/budget, and Inbox is highest
    // churn. Concurrent Session evaluations of the same Context therefore
    // reuse the protocol + Mind prefix whenever they observe the same version.
    format!(
        "{} {} {} {} {})",
        stable_context_prefix(),
        SExpr::List(mind),
        session_directory,
        SExpr::List(kernel),
        SExpr::List(inbox)
    )
}

fn stable_context_prefix() -> &'static str {
    static PREFIX: OnceLock<String> = OnceLock::new();
    PREFIX
        .get_or_init(|| format!("(context {}", render_protocol()))
        .as_str()
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
                "routing-contract",
                vec![
                    pair("ownership", atom("一个 Cognitive Context 持有一个共享 Mind 与多个 Session")),
                    pair("session-role", atom("Session 是输入输出连接与进展边界，不拥有独立 Mind")),
                    pair("active-session", atom("single 求值时表示输入来源与回复目标；不是 Context 的全局唯一活动 Session")),
                    pair("ready-sessions", atom("batch 求值时列出每个必须分别处理的 Session、稳定 work-item 和当前 input-preview；不存在可承载所有回复的单一正文目标")),
                    pair("concurrency", atom("同一 Context 可有多个 Session 同时进行各自求值与回复")),
                    pair("shared-evidence", atom("inbox observation 按 session 标记来源，但均属于当前 Context，可跨 Session 推理与复用")),
                    pair("reply-routing", atom("single 求值的标准 reply 与可见 progress 必须对应 kernel.active-session")),
                    pair("write-serialization", atom("context_tx 修改共享 Mind；Runtime 按 Context 串行提交并执行 version 检查")),
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
                        atom("当前可见状态：full 全文、preview 预览、recalled-chunk 召回片段"),
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
                ],
            ),
            list(
                "response-contract",
                vec![
                    list(
                        "reply",
                        vec![
                            pair("evaluation-mode", atom("single")),
                            pair("when", atom("当前用户任务已经完成，或必须向用户说明阻塞")),
                            pair("tool", atom("reply")),
                            pair("exclusive", atom("reply 必须是终态响应中唯一的工具调用")),
                            pair("deliver", atom("disposition=deliver；content 必须非空并交付当前 Session")),
                            pair("suppress", atom("disposition=suppress；明确结束但不向当前 Session 投递消息")),
                            pair("plain-text", atom("普通文本或空响应都不是终态；Runtime 返回协议错误并有限重试")),
                            pair("circuit-breaker", atom("允许两次纠错；第三次仍无合法 reply 时安全熔断")),
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
                        "batch-reply",
                        vec![
                            pair("evaluation-mode", atom("batch")),
                            pair("tool", atom("session_output")),
                            pair("content", atom("empty; 可见文本必须显式路由")),
                            pair("coverage", atom("每个 ready Session 必须 final、progress+action 或明确阻塞")),
                            pair("fallback", atom("遗漏或歧义项由 Runtime 单独重新求值；已交付项不重放")),
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
                                atom("Runtime 必定再次调用；非 critical 时冷却 context_tx，必须调用 reply 或执行 act"),
                            ),
                        ],
                    ),
                ],
            ),
            list(
                "session-output-contract",
                vec![
                    pair("role", atom("外部 Session IO；不是 Mind transaction")),
                    pair("tool", atom("session_output")),
                    pair("syntax", atom("{deliveries:[{session_id,kind:progress|final,text},...]}")),
                    pair("final", atom("结束该 Session 当前回合；同一 Session 不得同时 final 和调用工具")),
                    pair("progress", atom("只发送可见进度，不结束回合；必须同时有后续动作或由 Runtime 重新调度")),
                    pair("routing", atom("session_id 必须来自 kernel.ready-sessions，Runtime 拒绝伪造目标")),
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
    let after_last_user = events
        .iter()
        .rposition(|event| event.event_type == TYPE_USER_MESSAGE)
        .map(|index| &events[index + 1..])
        .unwrap_or(events);
    let assistant_calls = after_last_user
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .collect::<Vec<_>>();
    let context_transactions_used = assistant_calls
        .iter()
        .filter(|event| {
            event
                .payload
                .get("tool_calls")
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
    // Attempt 表示本用户回合内的模型求值次数，而不是工具调用数量；一次响应中
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
        event.event_type == TYPE_USER_MESSAGE || event.event_type == TYPE_TOOL_OUTPUT
    });
    let Some(event) = latest else {
        return WakeSignal {
            cause: "session-start".to_string(),
            event_id: None,
            tool_name: None,
            visible_in_inbox: false,
        };
    };
    let tool_name = event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    let cause = if event.event_type == TYPE_USER_MESSAGE {
        "user-message"
    } else if tool_name.as_deref() == Some("context_tx") {
        "context-transaction-result"
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

fn load_mind_from_events(events: &[Event]) -> Result<MindState, String> {
    let mut state = MindState::default();
    let mut seen_observations = HashSet::new();
    let mut seed_seen = false;
    for event in events {
        if is_observation(event) {
            seen_observations.insert(event.id.clone());
            continue;
        }
        if event.event_type == TYPE_CONTEXT_SEED
            && event.topic == "runtime/context_seeded"
            && event.actor == "System-ContextSeed"
        {
            if seed_seen || state != MindState::default() || !seen_observations.is_empty() {
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
            let snapshot_hash = mind_state_hash(&source_state)?;
            let projected_hash = mind_state_hash(&projected)?;
            if event
                .payload
                .get("snapshot_hash")
                .and_then(|value| value.as_str())
                != Some(snapshot_hash.as_str())
                || event
                    .payload
                    .get("projected_hash")
                    .and_then(|value| value.as_str())
                    != Some(projected_hash.as_str())
            {
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

        let transaction = event
            .payload
            .get("transaction")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("Context transaction '{}' 缺少 transaction", event.id))?;
        let parsed = parse_transaction(transaction)
            .map_err(|error| format!("Context transaction '{}' 无法重放: {}", event.id, error))?;
        let (candidate, replayed_changes) =
            apply_parsed_transaction(&state, &parsed, &seen_observations).map_err(|error| {
                format!(
                    "Context transaction '{}' 确定性重放失败: {}",
                    event.id, error
                )
            })?;

        let recorded_state: MindState = serde_json::from_value(
            event
                .payload
                .get("state_after")
                .ok_or_else(|| format!("Context transaction '{}' 缺少 state_after", event.id))?
                .clone(),
        )
        .map_err(|error| format!("Context transaction '{}' 状态损坏: {}", event.id, error))?;
        if recorded_state != candidate {
            return Err(format!(
                "Context transaction '{}' 的 state_after 与 SExpr 重放结果不一致: {}",
                event.id,
                mind_state_mismatch(&recorded_state, &candidate)
            ));
        }
        if let Some(recorded_changes) = event.payload.get("changes") {
            let recorded_changes: Vec<ContextChange> =
                serde_json::from_value(recorded_changes.clone()).map_err(|error| {
                    format!("Context transaction '{}' Diff 损坏: {}", event.id, error)
                })?;
            if recorded_changes != replayed_changes {
                return Err(format!(
                    "Context transaction '{}' 的 Diff 与 SExpr 重放结果不一致",
                    event.id
                ));
            }
        }
        state = candidate;
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

fn is_observation(event: &Event) -> bool {
    if event.topic == "chat/assistant_call"
        || event.topic == "chat/progress"
        || event.topic == "chat/context_inspect"
        || event.topic == "chat/context_tx_committed"
        || event.topic == "chat/runtime_error"
        || event.topic.starts_with("runtime/")
    {
        return false;
    }
    if event.event_type == TYPE_TOOL_OUTPUT
        && event
            .payload
            .get("tool_name")
            .and_then(|value| value.as_str())
            == Some("context_tx")
    {
        return event
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .is_some_and(|text| text.starts_with("执行失败:") || text.starts_with("执行拒绝:"));
    }
    matches!(
        event.event_type.as_str(),
        TYPE_USER_MESSAGE | TYPE_TOOL_OUTPUT | TYPE_AGENT_CALL | TYPE_EXCEPTION | TYPE_FILE_CHANGE
    )
}

fn event_session(event: &Event) -> Option<&str> {
    event
        .payload
        .get("session_id")
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
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{NewCognitiveContext, NewSession, SessionStore};
    use tempfile::TempDir;

    fn observations(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
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
    fn render_has_kernel_mind_and_inbox_without_fixed_cognitive_schema() {
        let mut state = MindState::default();
        state.frames.push(ContextFrame {
            id: "free-form".to_string(),
            body: "(whatever (the agent invents))".to_string(),
            sources: Vec::new(),
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
        let rendered = render_context(ContextRenderInput {
            context_id: "context-1",
            active_session_id: "s1",
            parent_session_id: None,
            ready_sessions: &[],
            sessions: &[],
            state: &state,
            observations: &[],
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
            parsed.get_path(&["kernel", "wake", "cause"]),
            Some(&SExpr::Atom("user-message".to_string()))
        );
        assert!(rendered.contains("(response-contract"));
        assert!(rendered.contains("(reality-contract"));
        assert!(rendered.contains("(name reality-contract-v1)"));
        assert!(rendered.contains("(epistemic-contract"));
        assert!(rendered.contains("(name epistemic-contract-v1)"));
        for clause in REALITY_CONTRACT.iter().chain(EPISTEMIC_CONTRACT.iter()) {
            assert!(rendered.contains(clause.key));
            assert!(rendered.contains(clause.meaning));
        }
        assert!(rendered.contains("(context-tx-contract"));
        assert!(rendered.contains("(body-arity \"create derive revise one-or-more\")"));
        assert!(rendered.contains("(body-normalization"));
        assert!(rendered.contains("(revise-semantics"));
        assert!(rendered.contains("(checkpoint-policy"));
        assert!(rendered.contains("(source-placement"));
        assert!(rendered.contains("(syntax \"(retire ID...)\")"));
        assert!(rendered.contains("(mind (frame"));
        assert!(rendered.contains("(inbox)"));
        assert!(!rendered.contains("todo_stack"));

        assert!(rendered.starts_with(stable_context_prefix()));
        let shared_mind_offset = stable_context_prefix().len();
        assert!(rendered[shared_mind_offset..].starts_with(" (mind"));
        assert!(shared_mind_offset < rendered.rfind(" (kernel").unwrap());
        budget.attempt = 2;
        let changed = render_context(ContextRenderInput {
            context_id: "context-1",
            active_session_id: "s2",
            parent_session_id: None,
            ready_sessions: &[],
            sessions: &[],
            state: &state,
            observations: &[],
            pressure: &pressure,
            turn_budget: &budget,
            wake: &wake,
            references: &references,
        });
        assert_ne!(rendered, changed);
        assert!(changed.starts_with(stable_context_prefix()));
        assert!(changed[shared_mind_offset..].starts_with(" (mind"));
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
    fn legacy_mind_state_without_relations_remains_readable() {
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

        let before = engine.build_view(session_id).await.unwrap();
        assert_eq!(before.observations[0].reference, "@e1");
        assert!(before.sexpr.contains("(ref @e1)"));
        assert!(before.sexpr.contains("(event @e1)"));
        assert!(!before.sexpr.contains(&long_id));

        engine
            .apply_transaction(
                session_id,
                r#"(context-tx (base-version 0) (reason "evidence absorbed")
                    (derive finding (from @e1) (finding stable) (confidence high))
                    (relate finding supersedes @e1)
                    (protect finding)
                    (retire @e1))"#,
            )
            .await
            .unwrap();

        let after = engine.build_view(session_id).await.unwrap();
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
            restarted.build_view(session_id).await.unwrap().state,
            after.state
        );
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
    async fn committed_mind_survives_engine_restart_and_observation_retirement() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-persistence.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let session_id = "persistent-session";
        store
            .append(Event::new(
                "event:constraint".to_string(),
                "User".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                vec![
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
        );
        engine
            .apply_transaction(
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

        let restarted = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        );
        let view = restarted.build_view(session_id).await.unwrap();
        assert_eq!(view.state.version, 1);
        assert_eq!(view.state.frames[0].id, "durable-constraint");
        assert!(view.state.protected.contains("durable-constraint"));
        assert!(view.observations.is_empty());
        assert!(restarted
            .find_event(session_id, "event:constraint")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn concurrent_transactions_are_single_writer_and_version_checked() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-concurrency.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let engine = Arc::new(ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        ));

        let left = {
            let engine = Arc::clone(&engine);
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
            let engine = Arc::clone(&engine);
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
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
        let view = engine
            .build_context_encoding("shared-context", "session-left", &HashSet::new())
            .await
            .unwrap();
        assert_eq!(view.state.version, 1);
        assert_eq!(view.state.frames.len(), 1);
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
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>);
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
        assert!(source_before_seed
            .state
            .protected
            .contains("stable-principle"));
        assert!(project_mind_seed(&source_before_seed.state)
            .protected
            .contains("stable-principle"));

        let receipt = engine
            .seed_context_from_mind("seed-source", Some(1), "seed-target")
            .await
            .unwrap();
        assert_eq!(receipt.source_version, 1);
        assert_eq!(receipt.inherited_frames, 2);
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
        assert_eq!(child.sessions[0].id, "seed-session-c");
        assert!(child.observations.is_empty());
        assert!(child.state.protected.contains("stable-principle"));
        assert!(child.state.retired.contains("evidence-frame"));
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

        let restarted = ContextEngine::new(
            Arc::clone(&store) as Arc<dyn EventStore>,
            OrchestratorConfig::default(),
        )
        .with_session_store(Arc::clone(&store) as Arc<dyn SessionStore>);
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
    }

    #[tokio::test]
    async fn pressure_reports_all_active_observations_without_silent_trimming() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("context-pressure.db");
        let store = Arc::new(SqliteStore::new(db.to_str().unwrap()).await.unwrap());
        let session_id = "pressure-session";
        for index in 0..5 {
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
        let view = engine.build_view(session_id).await.unwrap();
        assert_eq!(view.observations.len(), 5);
        assert_eq!(view.pressure.level, "critical");
    }
}
