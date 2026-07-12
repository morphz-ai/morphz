use crate::config::OrchestratorConfig;
use crate::event::{Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
use crate::llm::{Client, Message};
use crate::memory::{EventStore, QueryFilter};
use crate::orchestrator::context::{ContextEngine, ContextView};
use crate::orchestrator::context_contract::render_system_contract;
use crate::tool::Registry;
use chrono::Utc;
use dashmap::DashMap;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const AGENT_OWNED_CONTEXT_PROMPT_BASE: &str = r#"你是 Morphz，一个能够管理自身工作 Context 的 AI Agent。

Runtime 每轮提供一份自描述 Context。`protocol` 是当前响应模式与 Context DSL 的权威契约；先读取它，再决策。

Context 的状态分为三个权限域：
- kernel：Runtime 拥有，只读。包含 session、context version 和物理压力。
- mind：你拥有的长期工作注意力，由稳定 ID 的自由格式 frame 组成。
- inbox：Event Ledger 中尚未被你 retire 的原始 observation。它们是证据，不是 Runtime 替你形成的结论。

你必须自己判断当前目标下什么值得保留、摘要、修订、保护、恢复或遗忘。Runtime 不会自动替你摘要历史、裁剪旧消息或把检索结果写成事实。

每次响应必须明确选择 `protocol.response-contract` 中的一种主模式：
- reply：当前任务已完成或需要说明阻塞；不调用任何工具，正文直接交付用户并结束当前回合。
- act：确实需要新的外部结果；调用物理工具，可并行附带一个不依赖这些新结果的 context_tx；若有正文则只是可见进度，Runtime 执行工具后必定再次调用你。
- maintain：需要先修改 Mind 时可单独调用 context_tx，不输出最终正文。事务成功后 Runtime 必定再次调用你，并在非 critical 时暂时隐藏 context_tx；maintain 不是用户回合终点，下一响应必须 reply 或 act。

使用 context_tx 原子修改 Mind，并严格遵循 `protocol.context-tx-contract` 展示的语法。每次事务使用 kernel 中当前的 version。reason 是 context-tx 的事务级子项，绝不能作为 retire/unprotect 的参数。`revise` 会完整替换 frame body，不是局部 merge；仍需保留的字段必须在新 BODY 中重述。高风险重组前可由你显式建立 checkpoint，必要时带 reason rollback。

重要规则：
1. frame 的内部结构由你根据任务自由创造；不要假设固定 goal/todo/history schema。
   inbox 元数据中：seq 是 Ledger 的稳定写入顺序；turn 是用户回合；attempt 是该回合内的模型尝试；caused-by 是可观察的因果来源。时间较新不等于内容必然正确，它只帮助你区分先后。
   residency 说明当前看到的是 full（全文）、preview（预览）还是 recalled-chunk（主动召回片段）；preview 的全文仍可通过 recall 获取。
   freshness 是 Runtime 可客观判断的新旧关系：同一 resource 的较新物理版本会标为 latest；Agent 可用 `(relate NEW supersedes OLD)` 声明语义取代。旧信息不会因此自动删除，是否 retire 仍由你决定。
   `retire` 只改变当前可见性，不会让既有关系失效；不要仅因旧端点被 retire 就 unrelate supersedes，它仍解释新结论为何取代旧结论。
   usage 只统计主动 recall 与 derive/revise 的 `(from ...)` 证据引用；信息仅仅出现在 Context 中不算“使用过”。次数高只表示经常被主动取用，不表示它更真实或更重要。若证据已被 active frame 引用且 Mind 已包含所需结论，不要在没有新问题或矛盾时重复 recall。
2. 重要目标、用户约束、关键结论和未完成工作应进入 frame；适合时使用 protect。
   用户明确声明“始终、整个任务期间、不得、必须”等持续约束时，应将其写入受保护 frame，直到用户明确撤销或任务生命周期真正结束。
3. 大段 observation 可先 derive 成忠实摘要，再在同一 transaction 中 retire 原始 observation。不要把假设写成事实。已完成、可从 Ledger 召回且没有改变目标、约束或结论的过程记录应直接 retire，不得为每个批次创建或保护长期 frame。
4. 用户要求在已知文件中查证具体结论时，直接使用 read.query 取得带行号的窄证据；需要连续上下文时再用 start_line/end_line 精确分页。不要先整读长文件，也不要用 exec/grep 反复产生大段重复输出。Context observation 的 `ref`（如 `@e27`）是 Runtime 提供的稳定短引用；recall 与 context_tx 必须原样使用，不要猜测或抄写隐藏的完整 Event ID。被 truncated 的 observation 可使用 recall 按 ref 分段读取原文；若 recall 返回 next_offset，下一次必须把该值原样作为 offset，不得重复 offset=0 或猜测跳转；已知关键词时优先 query，并使用命中片段或 suggested_recall。exec 若给出 artifact path，则使用 read 按需读取完整归档。recall/read 结果只进入 inbox，你决定是否写入 Mind。
5. context_tx 可以与不依赖本批新结果的物理工具并行；如果新 frame 依赖工具结果，应等结果返回后再提交。当前用户回合内，Runtime 按标准 assistant.tool_calls → role=tool/tool_call_id 返回工具结果；物理结果已同时持久化到 Ledger，并带 observation_ref。同一请求的 Context View 不会重复注入这批结果正文，下一独立快照才按 active/retired 状态展示。status=success 且 output_state=empty 表示工具已经完成但没有文本，不得仅因空输出重复调用。任何包含工具调用的响应都是中间状态：正文只作为可见进度，Runtime 执行完工具后必定再次调用你。只有无工具的纯文本响应才是最终 reply。
6. 同一响应最多提交一个 context_tx；把多个修改合并进同一事务，避免版本冲突。
   retire 或 unprotect 时 reason 是必需的，使遗忘与解除保护可审计。
7. pressure=normal/notice 时不要仅为降低体积而压缩；只在出现必须跨轮保留的目标、约束或结论变化时做语义维护。pressure=warning 时考虑在最终 reply 前或随 act 提交压缩事务；pressure=critical 时必须先 maintain-only 释放预算。
8. 完成任务前，确认 Mind 中仍需跨轮保留的目标、约束、结论和开放问题准确；若物理工具结果改变了任务状态，在最终 reply 之前用一次 context_tx 完成收口。Runtime 会在事务回执后再次调用你，届时用无工具文本交付最终结果。
9. assistant_call 与 context_tx 回执属于 Runtime 控制轨迹，只保存在 Ledger，不会进入 Inbox；不要为了清理 context_tx 自己产生的记录而连续提交 housekeeping transaction。
   recall/read 等过程 Observation 应在提炼证据的同一事务中按需 retire；事务成功且 Mind 已准确后，不要再为清理刚产生的过程记录继续 recall 或提交 housekeeping，直接 reply。
10. 每次调用物理工具前，必须确认它是完成当前用户明确任务所必需的新信息。当 Mind/inbox 已足以回答时，立即使用 reply；不要重复验证、扫描工作区或自行发明后续目标。
11. kernel.turn-budget 是当前用户回合的 Attempt 预算。phase=work 时正常工作，剩余 3 次以内应停止重复验证并收敛；phase=context-closure 是一次专用收口阶段，只能调用 context_tx，把最终目标状态、关键结论和证据准确写入 Mind；phase=final-reply 或 force-final=true 时工具会被移除，必须基于已有证据给出最终答案或明确说明阻塞原因。
12. kernel.wake 说明本次为何被唤醒。独立 context_tx 成功后的 context-transaction-result 会触发一次冷却：除非仍处于 critical，否则本次不再提供 context_tx，必须 reply 或执行必要的物理动作。
13. 代码任务优先使用 list_files/search 发现文件、read 获取内容与 sha256、edit 做带版本前提的局部修改；write 主要用于 mode=create，新文件已存在或 overwrite 缺少 expected_sha256 时不得绕过保护。exec 用于测试/编译/格式化，不要用 Shell 替代受约束的文件工具。file_change 是已提交修改的可审计证据。相互独立的文件读取必须在同一响应中并行调用；已经进入 Inbox 且 sha256 未被 file_change 改变的内容不得重复 read。完成必要定位后立即修改并验证，不能把整个 Attempt 预算消耗在反复扫描与阅读上。

Context 的修改是你的元认知行为；read/write/exec/spawn 等工具是对外部世界的行为。保持二者边界清晰。"#;

pub(crate) const SYSTEM_PROMPT_MODE_ENV: &str = "MORPHZ_SYSTEM_PROMPT_MODE";
pub(crate) const BASELINE_SYSTEM_PROMPT_MODE: &str = "agent_owned_context";
pub(crate) const COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE: &str = "cognitive_sexpr_vm";
const COMMON_PROMPT_MARKER: &str = "每次响应必须明确选择";
const COGNITIVE_SEXPR_VM_PREAMBLE: &str = r#"你是 Morphz Cognitive S-Expression Machine 的语义处理器。

每次模型调用都是这台持续运行机器的一个非确定性执行周期。Runtime 提供的 Context 不是普通聊天历史或供你被动阅读的摘要，而是当前可执行的符号机器状态。你解释这一状态、执行当前目标并提出下一次状态迁移；只有经 Runtime 校验和提交的迁移才成为机器事实。

Runtime 是确定性的事务内核，负责版本、权限、资源边界、工具执行、持久化和恢复。你是非确定性的语义处理器，负责理解、推理、归纳、规划和符号结构重组。S 表达式既可承载数据，也可承载由你解释和执行的目标、规则、策略与过程；Runtime 不替自由格式 BODY 定义业务求值语义。

Context 的状态分为三个权限域：
- kernel：Runtime 拥有的特权机器状态，只读。包含 session、context version、执行阶段和物理压力。
- mind：你拥有的持久化符号程序与认知状态，由稳定 ID 的自由格式 frame 组成。frame 可以表示事实、目标、计划、规则、策略、过程、反例、能力模型或你认为具有持续执行价值的其他结构。
- inbox：Event Ledger 中尚未被你 retire 的外部输入与 observation。它们是证据和中断输入，不是 Runtime 替你形成的结论。

你的职责不只是记录信息，而是让 Mind 成为后续执行可以直接利用的认知程序。当多个已完成任务反复出现相似的判断或执行结构，并且该结构可能改变未来决策、减少重复工作或降低错误率时，你可以基于多个真实来源派生可复用的符号结构。应保留其适用范围、来源、反例和不确定性；不得从单个案例过度泛化，也不得为了形式完整而强制总结经验。

你必须自己判断当前目标下什么值得保留、摘要、修订、保护、恢复、抽象、重组或遗忘。Runtime 不会自动替你摘要历史、裁剪旧消息、生成经验规则或把检索结果写成事实。

"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SystemPromptMode {
    AgentOwnedContext,
    CognitiveSexprVm,
}

