use crate::config::OrchestratorConfig;
use crate::event::{
    Event, TYPE_AGENT_CALL, TYPE_CONTEXT_TRANSACTION, TYPE_EXCEPTION, TYPE_FILE_CHANGE,
    TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE,
};
use crate::memory::{EventStore, QueryFilter};
use crate::sexpr::{parse, SExpr};
use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const CONTEXT_PROTOCOL_VERSION: u64 = 6;
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
        meaning: "修订既有 frame 并递增 revision；可选 from 固定在 ID 后，随后可写一个或多个 BODY",
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
];

pub fn context_tx_tool_description() -> String {
    let operations = CONTEXT_OPERATIONS
        .iter()
        .map(|operation| operation.syntax)
        .collect::<Vec<_>>()
        .join("；");
    format!(
        "原子修改你拥有的 Mind Context。参数 transaction 是版本化 SExpr：(context-tx (base-version N) (reason \"...\") OP...)。支持：{operations}。Context observation 使用 @eN 形式的确定性短引用；在 from/retire/restore/protect/unprotect/relate/unrelate 中原样使用 ref，Runtime 会在提交前解析为完整 Ledger ID。create/derive/revise 可直接并列一个或多个 BODY；多项会被确定性规范化为 (context-body BODY...)，无需手工添加 record/frame 外壳。create 不接受 from；有证据来源必须写 (derive ID (from SOURCE...) BODY...)。一个 transaction 可以顺序包含多个不同 operation，并且整体成功或整体回滚；例如 (context-tx (base-version 3) (reason \"完成收口\") (revise task (status completed) (next none)) (derive result (from @e27) (tests passed) (confidence high)) (relate result supersedes old-result) (protect task result) (retire @e21 @e22))。不要为了表达多个修改而并行调用多次 context_tx。reason 是事务级字段，retire/unprotect/unrelate 必须提供；不要把 reason 放进操作参数。Context 修改不是给用户的最终回复。"
    )
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
pub struct ContextObservation {
    pub id: String,
    /// 当前 session 内由 Ledger sequence 派生的确定性短引用，例如 @e27。
    pub reference: String,
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
    pub soft_limit: usize,
    pub hard_limit: usize,
    pub maintenance_reserve: usize,
    pub active_frames: usize,
    pub active_observations: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnBudget {
    pub attempt: usize,
    pub limit: usize,
    pub remaining_including_current: usize,
    pub context_transactions_used: usize,
    pub context_transactions_limit: usize,
    pub context_tx_available: bool,
    /// `work`、`context-closure` 或 `final-reply`。
    pub phase: String,
    pub force_final: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WakeSignal {
    pub cause: String,
    pub event_id: Option<String>,
    pub tool_name: Option<String>,
    pub visible_in_inbox: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextView {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub state: MindState,
    pub observations: Vec<ContextObservation>,
    pub pressure: ContextPressure,
    pub turn_budget: TurnBudget,
    pub wake: WakeSignal,
    pub sexpr: String,
}

/// Agent-Owned Context v1 的唯一状态入口。
///
/// Context transaction 在每个 session 的互斥锁内校验、提交并写入 Event Ledger。
/// Orchestrator 与 context_tx 工具共享同一个实例。
pub struct ContextEngine {
    store: Arc<dyn EventStore>,
    config: OrchestratorConfig,
    session_locks: DashMap<String, Arc<Mutex<()>>>,
}

impl ContextEngine {
    pub fn new(store: Arc<dyn EventStore>, config: OrchestratorConfig) -> Self {
        Self {
            store,
            config,
            session_locks: DashMap::new(),
        }
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
        session_id: &str,
        transaction: &str,
    ) -> Result<ContextCommit, DynError> {
        let mut parsed = parse_transaction(transaction)?;
        let lock = self.session_lock(session_id);
        let _guard = lock.lock().await;

        let events = self.session_events(session_id).await?;
        let references = ContextReferences::from_events(&events);
        resolve_transaction_references(&mut parsed, &references)?;
        let canonical_transaction = render_parsed_transaction(&parsed);
        let current = load_mind_from_events(&events)?;
        let observation_ids = observation_ids(&events);
        let (next, changes) = apply_parsed_transaction(&current, &parsed, &observation_ids)?;

        let tx_id = format!(
            "ctx_tx_{}_{}",
            session_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let payload = vec![
            ("session_id".to_string(), json!(session_id)),
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

    pub async fn build_view(&self, session_id: &str) -> Result<ContextView, DynError> {
        let events = self.session_events(session_id).await?;
        let references = ContextReferences::from_events(&events);
        let state = load_mind_from_events(&events)?;
        let metadata = observation_metadata(&events, &state);
        let parent_session_id = events.iter().find_map(|event| {
            event
                .payload
                .get("parent_session_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        });

        let observations = events
            .iter()
            .filter(|event| is_observation(event))
            .filter(|event| !state.retired.contains(&event.id))
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
        let turn_budget = turn_budget_for(&events, &self.config);
        let wake = wake_for(&events);
        let sexpr = render_context(ContextRenderInput {
            session_id,
            parent_session_id: parent_session_id.as_deref(),
            state: &state,
            observations: &observations,
            pressure: &pressure,
            turn_budget: &turn_budget,
            wake: &wake,
            references: &references,
        });

        Ok(ContextView {
            session_id: session_id.to_string(),
            parent_session_id,
            state,
            observations,
            pressure,
            turn_budget,
            wake,
            sexpr,
        })
    }

    pub async fn find_event(
        &self,
        session_id: &str,
        event_id: &str,
    ) -> Result<Option<Event>, DynError> {
        let events = self.session_events(session_id).await?;
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
        session_id: &str,
        frame_id: &str,
    ) -> Result<Option<ContextFrame>, DynError> {
        let events = self.session_events(session_id).await?;
        Ok(load_mind_from_events(&events)?
            .frames
            .into_iter()
            .find(|frame| frame.id == frame_id))
    }

    pub async fn search_events(
        &self,
        session_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Event>, DynError> {
        let events = self
            .store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                search_query: Some(query.to_string()),
                ..Default::default()
            })
            .await?;
        Ok(events
            .into_iter()
            .filter(|event| event_session(event) == Some(session_id))
            .take(limit)
            .collect())
    }

    fn session_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.session_locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn session_events(&self, session_id: &str) -> Result<Vec<Event>, DynError> {
        let events = self
            .store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                topic: Some("chat/*".to_string()),
                ..Default::default()
            })
            .await?;
        Ok(events)
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
            other => {
                return Err(format!(
                    "未知 Context 原语 '{}'。v3 支持 create/derive/revise/retire/restore/protect/unprotect/place/relate/unrelate",
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
    session_id: &'a str,
    parent_session_id: Option<&'a str>,
    state: &'a MindState,
    observations: &'a [ContextObservation],
    pressure: &'a ContextPressure,
    turn_budget: &'a TurnBudget,
    wake: &'a WakeSignal,
    references: &'a ContextReferences,
}

fn render_context(input: ContextRenderInput<'_>) -> String {
    let ContextRenderInput {
        session_id,
        parent_session_id,
        state,
        observations,
        pressure,
        turn_budget,
        wake,
        references,
    } = input;
    let mut kernel = vec![atom("kernel"), pair("session", atom(session_id))];
    if let Some(parent) = parent_session_id {
        kernel.push(pair("parent-session", atom(parent)));
    }
    kernel.push(pair("version", atom(state.version.to_string())));
    let mut wake_fields = vec![
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
        wake_fields.push(pair("event", atom(references.display(event_id))));
    }
    if let Some(tool_name) = &wake.tool_name {
        wake_fields.push(pair("tool", atom(tool_name)));
    }
    kernel.push(list("wake", wake_fields));
    kernel.push(list(
        "context-pressure",
        vec![
            pair("level", atom(&pressure.level)),
            pair(
                "estimated-tokens",
                atom(pressure.estimated_tokens.to_string()),
            ),
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
    kernel.push(list(
        "turn-budget",
        vec![
            pair("attempt", atom(turn_budget.attempt.to_string())),
            pair("limit", atom(turn_budget.limit.to_string())),
            pair(
                "remaining-including-current",
                atom(turn_budget.remaining_including_current.to_string()),
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
            pair(
                "force-final",
                atom(if turn_budget.force_final {
                    "true"
                } else {
                    "false"
                }),
            ),
        ],
    ));

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
        if let Some(attempt) = observation.attempt {
            fields.insert(3, pair("attempt", atom(attempt.to_string())));
        }
        if let Some(caused_by) = &observation.caused_by {
            fields.insert(4, pair("caused-by", atom(caused_by)));
        }
        if let Some(tool_name) = &observation.tool_name {
            fields.insert(5, pair("tool", atom(tool_name)));
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

    SExpr::List(vec![
        atom("context"),
        render_protocol(),
        SExpr::List(kernel),
        SExpr::List(mind),
        SExpr::List(inbox),
    ])
    .to_string()
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
                            pair("when", atom("当前用户任务已经完成，或必须向用户说明阻塞")),
                            pair("tool-calls", atom("none")),
                            pair("content", atom("直接交付给用户的最终答复")),
                            pair("terminal", atom("只有无工具纯文本响应才结束用户回合")),
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
                                atom("Runtime 必定再次调用；非 critical 时冷却 context_tx，必须 reply 或 act"),
                            ),
                        ],
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
                    pair("reason-required-for", atom("retire unprotect unrelate")),
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
        soft_limit: config.context_soft_token_limit,
        hard_limit: config.context_hard_token_limit,
        maintenance_reserve: config.context_maintenance_reserve_tokens,
        active_frames,
        active_observations,
    }
}

fn turn_budget_for(events: &[Event], config: &OrchestratorConfig) -> TurnBudget {
    let limit = config.max_attempts_per_turn.max(1);
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
    let closure_attempted = assistant_calls.iter().any(|event| {
        event.topic == "chat/assistant_call"
            && event.payload.get("phase").and_then(|value| value.as_str())
                == Some("context-closure")
    });
    let previous_work_attempts = assistant_calls
        .iter()
        .filter(|event| {
            if event.payload.get("phase").and_then(|value| value.as_str())
                == Some("context-closure")
            {
                return false;
            }
            event
                .payload
                .get("tool_calls")
                .and_then(|value| value.as_array())
                .map(|calls| {
                    calls.iter().any(|call| {
                        call.get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(|value| value.as_str())
                            != Some("context_tx")
                    })
                })
                .unwrap_or(true)
        })
        .count();
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
    let attempt = previous_work_attempts.saturating_add(1);
    let phase = if closure_attempted {
        "final-reply"
    } else if attempt < limit {
        "work"
    } else {
        "context-closure"
    };
    TurnBudget {
        attempt,
        limit,
        remaining_including_current: limit.saturating_sub(attempt).saturating_add(1),
        context_transactions_used,
        context_transactions_limit,
        context_tx_available: context_transactions_used < context_transactions_limit,
        phase: phase.to_string(),
        force_final: phase == "final-reply",
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

fn load_mind_from_events(events: &[Event]) -> Result<MindState, String> {
    let mut state = MindState::default();
    let mut seen_observations = HashSet::new();
    for event in events {
        if is_observation(event) {
            seen_observations.insert(event.id.clone());
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
                "Context transaction '{}' 的 state_after 与 SExpr 重放结果不一致",
                event.id
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
    if state.frames.iter().any(|frame| frame.id == id) || observation_ids.contains(id) {
        Err(format!(
            "Context ID '{}' 已存在，不能重复 create/derive",
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
            soft_limit: 100,
            hard_limit: 200,
            maintenance_reserve: 20,
            active_frames: 1,
            active_observations: 0,
        };
        let budget = TurnBudget {
            attempt: 1,
            limit: 12,
            remaining_including_current: 12,
            context_transactions_used: 0,
            context_transactions_limit: 6,
            context_tx_available: true,
            phase: "work".to_string(),
            force_final: false,
        };
        let wake = WakeSignal {
            cause: "user-message".to_string(),
            event_id: Some("user:1".to_string()),
            tool_name: None,
            visible_in_inbox: true,
        };
        let references = ContextReferences::default();
        let rendered = render_context(ContextRenderInput {
            session_id: "s1",
            parent_session_id: None,
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
            Some(&SExpr::Atom("6".to_string()))
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
        assert!(rendered.contains("(context-tx-contract"));
        assert!(rendered.contains("(body-arity \"create derive revise one-or-more\")"));
        assert!(rendered.contains("(body-normalization"));
        assert!(rendered.contains("(source-placement"));
        assert!(rendered.contains("(syntax \"(retire ID...)\")"));
        assert!(rendered.contains("(mind (frame"));
        assert!(rendered.contains("(inbox)"));
        assert!(!rendered.contains("todo_stack"));
    }

    #[test]
    fn turn_budget_counts_attempts_after_latest_user_message() {
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
            max_attempts_per_turn: 3,
            max_context_transactions_per_turn: 2,
            ..Default::default()
        };
        let events = vec![call("old"), user, call("new-1"), call("new-2")];
        let closure = turn_budget_for(&events, &config);
        assert_eq!(closure.attempt, 3);
        assert_eq!(closure.remaining_including_current, 1);
        assert_eq!(closure.phase, "context-closure");
        assert!(!closure.force_final);

        let closure_call = Event::new(
            "closure".to_string(),
            "Agent".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/assistant_call".to_string(),
            vec![("phase".to_string(), json!("context-closure"))]
                .into_iter()
                .collect(),
        );
        let final_reply = turn_budget_for(
            &[
                call("old"),
                events[1].clone(),
                call("new-1"),
                call("new-2"),
                closure_call,
            ],
            &config,
        );
        assert_eq!(final_reply.attempt, 3);
        assert_eq!(final_reply.phase, "final-reply");
        assert!(final_reply.force_final);
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
            max_attempts_per_turn: 4,
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
        assert_eq!(budget.attempt, 2);
        assert_eq!(budget.remaining_including_current, 3);
        assert_eq!(budget.context_transactions_used, 2);
        assert!(!budget.context_tx_available);
        assert_eq!(budget.phase, "work");
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
                    .apply_transaction(
                        "same-session",
                        "(context-tx (base-version 0) (create left (note left)))",
                    )
                    .await
            })
        };
        let right = {
            let engine = Arc::clone(&engine);
            tokio::spawn(async move {
                engine
                    .apply_transaction(
                        "same-session",
                        "(context-tx (base-version 0) (create right (note right)))",
                    )
                    .await
            })
        };

        let outcomes = [left.await.unwrap(), right.await.unwrap()];
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
        let view = engine.build_view("same-session").await.unwrap();
        assert_eq!(view.state.version, 1);
        assert_eq!(view.state.frames.len(), 1);
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
