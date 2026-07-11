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
use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;

type DynError = Box<dyn std::error::Error + Send + Sync>;

pub const CONTEXT_PROTOCOL_VERSION: u64 = 1;

struct ContextOperationSpec {
    name: &'static str,
    syntax: &'static str,
    meaning: &'static str,
}

const CONTEXT_OPERATIONS: &[ContextOperationSpec] = &[
    ContextOperationSpec {
        name: "create",
        syntax: "(create ID BODY)",
        meaning: "创建具有稳定 ID 的自由格式 frame",
    },
    ContextOperationSpec {
        name: "derive",
        syntax: "(derive ID (from SOURCE_ID...) BODY)",
        meaning: "基于 observation/frame 创建带血缘的新 frame",
    },
    ContextOperationSpec {
        name: "revise",
        syntax: "(revise ID BODY) | (revise ID (from SOURCE_ID...) BODY)",
        meaning: "修订既有 frame 并递增 revision",
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
];

pub fn context_tx_tool_description() -> String {
    let operations = CONTEXT_OPERATIONS
        .iter()
        .map(|operation| operation.syntax)
        .collect::<Vec<_>>()
        .join("；");
    format!(
        "原子修改你拥有的 Mind Context。参数 transaction 是版本化 SExpr：(context-tx (base-version N) (reason \"...\") OP...)。支持：{operations}。create/derive/revise 的 BODY 必须恰好是一个 SExpr；多个字段应包在同一个 List 中，例如 (create task (task (goal x) (status active)))。reason 是事务级字段，retire/unprotect 必须提供；不要把 reason 放进操作参数。Context 修改不是给用户的最终回复。"
    )
}

#[derive(Debug, Clone)]
struct ParsedTransaction {
    base_version: u64,
    reason: Option<String>,
    operations: Vec<SExpr>,
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

/// Agent 拥有的 Mind 持久状态。
///
/// `retired` 同时可以包含 frame ID 和 Event Ledger 中的 observation ID。
/// 退役只影响当前 Context 视口，不删除底层事实。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MindState {
    pub version: u64,
    pub frames: Vec<ContextFrame>,
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
    pub kind: String,
    pub topic: String,
    pub actor: String,
    pub timestamp: String,
    pub preview: String,
    pub truncated: bool,
    pub protected: bool,
    pub tool_name: Option<String>,
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

    pub async fn apply_transaction(
        &self,
        session_id: &str,
        transaction: &str,
    ) -> Result<ContextCommit, DynError> {
        let parsed = parse_transaction(transaction)?;
        let lock = self.session_lock(session_id);
        let _guard = lock.lock().await;

        let events = self.session_events(session_id).await?;
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
            ("transaction".to_string(), json!(transaction)),
            ("before_version".to_string(), json!(current.version)),
            ("after_version".to_string(), json!(next.version)),
            ("reason".to_string(), json!(&parsed.reason)),
            ("changes".to_string(), json!(changes)),
            ("state_after".to_string(), json!(next)),
            ("text".to_string(), json!(transaction)),
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
        let state = load_mind_from_events(&events)?;
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
            .map(|event| self.to_observation(event, &state))
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
                .map(|observation| estimate_text_tokens(&observation.preview) + 64)
                .sum::<usize>()
            + 1_000; // Kernel、DSL contract 与工具定义的保守固定开销
        let pressure = pressure_for(
            estimated_tokens,
            active_frames.len(),
            observations.len(),
            &self.config,
        );
        let turn_budget = turn_budget_for(&events, self.config.max_attempts_per_turn);
        let wake = wake_for(&events);
        let sexpr = render_context(
            session_id,
            parent_session_id.as_deref(),
            &state,
            &observations,
            &pressure,
            &turn_budget,
            &wake,
        );

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
        Ok(self
            .session_events(session_id)
            .await?
            .into_iter()
            .find(|event| event.id == event_id))
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

    fn to_observation(&self, event: &Event, state: &MindState) -> ContextObservation {
        let text = event_text(event);
        let (preview, truncated) = preview_text(&text, self.config.observation_preview_chars);
        ContextObservation {
            id: event.id.clone(),
            kind: event.event_type.clone(),
            topic: event.topic.clone(),
            actor: event.actor.clone(),
            timestamp: event.timestamp.to_rfc3339(),
            preview,
            truncated,
            protected: state.protected.contains(&event.id),
            tool_name: event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
        }
    }
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
    Ok(ParsedTransaction {
        base_version: base_version.ok_or("缺少 (base-version N)")?,
        reason,
        operations,
    })
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
                    return Err(
                        "create 必须且只能有一个 BODY：(create ID BODY)。若要保存 goal、constraints、status 等多个字段，请包成 (create ID (frame (goal ...) (constraints ...) (status ...)))"
                            .to_string(),
                    );
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
                        "derive 必须且只能有一个 BODY：(derive ID (from SOURCE...) BODY)。若要保存 goal、constraints、status 等多个字段，请先把它们包在同一个 SExpr List 中作为 BODY"
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
                        "revise 必须且只能有一个 BODY：(revise ID BODY) 或 (revise ID (from SOURCE...) BODY)。多个字段必须包在同一个 SExpr List 中"
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
            other => {
                return Err(format!(
                    "未知 Context 原语 '{}'。v1 支持 create/derive/revise/retire/restore/protect/unprotect/place",
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

fn render_context(
    session_id: &str,
    parent_session_id: Option<&str>,
    state: &MindState,
    observations: &[ContextObservation],
    pressure: &ContextPressure,
    turn_budget: &TurnBudget,
    wake: &WakeSignal,
) -> String {
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
        wake_fields.push(pair("event", atom(event_id)));
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
            frame.sources.iter().map(atom).collect::<Vec<SExpr>>(),
        );
        mind.push(list(
            "frame",
            vec![
                pair("id", atom(&frame.id)),
                pair("revision", atom(frame.revision.to_string())),
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
            ],
        ));
    }

    let mut inbox = vec![atom("inbox")];
    for observation in observations {
        let mut fields = vec![
            pair("id", atom(&observation.id)),
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
            pair(
                "truncated",
                atom(if observation.truncated {
                    "true"
                } else {
                    "false"
                }),
            ),
            pair("full-ref", atom(&observation.id)),
            pair("preview", atom(&observation.preview)),
        ];
        if let Some(tool_name) = &observation.tool_name {
            fields.insert(3, pair("tool", atom(tool_name)));
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
                "response-contract",
                vec![
                    list(
                        "reply",
                        vec![
                            pair("when", atom("当前用户任务已经完成，或必须向用户说明阻塞")),
                            pair("tool-calls", atom("none")),
                            pair("content", atom("直接交付给用户的最终答复")),
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
                            pair("tool-calls", atom("physical-tools")),
                            pair("content", atom("控制轨迹，不是最终答复")),
                            pair(
                                "scope",
                                atom("只执行当前明确任务所必需的动作，不自行扩张探索"),
                            ),
                        ],
                    ),
                    list(
                        "maintain",
                        vec![
                            pair("when", atom("需要修改自己的 Mind")),
                            pair("tool", atom("context_tx")),
                            pair("content", atom("事务调用不是最终答复")),
                            pair(
                                "after-commit",
                                atom("若任务已经完成，下一次响应必须使用 reply，不再调用工具"),
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
                    pair("body-arity", atom("create derive revise exactly-one")),
                    pair(
                        "body-example",
                        atom("(create task (task (goal x) (constraints y) (status active)))"),
                    ),
                    pair("reason-required-for", atom("retire unprotect")),
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

fn turn_budget_for(events: &[Event], configured_limit: usize) -> TurnBudget {
    let limit = configured_limit.max(1);
    let after_last_user = events
        .iter()
        .rposition(|event| event.event_type == TYPE_USER_MESSAGE)
        .map(|index| &events[index + 1..])
        .unwrap_or(events);
    let previous_attempts = after_last_user
        .iter()
        .filter(|event| event.topic == "chat/assistant_call")
        .count();
    let attempt = previous_attempts.saturating_add(1);
    TurnBudget {
        attempt,
        limit,
        remaining_including_current: limit.saturating_sub(attempt).saturating_add(1),
        force_final: attempt >= limit,
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
        || event.topic == "chat/context_inspect"
        || event.topic == "chat/context_tx_committed"
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
        return false;
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
            "{}\n...[原文共 {} 字符，使用 recall 按 full-ref 分段读取]...\n{}",
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
    if id.is_empty() || id.len() > 128 {
        return Err("Context ID 长度必须在 1..=128 之间".to_string());
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
            force_final: false,
        };
        let wake = WakeSignal {
            cause: "user-message".to_string(),
            event_id: Some("user:1".to_string()),
            tool_name: None,
            visible_in_inbox: true,
        };
        let rendered = render_context("s1", None, &state, &[], &pressure, &budget, &wake);
        let parsed = parse(&rendered).unwrap();
        assert_eq!(
            parsed.get_path(&["protocol", "version"]),
            Some(&SExpr::Atom("1".to_string()))
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
        let events = vec![call("old"), user, call("new-1"), call("new-2")];
        let budget = turn_budget_for(&events, 3);
        assert_eq!(budget.attempt, 3);
        assert_eq!(budget.remaining_including_current, 1);
        assert!(budget.force_final);
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
            vec![("tool_name".to_string(), json!("context_tx"))]
                .into_iter()
                .collect(),
        );
        let receipt = wake_for(&[user, context_output]);
        assert_eq!(receipt.cause, "context-transaction-result");
        assert!(!receipt.visible_in_inbox);
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
    fn derive_multiple_bodies_returns_actionable_error() {
        let tx = parse_transaction(
            "(context-tx (base-version 0) (derive task (from user:1) (goal x) (status active)))",
        )
        .unwrap();
        let error =
            apply_parsed_transaction(&MindState::default(), &tx, &observations(&["user:1"]))
                .unwrap_err();
        assert!(error.contains("只能有一个 BODY"));
        assert!(error.contains("包在同一个 SExpr List"));
    }

    #[test]
    fn create_multiple_bodies_returns_actionable_error() {
        let tx = parse_transaction(
            "(context-tx (base-version 0) (create task (goal x) (status active)))",
        )
        .unwrap();
        let error =
            apply_parsed_transaction(&MindState::default(), &tx, &HashSet::new()).unwrap_err();
        assert!(error.contains("只能有一个 BODY"));
        assert!(error.contains("(create ID (frame"));
    }

    #[test]
    fn preview_keeps_head_and_tail_without_semantic_rewrite() {
        let (preview, truncated) = preview_text("abcdefghij", 6);
        assert!(truncated);
        assert!(preview.starts_with("abc"));
        assert!(preview.ends_with("hij"));
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

        assert!(!is_observation(&assistant_call));
        assert!(!is_observation(&context_receipt));
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