impl SystemPromptMode {
    fn from_environment() -> Result<Self, String> {
        match std::env::var(SYSTEM_PROMPT_MODE_ENV) {
            Ok(value) if value == COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE => {
                Ok(Self::CognitiveSexprVm)
            }
            Ok(value) if value == BASELINE_SYSTEM_PROMPT_MODE => Ok(Self::AgentOwnedContext),
            Ok(value) => Err(format!(
                "未知 {SYSTEM_PROMPT_MODE_ENV}='{value}'；支持 {BASELINE_SYSTEM_PROMPT_MODE} 或 {COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE}"
            )),
            Err(std::env::VarError::NotPresent) => Ok(Self::CognitiveSexprVm),
            Err(error) => Err(format!("无法读取 {SYSTEM_PROMPT_MODE_ENV}: {error}")),
        }
    }
}

fn render_stable_system_prompt(mode: SystemPromptMode) -> &'static str {
    static BASELINE_PROMPT: OnceLock<String> = OnceLock::new();
    static COGNITIVE_VM_PROMPT: OnceLock<String> = OnceLock::new();
    let prompt = match mode {
        SystemPromptMode::AgentOwnedContext => BASELINE_PROMPT
            .get_or_init(|| build_stable_system_prompt(AGENT_OWNED_CONTEXT_PROMPT_BASE)),
        SystemPromptMode::CognitiveSexprVm => COGNITIVE_VM_PROMPT.get_or_init(|| {
            let common_offset = AGENT_OWNED_CONTEXT_PROMPT_BASE
                .find(COMMON_PROMPT_MARKER)
                .expect("Agent-Owned Context prompt 必须保留公共规则标记");
            let common_rules = &AGENT_OWNED_CONTEXT_PROMPT_BASE[common_offset..];
            build_stable_system_prompt(&format!("{COGNITIVE_SEXPR_VM_PREAMBLE}{common_rules}"))
        }),
    };
    prompt.as_str()
}

fn build_stable_system_prompt(base: &str) -> String {
    format!("{base}\n\n{}", render_system_contract())
}

fn configured_system_prompt() -> Result<&'static str, String> {
    SystemPromptMode::from_environment().map(render_stable_system_prompt)
}

#[cfg(test)]
fn baseline_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::AgentOwnedContext)
}

#[cfg(test)]
fn cognitive_sexpr_vm_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::CognitiveSexprVm)
}

const CONTEXT_CLOSURE_PROMPT: &str = r#"Runtime 当前处于 context-closure 阶段。这是本回合唯一一次专用 Mind 收口机会，不是继续工作的额外预算。
- 不得调用任何物理工具，不得继续探索或重复验证。
- 若 Mind 尚未准确反映最终状态，调用且仅调用一次 context_tx：将目标标记为 completed 或 blocked，写入已确认的关键结论、修改与验证证据，并清理不再有价值的过程信息。
- 若 Mind 已经准确，无需事务，可直接给出最终回复。
- context_tx 成功或失败后，Runtime 都会进入无工具 final-reply 阶段。"#;

const FINAL_REPLY_PROMPT: &str = r#"Runtime 当前处于 final-reply 阶段。Context 收口机会已经使用或耗尽；不得调用工具。请基于现有 Mind 与 Inbox 直接给出最终答复，或明确说明阻塞。"#;
const MAINTENANCE_BUDGET_EXHAUSTED_PROMPT: &str = r#"Runtime 检测到 Context 已处于 critical，且本回合普通 context_tx 额度已经耗尽。为避免在不可执行的维护请求中循环，本次强制进入无工具最终回复。不得调用任何工具；请如实说明已完成状态、最近一次可靠验证和剩余工作。"#;

const CONTEXT_TX_COOLDOWN_PROMPT: &str = r#"上一次独立 context_tx 已成功提交，且当前不再处于 critical。Runtime 本次隐藏 context_tx 以阻断连续 housekeeping；请直接回复用户，或仅执行完成当前任务确实必需的物理动作。新的 user/tool observation 到达后，context_tx 会恢复。"#;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextTxReceipt {
    None,
    Committed,
    Failed,
}

#[derive(Debug)]
struct ToolExecutionOptions {
    context_tx_allowed: bool,
    wake_on_output: bool,
}

#[derive(Debug, Default)]
struct ToolExecutionOutcome {
    context_tx_succeeded: bool,
}

#[derive(Debug, Default)]
struct TurnToolTranscript {
    messages: Vec<Message>,
    delivered_output_ids: HashSet<String>,
}

#[derive(Debug, Default)]
struct ReadTurnGuard {
    files: HashMap<String, ReadCoverage>,
}

#[derive(Debug, Default)]
struct ReadCoverage {
    full: Option<String>,
    ranges: Vec<(usize, usize, String)>,
    queries: Vec<(String, String)>,
}

#[derive(Debug, PartialEq, Eq)]
struct ReadDuplicate {
    path: String,
    evidence_event_id: String,
}

#[derive(Debug, serde::Deserialize)]
struct ReadGuardArgs {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    query: Option<String>,
    context_lines: Option<usize>,
    max_matches: Option<usize>,
}

impl ReadTurnGuard {
    fn reserve(&mut self, arguments: &str, evidence_event_id: &str) -> Option<ReadDuplicate> {
        let args: ReadGuardArgs = serde_json::from_str(arguments).ok()?;
        let coverage = self.files.entry(args.path.clone()).or_default();
        let covered_by = if let Some(event_id) = coverage.full.as_ref() {
            Some(event_id.clone())
        } else if let Some(query) = args.query.as_deref() {
            let signature = format!(
                "{}\u{0}{}\u{0}{}",
                query.to_lowercase(),
                args.context_lines.unwrap_or(3),
                args.max_matches.unwrap_or(20)
            );
            if let Some((_, event_id)) = coverage
                .queries
                .iter()
                .find(|(candidate, _)| candidate == &signature)
            {
                Some(event_id.clone())
            } else {
                coverage
                    .queries
                    .push((signature, evidence_event_id.to_string()));
                None
            }
        } else if args.start_line.is_none() && args.end_line.is_none() {
            coverage.full = Some(evidence_event_id.to_string());
            None
        } else {
            let start = args.start_line.unwrap_or(1);
            let end = args.end_line.unwrap_or(usize::MAX);
            if let Some((_, _, event_id)) =
                coverage
                    .ranges
                    .iter()
                    .find(|(covered_start, covered_end, _)| {
                        start >= *covered_start && end <= *covered_end
                    })
            {
                Some(event_id.clone())
            } else {
                coverage
                    .ranges
                    .push((start, end, evidence_event_id.to_string()));
                None
            }
        };

        covered_by.map(|evidence_event_id| ReadDuplicate {
            path: args.path,
            evidence_event_id,
        })
    }

    fn invalidate_path_from_arguments(&mut self, arguments: &str) {
        let Some(path) = serde_json::from_str::<serde_json::Value>(arguments)
            .ok()
            .and_then(|value| value.get("path")?.as_str().map(ToOwned::to_owned))
        else {
            return;
        };
        self.files.remove(&path);
    }
}

pub struct Orchestrator {
    bus: Arc<InMemoryEventBus>,
    store: Arc<dyn EventStore>,
    client: Arc<dyn Client>,
    registry: Arc<Registry>,
    tool_definitions: Vec<crate::llm::ToolDefinition>,
    context_engine: Arc<ContextEngine>,
    orchestrator_config: OrchestratorConfig,
    pub concurrency_semaphore: Arc<tokio::sync::Semaphore>,
    session_locks: DashMap<String, Arc<Mutex<()>>>,
    read_turn_guards: DashMap<String, Arc<Mutex<ReadTurnGuard>>>,
}

impl Orchestrator {
    pub fn new(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
    ) -> Self {
        let orchestrator_config = OrchestratorConfig::default();
        let context_engine = Arc::new(ContextEngine::new(
            Arc::clone(&store),
            orchestrator_config.clone(),
        ));
        Self::new_with_context_engine(
            bus,
            store,
            client,
            registry,
            orchestrator_config,
            context_engine,
        )
    }

    pub fn new_with_context_engine(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
        orchestrator_config: OrchestratorConfig,
        context_engine: Arc<ContextEngine>,
    ) -> Self {
        let concurrency_semaphore = Arc::new(tokio::sync::Semaphore::new(
            orchestrator_config.concurrency_limit.max(1),
        ));
        let tool_definitions = registry.definitions();
        Self {
            bus,
            store,
            client,
            registry,
            tool_definitions,
            context_engine,
            orchestrator_config,
            concurrency_semaphore,
            session_locks: DashMap::new(),
            read_turn_guards: DashMap::new(),
        }
    }

    pub async fn start(self: Arc<Self>) -> Result<(), DynError> {
        let store = Arc::clone(&self.store);
        self.bus.subscribe(
            "*".to_string(),
            Arc::new(move |event| {
                let store = Arc::clone(&store);
                Box::pin(async move {
                    store.append(event).await?;
                    Ok(())
                })
            }),
        );

        let orchestrator = Arc::clone(&self);
        self.bus.subscribe(
            "chat/*".to_string(),
            Arc::new(move |event| {
                let orchestrator = Arc::clone(&orchestrator);
                Box::pin(async move { orchestrator.handle_chat_event(event).await })
            }),
        );

        let orchestrator = Arc::clone(&self);
        self.bus.subscribe(
            "chat/spawn".to_string(),
            Arc::new(move |event| {
                let orchestrator = Arc::clone(&orchestrator);
                Box::pin(async move { orchestrator.handle_spawn_event(event).await })
            }),
        );
        Ok(())
    }

    async fn handle_spawn_event(&self, event: Event) -> Result<(), DynError> {
        let sub_session_id = required_payload_str(&event, "session_id")?.to_string();
        let parent_session_id = required_payload_str(&event, "parent_session_id")?.to_string();
        let delegation = required_payload_str(&event, "delegation")?;
        let canonical_delegation = crate::sexpr::parse(delegation)
            .map_err(|error| format!("spawn delegation 必须是合法 SExpr: {}", error))?
            .to_string();

        let transaction = format!(
            "(context-tx (base-version 0) (derive delegated-task (from {}) {}) (protect delegated-task))",
            event.id, canonical_delegation
        );
        self.context_engine
            .apply_transaction(&sub_session_id, &transaction)
            .await?;

        let mut payload = serde_json::Map::new();
        payload.insert("session_id".to_string(), json!(sub_session_id));
        payload.insert("parent_session_id".to_string(), json!(parent_session_id));
        payload.insert(
            "text".to_string(),
            json!("Begin the delegated task using the protected delegated-task frame."),
        );
        self.bus
            .publish(Event::new(
                format!(
                    "sub_start_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "System-Spawner".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                payload,
            ))
            .await?;
        Ok(())
    }

    async fn handle_chat_event(&self, event: Event) -> Result<(), DynError> {
        let Some(session_id) = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
        else {
            return Ok(());
        };

        if event.event_type == TYPE_AGENT_CALL && event.topic == "chat/reply" {
            self.wake_parent_if_needed(&event, &session_id).await?;
            return Ok(());
        }
        if event.event_type != TYPE_USER_MESSAGE && event.event_type != TYPE_TOOL_OUTPUT {
            return Ok(());
        }
        if event.event_type == TYPE_USER_MESSAGE {
            self.read_turn_guards.remove(&session_id);
        }

        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config
                .model_attempt_timeout_secs
                .max(1)
                .saturating_add(1),
        );
        let watchdog_attempt_id = format!(
            "attempt_watchdog_{}_{}",
            session_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let attempt = tokio::time::timeout(deadline, async {
            let lock = self.session_lock(&session_id);
            let _session_guard = lock.lock().await;
            if event.event_type == TYPE_TOOL_OUTPUT
                && self
                    .tool_output_already_covered(&session_id, &event)
                    .await?
            {
                tracing::debug!(
                    session_id,
                    event_id = %event.id,
                    "跳过已被更新 Context view 覆盖的排队 tool wakeup"
                );
                return Ok(());
            }
            self.run_attempt(&session_id).await
        })
        .await;
        match attempt {
            Ok(result) => result,
            Err(error) => {
                self.publish_runtime_failure(
                    &session_id,
                    &watchdog_attempt_id,
                    "attempt_watchdog",
                    &error,
                    None,
                )
                .await
            }
        }
    }

    async fn tool_output_already_covered(
        &self,
        session_id: &str,
        trigger: &Event,
    ) -> Result<bool, DynError> {
        let inspections = self
            .store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                topic: Some("chat/context_inspect".to_string()),
                ..Default::default()
            })
            .await?;
        Ok(inspections
            .iter()
            .any(|inspection| inspection.timestamp > trigger.timestamp))
    }

    /// Rebuild the standard Function Calling transcript for the active user
    /// turn. Long-term conversation history is still represented only by the
    /// compiled Context snapshot; assistant/tool messages here are transient
    /// protocol messages since the latest user observation.
    async fn turn_tool_transcript(&self, session_id: &str) -> Result<TurnToolTranscript, DynError> {
        let events = self
            .store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                ..Default::default()
            })
            .await?;
        let turn_start = events
            .iter()
            .rposition(|event| event.event_type == TYPE_USER_MESSAGE)
            .unwrap_or(0);
        let turn_events = &events[turn_start..];
        let mut outputs = HashMap::<(String, String), Event>::new();
        for event in turn_events {
            if event.event_type != TYPE_TOOL_OUTPUT {
                continue;
            }
            let Some(attempt_id) = event
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            let Some(tool_call_id) = event
                .payload
                .get("tool_call_id")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            outputs.insert(
                (attempt_id.to_string(), tool_call_id.to_string()),
                event.clone(),
            );
        }

        let mut transcript = TurnToolTranscript::default();
        for event in turn_events {
            if event.topic != "chat/assistant_call" {
                continue;
            }
            let Some(attempt_id) = event
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
            else {
                continue;
            };
            let calls_value = event
                .payload
                .get("transcript_tool_calls")
                .or_else(|| event.payload.get("tool_calls"));
            let Some(calls_value) = calls_value else {
                continue;
            };
            let calls = serde_json::from_value::<Vec<crate::llm::ToolCall>>(calls_value.clone())?;
            let calls = calls
                .into_iter()
                .filter(|call| outputs.contains_key(&(attempt_id.to_string(), call.id.clone())))
                .collect::<Vec<_>>();
            if calls.is_empty() {
                continue;
            }

            transcript.messages.push(Message {
                role: "assistant".to_string(),
                content: event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                name: None,
                tool_call_id: None,
                tool_calls: Some(calls.clone()),
            });
            for call in calls {
                let Some(output) = outputs.get(&(attempt_id.to_string(), call.id.clone())) else {
                    continue;
                };
                transcript.delivered_output_ids.insert(output.id.clone());
                transcript
                    .messages
                    .push(self.standard_tool_result_message(&call, output));
            }
        }
        Ok(transcript)
    }

    fn standard_tool_result_message(&self, call: &crate::llm::ToolCall, output: &Event) -> Message {
        let text = output
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let status = output
            .payload
            .get("tool_status")
            .and_then(|value| value.as_str())
            .unwrap_or_else(|| infer_tool_status(text));
        let output_state = if text.trim().is_empty() {
            "empty"
        } else {
            "content"
        };
        let recallable = call.function.name != "context_tx"
            || text.starts_with("执行失败:")
            || text.starts_with("执行拒绝:");
        let observation_ref = recallable.then(|| self.context_engine.event_reference(output));
        let guidance = (status == "success" && output_state == "empty").then_some(
            "工具已成功完成但没有返回文本；不要仅因输出为空而重复调用。若工具具有副作用，请依据后续 file_change 或状态证据判断。",
        );
        let content = serde_json::to_string(&json!({
            "status": status,
            "output_state": output_state,
            "observation_ref": observation_ref,
            "tool_name": call.function.name,
            "result": text,
            "guidance": guidance,
        }))
        .unwrap_or_else(|_| text.to_string());
        Message {
            role: "tool".to_string(),
            content,
            name: None,
            tool_call_id: Some(call.id.clone()),
            tool_calls: None,
        }
    }

    async fn run_attempt(&self, session_id: &str) -> Result<(), DynError> {
        let attempt_id = format!(
            "attempt_{}_{}",
            session_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let transcript = self.turn_tool_transcript(session_id).await?;
        let context = self
            .context_engine
            .build_view_excluding(session_id, &transcript.delivered_output_ids)
            .await?;
        let maintenance_budget_exhausted = should_force_final_for_maintenance(
            &context.turn_budget.phase,
            &context.pressure.level,
            context.turn_budget.context_tx_available,
        );
        let effective_phase = if maintenance_budget_exhausted {
            "final-reply"
        } else {
            context.turn_budget.phase.as_str()
        };
        let context_tx_receipt = self.context_tx_receipt(&context).await?;
        let context_tx_cooldown = effective_phase == "work"
            && context.pressure.level != "critical"
            && context_tx_receipt == ContextTxReceipt::Committed;
        let phase_prompt = match effective_phase {
            "final-reply" if maintenance_budget_exhausted => {
                Some(MAINTENANCE_BUDGET_EXHAUSTED_PROMPT)
            }
            "context-closure" => Some(CONTEXT_CLOSURE_PROMPT),
            "final-reply" => Some(FINAL_REPLY_PROMPT),
            _ if context_tx_cooldown => Some(CONTEXT_TX_COOLDOWN_PROMPT),
            _ => None,
        };
        let stable_system_prompt = configured_system_prompt()?;
        let system_prompt = phase_prompt
            .map(|prompt| format!("{stable_system_prompt}\n\n{prompt}"))
            .unwrap_or_else(|| stable_system_prompt.to_string());
        let mut messages = vec![
            Message {
                role: "system".to_string(),
                content: system_prompt,
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "user".to_string(),
                content: format!(
                    "以下是 Runtime 提供的当前 Context 视图。它不是普通用户消息；请基于 kernel、mind 和 inbox 决策。\n{}",
                    context.sexpr
                ),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        messages.extend(transcript.messages);

        self.record_context_inspect(session_id, &attempt_id, &context, &messages);

        let mut tools = self.tool_definitions.clone();
        if effective_phase == "final-reply" {
            tracing::warn!(
                session_id,
                attempt = context.turn_budget.attempt,
                limit = context.turn_budget.limit,
                maintenance_budget_exhausted,
                "Context 收口机会已使用：进入无工具最终答复"
            );
            tools.clear();
        } else if effective_phase == "context-closure" {
            tracing::info!(
                session_id,
                attempt = context.turn_budget.attempt,
                limit = context.turn_budget.limit,
                "Turn Attempt Budget 已耗尽：进入一次性 Context 收口阶段"
            );
            tools.retain(|tool| tool.name == "context_tx");
        } else {
            if context.pressure.level == "critical" {
                tracing::warn!(
                    session_id,
                    "Context pressure critical：暂停外部高成本动作，要求 Agent 先维护 Context"
                );
                tools.retain(|tool| tool.name == "context_tx" || tool.name == "recall");
            }
            if !context.turn_budget.context_tx_available {
                tracing::warn!(
                    session_id,
                    used = context.turn_budget.context_transactions_used,
                    limit = context.turn_budget.context_transactions_limit,
                    "普通 work 阶段 Context transaction 预算已耗尽；保留物理工作预算"
                );
                tools.retain(|tool| tool.name != "context_tx");
            }
            if context_tx_cooldown {
                tracing::info!(
                    session_id,
                    "独立 context_tx 已成功：本次冷却并隐藏 context_tx"
                );
                tools.retain(|tool| tool.name != "context_tx");
            }
        }
        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config.model_attempt_timeout_secs.max(1),
        );
        let _permit = self.concurrency_semaphore.acquire().await?;
        self.record_model_attempt_started(session_id, &attempt_id, effective_phase, tools.len());
        let client = Arc::clone(&self.client);
        let (model_tx, model_rx) = tokio::sync::oneshot::channel();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("morphz-llm-{attempt_id}"))
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| Box::new(error) as DynError)
                    .and_then(|runtime| {
                        runtime.block_on(client.create_completion(messages, tools))
                    });
                let _ = model_tx.send(result);
            })
        {
            return self
                .publish_runtime_failure(
                    session_id,
                    &attempt_id,
                    "llm_thread_spawn",
                    &error,
                    context.parent_session_id.as_deref(),
                )
                .await;
        }
        let completion = tokio::time::timeout(deadline, model_rx).await;
        let response = match completion {
            Ok(Ok(Ok(response))) => response,
            Ok(Ok(Err(error))) => {
                return self
                    .publish_runtime_failure(
                        session_id,
                        &attempt_id,
                        "llm_completion",
                        error.as_ref(),
                        context.parent_session_id.as_deref(),
                    )
                    .await;
            }
            Ok(Err(error)) => {
                return self
                    .publish_runtime_failure(
                        session_id,
                        &attempt_id,
                        "llm_worker_channel",
                        &error,
                        context.parent_session_id.as_deref(),
                    )
                    .await;
            }
            Err(error) => {
                return self
                    .publish_runtime_failure(
                        session_id,
                        &attempt_id,
                        "llm_completion",
                        &error,
                        context.parent_session_id.as_deref(),
                    )
                    .await;
            }
        };

        if effective_phase == "context-closure" && !response.tool_calls.is_empty() {
            let valid_closure = response
                .tool_calls
                .iter()
                .all(|call| call.func_name == "context_tx");
            if valid_closure {
                self.execute_tool_calls(
                    session_id,
                    &attempt_id,
                    response,
                    effective_phase,
                    ToolExecutionOptions {
                        context_tx_allowed: true,
                        wake_on_output: true,
                    },
                )
                .await?;
                return Ok(());
            }
            let content = if response.content.trim().is_empty() {
                "Context 收口阶段只允许一次 context_tx；Runtime 已拒绝其他工具调用并停止本轮执行。"
                    .to_string()
            } else {
                response.content
            };
            return self
                .publish_reply(
                    session_id,
                    &attempt_id,
                    content,
                    context.parent_session_id.as_deref(),
                )
                .await;
        }

        if effective_phase == "final-reply" && !response.tool_calls.is_empty() {
            let content = if response.content.trim().is_empty() {
                if maintenance_budget_exhausted {
                    "Context 已达到 critical 且本回合维护事务额度耗尽，Runtime 已停止继续执行工具以避免循环。请在新回合继续未完成工作；现有文件修改与 Ledger 均已保留。".to_string()
                } else {
                    format!(
                        "本轮已达到 {} 次 Attempt 上限并完成 Context 收口阶段，Runtime 已停止继续执行工具。现有信息不足以形成最终答复，请缩小任务或提供新的指令。",
                        context.turn_budget.limit
                    )
                }
            } else {
                response.content
            };
            return self
                .publish_reply(
                    session_id,
                    &attempt_id,
                    content,
                    context.parent_session_id.as_deref(),
                )
                .await;
        }

        if !response.tool_calls.is_empty() {
            if !response.content.trim().is_empty() {
                self.publish_progress(session_id, &attempt_id, response.content.clone())
                    .await?;
            }
            self.execute_tool_calls(
                session_id,
                &attempt_id,
                response,
                effective_phase,
                ToolExecutionOptions {
                    context_tx_allowed: context.turn_budget.context_tx_available
                        && !context_tx_cooldown,
                    wake_on_output: true,
                },
            )
            .await?;
            return Ok(());
        }

        self.publish_reply(
            session_id,
            &attempt_id,
            response.content,
            context.parent_session_id.as_deref(),
        )
        .await
    }

    async fn publish_reply(
        &self,
        session_id: &str,
        attempt_id: &str,
        content: String,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        let mut payload = vec![
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("text".to_string(), json!(content)),
        ];
        if let Some(parent_session_id) = parent_session_id {
            payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        self.bus
            .publish(Event::new(
                format!("reply_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/reply".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn publish_progress(
        &self,
        session_id: &str,
        attempt_id: &str,
        content: String,
    ) -> Result<(), DynError> {
        self.bus
            .publish(Event::new(
                format!("progress_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/progress".to_string(),
                vec![
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("text".to_string(), json!(content)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
        Ok(())
    }

    async fn publish_runtime_failure(
        &self,
        session_id: &str,
        attempt_id: &str,
        stage: &str,
        error: &(dyn std::error::Error + Send + Sync),
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        let error_text: String = error.to_string().chars().take(2_000).collect();
        tracing::error!(
            session_id,
            attempt_id,
            error = %error_text,
            "LLM 请求在重试后失败；终止本回合并向用户返回可见错误"
        );
        self.bus
            .publish(Event::new(
                format!(
                    "runtime_error_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_error".to_string(),
                "chat/runtime_error".to_string(),
                vec![
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("stage".to_string(), json!(stage)),
                    ("error".to_string(), json!(error_text)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;

        let user_message = if stage == "llm_completion" {
            "模型请求在重试后仍然失败，Runtime 已停止本回合，未继续执行任何工具。请稍后重试；当前 Session、Mind 与已提交文件修改均已保留。"
        } else {
            "Runtime 的完整 Attempt 超过执行期限，已取消本回合以避免用户一直等待。当前 Session、Mind 与已提交文件修改均已保留；请重试或缩小单次任务。"
        };
        self.publish_reply(
            session_id,
            attempt_id,
            user_message.to_string(),
            parent_session_id,
        )
        .await
    }

    fn record_model_attempt_started(
        &self,
        session_id: &str,
        attempt_id: &str,
        phase: &str,
        tool_count: usize,
    ) {
        let bus = Arc::clone(&self.bus);
        let event = Event::new(
            format!(
                "model_attempt_started_{}",
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Runtime-Orchestrator".to_string(),
            "runtime_control".to_string(),
            "runtime/model_attempt_started".to_string(),
            vec![
                ("session_id".to_string(), json!(session_id)),
                ("attempt_id".to_string(), json!(attempt_id)),
                ("phase".to_string(), json!(phase)),
                ("tool_count".to_string(), json!(tool_count)),
                (
                    "deadline_secs".to_string(),
                    json!(self.orchestrator_config.model_attempt_timeout_secs.max(1)),
                ),
            ]
            .into_iter()
            .collect(),
        );
        tokio::spawn(async move {
            if let Err(error) = bus.publish(event).await {
                tracing::error!(?error, "记录 model_attempt_started 失败");
            }
        });
    }

    async fn execute_tool_calls(
        &self,
        session_id: &str,
        attempt_id: &str,
        response: crate::llm::Response,
        phase: &str,
        options: ToolExecutionOptions,
    ) -> Result<ToolExecutionOutcome, DynError> {
        let requested_tool_calls = response.tool_calls;
        let mapped_tool_calls = requested_tool_calls
            .iter()
            .map(|call| crate::llm::ToolCall {
                id: call.id.clone(),
                r#type: call.r#type.clone(),
                function: crate::llm::FunctionCall {
                    name: call.func_name.clone(),
                    arguments: call.arguments.clone(),
                },
            })
            .collect::<Vec<_>>();
        let mut selected_tool_calls = Vec::with_capacity(requested_tool_calls.len());
        let mut context_tx_calls = Vec::new();
        for call in requested_tool_calls {
            if call.func_name == "context_tx" {
                context_tx_calls.push(call);
            } else {
                selected_tool_calls.push(call);
            }
        }
        let mut deduplicated_context_tx_ids = Vec::new();
        let mut rejected_context_tx_ids = Vec::new();
        let mut context_tx_batch_error = None;
        let mut context_tx_batch_status = None;
        if !options.context_tx_allowed && !context_tx_calls.is_empty() {
            rejected_context_tx_ids.extend(context_tx_calls.into_iter().map(|call| call.id));
            context_tx_batch_status = Some("budget-exhausted".to_string());
            context_tx_batch_error = Some(format!(
                "执行拒绝: CONTEXT_TX_BUDGET_EXHAUSTED：普通 work 阶段 Context transaction 已达到 {} 次上限。本轮保留剩余物理工作预算；请继续完成必要工作，Runtime 在最终 context-closure 阶段仍会提供一次专用收口机会。",
                self.orchestrator_config.max_context_transactions_per_turn.max(1)
            ));
        } else {
            match context_tx_calls.len() {
                0 => {}
                1 => selected_tool_calls.push(context_tx_calls.remove(0)),
                _ => {
                    let normalized = context_tx_calls
                        .iter()
                        .map(|call| normalize_context_tx_key(session_id, &call.arguments))
                        .collect::<Vec<_>>();
                    let all_normalized_equal = normalized
                        .first()
                        .and_then(|first| first.as_ref().ok())
                        .is_some_and(|first| {
                            normalized
                                .iter()
                                .all(|key| key.as_ref().is_ok_and(|key| key == first))
                        });
                    let all_raw_equal = context_tx_calls
                        .windows(2)
                        .all(|pair| pair[0].arguments == pair[1].arguments);
                    if all_normalized_equal || all_raw_equal {
                        let first = context_tx_calls.remove(0);
                        deduplicated_context_tx_ids
                            .extend(context_tx_calls.into_iter().map(|call| call.id));
                        selected_tool_calls.push(first);
                    } else {
                        rejected_context_tx_ids
                            .extend(context_tx_calls.into_iter().map(|call| call.id));
                        context_tx_batch_status = Some("multiple-distinct".to_string());
                        context_tx_batch_error = Some(format!(
                        "执行拒绝: MULTIPLE_DISTINCT_CONTEXT_TX：同一响应请求了 {} 个内容不同的 context_tx。Runtime 未执行其中任何一个；请把所有 create/derive/revise/retire/restore/protect/unprotect/place 操作合并到一个原子 (context-tx ...) 后重新提交。",
                        rejected_context_tx_ids.len()
                    ));
                    }
                }
            }
        }
        if !deduplicated_context_tx_ids.is_empty() {
            tracing::warn!(
                session_id,
                attempt_id,
                deduplicated = deduplicated_context_tx_ids.len(),
                "同一 assistant response 包含重复 context_tx；已规范化去重"
            );
        }
        if !rejected_context_tx_ids.is_empty() {
            match context_tx_batch_status.as_deref() {
                Some("budget-exhausted") => tracing::warn!(
                    session_id,
                    attempt_id,
                    rejected = rejected_context_tx_ids.len(),
                    "Context transaction 预算已耗尽"
                ),
                _ => tracing::warn!(
                    session_id,
                    attempt_id,
                    rejected = rejected_context_tx_ids.len(),
                    "同一 assistant response 包含多个不同 context_tx；已全部拒绝并要求合并"
                ),
            }
        }
        let mut transcript_tool_calls = selected_tool_calls
            .iter()
            .map(|call| crate::llm::ToolCall {
                id: call.id.clone(),
                r#type: call.r#type.clone(),
                function: crate::llm::FunctionCall {
                    name: call.func_name.clone(),
                    arguments: call.arguments.clone(),
                },
            })
            .collect::<Vec<_>>();
        if context_tx_batch_error.is_some() {
            transcript_tool_calls.push(crate::llm::ToolCall {
                id: "context_tx_batch_rejected".to_string(),
                r#type: "function".to_string(),
                function: crate::llm::FunctionCall {
                    name: "context_tx".to_string(),
                    arguments: json!({
                        "runtime_rejected_batch": true,
                        "status": context_tx_batch_status,
                    })
                    .to_string(),
                },
            });
        }
        self.bus
            .publish(Event::new(
                format!("call_{}", attempt_id),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                vec![
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("phase".to_string(), json!(phase)),
                    ("text".to_string(), json!(response.content)),
                    ("tool_calls".to_string(), json!(mapped_tool_calls)),
                    (
                        "transcript_tool_calls".to_string(),
                        json!(transcript_tool_calls),
                    ),
                    (
                        "deduplicated_context_tx_ids".to_string(),
                        json!(deduplicated_context_tx_ids),
                    ),
                    (
                        "rejected_context_tx_ids".to_string(),
                        json!(rejected_context_tx_ids),
                    ),
                    (
                        "context_tx_rejection_status".to_string(),
                        json!(context_tx_batch_status),
                    ),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;

        let mut tasks = Vec::new();
        let mut guarded_outputs = Vec::new();
        for call in selected_tool_calls {
            if matches!(call.func_name.as_str(), "write" | "edit") {
                self.read_guard(session_id)
                    .lock()
                    .await
                    .invalidate_path_from_arguments(&call.arguments);
            }
            if call.func_name == "read" {
                let evidence_event_id = format!("output_{}_{}", attempt_id, call.id);
                let duplicate = self
                    .read_guard(session_id)
                    .lock()
                    .await
                    .reserve(&call.arguments, &evidence_event_id);
                if let Some(duplicate) = duplicate {
                    let reference = self
                        .context_engine
                        .find_event(session_id, &duplicate.evidence_event_id)
                        .await?
                        .as_ref()
                        .map(|event| self.context_engine.event_reference(event));
                    let evidence_hint = reference.map_or_else(
                        || "本批较早的 read 输出".to_string(),
                        |reference| format!("已有证据 {reference}"),
                    );
                    let output = format!(
                        "READ_ALREADY_COVERED: '{}' 的相同版本内容已在本轮 Inbox 中覆盖；本次未再次读取，也不会复制旧内容。{evidence_hint} 包含原 read 结果与 sha256，请直接使用它进行 edit/write、必要测试或回复用户。仅在 file_change 后才需要重新 read。",
                        duplicate.path
                    );
                    guarded_outputs.push(Event::new(
                        format!("output_{}_{}", attempt_id, call.id),
                        "System-ReadGuard".to_string(),
                        TYPE_TOOL_OUTPUT.to_string(),
                        "chat/tool_output".to_string(),
                        vec![
                            ("session_id".to_string(), json!(session_id)),
                            ("attempt_id".to_string(), json!(attempt_id)),
                            ("tool_call_id".to_string(), json!(call.id)),
                            ("tool_name".to_string(), json!(call.func_name)),
                            ("tool_status".to_string(), json!("guarded")),
                            ("read_guard_status".to_string(), json!("already-covered")),
                            ("text".to_string(), json!(output)),
                        ]
                        .into_iter()
                        .collect(),
                    ));
                    continue;
                }
            }
            let registry = Arc::clone(&self.registry);
            let session_id = session_id.to_string();
            let attempt_id = attempt_id.to_string();
            let timeout_secs = self.orchestrator_config.tool_timeout_secs;
            tasks.push(tokio::spawn(async move {
                crate::tool::CURRENT_SESSION_ID
                    .scope(session_id.clone(), async move {
                        let result = tokio::time::timeout(
                            tokio::time::Duration::from_secs(timeout_secs),
                            async {
                                match registry.get(&call.func_name) {
                                    Some(tool) => tool.execute(&call.arguments).await,
                                    None => Err(format!("未注册的工具: {}", call.func_name).into()),
                                }
                            },
                        )
                        .await;
                        let (output, tool_status) = match result {
                            Ok(Ok(output)) => {
                                let status = infer_tool_status(&output);
                                (output, status)
                            }
                            Ok(Err(error)) => (format!("执行失败: {}", error), "error"),
                            Err(_) => {
                                (format!("执行超时: 超过 {} 秒限额", timeout_secs), "timeout")
                            }
                        };
                        let output_empty = output.trim().is_empty();
                        Event::new(
                            format!("output_{}_{}", attempt_id, call.id),
                            "System-Executor".to_string(),
                            TYPE_TOOL_OUTPUT.to_string(),
                            "chat/tool_output".to_string(),
                            vec![
                                ("session_id".to_string(), json!(session_id)),
                                ("attempt_id".to_string(), json!(attempt_id)),
                                ("tool_call_id".to_string(), json!(call.id)),
                                ("tool_name".to_string(), json!(call.func_name)),
                                ("tool_status".to_string(), json!(tool_status)),
                                ("output_empty".to_string(), json!(output_empty)),
                                ("text".to_string(), json!(output)),
                            ]
                            .into_iter()
                            .collect(),
                        )
                    })
                    .await
            }));
        }

        let mut outputs = guarded_outputs;
        if let Some(error) = context_tx_batch_error {
            outputs.push(Event::new(
                format!("output_{}_context_tx_batch_rejected", attempt_id),
                "System-ContextGuard".to_string(),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    (
                        "tool_call_id".to_string(),
                        json!("context_tx_batch_rejected"),
                    ),
                    ("tool_name".to_string(), json!("context_tx")),
                    ("tool_status".to_string(), json!("rejected")),
                    (
                        "context_tx_status".to_string(),
                        json!(context_tx_batch_status.as_deref().unwrap_or("rejected")),
                    ),
                    ("text".to_string(), json!(error)),
                ]
                .into_iter()
                .collect(),
            ));
        }
        for task in tasks {
            match task.await {
                Ok(output) => outputs.push(output),
                Err(error) => tracing::error!(?error, "工具任务 join 失败"),
            }
        }
        if outputs.is_empty() {
            return Err("所有工具任务都在产生结果前异常终止".into());
        }
        let mut outcome = ToolExecutionOutcome::default();
        for output in &outputs {
            if output
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("context_tx")
            {
                outcome.context_tx_succeeded = context_tx_output_succeeded(output);
            }
        }
        let output_count = outputs.len();
        for (index, output) in outputs.into_iter().enumerate() {
            if options.wake_on_output && index + 1 == output_count {
                self.bus.publish(output).await?;
            } else {
                self.store.append(output).await?;
            }
        }
        Ok(outcome)
    }

    async fn context_tx_receipt(
        &self,
        context: &ContextView,
    ) -> Result<ContextTxReceipt, DynError> {
        if context.wake.tool_name.as_deref() != Some("context_tx") {
            return Ok(ContextTxReceipt::None);
        }
        let Some(event_id) = context.wake.event_id.as_deref() else {
            return Ok(ContextTxReceipt::None);
        };
        Ok(self
            .context_engine
            .find_event(&context.session_id, event_id)
            .await?
            .as_ref()
            .map(context_tx_receipt_for_event)
            .unwrap_or(ContextTxReceipt::None))
    }

    fn record_context_inspect(
        &self,
        session_id: &str,
        attempt_id: &str,
        context: &ContextView,
        messages: &[Message],
    ) {
        let bus = Arc::clone(&self.bus);
        let event = Event::new(
            format!("context_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "System-ContextKernel".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "chat/context_inspect".to_string(),
            vec![
                ("session_id".to_string(), json!(session_id)),
                ("attempt_id".to_string(), json!(attempt_id)),
                ("text".to_string(), json!(context.sexpr)),
                ("messages".to_string(), json!(messages)),
                ("mind".to_string(), json!(context.state)),
                ("inbox".to_string(), json!(context.observations)),
                ("pressure".to_string(), json!(context.pressure)),
                ("turn_budget".to_string(), json!(context.turn_budget)),
                (
                    "model_attempt_timeout_secs".to_string(),
                    json!(self.orchestrator_config.model_attempt_timeout_secs),
                ),
                ("wake".to_string(), json!(context.wake)),
            ]
            .into_iter()
            .collect(),
        );
        tokio::spawn(async move {
            if let Err(error) = bus.publish(event).await {
                tracing::error!(?error, "记录 context_inspect 失败");
            }
        });
    }

    async fn wake_parent_if_needed(&self, event: &Event, session_id: &str) -> Result<(), DynError> {
        let Some(parent_session_id) = event
            .payload
            .get("parent_session_id")
            .and_then(|value| value.as_str())
        else {
            return Ok(());
        };
        let text = event
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        self.bus
            .publish(Event::new(
                format!(
                    "wakeup_{}_{}",
                    parent_session_id,
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                format!("Sub-Agent-{}", session_id),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    ("session_id".to_string(), json!(parent_session_id)),
                    ("source_event_id".to_string(), json!(event.id)),
                    ("sub_session_id".to_string(), json!(session_id)),
                    ("tool_name".to_string(), json!("spawn")),
                    ("text".to_string(), json!(text)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
        Ok(())
    }

    fn session_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.session_locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn read_guard(&self, session_id: &str) -> Arc<Mutex<ReadTurnGuard>> {
        self.read_turn_guards
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(ReadTurnGuard::default())))
            .clone()
    }

    pub async fn get_current_context(
        &self,
        session_id: &str,
    ) -> Result<crate::sexpr::SExpr, DynError> {
        let view = self.context_engine.build_view(session_id).await?;
        Ok(crate::sexpr::parse(&view.sexpr)?)
    }

    pub async fn get_current_context_view(
        &self,
        session_id: &str,
    ) -> Result<ContextView, DynError> {
        self.context_engine.build_view(session_id).await
    }
}

fn context_tx_output_succeeded(event: &Event) -> bool {
    if event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        != Some("context_tx")
    {
        return false;
    }
    event
        .payload
        .get("text")
        .and_then(|value| value.as_str())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .is_some_and(|value| {
            value.get("status").and_then(|status| status.as_str()) == Some("committed")
        })
}

fn infer_tool_status(text: &str) -> &'static str {
    if text.starts_with("执行失败:")
        || text.starts_with("系统报错:")
        || text.starts_with("系统报错：")
    {
        "error"
    } else if text.starts_with("执行超时:") {
        "timeout"
    } else if text.starts_with("执行拒绝:") || text.starts_with("READ_ALREADY_COVERED:") {
        "rejected"
    } else {
        "success"
    }
}

fn context_tx_receipt_for_event(event: &Event) -> ContextTxReceipt {
    if event
        .payload
        .get("tool_name")
        .and_then(|value| value.as_str())
        != Some("context_tx")
    {
        return ContextTxReceipt::None;
    }
    if context_tx_output_succeeded(event) {
        return ContextTxReceipt::Committed;
    }
    ContextTxReceipt::Failed
}

fn required_payload_str<'a>(event: &'a Event, key: &str) -> Result<&'a str, DynError> {
    event
        .payload
        .get(key)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("事件 '{}' 缺少字符串字段 '{}'", event.id, key).into())
}

fn should_force_final_for_maintenance(
    phase: &str,
    pressure: &str,
    context_tx_available: bool,
) -> bool {
    phase == "work" && pressure == "critical" && !context_tx_available
}

fn normalize_context_tx_key(session_id: &str, arguments: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(arguments).map_err(|error| format!("参数 JSON 非法: {error}"))?;
    let transaction = value
        .get("transaction")
        .and_then(|value| value.as_str())
        .ok_or("缺少 transaction 字符串")?;
    let target_session = value
        .get("session_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(session_id);
    let canonical = crate::sexpr::parse(transaction)
        .map_err(|error| format!("transaction SExpr 非法: {error}"))?
        .to_string();
    Ok(format!("{target_session}\u{0}{canonical}"))
}

#[cfg(test)]
mod tests {
    use super::{
        baseline_system_prompt, cognitive_sexpr_vm_system_prompt, render_system_contract,
        should_force_final_for_maintenance, ReadTurnGuard, AGENT_OWNED_CONTEXT_PROMPT_BASE,
    };

    #[test]
    fn system_prompt_has_a_deterministic_generated_contract_prefix() {
        let first = baseline_system_prompt();
        let second = baseline_system_prompt();
        assert_eq!(first, second);
        assert_eq!(
            first,
            format!(
                "{AGENT_OWNED_CONTEXT_PROMPT_BASE}\n\n{}",
                render_system_contract()
            )
        );
        assert!(first.contains("Runtime Reality Contract（现实契约）"));
        assert!(first.contains("Agent Epistemic Contract（认识契约）"));
        assert!(first.contains("claims-no-stronger-than-sources"));
        assert!(first.contains("不规定 Mind BODY 的结构"));
    }

    #[test]
    fn cognitive_vm_prompt_changes_identity_without_task_specific_hints() {
        let baseline = baseline_system_prompt();
        let candidate = cognitive_sexpr_vm_system_prompt();
        assert_ne!(baseline, candidate);
        assert!(baseline.contains("能够管理自身工作 Context 的 AI Agent"));
        assert!(!baseline.contains("Cognitive S-Expression Machine"));
        assert!(candidate.contains("Cognitive S-Expression Machine"));
        assert!(candidate.contains("非确定性执行周期"));
        assert!(candidate.contains("持久化符号程序与认知状态"));
        assert!(candidate.contains("适用范围、来源、反例和不确定性"));
        assert!(candidate.contains("每次响应必须明确选择"));
        assert!(candidate.contains("Runtime Reality Contract（现实契约）"));
        for leaked_task_hint in ["ALPHA", "BETA", "CHARLIE", "approved-current"] {
            assert!(!candidate.contains(leaked_task_hint));
        }
    }

    #[test]
    fn critical_pressure_with_exhausted_maintenance_budget_forces_final_reply() {
        assert!(should_force_final_for_maintenance(
            "work", "critical", false
        ));
        assert!(!should_force_final_for_maintenance(
            "work", "warning", false
        ));
        assert!(!should_force_final_for_maintenance(
            "work", "critical", true
        ));
        assert!(!should_force_final_for_maintenance(
            "context-closure",
            "critical",
            false
        ));
    }

    #[test]
    fn full_file_read_blocks_rephrased_reads_until_file_changes() {
        let mut guard = ReadTurnGuard::default();
        assert!(guard
            .reserve(r#"{"path":"src/lib.rs"}"#, "read-full")
            .is_none());
        let range_duplicate = guard
            .reserve(
                r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
                "read-range",
            )
            .unwrap();
        assert_eq!(range_duplicate.evidence_event_id, "read-full");
        let query_duplicate = guard
            .reserve(
                r#"{"path":"src/lib.rs","query":"struct App"}"#,
                "read-query",
            )
            .unwrap();
        assert_eq!(query_duplicate.evidence_event_id, "read-full");

        guard.invalidate_path_from_arguments(r#"{"path":"src/lib.rs","edits":[]}"#);
        assert!(guard
            .reserve(
                r#"{"path":"src/lib.rs","start_line":1,"end_line":20}"#,
                "read-after-edit"
            )
            .is_none());
    }

    #[test]
    fn covered_ranges_and_queries_are_deduplicated_per_path() {
        let mut guard = ReadTurnGuard::default();
        assert!(guard
            .reserve(
                r#"{"path":"src/lib.rs","start_line":10,"end_line":40}"#,
                "read-range-1"
            )
            .is_none());
        let range_duplicate = guard
            .reserve(
                r#"{"path":"src/lib.rs","start_line":15,"end_line":25}"#,
                "read-range-2",
            )
            .unwrap();
        assert_eq!(range_duplicate.evidence_event_id, "read-range-1");
        assert!(guard
            .reserve(
                r#"{"path":"src/lib.rs","start_line":41,"end_line":60}"#,
                "read-range-3"
            )
            .is_none());
        assert!(guard
            .reserve(
                r#"{"path":"src/lib.rs","query":"TODO","context_lines":2}"#,
                "read-query-1"
            )
            .is_none());
        let query_duplicate = guard
            .reserve(
                r#"{"path":"src/lib.rs","query":"todo","context_lines":2}"#,
                "read-query-2",
            )
            .unwrap();
        assert_eq!(query_duplicate.evidence_event_id, "read-query-1");
        assert!(guard
            .reserve(r#"{"path":"src/main.rs"}"#, "read-other-file")
            .is_none());
    }
}
