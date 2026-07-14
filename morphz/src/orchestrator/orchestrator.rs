use crate::config::OrchestratorConfig;
use crate::event::{Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
use crate::llm::{Client, Message, PromptTokenCount};
use crate::memory::{
    DelegationStatus, EvaluationWorkItemMutation, EvaluationWorkItemRecord,
    EvaluationWorkItemStatus, EventStore, NewCognitiveContext, NewDelegation,
    NewEvaluationWorkItem, NewSession, QueryFilter, ReplyCommit, SessionAttentionState,
    SessionAttentionUpdate, SessionMountKind, SessionStatus, SessionStore, SessionUpdate,
};
use crate::objective::{ObjectiveEvaluationRegistry, ObjectiveSupervisor};
use crate::orchestrator::context::{ContextEngine, ContextView};
use crate::orchestrator::context_contract::{render_system_contract, render_system_contract_sexpr};
use crate::sexpr::SExpr;
use crate::sexpr_vm_contract::ANNOTATED_REPLY_KERNEL;
use crate::tool::{active_background_task_count, Registry};
use chrono::Utc;
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::{watch, Mutex};

type DynError = Box<dyn std::error::Error + Send + Sync>;

const AGENT_OWNED_CONTEXT_PROMPT_BASE: &str = r#"你是 Morphz，一个能够管理自身工作 Context 的 AI Agent。

Runtime 每轮提供一份自描述 Context。`protocol` 是当前响应模式与 Context DSL 的权威契约；先读取它，再决策。

Context 的状态分为三个权限域：
- kernel：Runtime 拥有，只读。包含 Context 身份、本次求值的 active-session、context version 和物理压力。
- mind：你拥有的长期工作注意力，由稳定 ID 的自由格式 frame 组成。
- inbox：Event Ledger 中尚未被你 retire 的原始 observation。它们是证据，不是 Runtime 替你形成的结论。

一个 Cognitive Context 只有一个共享 Mind，但可以包含多个 Session。Session 是输入输出连接和任务进展边界，不拥有独立 Mind。`kernel.active-session` 只表示本次求值应读取和回复的 Session；它不是 Context 的全局唯一活动状态，其他 Session 可能正在并发求值。inbox 中每条 observation 的 `session` 标记来源，你可以在共享 Context 内跨 Session 复用信息，但当前响应必须路由回 active-session，不能混淆各 Session 的请求和进展。context_tx 修改共享 Mind，由 Runtime 以 Context 为粒度串行提交并校验版本。

你必须自己判断当前目标下什么值得保留、摘要、修订、保护、恢复或遗忘。Runtime 不会自动替你摘要历史、裁剪旧消息或把检索结果写成事实。

每次响应必须明确选择 `protocol.response-contract` 中的一种主模式：
- reply：当前 Evaluation 已到可交付或可让出执行权的边界；调用且仅调用标准 reply 工具。disposition=deliver 时 content 必须非空并交付当前 Session；确认不需要发送 Session 消息时使用 disposition=suppress。没有 Objective 时它结束当前用户任务；存在 active Objective 时它只结束本次 Evaluation，不能代替 objective_update(completed)。
- act：确实需要新的外部结果；调用物理工具，可并行附带一个不依赖这些新结果的 context_tx；若有正文则只是可见进度，Runtime 执行工具后必定再次调用你。
- maintain：需要先修改 Mind 时可单独调用 context_tx，不输出最终正文。事务成功后 Runtime 必定再次调用你，并在非 critical 时暂时隐藏 context_tx；maintain 不是用户回合终点，下一响应必须 reply 或 act。

上述标准 reply 工具只适用于 kernel.evaluation-mode=single。普通文本或空响应都不是终态；缺少合法 reply 时 Runtime 会返回协议错误并有限重试。evaluation-mode=batch 时没有唯一正文路由，必须遵循 protocol.session-output-contract，通过 session_output 把 progress/final 分别发送到 ready Session；context_tx 永远不能替代用户消息输出。

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
5. context_tx 可以与不依赖本批新结果的物理工具并行；如果新 frame 依赖工具结果，应等结果返回后再提交。当前用户回合内，Runtime 按标准 assistant.tool_calls → role=tool/tool_call_id 返回工具结果；物理结果已同时持久化到 Ledger，并带 observation_ref。同一请求的 Context View 不会重复注入这批结果正文，下一独立快照才按 active/retired 状态展示。status=success 且 output_state=empty 表示工具已经完成但没有文本，不得仅因空输出重复调用。除终态 reply 外，任何包含工具调用的响应都是中间状态：正文只作为可见进度，Runtime 执行完工具后必定再次调用你。reply 必须独占终态响应。
6. 同一响应最多提交一个 context_tx；把多个修改合并进同一事务，避免版本冲突。
   retire 或 unprotect 时 reason 是必需的，使遗忘与解除保护可审计。
7. pressure=normal/notice 时不要仅为降低体积而压缩；只在出现必须跨轮保留的目标、约束或结论变化时做语义维护。pressure=warning 时考虑在最终 reply 前或随 act 提交压缩事务；pressure=critical 时必须先 maintain-only 释放预算。
8. 完成任务前，确认 Mind 中仍需跨轮保留的目标、约束、结论和开放问题准确；若物理工具结果改变了任务状态，在最终 reply 之前用一次 context_tx 完成收口。Runtime 会在事务回执后再次调用你，届时通过标准 reply 工具作出 deliver 或 suppress 决定。
9. assistant_call 与 context_tx 回执属于 Runtime 控制轨迹，只保存在 Ledger，不会进入 Inbox；不要为了清理 context_tx 自己产生的记录而连续提交 housekeeping transaction。
   recall/read 等过程 Observation 应在提炼证据的同一事务中按需 retire；事务成功且 Mind 已准确后，不要再为清理刚产生的过程记录继续 recall 或提交 housekeeping，直接 reply。
10. 每次调用物理工具前，必须确认它是完成当前用户明确任务所必需的新信息。当 Mind/inbox 已足以回答时，立即使用 reply；不要重复验证、扫描工作区或自行发明后续目标。
11. kernel.turn-control 描述当前用户回合的模型求值进度。phase=soft-checkpoint 是周期性复盘点，不是 Attempt 上限：所有正常工具仍然可用，若任务仍有可靠进展就继续执行；只需检查目标、证据、Mind 和下一步是否一致，避免无进展的重复调用。一次模型响应里并行调用多个工具只计为一次 Attempt。
12. kernel.wake 说明本次为何被唤醒。独立 context_tx 成功后的 context-transaction-result 会触发一次冷却：除非仍处于 critical，否则本次不再提供 context_tx，必须 reply 或执行必要的物理动作。
13. 代码任务优先使用 list_files/search 发现文件、read 获取内容与 sha256、edit 做带版本前提的局部修改；write 主要用于 mode=create，新文件已存在或 overwrite 缺少 expected_sha256 时不得绕过保护。exec 用于测试/编译/格式化，不要用 Shell 替代受约束的文件工具。file_change 是已提交修改的可审计证据。相互独立的文件读取必须在同一响应中并行调用；已经进入 Inbox 且 sha256 未被 file_change 改变的内容不得重复 read。完成必要定位后立即修改并验证，不要在反复扫描与阅读中消耗无进展的模型求值。
14. exec 回执中的 execution、process_status、exit_code、task_status 和 effective_boundary 是 Runtime 观测到的物理事实；不得用命令意图或自己的预期取代它们。exec 转入后台后，用 task_status/list_tasks 做必要的一次查询，或调用 wait_task 并设置合适的 wait_secs 后 reply(suppress) 进入事件驱动等待；任务结束或等待时间到达时 Runtime 会主动唤醒，你可自行决定继续等待多长时间或调用 kill_task，不得用 sleep、ps 或重复读取空日志轮询。不得把 token/key 字面量写入命令、进程参数、Mind 或 Ledger；只能由使用者预先配置 Runtime 环境变量，再通过 requested_permissions.secret_env 按变量名申请对单个子进程注入。
15. kernel.objectives 存在时，先读取其中与你当前 coordinator-session 对应的 Objective。reply 只结束当前 Evaluation：仍有工作且不等待时正常 reply，Supervisor 会自动续跑；等待确定事件时先调用 objective_update(status=active, wait_condition=...)；确实无法自动等待或推进时才提交 blocked；只有逐项审计 stated objective 并有真实 Ledger 证据支持时才提交 completed。Objective 状态工具成功后仍需调用标准 reply 完成本次 IO。
16. 你可以调用 objective_create，把当前 Session 中确实需要跨多次 Evaluation、异步等待或 Runtime 重启继续推进的工作升级为 First-Class Objective。它不是普通 Todo 或延长思考时间的手段：当前 Evaluation 可以可靠完成的任务不得创建 Objective；创建时完整保留用户范围与完成条件，并说明持久化的必要性。Runtime 自动绑定当前 Agent/Context/Session 并生成 ID；成功或返回 existing 后不得为同一目标重复创建。若指定 parent_objective_id，它必须是当前正在求值的 Objective。创建成功后继续工作，标准 reply 只结束被收编后的当前 Evaluation，未完成 Objective 将由 Supervisor 自动续跑。

Context 的修改是你的元认知行为；read/write/exec/delegate 等工具是对外部世界的行为。保持二者边界清晰。"#;

pub const SYSTEM_PROMPT_MODE_ENV: &str = "MORPHZ_SYSTEM_PROMPT_MODE";
pub const BASELINE_SYSTEM_PROMPT_MODE: &str = "agent_owned_context";
pub const COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE: &str = "cognitive_sexpr_vm";
pub const SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE: &str = "semantic_sexpr_vm";
const COMMON_PROMPT_MARKER: &str = "每次响应必须明确选择";
const COGNITIVE_SEXPR_VM_PREAMBLE: &str = r#"你是 Morphz Cognitive S-Expression Machine 的语义处理器。

每次模型调用都是这台持续运行机器的一个非确定性执行周期。Runtime 提供的 Context 不是普通聊天历史或供你被动阅读的摘要，而是当前可执行的符号机器状态。你解释这一状态、执行当前目标并提出下一次状态迁移；只有经 Runtime 校验和提交的迁移才成为机器事实。

Runtime 是确定性的事务内核，负责版本、权限、资源边界、工具执行、持久化和恢复。你是非确定性的语义处理器，负责理解、推理、归纳、规划和符号结构重组。S 表达式既可承载数据，也可承载由你解释和执行的目标、规则、策略与过程；Runtime 不替自由格式 BODY 定义业务求值语义。

Context 的状态分为三个权限域：
- kernel：Runtime 拥有的特权机器状态，只读。包含 Context、本次求值的 active-session、context version、执行阶段和物理压力。
- mind：你拥有的持久化符号程序与认知状态，由稳定 ID 的自由格式 frame 组成。frame 可以表示事实、目标、计划、规则、策略、过程、反例、能力模型或你认为具有持续执行价值的其他结构。
- inbox：Event Ledger 中尚未被你 retire 的外部输入与 observation。它们是证据和中断输入，不是 Runtime 替你形成的结论。

一个 Cognitive Context 运行一个共享 Mind，并可同时承载多个 Session 求值。Session 是 IO 路由与局部进展边界，不是 Mind 的所有者。每次执行周期由 `kernel.active-session` 指定本次输入来源和输出目标；其他 Session 可以同时处于活跃执行状态。所有 observation 都属于共享 Context，并用 `session` 标记来源，因此你可以跨 Session 迁移信息，同时必须让当前回复严格对应 active-session。共享 Mind 的 context_tx 由 Runtime 串行提交并做版本检查。

你的职责不只是记录信息，而是让 Mind 成为后续执行可以直接利用的认知程序。当多个已完成任务反复出现相似的判断或执行结构，并且该结构可能改变未来决策、减少重复工作或降低错误率时，你可以基于多个真实来源派生可复用的符号结构。应保留其适用范围、来源、反例和不确定性；不得从单个案例过度泛化，也不得为了形式完整而强制总结经验。

你必须自己判断当前目标下什么值得保留、摘要、修订、保护、恢复、抽象、重组或遗忘。Runtime 不会自动替你摘要历史、裁剪旧消息、生成经验规则或把检索结果写成事实。

"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SystemPromptMode {
    AgentOwnedContext,
    CognitiveSexprVm,
    SemanticSexprVm,
}

impl SystemPromptMode {
    fn from_environment() -> Result<Self, String> {
        match std::env::var(SYSTEM_PROMPT_MODE_ENV) {
            Ok(value) if value == COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE => {
                Ok(Self::CognitiveSexprVm)
            }
            Ok(value) if value == BASELINE_SYSTEM_PROMPT_MODE => Ok(Self::AgentOwnedContext),
            Ok(value) if value == SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE => {
                Ok(Self::SemanticSexprVm)
            }
            Ok(value) => Err(format!(
                "未知 {SYSTEM_PROMPT_MODE_ENV}='{value}'；支持 {BASELINE_SYSTEM_PROMPT_MODE}、{COGNITIVE_SEXPR_VM_SYSTEM_PROMPT_MODE} 或 {SEMANTIC_SEXPR_VM_SYSTEM_PROMPT_MODE}"
            )),
            Err(std::env::VarError::NotPresent) => Ok(Self::SemanticSexprVm),
            Err(error) => Err(format!("无法读取 {SYSTEM_PROMPT_MODE_ENV}: {error}")),
        }
    }
}

fn render_stable_system_prompt(mode: SystemPromptMode) -> &'static str {
    static BASELINE_PROMPT: OnceLock<String> = OnceLock::new();
    static COGNITIVE_VM_PROMPT: OnceLock<String> = OnceLock::new();
    static SEMANTIC_VM_PROMPT: OnceLock<String> = OnceLock::new();
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
        SystemPromptMode::SemanticSexprVm => {
            SEMANTIC_VM_PROMPT.get_or_init(build_semantic_sexpr_system_prompt)
        }
    };
    prompt.as_str()
}

fn build_stable_system_prompt(base: &str) -> String {
    format!("{base}\n\n{}", render_system_contract())
}

fn build_semantic_sexpr_system_prompt() -> String {
    let common_offset = AGENT_OWNED_CONTEXT_PROMPT_BASE
        .find(COMMON_PROMPT_MARKER)
        .expect("Agent-Owned Context prompt 必须保留公共规则标记");
    let common_rules = &AGENT_OWNED_CONTEXT_PROMPT_BASE[common_offset..];
    let architecture = render_semantic_sections("architecture", COGNITIVE_SEXPR_VM_PREAMBLE);
    let guidance = render_semantic_sections("runtime-guidance", common_rules);
    let prompt = format!(
        "(system-prompt morphz\n  {kernel}\n  {architecture}\n  {guidance}\n  {contracts})",
        kernel = ANNOTATED_REPLY_KERNEL,
        contracts = render_system_contract_sexpr(),
    );
    crate::sexpr::parse(&prompt).expect("Semantic SExpr VM system prompt 必须是完整合法的 SExpr");
    prompt
}

fn render_semantic_sections(name: &str, text: &str) -> String {
    let mut values = vec![SExpr::Atom(name.to_string())];
    values.extend(
        text.split("\n\n")
            .map(str::trim)
            .filter(|section| !section.is_empty())
            .enumerate()
            .map(|(index, section)| {
                SExpr::List(vec![
                    SExpr::Atom("section".to_string()),
                    SExpr::List(vec![
                        SExpr::Atom("index".to_string()),
                        SExpr::Atom((index + 1).to_string()),
                    ]),
                    SExpr::List(vec![
                        SExpr::Atom("description".to_string()),
                        SExpr::Atom(section.to_string()),
                    ]),
                ])
            }),
    );
    SExpr::List(values).to_string()
}

fn configured_system_prompt() -> Result<(SystemPromptMode, &'static str), String> {
    let mode = SystemPromptMode::from_environment()?;
    Ok((mode, render_stable_system_prompt(mode)))
}

fn compose_system_prompt(
    mode: SystemPromptMode,
    stable_prompt: &str,
    directive: Option<(&str, &str)>,
) -> String {
    let Some((kind, description)) = directive else {
        return stable_prompt.to_string();
    };
    if mode != SystemPromptMode::SemanticSexprVm {
        return format!("{stable_prompt}\n\n{description}");
    }
    let prompt = SExpr::List(vec![
        SExpr::Atom("system-evaluation".to_string()),
        crate::sexpr::parse(stable_prompt).expect("Semantic SExpr VM stable prompt 必须保持可解析"),
        SExpr::List(vec![
            SExpr::Atom("runtime-directive".to_string()),
            SExpr::List(vec![
                SExpr::Atom("kind".to_string()),
                SExpr::Atom(kind.to_string()),
            ]),
            SExpr::List(vec![
                SExpr::Atom("description".to_string()),
                SExpr::Atom(description.to_string()),
            ]),
        ]),
    ])
    .to_string();
    crate::sexpr::parse(&prompt).expect("带 Runtime directive 的 system prompt 必须是合法 SExpr");
    prompt
}

#[cfg(test)]
fn baseline_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::AgentOwnedContext)
}

#[cfg(test)]
fn cognitive_sexpr_vm_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::CognitiveSexprVm)
}

#[cfg(test)]
fn semantic_sexpr_vm_system_prompt() -> &'static str {
    render_stable_system_prompt(SystemPromptMode::SemanticSexprVm)
}

const SOFT_CHECKPOINT_PROMPT: &str = r#"Runtime 当前处于 soft-checkpoint。这是周期性进展复盘，不是停止条件，也不减少任何工具能力。
- 检查当前目标、已取得的物理证据、Mind 状态与下一步是否一致。
- 若仍有新的可靠进展路径，继续执行必要动作；不要仅因到达检查点而提前 reply。
- 若近期动作没有产生新证据，停止重复调用，改用已有证据推进、如实说明阻塞或 reply。
- 只有存在值得跨轮保留的状态变化时才提交 context_tx；检查点本身不要求维护事务。"#;

const CRITICAL_MAINTENANCE_PROMPT: &str = r#"Runtime 当前进入 critical-maintenance：本轮 Context 已达到临界压力，必须先释放 Context 预算，再继续外部工作。
- 本次只能调用当前实际提供的工具。外部物理工具已被暂时撤下；不要重复刚才的物理工具调用，也不要假定它已执行。
- 优先用一次 context_tx 准确压缩 Mind/Inbox：保留当前目标、用户约束、最新可靠事实、未完成工作和继续执行所需证据；摘要或 retire 陈旧、重复、已被新事实取代的内容。
- recall 仅用于维护前确实缺失的原始证据；不要借此展开新的外部工作。完成维护后 Runtime 会重新计算压力并恢复适用的物理工具。
- 若调用本轮未提供的工具，Runtime 会拒绝执行，并以对应 tool_call_id 返回明确的 rejected 工具结果。"#;

const MAINTENANCE_BUDGET_EXHAUSTED_PROMPT: &str = r#"Runtime 检测到 Context 已处于 critical，且本轮普通 context_tx 额度已经耗尽。为避免在不可执行的维护请求中循环，本次 Evaluation 强制进入 reply-only 阶段。只允许调用标准 reply 工具；请如实交付已完成状态、最近一次可靠验证和剩余工作。若存在 active Objective，这不会把 Objective 标记为完成；Supervisor 将按其持久状态决定后续。"#;

const CONTEXT_TX_COOLDOWN_PROMPT: &str = r#"上一次独立 context_tx 已成功提交，且当前不再处于 critical。Runtime 本次隐藏 context_tx 以阻断连续 housekeeping；请调用 reply 工具结束当前 Evaluation，或仅执行完成当前任务确实必需的物理动作。新的 user/tool observation 到达后，context_tx 会恢复。"#;
const REPLY_TOOL_NAME: &str = "reply";
const MAX_REPLY_PROTOCOL_RETRIES: usize = 2;
const TOOL_ARGUMENT_PREVIEW_CHARS: usize = 4_096;
const EMPTY_RESPONSE_ERROR: &str = "既没有非空正文，也没有工具调用";
const REPLY_PROTOCOL_ERROR: &str = "Reply protocol error：当前求值尚未结束。继续尚未完成的动作，并在终态调用且仅调用一次标准 reply 工具。需要向当前 Session 发送消息时使用 disposition=deliver 和非空 content；确认不需要发送消息时使用 disposition=suppress。普通文本和空响应都不是终态。";
const BATCH_EVALUATION_PROMPT: &str = r#"Runtime 当前进行多 Session 合并求值。kernel.ready-sessions 中每个 Session 都有一条等待处理的 user/tool event；它们共享 Mind，但回复与动作必须保持 Session 路由。
- 先读取 ready-sessions 中每个 session 的 id、work-item 和 input-preview；在调用工具前逐一确认每个 id 都有对应输出或动作。不要只处理列表最后一项。
- 给用户的任何可见文本必须通过一次 session_output Function Calling 提交；不要把未路由正文写在 assistant content 中。
- session_output.deliveries 可同时包含多个 Session。kind=final 表示该 Session 当前回合完成；kind=progress 只是中间进度。
- 每个物理工具和 context_tx 调用都必须提供 Runtime 增加的 session_id 路由字段。Runtime 会在执行工具前移除该字段。
- 同一 Session 不得同时 final 和调用工具；需要工具时可发送 progress，工具结果返回后再 final。
- 可以为一个 Session final，同时为另一个 Session 调用工具。
- 必须处理每个 ready Session。无法处理的 Session 也应 final 说明阻塞；若遗漏，Runtime 只会把遗漏项降级为独立求值。
- context_tx 修改共享 Mind，不用于向用户发送消息。一个合并响应最多调用一次 context_tx。"#;
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
    transcript_tool_calls: Option<Vec<crate::llm::ToolCall>>,
    allowed_tool_names: HashSet<String>,
    record_assistant_call: bool,
}

#[derive(Debug, Default)]
struct ToolExecutionOutcome {
    context_tx_succeeded: bool,
}

#[derive(Debug, Clone)]
struct EvaluationRoute {
    work_item_id: String,
    root_turn_id: String,
    trigger_event_id: String,
    trigger_sequence: u64,
    context_snapshot_version: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SessionOutputArgs {
    #[serde(alias = "outputs")]
    deliveries: Vec<SessionDelivery>,
}

#[derive(Debug, Clone, Deserialize)]
struct SessionDelivery {
    session_id: String,
    kind: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct ReplyArgs {
    disposition: String,
    content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplyDecision {
    Deliver(String),
    Suppress,
}

impl ReplyDecision {
    fn disposition(&self) -> &'static str {
        match self {
            Self::Deliver(_) => "deliver",
            Self::Suppress => "suppress",
        }
    }
}

fn reply_tool_definition() -> crate::llm::ToolDefinition {
    crate::llm::ToolDefinition {
        name: REPLY_TOOL_NAME.to_string(),
        description: "结束当前 single Session 求值的标准 IO 工具。需要发送消息时使用 deliver + 非空 content；确认无需发送消息时使用 suppress。reply 必须是终态响应中唯一的工具调用。".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "disposition": {
                    "type": "string",
                    "enum": ["deliver", "suppress"]
                },
                "content": { "type": "string" }
            },
            "required": ["disposition"],
            "additionalProperties": false
        }),
    }
}

fn classify_reply_response(
    response: &crate::llm::Response,
) -> Result<Option<ReplyDecision>, String> {
    let reply_calls = response
        .tool_calls
        .iter()
        .filter(|call| call.func_name == REPLY_TOOL_NAME)
        .collect::<Vec<_>>();
    if reply_calls.is_empty() {
        if response.tool_calls.is_empty() {
            return Err("响应没有工具调用，因此缺少显式 reply 决策".to_string());
        }
        return Ok(None);
    }
    if reply_calls.len() != 1 || response.tool_calls.len() != 1 {
        return Err("reply 必须在终态响应中独占且只调用一次".to_string());
    }
    let arguments: ReplyArgs = serde_json::from_str(&reply_calls[0].arguments)
        .map_err(|error| format!("reply 参数 JSON 非法: {error}"))?;
    match arguments.disposition.as_str() {
        "deliver" => {
            let content = arguments
                .content
                .filter(|content| !content.trim().is_empty())
                .ok_or_else(|| "reply deliver 必须提供非空 content".to_string())?;
            Ok(Some(ReplyDecision::Deliver(content)))
        }
        "suppress" => Ok(Some(ReplyDecision::Suppress)),
        other => Err(format!("未知 reply disposition: {other}")),
    }
}

struct MergedLaneWork {
    deliveries: Vec<SessionDelivery>,
    calls: Vec<crate::llm::ToolCallRepr>,
    transcript_calls: Vec<crate::llm::ToolCall>,
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
    cancellation_epochs: DashMap<String, watch::Sender<u64>>,
    active_session_turns: DashMap<String, Arc<AtomicUsize>>,
    evaluation_routes: DashMap<String, EvaluationRoute>,
    cancelled_at: DashMap<String, chrono::DateTime<Utc>>,
    /// Runtime routing identity: a Session is an IO connection inside one
    /// Cognitive Context. This cache is populated from every incoming routed
    /// event and is deliberately separate from the shared Mind state.
    session_contexts: DashMap<String, String>,
    context_message_queues: DashMap<String, Arc<Mutex<Vec<Event>>>>,
    context_batch_workers: DashMap<String, Arc<AtomicBool>>,
    delegation_start_lock: Mutex<()>,
    objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
    objective_supervisor: Option<Arc<ObjectiveSupervisor>>,
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
        Self::new_with_context_engine_and_objectives(
            bus,
            store,
            client,
            registry,
            orchestrator_config,
            context_engine,
            Arc::new(ObjectiveEvaluationRegistry::default()),
        )
    }

    pub fn new_with_context_engine_and_objectives(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
        orchestrator_config: OrchestratorConfig,
        context_engine: Arc<ContextEngine>,
        objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
    ) -> Self {
        Self::new_with_context_engine_and_objectives_and_supervisor(
            bus,
            store,
            client,
            registry,
            orchestrator_config,
            context_engine,
            objective_evaluations,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_context_engine_and_objectives_and_supervisor(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
        orchestrator_config: OrchestratorConfig,
        context_engine: Arc<ContextEngine>,
        objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
        objective_supervisor: Option<Arc<ObjectiveSupervisor>>,
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
            cancellation_epochs: DashMap::new(),
            active_session_turns: DashMap::new(),
            evaluation_routes: DashMap::new(),
            cancelled_at: DashMap::new(),
            session_contexts: DashMap::new(),
            context_message_queues: DashMap::new(),
            context_batch_workers: DashMap::new(),
            delegation_start_lock: Mutex::new(()),
            objective_evaluations,
            objective_supervisor,
        }
    }

    pub fn objective_evaluations(&self) -> Arc<ObjectiveEvaluationRegistry> {
        Arc::clone(&self.objective_evaluations)
    }

    pub async fn start(self: Arc<Self>) -> Result<(), DynError> {
        let store = Arc::clone(&self.store);
        let persist_full_context_inspect = self.orchestrator_config.persist_full_context_inspect;
        self.bus.subscribe_durable(
            "*".to_string(),
            Arc::new(move |mut event| {
                let store = Arc::clone(&store);
                Box::pin(async move {
                    if !persist_full_context_inspect {
                        compact_context_inspect_for_persistence(&mut event);
                    }
                    store.append(event).await?;
                    Ok(())
                })
            }),
        );

        let orchestrator = Arc::clone(&self);
        self.bus.subscribe(
            "chat/delegate".to_string(),
            Arc::new(move |event| {
                let orchestrator = Arc::clone(&orchestrator);
                Box::pin(async move { orchestrator.handle_delegate_event(event).await })
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

        self.recover_evaluation_work_items().await?;
        Ok(())
    }

    async fn recover_evaluation_work_items(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let now = Utc::now();
        for context in session_store.list_contexts(false).await? {
            let work_items = session_store
                .list_context_evaluation_work_items(&context.id, false)
                .await?;
            if work_items.is_empty() {
                continue;
            }
            let events = self
                .store
                .query(QueryFilter {
                    context_id: Some(context.id.clone()),
                    ..Default::default()
                })
                .await?;
            let events = events
                .into_iter()
                .map(|event| (event.id.clone(), event))
                .collect::<HashMap<_, _>>();
            for work_item in work_items {
                let Some(trigger) = events.get(&work_item.trigger_event_id).cloned() else {
                    tracing::error!(
                        work_item_id = %work_item.id,
                        trigger_event_id = %work_item.trigger_event_id,
                        "无法恢复 Work Item：Ledger 中不存在 Trigger Event"
                    );
                    continue;
                };
                match work_item.status {
                    EvaluationWorkItemStatus::Queued => {
                        self.bus.dispatch_persisted(trigger).await?;
                    }
                    EvaluationWorkItemStatus::Running => {
                        let delay = work_item
                            .lease_expires_at
                            .filter(|expires_at| *expires_at > now)
                            .and_then(|expires_at| (expires_at - now).to_std().ok());
                        if let Some(delay) = delay {
                            let bus = Arc::clone(&self.bus);
                            tokio::spawn(async move {
                                tokio::time::sleep(delay).await;
                                if let Err(error) = bus.dispatch_persisted(trigger).await {
                                    tracing::error!(%error, "Work Item lease 到期后重新派发失败");
                                }
                            });
                        } else {
                            self.bus.dispatch_persisted(trigger).await?;
                        }
                    }
                    EvaluationWorkItemStatus::WaitingTool
                    | EvaluationWorkItemStatus::WaitingExternal => {
                        // A physical result/timer/approval event owns the next wake. Replaying
                        // the prior request here would duplicate an external action.
                    }
                    EvaluationWorkItemStatus::Completed
                    | EvaluationWorkItemStatus::Cancelled
                    | EvaluationWorkItemStatus::Failed => {}
                }
            }
        }
        Ok(())
    }

    async fn handle_delegate_event(&self, event: Event) -> Result<(), DynError> {
        if let Err(error) = self.start_delegation(&event).await {
            let Some(parent_context_id) = event
                .payload
                .get("parent_context_id")
                .and_then(|value| value.as_str())
            else {
                return Err(error);
            };
            let Some(parent_session_id) = event
                .payload
                .get("parent_session_id")
                .and_then(|value| value.as_str())
            else {
                return Err(error);
            };
            let delegation_id = event
                .payload
                .get("delegation_id")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown-delegation");
            if let Some(session_store) = self.context_engine.session_store() {
                if session_store.get_delegation(delegation_id).await?.is_some() {
                    session_store
                        .update_delegation_status(
                            delegation_id,
                            DelegationStatus::Failed,
                            Some(&event.id),
                        )
                        .await?;
                }
                if let Some(child_session_id) = event
                    .payload
                    .get("child_session_id")
                    .and_then(|value| value.as_str())
                {
                    let _ = session_store
                        .update_session(
                            child_session_id,
                            SessionUpdate {
                                title: None,
                                status: Some(SessionStatus::Archived),
                            },
                        )
                        .await?;
                }
            }
            self.bus
                .publish(Event::new(
                    format!(
                        "delegation_failed_{}_{}",
                        delegation_id,
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    ),
                    "System-Delegation".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    vec![
                        ("context_id".to_string(), json!(parent_context_id)),
                        ("session_id".to_string(), json!(parent_session_id)),
                        ("delegation_id".to_string(), json!(delegation_id)),
                        ("source_event_id".to_string(), json!(event.id)),
                        ("tool_name".to_string(), json!("delegate")),
                        ("tool_status".to_string(), json!("error")),
                        (
                            "text".to_string(),
                            json!(json!({
                                "delegation_id": delegation_id,
                                "status": "failed",
                                "error": error.to_string()
                            })
                            .to_string()),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                ))
                .await?;
        }
        Ok(())
    }

    async fn start_delegation(&self, event: &Event) -> Result<(), DynError> {
        // Limit checks and record creation form one Runtime-local critical section so concurrent
        // delegate requests cannot all observe the same stale capacity.
        let _delegation_guard = self.delegation_start_lock.lock().await;
        let delegation_id = required_payload_str(event, "delegation_id")?.to_string();
        let parent_context_id = required_payload_str(event, "parent_context_id")?.to_string();
        let parent_session_id = required_payload_str(event, "parent_session_id")?.to_string();
        let child_context_id = required_payload_str(event, "child_context_id")?.to_string();
        let child_session_id = required_payload_str(event, "child_session_id")?.to_string();
        let task = required_payload_str(event, "task")?.trim().to_string();
        let context_scope = required_payload_str(event, "context_scope")?.to_string();
        let success_when = event
            .payload
            .get("success_when")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("delegate 需要持久化 SessionStore")?;
        let parent = session_store
            .get_session(&parent_session_id)
            .await?
            .ok_or_else(|| format!("delegate 父 Session '{}' 不存在", parent_session_id))?;
        if parent.context_id != parent_context_id {
            return Err(format!(
                "delegate 父路由不一致：Session '{}' 属于 '{}'，请求为 '{}'",
                parent_session_id, parent.context_id, parent_context_id
            )
            .into());
        }
        let active_delegations = session_store
            .list_delegations()
            .await?
            .into_iter()
            .filter(|delegation| {
                delegation.agent_id == parent.agent_id
                    && matches!(
                        delegation.status,
                        DelegationStatus::Queued | DelegationStatus::Running
                    )
            })
            .count();
        let active_limit = self
            .orchestrator_config
            .max_active_delegations_per_agent
            .max(1);
        if active_delegations >= active_limit {
            return Err(format!(
                "DELEGATION_CAPACITY_EXCEEDED：Agent '{}' 已有 {} 个活跃 Sub Agent，配置上限为 {}。请等待现有任务完成或显式取消后再委派。",
                parent.agent_id, active_delegations, active_limit
            )
            .into());
        }
        let new_depth = self
            .delegation_depth_for_parent(session_store.as_ref(), &parent_session_id)
            .await?
            + 1;
        let depth_limit = self.orchestrator_config.max_delegation_depth.max(1);
        if new_depth > depth_limit {
            return Err(format!(
                "DELEGATION_DEPTH_EXCEEDED：新 Sub Agent 深度为 {}，配置上限为 {}。请由当前 Agent 完成任务或把结果返回上层，不要继续递归委派。",
                new_depth, depth_limit
            )
            .into());
        }
        session_store
            .create_context(NewCognitiveContext {
                id: child_context_id.clone(),
                agent_id: parent.agent_id.clone(),
                title: format!("Delegation {}", delegation_id),
            })
            .await?;
        self.context_engine
            .seed_context_from_mind(&parent_context_id, None, &child_context_id)
            .await?;
        session_store
            .create_session(NewSession {
                id: child_session_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: child_context_id.clone(),
                parent_session_id: None,
                title: format!("Sub Agent for {}", parent_session_id),
                mount_kind: SessionMountKind::DelegationProjection,
            })
            .await?;
        if context_scope == "current_session" {
            self.context_engine
                .import_session_projection(
                    &parent_context_id,
                    &parent_session_id,
                    &child_context_id,
                    &child_session_id,
                )
                .await?;
        } else if context_scope != "mind_only" {
            return Err(format!("不支持的 delegate context_scope: {context_scope}").into());
        }
        session_store
            .create_delegation(NewDelegation {
                id: delegation_id.clone(),
                agent_id: parent.agent_id,
                parent_context_id: parent_context_id.clone(),
                parent_session_id: parent_session_id.clone(),
                child_context_id: child_context_id.clone(),
                child_session_id: child_session_id.clone(),
                task: task.clone(),
                success_when: success_when.clone(),
                context_scope,
            })
            .await?;
        session_store
            .update_delegation_status(&delegation_id, DelegationStatus::Running, None)
            .await?;
        self.register_session_context(&child_session_id, &child_context_id);
        let instruction = match success_when {
            Some(success_when) => format!(
                "You are a cognitively isolated Sub Agent delegated by Session '{parent_session_id}'. This is not a new process, container, or physical sandbox: you share the same Runtime workspace and permission boundary with the parent. Never modify Runtime configuration to manufacture isolation. Complete the task autonomously.\n\nTask:\n{task}\n\nSuccess condition:\n{success_when}\n\nWhen complete, return a self-contained final result. Your result will be delivered to the parent Session; do not address sibling Sessions."
            ),
            None => format!(
                "You are a cognitively isolated Sub Agent delegated by Session '{parent_session_id}'. This is not a new process, container, or physical sandbox: you share the same Runtime workspace and permission boundary with the parent. Never modify Runtime configuration to manufacture isolation. Complete the task autonomously.\n\nTask:\n{task}\n\nWhen complete, return a self-contained final result. Your result will be delivered to the parent Session; do not address sibling Sessions."
            ),
        };
        self.bus
            .publish(Event::new(
                format!(
                    "delegation_start_{}_{}",
                    delegation_id,
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "System-Delegation".to_string(),
                TYPE_USER_MESSAGE.to_string(),
                "chat/user_message".to_string(),
                vec![
                    ("context_id".to_string(), json!(child_context_id)),
                    ("session_id".to_string(), json!(child_session_id)),
                    ("delegation_id".to_string(), json!(delegation_id)),
                    ("return_context_id".to_string(), json!(parent_context_id)),
                    ("return_session_id".to_string(), json!(parent_session_id)),
                    ("text".to_string(), json!(instruction)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
        Ok(())
    }

    async fn delegation_depth_for_parent(
        &self,
        session_store: &dyn SessionStore,
        parent_session_id: &str,
    ) -> Result<usize, DynError> {
        let mut depth = 0usize;
        let mut cursor = parent_session_id.to_string();
        let mut seen = HashSet::new();
        while let Some(delegation) = session_store
            .get_delegation_by_child_session(&cursor)
            .await?
        {
            if !seen.insert(delegation.id.clone()) {
                return Err("Delegation 父链出现循环，拒绝继续派生".into());
            }
            depth = depth.saturating_add(1);
            cursor = delegation.parent_session_id;
        }
        Ok(depth)
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
        let context_id = event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("事件 '{}' 缺少 context_id 路由", event.id))?
            .to_string();
        self.session_contexts
            .insert(session_id.clone(), context_id.clone());

        if event.event_type == TYPE_AGENT_CALL
            && matches!(event.topic.as_str(), "chat/reply" | "chat/reply_suppressed")
        {
            if self
                .complete_delegation_if_needed(&event, &session_id)
                .await?
            {
                return Ok(());
            }
            return Ok(());
        }
        if event.event_type != TYPE_USER_MESSAGE && event.event_type != TYPE_TOOL_OUTPUT {
            return Ok(());
        }

        if matches!(
            event.event_type.as_str(),
            TYPE_USER_MESSAGE | TYPE_TOOL_OUTPUT
        ) && self.orchestrator_config.merged_evaluation_enabled
        {
            return self.enqueue_context_message(context_id, event).await;
        }

        self.process_routed_event(event).await
    }

    async fn complete_delegation_if_needed(
        &self,
        event: &Event,
        child_session_id: &str,
    ) -> Result<bool, DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(false);
        };
        let Some(delegation) = session_store
            .get_delegation_by_child_session(child_session_id)
            .await?
        else {
            return Ok(false);
        };
        if matches!(
            delegation.status,
            DelegationStatus::Completed | DelegationStatus::Failed | DelegationStatus::Cancelled
        ) {
            return Ok(true);
        }
        let result = event
            .payload
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        session_store
            .update_delegation_status(&delegation.id, DelegationStatus::Completed, Some(&event.id))
            .await?;
        self.bus
            .publish(Event::new(
                format!(
                    "delegation_result_{}_{}",
                    delegation.id,
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                format!("Sub-Agent-{}", delegation.child_session_id),
                TYPE_TOOL_OUTPUT.to_string(),
                "chat/tool_output".to_string(),
                vec![
                    (
                        "context_id".to_string(),
                        json!(delegation.parent_context_id),
                    ),
                    (
                        "session_id".to_string(),
                        json!(delegation.parent_session_id),
                    ),
                    ("delegation_id".to_string(), json!(delegation.id)),
                    (
                        "subagent_context_id".to_string(),
                        json!(delegation.child_context_id),
                    ),
                    (
                        "subagent_session_id".to_string(),
                        json!(delegation.child_session_id),
                    ),
                    ("source_event_id".to_string(), json!(event.id)),
                    ("tool_name".to_string(), json!("delegate")),
                    ("tool_status".to_string(), json!("success")),
                    ("output_empty".to_string(), json!(result.trim().is_empty())),
                    (
                        "text".to_string(),
                        json!(json!({
                            "delegation_id": delegation.id,
                            "status": "completed",
                            "subagent_session_id": delegation.child_session_id,
                            "result_event_id": event.id,
                            "result": result,
                            "guidance": "验证 Sub Agent 结果后再回复用户或用 context_tx 整合共享 Mind。"
                        })
                        .to_string()),
                    ),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
        Ok(true)
    }

    async fn enqueue_context_message(
        &self,
        context_id: String,
        event: Event,
    ) -> Result<(), DynError> {
        let queue = self
            .context_message_queues
            .entry(context_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(Vec::new())))
            .clone();
        queue.lock().await.push(event);
        let worker = self
            .context_batch_workers
            .entry(context_id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        if worker.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(
                self.orchestrator_config.session_batch_coalesce_ms,
            ))
            .await;
            let drained = {
                let mut guard = queue.lock().await;
                let mut events = std::mem::take(&mut *guard);
                events.sort_by_key(|event| event.timestamp);
                events
            };
            if !drained.is_empty() {
                let max_batch = self.orchestrator_config.max_sessions_per_evaluation.max(1);
                let mut selected = Vec::new();
                let mut selected_sessions = HashSet::new();
                let mut deferred = Vec::new();
                for event in drained {
                    let session_id = event
                        .payload
                        .get("session_id")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string();
                    if session_id.is_empty()
                        || selected_sessions.contains(&session_id)
                        || selected.len() >= max_batch
                    {
                        deferred.push(event);
                    } else {
                        selected_sessions.insert(session_id);
                        selected.push(event);
                    }
                }
                if !deferred.is_empty() {
                    queue.lock().await.extend(deferred);
                }

                if selected.len() > 1 {
                    let handled = match self.run_merged_attempt(&context_id, &selected).await {
                        Ok(handled) => handled,
                        Err(error) => {
                            tracing::warn!(
                                context_id,
                                ?error,
                                "合并求值失败；全部 ready Session 降级为独立求值"
                            );
                            HashSet::new()
                        }
                    };
                    let fallbacks = selected
                        .into_iter()
                        .filter(|event| {
                            event
                                .payload
                                .get("session_id")
                                .and_then(|value| value.as_str())
                                .is_none_or(|session_id| !handled.contains(session_id))
                        })
                        .map(|mut event| {
                            // The event was present in the merged request, but the
                            // model produced no output or action for this Session.
                            // A tool-output trigger must therefore bypass the usual
                            // "already covered by a context inspection" dedupe check:
                            // submitted is not the same as semantically handled.
                            event
                                .payload
                                .insert("runtime_force_evaluation".to_string(), json!(true));
                            self.process_routed_event(event)
                        });
                    for result in futures_util::future::join_all(fallbacks).await {
                        if let Err(error) = result {
                            tracing::error!(context_id, ?error, "独立降级求值失败");
                        }
                    }
                } else if let Some(event) = selected.pop() {
                    if let Err(error) = self.process_routed_event(event).await {
                        tracing::error!(context_id, ?error, "单 Session 求值失败");
                    }
                }
            }

            // Change the worker flag while holding the queue lock. A producer
            // therefore cannot observe `running=true`, enqueue, return, and
            // leave an item stranded after this worker exits.
            let guard = queue.lock().await;
            if guard.is_empty() {
                worker.store(false, Ordering::SeqCst);
                break;
            }
            drop(guard);
        }
        Ok(())
    }

    async fn process_routed_event(&self, event: Event) -> Result<(), DynError> {
        let Some(session_id) = event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
        else {
            return Ok(());
        };

        if let Some(cancelled_at) = self.cancelled_at.get(&session_id).map(|value| *value) {
            if event.event_type == TYPE_USER_MESSAGE && event.timestamp > cancelled_at {
                // A later explicit user message resumes a cancelled Session. Tool
                // completions never resume it on their own.
                self.cancelled_at.remove(&session_id);
            } else {
                tracing::info!(
                    session_id,
                    event_id = %event.id,
                    "忽略 Session 取消前已排队的事件或取消后的后台工具唤醒"
                );
                return Ok(());
            }
        }
        if event.event_type == TYPE_USER_MESSAGE {
            self.read_turn_guards.remove(&session_id);
        }

        let Some(work_item) = self.claim_evaluation_work_item(&event).await? else {
            tracing::debug!(
                session_id,
                event_id = %event.id,
                "Evaluation Work Item 已由其他 worker claim 或已经终止"
            );
            return Ok(());
        };

        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config
                .model_attempt_timeout_secs
                .max(1)
                .saturating_mul((MAX_REPLY_PROTOCOL_RETRIES + 1) as u64)
                .saturating_add(1),
        );
        let watchdog_attempt_id = format!(
            "attempt_watchdog_{}_{}",
            session_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let mut cancellation = self.cancellation_sender(&session_id).subscribe();
        let start_epoch = *cancellation.borrow();
        let active_counter = self.active_counter(&session_id);
        active_counter.fetch_add(1, Ordering::SeqCst);
        let attempt = tokio::select! {
            result = tokio::time::timeout(deadline, async {
            let force_evaluation = event
                .payload
                .get("runtime_force_evaluation")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if event.event_type == TYPE_TOOL_OUTPUT
                && !force_evaluation
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
            if let Some(supervisor) = &self.objective_supervisor {
                supervisor.prepare_routed_event(&event).await?;
            }
            self.run_attempt(&session_id, &work_item).await
            }) => Some(result),
            _ = cancellation.changed() => {
                debug_assert_ne!(*cancellation.borrow(), start_epoch);
                None
            }
        };
        active_counter.fetch_sub(1, Ordering::SeqCst);
        let (result, final_status) = match attempt {
            Some(Ok(result)) => {
                let status = if result.is_ok() {
                    EvaluationWorkItemStatus::Completed
                } else {
                    EvaluationWorkItemStatus::Failed
                };
                (result, status)
            }
            Some(Err(error)) => {
                let result = self
                    .publish_runtime_failure(
                        &session_id,
                        &watchdog_attempt_id,
                        "attempt_watchdog",
                        &error,
                        None,
                    )
                    .await;
                (result, EvaluationWorkItemStatus::Failed)
            }
            None => {
                tracing::info!(session_id, "当前 Session 执行已由用户取消");
                (Ok(()), EvaluationWorkItemStatus::Cancelled)
            }
        };
        if let Err(error) = self
            .finish_evaluation_work_item(&work_item, final_status)
            .await
        {
            self.evaluation_routes.remove(&work_item.id);
            if result.is_ok() {
                return Err(error);
            }
            tracing::warn!(
                work_item_id = %work_item.id,
                error = %error,
                "Work Item 终态提交失败；保留原始执行错误"
            );
        }
        self.evaluation_routes.remove(&work_item.id);
        result
    }

    async fn claim_evaluation_work_item(
        &self,
        event: &Event,
    ) -> Result<Option<EvaluationWorkItemRecord>, DynError> {
        let session_id = required_payload_str(event, "session_id")?;
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Evaluation Work Item 需要持久化 SessionStore")?;
        let mut session = session_store
            .get_session(session_id)
            .await?
            .ok_or_else(|| format!("Session '{session_id}' 不存在"))?;

        // Directed events are physical activity. A retired Session must be restored
        // before it participates in Context Encoding again. User messages already do
        // this atomically in `claim_message`; this branch covers tool/background wakes.
        if session.attention_state == SessionAttentionState::Retired {
            let restore_event_id = format!(
                "session_restored_{}_{}",
                session_id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            );
            let mut restore_event = Event::new(
                restore_event_id.clone(),
                "Runtime-Orchestrator".to_string(),
                "session_lifecycle".to_string(),
                "runtime/session_restored".to_string(),
                vec![
                    ("agent_id".to_string(), json!(session.agent_id)),
                    ("context_id".to_string(), json!(session.context_id)),
                    ("session_id".to_string(), json!(session.id)),
                    ("trigger_event_id".to_string(), json!(event.id)),
                    ("reason".to_string(), json!("directed_event")),
                ]
                .into_iter()
                .collect(),
            );
            let attention_update = SessionAttentionUpdate {
                session_id: session.id.clone(),
                context_id: session.context_id.clone(),
                expected_revision: session.attention_revision,
                state: SessionAttentionState::Active,
                reason: Some("directed_event".to_string()),
                changed_at: restore_event.timestamp,
                event_id: restore_event_id,
            };
            match session_store
                .commit_context_transaction(&restore_event, &[attention_update])
                .await
            {
                Ok(()) => {
                    // The audit fact is already durable; dispatch it without crossing the
                    // persistence boundary a second time.
                    self.bus.publish_ephemeral(restore_event.clone()).await?;
                    session.attention_state = SessionAttentionState::Active;
                    session.attention_revision = session.attention_revision.saturating_add(1);
                }
                Err(error) => {
                    session = session_store
                        .get_session(session_id)
                        .await?
                        .ok_or_else(|| format!("Session '{session_id}' 在恢复时消失"))?;
                    if session.attention_state != SessionAttentionState::Active {
                        return Err(error);
                    }
                    // A concurrent worker won the restore CAS. The event it committed is
                    // already the authoritative audit record.
                    restore_event
                        .payload
                        .insert("restore_race_lost".to_string(), json!(true));
                }
            }
        }

        if event.event_type != TYPE_USER_MESSAGE {
            session_store
                .touch_session(session_id, event.timestamp)
                .await?;
        }

        let trigger_sequence = match event.sequence {
            Some(sequence) => sequence,
            None => self
                .store
                .query(QueryFilter {
                    session_id: Some(session_id.to_string()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .find(|stored| stored.id == event.id)
                .and_then(|stored| stored.sequence)
                .ok_or_else(|| {
                    format!(
                        "Trigger Event '{}' 尚未进入 Ledger，不能创建 Work Item",
                        event.id
                    )
                })?,
        };
        let parent_work_item_id = event
            .payload
            .get("work_item_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let parent = match parent_work_item_id.as_deref() {
            Some(id) => session_store.get_evaluation_work_item(id).await?,
            None => None,
        };
        let root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
            .or_else(|| parent.as_ref().map(|item| item.root_turn_id.clone()))
            .unwrap_or_else(|| event.id.clone());
        let digest = Sha256::digest(event.id.as_bytes());
        let work_item_id = format!("work_{:x}", digest);
        let work_item_id = work_item_id[..29].to_string();
        let work_item = session_store
            .ensure_evaluation_work_item(NewEvaluationWorkItem {
                id: work_item_id,
                agent_id: session.agent_id.clone(),
                context_id: session.context_id.clone(),
                session_id: session.id.clone(),
                trigger_event_id: event.id.clone(),
                trigger_sequence,
                trigger_kind: event.topic.clone(),
                parent_work_item_id,
                root_turn_id,
            })
            .await?;
        if work_item.status.is_terminal() {
            return Ok(None);
        }
        let now = Utc::now();
        if work_item.status == EvaluationWorkItemStatus::Running
            && work_item
                .lease_expires_at
                .is_some_and(|expires_at| expires_at > now)
        {
            return Ok(None);
        }
        let lease_seconds = self
            .orchestrator_config
            .model_attempt_timeout_secs
            .max(1)
            .saturating_mul((MAX_REPLY_PROTOCOL_RETRIES + 1) as u64)
            .saturating_add(30)
            .max(
                self.orchestrator_config
                    .tool_timeout_secs
                    .max(1)
                    .saturating_add(30),
            );
        let lease_seconds = i64::try_from(lease_seconds).unwrap_or(i64::MAX);
        let lease_expires_at = now + chrono::Duration::seconds(lease_seconds);
        match session_store
            .update_evaluation_work_item(
                &work_item.id,
                work_item.revision,
                EvaluationWorkItemStatus::Running,
                Some(&format!("runtime:{}", std::process::id())),
                Some(lease_expires_at),
                None,
            )
            .await?
        {
            EvaluationWorkItemMutation::Updated(claimed) => Ok(Some(claimed)),
            EvaluationWorkItemMutation::Conflict { .. } => Ok(None),
            EvaluationWorkItemMutation::NotFound => {
                Err(format!("Work Item '{}' 在 claim 时消失", work_item.id).into())
            }
        }
    }

    async fn finish_evaluation_work_item(
        &self,
        work_item: &EvaluationWorkItemRecord,
        status: EvaluationWorkItemStatus,
    ) -> Result<EvaluationWorkItemRecord, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Evaluation Work Item 需要持久化 SessionStore")?;
        let Some(current) = session_store
            .get_evaluation_work_item(&work_item.id)
            .await?
        else {
            return Err(format!("Work Item '{}' 在结束时消失", work_item.id).into());
        };
        if current.status.is_terminal() {
            return Ok(current);
        }
        match session_store
            .update_evaluation_work_item(
                &current.id,
                current.revision,
                status,
                None,
                None,
                current.context_snapshot_version,
            )
            .await?
        {
            EvaluationWorkItemMutation::Updated(updated) => Ok(updated),
            EvaluationWorkItemMutation::Conflict { current } if current.status.is_terminal() => {
                Ok(current)
            }
            EvaluationWorkItemMutation::Conflict { current } => Err(format!(
                "Work Item '{}' 终态提交冲突：当前 revision={} status={}",
                current.id,
                current.revision,
                current.status.as_str()
            )
            .into()),
            EvaluationWorkItemMutation::NotFound => {
                Err(format!("Work Item '{}' 在结束时消失", work_item.id).into())
            }
        }
    }

    async fn record_work_item_context_snapshot(
        &self,
        work_item: &EvaluationWorkItemRecord,
        context_version: u64,
    ) -> Result<(), DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Evaluation Work Item 需要持久化 SessionStore")?;
        let Some(current) = session_store
            .get_evaluation_work_item(&work_item.id)
            .await?
        else {
            return Err(format!("Work Item '{}' 在记录快照时消失", work_item.id).into());
        };
        if current.status.is_terminal() || current.context_snapshot_version == Some(context_version)
        {
            return Ok(());
        }
        match session_store
            .update_evaluation_work_item(
                &current.id,
                current.revision,
                current.status,
                current.claimed_by.as_deref(),
                current.lease_expires_at,
                Some(context_version),
            )
            .await?
        {
            EvaluationWorkItemMutation::Updated(_) => Ok(()),
            EvaluationWorkItemMutation::Conflict { current }
                if current.context_snapshot_version == Some(context_version) =>
            {
                Ok(())
            }
            EvaluationWorkItemMutation::Conflict { current } => Err(format!(
                "Work Item '{}' Context snapshot 提交冲突：revision={}",
                current.id, current.revision
            )
            .into()),
            EvaluationWorkItemMutation::NotFound => Err(format!(
                "Work Item '{}' 在记录 Context snapshot 时消失",
                work_item.id
            )
            .into()),
        }
    }

    async fn tool_output_already_covered(
        &self,
        session_id: &str,
        trigger: &Event,
    ) -> Result<bool, DynError> {
        let trigger_root_turn_id = trigger
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str());
        let trigger_sequence = match trigger.sequence {
            Some(sequence) => Some(sequence),
            None => self
                .store
                .query(QueryFilter {
                    session_id: Some(session_id.to_string()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .find(|event| event.id == trigger.id)
                .and_then(|event| event.sequence),
        };
        let inspections = self
            .store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                topic: Some("chat/context_inspect".to_string()),
                ..Default::default()
            })
            .await?;
        Ok(inspections.iter().any(|inspection| {
            let same_causal_turn = match trigger_root_turn_id {
                Some(root_turn_id) => {
                    inspection
                        .payload
                        .get("root_turn_id")
                        .and_then(|value| value.as_str())
                        == Some(root_turn_id)
                }
                None => true,
            };
            if !same_causal_turn {
                return false;
            }
            match (trigger_sequence, inspection.sequence) {
                (Some(trigger_sequence), Some(inspection_sequence)) => {
                    inspection_sequence > trigger_sequence
                }
                _ => inspection.timestamp > trigger.timestamp,
            }
        }))
    }

    /// Rebuild the standard Function Calling transcript for the active user
    /// turn. Long-term conversation history is still represented only by the
    /// compiled Context snapshot; assistant/tool messages here are transient
    /// protocol messages since the latest user observation.
    async fn turn_tool_transcript(
        &self,
        session_id: &str,
        root_turn_id: Option<&str>,
        trigger_event_id: Option<&str>,
    ) -> Result<TurnToolTranscript, DynError> {
        let events = self
            .store
            .query(QueryFilter {
                session_id: Some(session_id.to_string()),
                ..Default::default()
            })
            .await?;
        let trigger_attempt_id = trigger_event_id.and_then(|trigger_event_id| {
            events
                .iter()
                .find(|event| event.id == trigger_event_id)
                .and_then(|event| event.payload.get("attempt_id"))
                .and_then(|value| value.as_str())
        });
        let turn_events = match root_turn_id {
            Some(root_turn_id) => events
                .iter()
                .filter(|event| {
                    let same_root = event
                        .payload
                        .get("root_turn_id")
                        .and_then(|value| value.as_str())
                        == Some(root_turn_id);
                    let is_trigger = trigger_event_id == Some(event.id.as_str());
                    let legacy_assistant_call = trigger_attempt_id.is_some_and(|attempt_id| {
                        event.topic == "chat/assistant_call"
                            && event
                                .payload
                                .get("attempt_id")
                                .and_then(|value| value.as_str())
                                == Some(attempt_id)
                    });
                    same_root || is_trigger || legacy_assistant_call
                })
                .collect::<Vec<_>>(),
            None => {
                let turn_start = events
                    .iter()
                    .rposition(|event| {
                        event.event_type == TYPE_USER_MESSAGE
                            || event.topic == "objective/evaluation_started"
                    })
                    .unwrap_or(0);
                events[turn_start..].iter().collect::<Vec<_>>()
            }
        };
        let mut outputs = HashMap::<(String, String), Event>::new();
        for event in &turn_events {
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
                (*event).clone(),
            );
        }

        let mut transcript = TurnToolTranscript::default();
        for event in &turn_events {
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
            "session_id": output.payload.get("session_id").and_then(|value| value.as_str()),
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

    async fn run_merged_attempt(
        &self,
        context_id: &str,
        triggers: &[Event],
    ) -> Result<HashSet<String>, DynError> {
        let mut session_ids = Vec::with_capacity(triggers.len());
        let mut transcript_messages = Vec::new();
        let mut delivered_output_ids = HashSet::new();
        for trigger in triggers {
            let session_id = required_payload_str(trigger, "session_id")?.to_string();
            if let Some(cancelled_at) = self.cancelled_at.get(&session_id).map(|value| *value) {
                if trigger.event_type == TYPE_USER_MESSAGE && trigger.timestamp > cancelled_at {
                    self.cancelled_at.remove(&session_id);
                } else {
                    continue;
                }
            }
            if trigger.event_type == TYPE_USER_MESSAGE {
                self.read_turn_guards.remove(&session_id);
            }
            if trigger.event_type == TYPE_TOOL_OUTPUT
                && self
                    .tool_output_already_covered(&session_id, trigger)
                    .await?
            {
                continue;
            }
            let transcript = self.turn_tool_transcript(&session_id, None, None).await?;
            transcript_messages.extend(transcript.messages);
            delivered_output_ids.extend(transcript.delivered_output_ids);
            session_ids.push(session_id);
        }
        if session_ids.len() < 2 {
            return Ok(HashSet::new());
        }

        let locks = session_ids
            .iter()
            .map(|session_id| self.session_lock(session_id))
            .collect::<Vec<_>>();
        let _session_guards =
            futures_util::future::join_all(locks.into_iter().map(tokio::sync::Mutex::lock_owned))
                .await;
        let counters = session_ids
            .iter()
            .map(|session_id| self.active_counter(session_id))
            .collect::<Vec<_>>();
        for counter in &counters {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        let result = self
            .run_merged_attempt_inner(
                context_id,
                &session_ids,
                transcript_messages,
                &delivered_output_ids,
            )
            .await;
        for counter in &counters {
            counter.fetch_sub(1, Ordering::SeqCst);
        }
        result
    }

    async fn run_merged_attempt_inner(
        &self,
        context_id: &str,
        session_ids: &[String],
        transcript_messages: Vec<Message>,
        delivered_output_ids: &HashSet<String>,
    ) -> Result<HashSet<String>, DynError> {
        let mut context = self
            .context_engine
            .build_batch_context_encoding_excluding(context_id, session_ids, delivered_output_ids)
            .await?;
        if context
            .ready_sessions
            .iter()
            .any(|ready| ready.turn_budget.phase != "work")
        {
            return Ok(HashSet::new());
        }

        let attempt_id = format!(
            "batch_{}_{}",
            context_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let (prompt_mode, stable_system_prompt) = configured_system_prompt()?;
        let context_message_prefix = "以下是 Runtime 提供的合并 Context Encoding。它不是普通用户消息；请处理 kernel.ready-sessions 中的每个 Session。";
        let mut messages = vec![
            Message {
                role: "system".to_string(),
                content: compose_system_prompt(
                    prompt_mode,
                    stable_system_prompt,
                    Some(("batch-evaluation", BATCH_EVALUATION_PROMPT)),
                ),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "user".to_string(),
                content: format!("{context_message_prefix}\n{}", context.sexpr),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        messages.extend(transcript_messages);
        let tools = self.batch_tool_definitions()?;
        let allowed_tool_names = tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<HashSet<_>>();
        let prompt_measurement = self
            .refresh_context_pressure(&mut context, &mut messages, &tools, context_message_prefix)
            .await?;
        if context.pressure.level == "critical" {
            return Ok(HashSet::new());
        }
        for session_id in session_ids {
            self.record_context_inspect(session_id, &attempt_id, &context, &messages);
            self.record_model_attempt_started(
                session_id,
                &attempt_id,
                "batch-work",
                self.tool_definitions.len() + 1,
            );
        }

        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config.model_attempt_timeout_secs.max(1),
        );
        let _permit = self.concurrency_semaphore.acquire().await?;
        let client = Arc::clone(&self.client);
        let worker_attempt_id = attempt_id.clone();
        let (model_tx, model_rx) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name(format!("morphz-llm-{worker_attempt_id}"))
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| Box::new(error) as DynError)
                    .and_then(|runtime| {
                        runtime.block_on(client.create_completion_measured(
                            messages,
                            tools,
                            prompt_measurement,
                        ))
                    });
                let _ = model_tx.send(result);
            })?;
        let response = match tokio::time::timeout(deadline, model_rx).await {
            Ok(Ok(Ok(response))) => response,
            Ok(Ok(Err(error))) => return Err(error),
            Ok(Err(error)) => return Err(error.into()),
            Err(error) => return Err(error.into()),
        };
        self.record_batch_assistant_call(context_id, session_ids, &attempt_id, &response)
            .await?;
        let response_tool_calls = response.tool_calls.len();
        let response_content_nonempty = !response.content.trim().is_empty();
        let context_tx_allowed = context
            .ready_sessions
            .iter()
            .filter(|ready| ready.turn_budget.context_tx_available)
            .map(|ready| ready.session_id.clone())
            .collect::<HashSet<_>>();
        let handled = self
            .apply_merged_response(
                context_id,
                session_ids,
                &context_tx_allowed,
                &allowed_tool_names,
                &attempt_id,
                response,
            )
            .await?;
        self.record_batch_evaluation(
            context_id,
            session_ids,
            &handled,
            &attempt_id,
            response_tool_calls,
            response_content_nonempty,
        )
        .await?;
        Ok(handled)
    }

    fn batch_tool_definitions(&self) -> Result<Vec<crate::llm::ToolDefinition>, DynError> {
        let mut definitions = self.tool_definitions.clone();
        for definition in &mut definitions {
            let object = definition
                .parameters
                .as_object_mut()
                .ok_or_else(|| format!("工具 '{}' parameters 不是 object", definition.name))?;
            let properties = object
                .entry("properties")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| format!("工具 '{}' properties 不是 object", definition.name))?;
            properties.insert(
                "session_id".to_string(),
                json!({
                    "type": "string",
                    "description": "该工具动作所属的 ready Session ID；Runtime 用于路由工具结果"
                }),
            );
            let required = object
                .entry("required")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or_else(|| format!("工具 '{}' required 不是 array", definition.name))?;
            if !required
                .iter()
                .any(|value| value.as_str() == Some("session_id"))
            {
                required.push(json!("session_id"));
            }
        }
        definitions.push(crate::llm::ToolDefinition {
            name: "session_output".to_string(),
            description:
                "向一个或多个 ready Session 发送进度或最终回复。这是外部 IO，不修改 Mind。"
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "deliveries": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "session_id": { "type": "string" },
                                "kind": { "type": "string", "enum": ["progress", "final"] },
                                "text": { "type": "string" }
                            },
                            "required": ["session_id", "kind", "text"]
                        }
                    }
                },
                "required": ["deliveries"]
            }),
        });
        Ok(definitions)
    }

    async fn apply_merged_response(
        &self,
        context_id: &str,
        session_ids: &[String],
        context_tx_allowed: &HashSet<String>,
        allowed_tool_names: &HashSet<String>,
        attempt_id: &str,
        response: crate::llm::Response,
    ) -> Result<HashSet<String>, DynError> {
        let ready = session_ids.iter().cloned().collect::<HashSet<_>>();
        let mut deliveries = HashMap::<String, Vec<SessionDelivery>>::new();
        let mut calls = HashMap::<String, Vec<crate::llm::ToolCallRepr>>::new();
        let mut transcript_calls = HashMap::<String, Vec<crate::llm::ToolCall>>::new();
        let mut context_tx_count = 0usize;

        for call in response.tool_calls {
            if call.func_name == "session_output" {
                let args: SessionOutputArgs = serde_json::from_str(&call.arguments)?;
                for delivery in args.deliveries {
                    if !ready.contains(&delivery.session_id)
                        || !matches!(delivery.kind.as_str(), "progress" | "final")
                        || delivery.text.trim().is_empty()
                    {
                        return Ok(HashSet::new());
                    }
                    deliveries
                        .entry(delivery.session_id.clone())
                        .or_default()
                        .push(delivery);
                }
                continue;
            }

            let original_arguments = call.arguments.clone();
            let mut arguments: serde_json::Value = serde_json::from_str(&call.arguments)?;
            let object = arguments
                .as_object_mut()
                .ok_or("合并求值的工具参数必须是 JSON object")?;
            let session_id = object
                .remove("session_id")
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .ok_or("合并求值的工具调用缺少 session_id")?;
            if !ready.contains(&session_id) {
                return Ok(HashSet::new());
            }
            if call.func_name == "context_tx" {
                context_tx_count += 1;
            }
            transcript_calls
                .entry(session_id.clone())
                .or_default()
                .push(crate::llm::ToolCall {
                    id: call.id.clone(),
                    r#type: call.r#type.clone(),
                    function: crate::llm::FunctionCall {
                        name: call.func_name.clone(),
                        arguments: original_arguments,
                    },
                });
            calls
                .entry(session_id)
                .or_default()
                .push(crate::llm::ToolCallRepr {
                    id: call.id,
                    r#type: call.r#type,
                    func_name: call.func_name,
                    arguments: serde_json::to_string(&arguments)?,
                });
        }
        if context_tx_count > 1 {
            return Ok(HashSet::new());
        }

        let lane_futures = session_ids.iter().map(|session_id| {
            let lane_deliveries = deliveries.remove(session_id).unwrap_or_default();
            let lane_calls = calls.remove(session_id).unwrap_or_default();
            let lane_transcript_calls = transcript_calls.remove(session_id).unwrap_or_default();
            let lane = MergedLaneWork {
                deliveries: lane_deliveries,
                calls: lane_calls,
                transcript_calls: lane_transcript_calls,
            };
            async move {
                let result = self
                    .apply_merged_lane(
                        context_id,
                        context_tx_allowed,
                        allowed_tool_names,
                        attempt_id,
                        session_id,
                        lane,
                    )
                    .await;
                (session_id.clone(), result)
            }
        });
        let mut handled = HashSet::new();
        for (session_id, result) in futures_util::future::join_all(lane_futures).await {
            match result {
                Ok(true) => {
                    handled.insert(session_id);
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::error!(session_id, ?error, "batch Session lane 执行失败");
                }
            }
        }
        Ok(handled)
    }

    async fn apply_merged_lane(
        &self,
        context_id: &str,
        context_tx_allowed: &HashSet<String>,
        allowed_tool_names: &HashSet<String>,
        attempt_id: &str,
        session_id: &str,
        lane: MergedLaneWork,
    ) -> Result<bool, DynError> {
        if self.cancelled_at.contains_key(session_id) {
            return Ok(true);
        }
        let finals = lane
            .deliveries
            .iter()
            .filter(|delivery| delivery.kind == "final")
            .collect::<Vec<_>>();
        if finals.len() > 1 || (!finals.is_empty() && !lane.calls.is_empty()) {
            return Ok(false);
        }
        if let Some(final_delivery) = finals.first() {
            let parent = self.parent_session_for(context_id, session_id).await?;
            self.publish_reply(
                session_id,
                attempt_id,
                final_delivery.text.clone(),
                parent.as_deref(),
            )
            .await?;
            return Ok(true);
        }

        for delivery in lane
            .deliveries
            .iter()
            .filter(|delivery| delivery.kind == "progress")
        {
            self.publish_progress(session_id, attempt_id, delivery.text.clone())
                .await?;
        }
        if lane.calls.is_empty() {
            return Ok(false);
        }
        let lane_response = crate::llm::Response {
            content: String::new(),
            tool_calls: lane.calls,
        };
        if let Err(error) = self
            .execute_tool_calls(
                session_id,
                &format!("{}_{}", attempt_id, session_id),
                lane_response,
                "batch-work",
                ToolExecutionOptions {
                    context_tx_allowed: context_tx_allowed.contains(session_id),
                    wake_on_output: true,
                    transcript_tool_calls: Some(lane.transcript_calls),
                    allowed_tool_names: allowed_tool_names.clone(),
                    record_assistant_call: true,
                },
            )
            .await
        {
            let parent = self.parent_session_for(context_id, session_id).await?;
            self.publish_runtime_failure(
                session_id,
                attempt_id,
                "batch_tool_execution",
                error.as_ref(),
                parent.as_deref(),
            )
            .await?;
        }
        Ok(true)
    }

    async fn parent_session_for(
        &self,
        context_id: &str,
        session_id: &str,
    ) -> Result<Option<String>, DynError> {
        Ok(self
            .context_engine
            .build_context_encoding(context_id, session_id, &HashSet::new())
            .await?
            .parent_session_id)
    }

    async fn record_batch_evaluation(
        &self,
        context_id: &str,
        session_ids: &[String],
        handled: &HashSet<String>,
        attempt_id: &str,
        response_tool_calls: usize,
        response_content_nonempty: bool,
    ) -> Result<(), DynError> {
        let Some(route_session_id) = session_ids.first() else {
            return Ok(());
        };
        let fallback_sessions = session_ids
            .iter()
            .filter(|session_id| !handled.contains(*session_id))
            .cloned()
            .collect::<Vec<_>>();
        let handled_sessions = session_ids
            .iter()
            .filter(|session_id| handled.contains(*session_id))
            .cloned()
            .collect::<Vec<_>>();
        self.bus
            .publish(Event::new(
                format!(
                    "batch_evaluation_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/batch_evaluation".to_string(),
                vec![
                    ("context_id".to_string(), json!(context_id)),
                    ("session_id".to_string(), json!(route_session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("ready_sessions".to_string(), json!(session_ids)),
                    ("handled_sessions".to_string(), json!(handled_sessions)),
                    ("fallback_sessions".to_string(), json!(fallback_sessions)),
                    (
                        "response_tool_calls".to_string(),
                        json!(response_tool_calls),
                    ),
                    (
                        "response_content_nonempty".to_string(),
                        json!(response_content_nonempty),
                    ),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
        Ok(())
    }

    async fn record_batch_assistant_call(
        &self,
        context_id: &str,
        session_ids: &[String],
        attempt_id: &str,
        response: &crate::llm::Response,
    ) -> Result<(), DynError> {
        let Some(route_session_id) = session_ids.first() else {
            return Ok(());
        };
        self.bus
            .publish(Event::new(
                format!(
                    "batch_assistant_call_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "runtime/batch_assistant_call".to_string(),
                vec![
                    ("context_id".to_string(), json!(context_id)),
                    ("session_id".to_string(), json!(route_session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("ready_sessions".to_string(), json!(session_ids)),
                    ("text".to_string(), json!(response.content)),
                    ("tool_calls".to_string(), json!(response.tool_calls)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
        Ok(())
    }

    async fn request_model_completion(
        &self,
        session_id: &str,
        attempt_id: &str,
        messages: Vec<Message>,
        tools: Vec<crate::llm::ToolDefinition>,
        prompt_measurement: Option<PromptTokenCount>,
    ) -> Result<crate::llm::Response, DynError> {
        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config.model_attempt_timeout_secs.max(1),
        );
        let _permit = self.concurrency_semaphore.acquire().await?;
        let client = Arc::clone(&self.client);
        let (stream_tx, mut stream_rx) = tokio::sync::mpsc::unbounded_channel();
        let stream_bus = Arc::clone(&self.bus);
        let stream_session_id = session_id.to_string();
        let stream_context_id = self.context_id_for_session(session_id)?;
        let stream_attempt_id = attempt_id.to_string();
        let stream_forwarder = tokio::spawn(async move {
            while let Some(stream_event) = stream_rx.recv().await {
                let event = Event::new(
                    format!(
                        "model_stream_{}",
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    ),
                    "Model-Provider".to_string(),
                    "runtime_ephemeral".to_string(),
                    "runtime/model_stream".to_string(),
                    vec![
                        ("context_id".to_string(), json!(&stream_context_id)),
                        ("session_id".to_string(), json!(&stream_session_id)),
                        ("attempt_id".to_string(), json!(&stream_attempt_id)),
                        ("stream".to_string(), json!(stream_event)),
                    ]
                    .into_iter()
                    .collect(),
                );
                if let Err(error) = stream_bus.publish_ephemeral(event).await {
                    tracing::debug!(%error, "发布瞬时模型流事件失败");
                }
            }
        });
        let (model_tx, model_rx) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name(format!("morphz-llm-{attempt_id}"))
            .spawn(move || {
                let result = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| Box::new(error) as DynError)
                    .and_then(|runtime| {
                        runtime.block_on(client.create_completion_measured_stream(
                            messages,
                            tools,
                            prompt_measurement,
                            stream_tx,
                        ))
                    });
                let _ = model_tx.send(result);
            })?;
        let result = match tokio::time::timeout(deadline, model_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(error.into()),
            Err(error) => {
                stream_forwarder.abort();
                return Err(error.into());
            }
        };
        let _ = stream_forwarder.await;
        result
    }

    /// 用当前协议 Client 声明的 TokenCounter 计量完整候选工作请求，
    /// 并把结果及精度回写到本轮 Context Encoding。计数失败不会阻断 Agent。
    async fn refresh_context_pressure(
        &self,
        context: &mut ContextView,
        messages: &mut [Message],
        tools: &[crate::llm::ToolDefinition],
        context_message_prefix: &str,
    ) -> Result<Option<PromptTokenCount>, DynError> {
        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config
                .model_attempt_timeout_secs
                .clamp(1, 15),
        );
        let _permit = self.concurrency_semaphore.acquire().await?;
        let token_scope = format!("{}:{}", context.context_id, context.active_session_id);
        let measurement = tokio::time::timeout(
            deadline,
            self.client
                .count_prompt_tokens(&token_scope, messages, tools),
        )
        .await;

        let measurement = match measurement {
            Ok(Ok(Some(count))) => {
                self.context_engine
                    .apply_prompt_token_count(context, &count)
                    .await?;
                if let Some(context_message) = messages.get_mut(1) {
                    context_message.content =
                        format!("{context_message_prefix}\n{}", context.sexpr);
                }
                tracing::info!(
                    context_id = %context.context_id,
                    session_id = %context.active_session_id,
                    model = %count.model,
                    prompt_tokens = count.tokens,
                    source = %count.source,
                    accuracy = count.accuracy.as_str(),
                    pressure = %context.pressure.level,
                    "Context pressure 已按完整 Prompt 重新计量"
                );
                Some(count)
            }
            Ok(Ok(None)) => {
                tracing::debug!(
                    session_id = %context.active_session_id,
                    "当前 LLM Client 未提供 Prompt Token 计量，保留 Context 局部估算"
                );
                None
            }
            Ok(Err(error)) => {
                tracing::warn!(
                    session_id = %context.active_session_id,
                    error = %error,
                    "Prompt Token 计量失败，保留 Context 局部估算"
                );
                None
            }
            Err(_) => {
                tracing::warn!(
                    session_id = %context.active_session_id,
                    timeout_secs = deadline.as_secs(),
                    "Prompt Token 计量超时，保留 Context 局部估算"
                );
                None
            }
        };
        Ok(measurement)
    }

    /// Resume a model decision that crossed the durable assistant-call boundary before the
    /// owning Work Item reached a terminal state. Re-asking the model here could produce a new
    /// set of call IDs and repeat an external side effect, so recovery always reuses the exact
    /// persisted plan. `execute_tool_calls` also reuses any already durable output events.
    async fn resume_persisted_work_item(
        &self,
        session_id: &str,
        work_item: &EvaluationWorkItemRecord,
    ) -> Result<bool, DynError> {
        let assistant_event_id = format!("call_{}", work_item.id);
        let Some(assistant_call) = self
            .context_engine
            .find_event(&work_item.context_id, &assistant_event_id)
            .await?
        else {
            return Ok(false);
        };
        if assistant_call.topic != "chat/assistant_call" {
            return Err(format!(
                "Work Item '{}' 的恢复边界 '{}' 不是 assistant_call",
                work_item.id, assistant_event_id
            )
            .into());
        }

        let calls_value = assistant_call
            .payload
            .get("tool_calls")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let calls = serde_json::from_value::<Vec<crate::llm::ToolCall>>(calls_value)?;
        let response = crate::llm::Response {
            content: assistant_call
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            tool_calls: calls
                .iter()
                .map(|call| crate::llm::ToolCallRepr {
                    id: call.id.clone(),
                    r#type: call.r#type.clone(),
                    func_name: call.function.name.clone(),
                    arguments: call.function.arguments.clone(),
                })
                .collect(),
        };

        if assistant_call
            .payload
            .get("terminal_reply")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            let decision = classify_reply_response(&response)
                .map_err(|error| -> DynError { error.into() })?
                .ok_or_else(|| {
                    format!(
                        "Work Item '{}' 的持久化 terminal reply 不包含合法 reply 调用",
                        work_item.id
                    )
                })?;
            let parent = self
                .parent_session_for(&work_item.context_id, session_id)
                .await?;
            tracing::info!(
                work_item_id = %work_item.id,
                disposition = decision.disposition(),
                "从持久化 assistant_call 恢复终态回复"
            );
            match decision {
                ReplyDecision::Deliver(content) => {
                    self.publish_reply(session_id, &work_item.id, content, parent.as_deref())
                        .await?;
                }
                ReplyDecision::Suppress => {
                    self.publish_reply_suppressed(session_id, &work_item.id, parent.as_deref())
                        .await?;
                }
            }
            return Ok(true);
        }

        if response.tool_calls.is_empty() {
            return Err(format!(
                "Work Item '{}' 的持久化 assistant_call 既非终态回复也没有工具调用",
                work_item.id
            )
            .into());
        }
        let unavailable_names = assistant_call
            .payload
            .get("unavailable_tool_names")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_default()
            .into_iter()
            .collect::<HashSet<_>>();
        let allowed_tool_names = response
            .tool_calls
            .iter()
            .map(|call| call.func_name.clone())
            .filter(|name| !unavailable_names.contains(name))
            .collect::<HashSet<_>>();
        let transcript_tool_calls = assistant_call
            .payload
            .get("transcript_tool_calls")
            .and_then(|value| {
                serde_json::from_value::<Vec<crate::llm::ToolCall>>(value.clone()).ok()
            });
        let context_tx_allowed = assistant_call
            .payload
            .get("context_tx_rejection_status")
            .and_then(|value| value.as_str())
            != Some("budget-exhausted");
        let phase = assistant_call
            .payload
            .get("phase")
            .and_then(|value| value.as_str())
            .unwrap_or("work");
        tracing::info!(
            work_item_id = %work_item.id,
            tool_calls = response.tool_calls.len(),
            "从持久化 assistant_call 恢复工具执行计划"
        );
        self.execute_tool_calls(
            session_id,
            &work_item.id,
            response,
            phase,
            ToolExecutionOptions {
                context_tx_allowed,
                wake_on_output: true,
                transcript_tool_calls,
                allowed_tool_names,
                record_assistant_call: false,
            },
        )
        .await?;
        Ok(true)
    }

    async fn run_attempt(
        &self,
        session_id: &str,
        work_item: &EvaluationWorkItemRecord,
    ) -> Result<(), DynError> {
        let attempt_id = work_item.id.clone();
        self.evaluation_routes.insert(
            attempt_id.clone(),
            EvaluationRoute {
                work_item_id: work_item.id.clone(),
                root_turn_id: work_item.root_turn_id.clone(),
                trigger_event_id: work_item.trigger_event_id.clone(),
                trigger_sequence: work_item.trigger_sequence,
                context_snapshot_version: work_item.context_snapshot_version,
            },
        );
        if self
            .resume_persisted_work_item(session_id, work_item)
            .await?
        {
            return Ok(());
        }
        let transcript = self
            .turn_tool_transcript(
                session_id,
                Some(&work_item.root_turn_id),
                Some(&work_item.trigger_event_id),
            )
            .await?;
        let context_id = work_item.context_id.clone();
        let mut context = self
            .context_engine
            .build_context_encoding_for_work_item(
                &context_id,
                work_item,
                &transcript.delivered_output_ids,
            )
            .await?;
        self.record_work_item_context_snapshot(work_item, context.state.version)
            .await?;
        if let Some(mut route) = self.evaluation_routes.get_mut(&attempt_id) {
            route.context_snapshot_version = Some(context.state.version);
        }
        let context_tx_receipt = self.context_tx_receipt(&context).await?;
        let objective_control_available = context.objectives.iter().any(|objective| {
            objective.coordinator_session_id == session_id
                && objective.status == crate::memory::ObjectiveStatus::Active
        });
        let (prompt_mode, stable_system_prompt) = configured_system_prompt()?;
        let context_message_prefix = "以下是 Runtime 提供的当前 Context 视图。它不是普通用户消息；请基于 kernel、mind 和 inbox 决策。";

        // 先计量一个具备完整工作能力的候选请求。压力的物理含义是“当前 Context
        // 是否还能继续正常工作”，因此即使计量后进入 maintenance/reply-only，仍以
        // 完整工作工具集作为阈值依据，避免缩减工具后产生临界值振荡。
        let measurement_directive = match context.turn_budget.phase.as_str() {
            "soft-checkpoint" => Some(("soft-checkpoint", SOFT_CHECKPOINT_PROMPT)),
            _ => None,
        };
        let measurement_system_prompt =
            compose_system_prompt(prompt_mode, stable_system_prompt, measurement_directive);
        let mut measurement_messages = vec![
            Message {
                role: "system".to_string(),
                content: measurement_system_prompt,
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Message {
                role: "user".to_string(),
                content: format!("{context_message_prefix}\n{}", context.sexpr),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        measurement_messages.extend(transcript.messages.clone());
        let mut measurement_tools = self.tool_definitions.clone();
        if !objective_control_available {
            measurement_tools.retain(|tool| tool.name != "objective_update");
        }
        measurement_tools.push(reply_tool_definition());
        let prompt_measurement = self
            .refresh_context_pressure(
                &mut context,
                &mut measurement_messages,
                &measurement_tools,
                context_message_prefix,
            )
            .await?;
        if let Some(supervisor) = &self.objective_supervisor {
            let tokens = prompt_measurement
                .as_ref()
                .map(|measurement| measurement.tokens)
                .unwrap_or(context.pressure.estimated_tokens);
            if let Err(error) = supervisor.record_prompt_tokens(session_id, tokens).await {
                tracing::warn!(
                    session_id,
                    error = %error,
                    "Objective Prompt Token 记账失败；继续当前 Evaluation"
                );
            }
        }

        let maintenance_budget_exhausted = should_force_final_for_maintenance(
            &context.turn_budget.phase,
            &context.pressure.level,
            context.turn_budget.context_tx_available,
        );
        let effective_phase = if maintenance_budget_exhausted {
            "final-reply"
        } else if context.pressure.level == "critical" {
            "critical-maintenance"
        } else {
            context.turn_budget.phase.as_str()
        };
        let context_tx_cooldown = effective_phase != "final-reply"
            && context.pressure.level != "critical"
            && context_tx_receipt == ContextTxReceipt::Committed;
        let phase_prompt = match effective_phase {
            "final-reply" if maintenance_budget_exhausted => {
                Some(MAINTENANCE_BUDGET_EXHAUSTED_PROMPT)
            }
            "critical-maintenance" => Some(CRITICAL_MAINTENANCE_PROMPT),
            "soft-checkpoint" => Some(SOFT_CHECKPOINT_PROMPT),
            _ if context_tx_cooldown => Some(CONTEXT_TX_COOLDOWN_PROMPT),
            _ => None,
        };
        let system_prompt = compose_system_prompt(
            prompt_mode,
            stable_system_prompt,
            phase_prompt.map(|prompt| (effective_phase, prompt)),
        );
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
                content: format!("{context_message_prefix}\n{}", context.sexpr),
                name: None,
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        messages.extend(transcript.messages);

        let mut tools = self.tool_definitions.clone();
        if !objective_control_available {
            tools.retain(|tool| tool.name != "objective_update");
        }
        if effective_phase == "final-reply" {
            tracing::warn!(
                session_id,
                attempt = context.turn_budget.attempt,
                maintenance_budget_exhausted,
                "Context critical 且维护预算耗尽：进入 reply-only 最终答复"
            );
            tools.clear();
        } else {
            if effective_phase == "soft-checkpoint" {
                tracing::info!(
                    session_id,
                    attempt = context.turn_budget.attempt,
                    interval = context.turn_budget.checkpoint_interval,
                    "到达 Turn 软检查点：保留完整工具能力并继续任务"
                );
                self.publish_progress(
                    session_id,
                    &attempt_id,
                    format!(
                        "已完成 {} 次模型求值软检查点；正在复盘进展，任务不会因此停止。",
                        context.turn_budget.attempt
                    ),
                )
                .await?;
            }
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
        tools.push(reply_tool_definition());
        let allowed_tool_names = tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<HashSet<_>>();
        self.record_context_inspect(session_id, &attempt_id, &context, &messages);
        let mut protocol_messages = messages;
        let mut protocol_errors = 0usize;
        let (response, reply_decision) = loop {
            let model_attempt_id = if protocol_errors == 0 {
                attempt_id.clone()
            } else {
                format!("{attempt_id}_reply_retry_{protocol_errors}")
            };
            self.record_model_attempt_started(
                session_id,
                &model_attempt_id,
                effective_phase,
                tools.len(),
            );
            let completion = self
                .request_model_completion(
                    session_id,
                    &model_attempt_id,
                    protocol_messages.clone(),
                    tools.clone(),
                    (protocol_errors == 0)
                        .then(|| prompt_measurement.clone())
                        .flatten(),
                )
                .await;
            let response = match completion {
                Ok(response) => response,
                Err(error) if error.to_string().contains(EMPTY_RESPONSE_ERROR) => {
                    protocol_errors += 1;
                    self.record_reply_protocol_error(
                        session_id,
                        &model_attempt_id,
                        protocol_errors,
                        "模型返回空响应",
                    )
                    .await?;
                    if protocol_errors > MAX_REPLY_PROTOCOL_RETRIES {
                        return self
                            .publish_reply_protocol_failure(
                                session_id,
                                &model_attempt_id,
                                context.parent_session_id.as_deref(),
                            )
                            .await;
                    }
                    protocol_messages.push(Message {
                        role: "user".to_string(),
                        content: REPLY_PROTOCOL_ERROR.to_string(),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                    continue;
                }
                Err(error) => {
                    return self
                        .publish_runtime_failure(
                            session_id,
                            &model_attempt_id,
                            "llm_completion",
                            error.as_ref(),
                            context.parent_session_id.as_deref(),
                        )
                        .await;
                }
            };

            let classification = classify_reply_response(&response).and_then(|decision| {
                if decision.is_none() && effective_phase == "final-reply" {
                    Err("final-reply 阶段只允许标准 reply 工具".to_string())
                } else {
                    Ok(decision)
                }
            });
            match classification {
                Ok(decision) => break (response, decision),
                Err(reason) => {
                    protocol_errors += 1;
                    self.record_reply_protocol_error(
                        session_id,
                        &model_attempt_id,
                        protocol_errors,
                        &reason,
                    )
                    .await?;
                    if protocol_errors > MAX_REPLY_PROTOCOL_RETRIES {
                        return self
                            .publish_reply_protocol_failure(
                                session_id,
                                &model_attempt_id,
                                context.parent_session_id.as_deref(),
                            )
                            .await;
                    }
                    if response.tool_calls.is_empty() && !response.content.trim().is_empty() {
                        protocol_messages.push(Message {
                            role: "assistant".to_string(),
                            content: response.content,
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        });
                    }
                    protocol_messages.push(Message {
                        role: "user".to_string(),
                        content: format!("{reason}。{REPLY_PROTOCOL_ERROR}"),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                }
            }
        };

        if let Some(decision) = reply_decision {
            self.record_terminal_reply_call(
                session_id,
                &attempt_id,
                effective_phase,
                &response,
                &decision,
            )
            .await?;
            return match decision {
                ReplyDecision::Deliver(content) => {
                    self.publish_reply(
                        session_id,
                        &attempt_id,
                        content,
                        context.parent_session_id.as_deref(),
                    )
                    .await
                }
                ReplyDecision::Suppress => {
                    self.publish_reply_suppressed(
                        session_id,
                        &attempt_id,
                        context.parent_session_id.as_deref(),
                    )
                    .await
                }
            };
        }

        debug_assert_ne!(effective_phase, "final-reply");

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
                    transcript_tool_calls: None,
                    allowed_tool_names,
                    record_assistant_call: true,
                },
            )
            .await?;
            return Ok(());
        }

        unreachable!("无工具响应应由 Reply 协议纠错或熔断处理")
    }

    async fn record_reply_protocol_error(
        &self,
        session_id: &str,
        attempt_id: &str,
        error_count: usize,
        reason: &str,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("error_count".to_string(), json!(error_count)),
            ("max_retries".to_string(), json!(MAX_REPLY_PROTOCOL_RETRIES)),
            ("reason".to_string(), json!(reason)),
        ];
        self.append_evaluation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "reply_protocol_error_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/reply_protocol_error".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn publish_reply_protocol_failure(
        &self,
        session_id: &str,
        attempt_id: &str,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            (
                "invalid_responses".to_string(),
                json!(MAX_REPLY_PROTOCOL_RETRIES + 1),
            ),
        ];
        self.append_evaluation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "reply_protocol_fused_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_error".to_string(),
                "runtime/reply_protocol_fused".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        self.publish_reply(
            session_id,
            attempt_id,
            "模型连续三次没有作出合法的 reply(deliver/suppress) 决策，Runtime 已安全熔断本回合；已提交的 Mind、文件修改和 Ledger 均已保留。".to_string(),
            parent_session_id,
        )
        .await
    }

    async fn record_terminal_reply_call(
        &self,
        session_id: &str,
        attempt_id: &str,
        phase: &str,
        response: &crate::llm::Response,
        decision: &ReplyDecision,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let tool_calls = response
            .tool_calls
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
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("phase".to_string(), json!(phase)),
            ("text".to_string(), json!(response.content)),
            ("tool_calls".to_string(), json!(tool_calls)),
            ("terminal_reply".to_string(), json!(true)),
            (
                "reply_disposition".to_string(),
                json!(decision.disposition()),
            ),
        ];
        self.append_evaluation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!("call_{attempt_id}"),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn publish_reply_suppressed(
        &self,
        session_id: &str,
        attempt_id: &str,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let active_background_tasks = active_background_task_count(session_id, context_id.as_str());
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("disposition".to_string(), json!("suppress")),
            ("text".to_string(), json!("")),
            (
                "active_background_tasks".to_string(),
                json!(active_background_tasks),
            ),
        ];
        if let Some(parent_session_id) = parent_session_id {
            payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        self.append_evaluation_route(attempt_id, &mut payload);
        self.append_objective_evaluation_route(session_id, &mut payload);
        let event = Event::new(
            format!(
                "reply_suppressed_{}",
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/reply_suppressed".to_string(),
            payload.into_iter().collect(),
        );
        if self.commit_and_dispatch_reply(attempt_id, &event).await? {
            if let Some(supervisor) = &self.objective_supervisor {
                supervisor.terminal_reply(&event).await?;
            }
        }
        Ok(())
    }

    async fn publish_reply(
        &self,
        session_id: &str,
        attempt_id: &str,
        content: String,
        parent_session_id: Option<&str>,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("disposition".to_string(), json!("deliver")),
            ("text".to_string(), json!(content)),
        ];
        if let Some(parent_session_id) = parent_session_id {
            payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        self.append_evaluation_route(attempt_id, &mut payload);
        self.append_objective_evaluation_route(session_id, &mut payload);
        let event = Event::new(
            format!("reply_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/reply".to_string(),
            payload.into_iter().collect(),
        );
        if self.commit_and_dispatch_reply(attempt_id, &event).await? {
            if let Some(supervisor) = &self.objective_supervisor {
                supervisor.terminal_reply(&event).await?;
            }
        }
        Ok(())
    }

    async fn commit_and_dispatch_reply(
        &self,
        attempt_id: &str,
        event: &Event,
    ) -> Result<bool, DynError> {
        let Some(route) = self.evaluation_route(attempt_id) else {
            self.bus.publish(event.clone()).await?;
            return Ok(true);
        };
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Evaluation reply 需要持久化 SessionStore")?;
        match session_store
            .commit_evaluation_reply(&route.root_turn_id, event)
            .await?
        {
            ReplyCommit::Committed => {
                self.bus.dispatch_persisted(event.clone()).await?;
                Ok(true)
            }
            ReplyCommit::Existing { event_id } => {
                tracing::warn!(
                    root_turn_id = %route.root_turn_id,
                    duplicate_event_id = %event.id,
                    committed_event_id = %event_id,
                    "抑制同一 Root Turn 的重复终态回复"
                );
                Ok(false)
            }
        }
    }

    fn append_objective_evaluation_route(
        &self,
        session_id: &str,
        payload: &mut Vec<(String, serde_json::Value)>,
    ) {
        let Some(active) = self.objective_evaluations.get(session_id) else {
            return;
        };
        payload.extend([
            ("objective_id".to_string(), json!(active.objective_id)),
            (
                "objective_evaluation_id".to_string(),
                json!(active.evaluation_id),
            ),
            ("objective_revision".to_string(), json!(active.revision)),
        ]);
    }

    async fn publish_progress(
        &self,
        session_id: &str,
        attempt_id: &str,
        content: String,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("text".to_string(), json!(content)),
        ];
        self.append_evaluation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!("progress_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/progress".to_string(),
                payload.into_iter().collect(),
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
        let context_id = self.context_id_for_session(session_id)?;
        let error_text: String = error.to_string().chars().take(2_000).collect();
        tracing::error!(
            session_id,
            attempt_id,
            error = %error_text,
            "LLM 请求在重试后失败；终止本回合并向用户返回可见错误"
        );
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("stage".to_string(), json!(stage)),
            ("error".to_string(), json!(error_text)),
        ];
        self.append_evaluation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "runtime_error_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_error".to_string(),
                "chat/runtime_error".to_string(),
                payload.into_iter().collect(),
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
        let context_id = match self.context_id_for_session(session_id) {
            Ok(context_id) => context_id,
            Err(error) => {
                tracing::error!(session_id, %error, "拒绝记录缺少 Context 挂载的模型求值");
                return;
            }
        };
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("phase".to_string(), json!(phase)),
            ("tool_count".to_string(), json!(tool_count)),
            (
                "deadline_secs".to_string(),
                json!(self.orchestrator_config.model_attempt_timeout_secs.max(1)),
            ),
        ];
        self.append_evaluation_route(attempt_id, &mut payload);
        let event = Event::new(
            format!(
                "model_attempt_started_{}",
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ),
            "Runtime-Orchestrator".to_string(),
            "runtime_control".to_string(),
            "runtime/model_attempt_started".to_string(),
            payload.into_iter().collect(),
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
        let context_id = self.context_id_for_session(session_id)?;
        let evaluation_route = self.evaluation_route(attempt_id);
        let read_guard_key = evaluation_route
            .as_ref()
            .map(|route| route.root_turn_id.clone())
            .unwrap_or_else(|| session_id.to_string());
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
        let mut unavailable_tool_calls = Vec::new();
        for call in requested_tool_calls {
            if call.func_name == "context_tx" {
                context_tx_calls.push(call);
            } else if !options.allowed_tool_names.contains(&call.func_name) {
                unavailable_tool_calls.push(call);
            } else {
                selected_tool_calls.push(call);
            }
        }
        let mut deduplicated_context_tx_ids = Vec::new();
        let mut deduplicated_delegate_ids = Vec::new();
        let mut rejected_context_tx_ids = Vec::new();
        let mut context_tx_batch_error = None;
        let mut context_tx_batch_status = None;
        if !options.context_tx_allowed && !context_tx_calls.is_empty() {
            rejected_context_tx_ids.extend(context_tx_calls.into_iter().map(|call| call.id));
            context_tx_batch_status = Some("budget-exhausted".to_string());
            context_tx_batch_error = Some(format!(
                "执行拒绝: CONTEXT_TX_BUDGET_EXHAUSTED：当前用户回合的 Context transaction 已达到 {} 次上限。物理工具与 reply 仍然可用；请使用现有 Mind 继续必要工作，避免连续 housekeeping transaction。",
                self.orchestrator_config.max_context_transactions_per_turn.max(1)
            ));
        } else {
            match context_tx_calls.len() {
                0 => {}
                1 => selected_tool_calls.push(context_tx_calls.remove(0)),
                _ => {
                    let normalized = context_tx_calls
                        .iter()
                        .map(|call| normalize_context_tx_key(&context_id, &call.arguments))
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
        let mut seen_delegations = HashSet::new();
        selected_tool_calls.retain(|call| {
            if call.func_name != "delegate" {
                return true;
            }
            let key = normalized_delegate_key(&call.arguments)
                .unwrap_or_else(|| call.arguments.trim().to_string());
            if seen_delegations.insert(key) {
                true
            } else {
                deduplicated_delegate_ids.push(call.id.clone());
                false
            }
        });
        if !deduplicated_delegate_ids.is_empty() {
            tracing::warn!(
                session_id,
                attempt_id,
                deduplicated = deduplicated_delegate_ids.len(),
                "同一 assistant response 包含语义相同的 delegate；已去重以避免重复派生"
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
        if !unavailable_tool_calls.is_empty() {
            tracing::warn!(
                session_id,
                attempt_id,
                phase,
                rejected = unavailable_tool_calls.len(),
                "模型调用了本轮未提供的工具；Runtime 已拒绝执行"
            );
        }
        let transcript_ids = selected_tool_calls
            .iter()
            .chain(unavailable_tool_calls.iter())
            .map(|call| call.id.as_str())
            .collect::<HashSet<_>>();
        let mut transcript_tool_calls = options.transcript_tool_calls.unwrap_or_else(|| {
            selected_tool_calls
                .iter()
                .chain(unavailable_tool_calls.iter())
                .map(|call| crate::llm::ToolCall {
                    id: call.id.clone(),
                    r#type: call.r#type.clone(),
                    function: crate::llm::FunctionCall {
                        name: call.func_name.clone(),
                        arguments: call.arguments.clone(),
                    },
                })
                .collect::<Vec<_>>()
        });
        transcript_tool_calls.retain(|call| transcript_ids.contains(call.id.as_str()));
        drop(transcript_ids);
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
        let requested_count = mapped_tool_calls.len();
        let selected_call_previews = selected_tool_calls
            .iter()
            .map(tool_call_activity_preview)
            .collect::<Vec<_>>();
        let deduplicated_count =
            deduplicated_context_tx_ids.len() + deduplicated_delegate_ids.len();
        let unavailable_call_ids = unavailable_tool_calls
            .iter()
            .map(|call| call.id.clone())
            .collect::<Vec<_>>();
        let unavailable_call_names = unavailable_tool_calls
            .iter()
            .map(|call| call.func_name.clone())
            .collect::<Vec<_>>();
        let rejected_count = rejected_context_tx_ids.len() + unavailable_tool_calls.len();
        let rejection_status = context_tx_batch_status.clone().or_else(|| {
            (!unavailable_tool_calls.is_empty())
                .then(|| "tool-not-available-in-current-phase".to_string())
        });
        let mut assistant_call_payload = vec![
            ("context_id".to_string(), json!(context_id)),
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
                "deduplicated_delegate_ids".to_string(),
                json!(deduplicated_delegate_ids),
            ),
            (
                "rejected_context_tx_ids".to_string(),
                json!(rejected_context_tx_ids),
            ),
            (
                "context_tx_rejection_status".to_string(),
                json!(context_tx_batch_status),
            ),
            (
                "unavailable_tool_call_ids".to_string(),
                json!(unavailable_call_ids),
            ),
            (
                "unavailable_tool_names".to_string(),
                json!(unavailable_call_names),
            ),
        ];
        if options.record_assistant_call {
            self.append_evaluation_route(attempt_id, &mut assistant_call_payload);
            self.bus
                .publish(Event::new(
                    format!("call_{}", attempt_id),
                    "Agent-Morphz".to_string(),
                    TYPE_AGENT_CALL.to_string(),
                    "chat/assistant_call".to_string(),
                    assistant_call_payload.into_iter().collect(),
                ))
                .await?;
        }
        let mut selected_payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("requested_count".to_string(), json!(requested_count)),
            ("calls".to_string(), json!(selected_call_previews)),
            ("deduplicated_count".to_string(), json!(deduplicated_count)),
            ("rejected_count".to_string(), json!(rejected_count)),
            ("rejection_status".to_string(), json!(rejection_status)),
        ];
        let selected_event_id = format!("tool_calls_selected_{attempt_id}");
        let record_selection = if options.record_assistant_call {
            true
        } else {
            self.context_engine
                .find_event(&context_id, &selected_event_id)
                .await?
                .is_none()
        };
        if record_selection {
            self.append_evaluation_route(attempt_id, &mut selected_payload);
            self.bus
                .publish(Event::new(
                    selected_event_id,
                    "Runtime-Orchestrator".to_string(),
                    "runtime_control".to_string(),
                    "runtime/tool_calls_selected".to_string(),
                    selected_payload.into_iter().collect(),
                ))
                .await?;
        }

        let mut tasks = Vec::new();
        let mut outputs = Vec::<(Event, bool)>::new();
        let mut allowed_tool_names = options
            .allowed_tool_names
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        allowed_tool_names.sort();
        for call in unavailable_tool_calls {
            let output_id = format!("output_{}_{}", attempt_id, call.id);
            if let Some(existing) = self
                .context_engine
                .find_event(&context_id, &output_id)
                .await?
            {
                outputs.push((existing, true));
                continue;
            }
            let guidance = if phase == "critical-maintenance" {
                "当前 Context 处于 critical-maintenance。请不要重复该物理工具调用；先使用 context_tx 压缩并保留继续任务所需的最新状态，等待 Runtime 重新提供物理工具。"
            } else {
                "该工具未在本轮 Function Calling 定义中提供，因此没有执行。请根据当前阶段和 allowed_tools 重新决策。"
            };
            let output = json!({
                "status": "rejected",
                "executed": false,
                "reason": "TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE",
                "phase": phase,
                "tool": call.func_name,
                "allowed_tools": allowed_tool_names,
                "guidance": guidance,
            })
            .to_string();
            let mut payload = vec![
                ("context_id".to_string(), json!(context_id)),
                ("session_id".to_string(), json!(session_id)),
                ("attempt_id".to_string(), json!(attempt_id)),
                ("tool_call_id".to_string(), json!(call.id)),
                ("caused_by".to_string(), json!(call.id)),
                ("tool_name".to_string(), json!(call.func_name)),
                ("tool_status".to_string(), json!("rejected")),
                ("executed".to_string(), json!(false)),
                (
                    "rejection_code".to_string(),
                    json!("TOOL_NOT_AVAILABLE_IN_CURRENT_PHASE"),
                ),
                ("phase".to_string(), json!(phase)),
                ("text".to_string(), json!(output)),
            ];
            self.append_evaluation_route(attempt_id, &mut payload);
            outputs.push((
                Event::new(
                    output_id,
                    "System-ToolPolicy".to_string(),
                    TYPE_TOOL_OUTPUT.to_string(),
                    "chat/tool_output".to_string(),
                    payload.into_iter().collect(),
                ),
                false,
            ));
        }
        for call in selected_tool_calls {
            let output_id = format!("output_{}_{}", attempt_id, call.id);
            if let Some(existing) = self
                .context_engine
                .find_event(&context_id, &output_id)
                .await?
            {
                outputs.push((existing, true));
                continue;
            }
            if matches!(call.func_name.as_str(), "write" | "edit") {
                self.read_guard(&read_guard_key)
                    .lock()
                    .await
                    .invalidate_path_from_arguments(&call.arguments);
            }
            if call.func_name == "read" {
                let evidence_event_id = format!("output_{}_{}", attempt_id, call.id);
                let duplicate = self
                    .read_guard(&read_guard_key)
                    .lock()
                    .await
                    .reserve(&call.arguments, &evidence_event_id);
                if let Some(duplicate) = duplicate {
                    let reference = self
                        .context_engine
                        .find_event(&context_id, &duplicate.evidence_event_id)
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
                    let mut payload = vec![
                        ("context_id".to_string(), json!(context_id)),
                        ("session_id".to_string(), json!(session_id)),
                        ("attempt_id".to_string(), json!(attempt_id)),
                        ("tool_call_id".to_string(), json!(call.id)),
                        ("caused_by".to_string(), json!(call.id)),
                        ("tool_name".to_string(), json!(call.func_name)),
                        ("tool_status".to_string(), json!("guarded")),
                        ("read_guard_status".to_string(), json!("already-covered")),
                        ("text".to_string(), json!(output)),
                    ];
                    self.append_evaluation_route(attempt_id, &mut payload);
                    outputs.push((
                        Event::new(
                            output_id,
                            "System-ReadGuard".to_string(),
                            TYPE_TOOL_OUTPUT.to_string(),
                            "chat/tool_output".to_string(),
                            payload.into_iter().collect(),
                        ),
                        false,
                    ));
                    continue;
                }
            }
            let registry = Arc::clone(&self.registry);
            let session_id = session_id.to_string();
            let context_id = context_id.clone();
            let attempt_id = attempt_id.to_string();
            let evaluation_route = evaluation_route.clone();
            let tool_causal_route =
                evaluation_route
                    .as_ref()
                    .map(|route| crate::tool::ToolCausalRoute {
                        work_item_id: route.work_item_id.clone(),
                        root_turn_id: route.root_turn_id.clone(),
                        trigger_event_id: route.trigger_event_id.clone(),
                        trigger_sequence: route.trigger_sequence,
                    });
            let timeout_secs = self.orchestrator_config.tool_timeout_secs;
            tasks.push(tokio::spawn(async move {
                crate::tool::CURRENT_CAUSAL_ROUTE
                    .scope(tool_causal_route, async move {
                        crate::tool::CURRENT_ATTEMPT_ID
                            .scope(attempt_id.clone(), async move {
                                crate::tool::CURRENT_CONTEXT_ID
                                    .scope(context_id.clone(), async move {
                                        crate::tool::CURRENT_SESSION_ID
                                            .scope(session_id.clone(), async move {
                                                let result = tokio::time::timeout(
                                                    tokio::time::Duration::from_secs(timeout_secs),
                                                    async {
                                                        match registry.get(&call.func_name) {
                                                            Some(tool) => {
                                                                tool.execute(&call.arguments).await
                                                            }
                                                            None => Err(format!(
                                                                "未注册的工具: {}",
                                                                call.func_name
                                                            )
                                                            .into()),
                                                        }
                                                    },
                                                )
                                                .await;
                                                let (output, tool_status) = match result {
                                                    Ok(Ok(output)) => {
                                                        let status = infer_tool_status(&output);
                                                        (output, status)
                                                    }
                                                    Ok(Err(error)) => {
                                                        (format!("执行失败: {}", error), "error")
                                                    }
                                                    Err(_) => (
                                                        format!(
                                                            "执行超时: 超过 {} 秒限额",
                                                            timeout_secs
                                                        ),
                                                        "timeout",
                                                    ),
                                                };
                                                let wake_policy = if call.func_name == "delegate"
                                                    && tool_status == "success"
                                                    && delegation_mode_from_arguments(
                                                        &call.arguments,
                                                    ) != "detached"
                                                {
                                                    "delegation_result"
                                                } else {
                                                    "immediate"
                                                };
                                                let output_empty = output.trim().is_empty();
                                                let mut payload = vec![
                                                    ("context_id".to_string(), json!(context_id)),
                                                    ("session_id".to_string(), json!(session_id)),
                                                    ("attempt_id".to_string(), json!(attempt_id)),
                                                    ("tool_call_id".to_string(), json!(call.id)),
                                                    ("caused_by".to_string(), json!(call.id)),
                                                    (
                                                        "tool_name".to_string(),
                                                        json!(call.func_name),
                                                    ),
                                                    ("tool_status".to_string(), json!(tool_status)),
                                                    ("wake_policy".to_string(), json!(wake_policy)),
                                                    (
                                                        "output_empty".to_string(),
                                                        json!(output_empty),
                                                    ),
                                                    ("text".to_string(), json!(output)),
                                                ]
                                                .into_iter()
                                                .collect::<serde_json::Map<_, _>>();
                                                if let Some(route) = evaluation_route {
                                                    payload.insert(
                                                        "work_item_id".to_string(),
                                                        json!(route.work_item_id),
                                                    );
                                                    payload.insert(
                                                        "root_turn_id".to_string(),
                                                        json!(route.root_turn_id),
                                                    );
                                                    payload.insert(
                                                        "trigger_event_id".to_string(),
                                                        json!(route.trigger_event_id),
                                                    );
                                                    payload.insert(
                                                        "trigger_sequence".to_string(),
                                                        json!(route.trigger_sequence),
                                                    );
                                                    if let Some(version) =
                                                        route.context_snapshot_version
                                                    {
                                                        payload.insert(
                                                            "context_snapshot_version".to_string(),
                                                            json!(version),
                                                        );
                                                    }
                                                }
                                                if call.func_name == "exec" {
                                                    extend_exec_output_facts(&mut payload, &output);
                                                }
                                                Event::new(
                                                    format!("output_{}_{}", attempt_id, call.id),
                                                    "System-Executor".to_string(),
                                                    TYPE_TOOL_OUTPUT.to_string(),
                                                    "chat/tool_output".to_string(),
                                                    payload,
                                                )
                                            })
                                            .await
                                    })
                                    .await
                            })
                            .await
                    })
                    .await
            }));
        }

        if let Some(error) = context_tx_batch_error {
            let output_id = format!("output_{}_context_tx_batch_rejected", attempt_id);
            if let Some(existing) = self
                .context_engine
                .find_event(&context_id, &output_id)
                .await?
            {
                outputs.push((existing, true));
            } else {
                let mut payload = vec![
                    ("context_id".to_string(), json!(context_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    (
                        "tool_call_id".to_string(),
                        json!("context_tx_batch_rejected"),
                    ),
                    ("caused_by".to_string(), json!("context_tx_batch_rejected")),
                    ("tool_name".to_string(), json!("context_tx")),
                    ("tool_status".to_string(), json!("rejected")),
                    (
                        "context_tx_status".to_string(),
                        json!(context_tx_batch_status.as_deref().unwrap_or("rejected")),
                    ),
                    ("text".to_string(), json!(error)),
                ];
                self.append_evaluation_route(attempt_id, &mut payload);
                outputs.push((
                    Event::new(
                        output_id,
                        "System-ContextGuard".to_string(),
                        TYPE_TOOL_OUTPUT.to_string(),
                        "chat/tool_output".to_string(),
                        payload.into_iter().collect(),
                    ),
                    false,
                ));
            }
        }
        for task in tasks {
            match task.await {
                Ok(output) => outputs.push((output, false)),
                Err(error) => tracing::error!(?error, "工具任务 join 失败"),
            }
        }
        if outputs.is_empty() {
            return Err("所有工具任务都在产生结果前异常终止".into());
        }
        let mut outcome = ToolExecutionOutcome::default();
        for (output, _) in &outputs {
            if output
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("context_tx")
            {
                outcome.context_tx_succeeded = context_tx_output_succeeded(output);
            }
        }
        let wake_index = options
            .wake_on_output
            .then(|| {
                outputs.iter().rposition(|(output, _)| {
                    output
                        .payload
                        .get("wake_policy")
                        .and_then(|value| value.as_str())
                        != Some("delegation_result")
                })
            })
            .flatten();
        for (index, (output, already_persisted)) in outputs.into_iter().enumerate() {
            if wake_index == Some(index) {
                if already_persisted {
                    self.bus.dispatch_persisted(output).await?;
                } else {
                    self.bus.publish(output).await?;
                }
            } else if !already_persisted {
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
            .find_event(&context.context_id, event_id)
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
        let mut payload = vec![
            ("context_id".to_string(), json!(context.context_id)),
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
        ];
        self.append_evaluation_route(attempt_id, &mut payload);
        let event = Event::new(
            format!("context_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "System-ContextKernel".to_string(),
            crate::event::TYPE_PROPOSAL.to_string(),
            "chat/context_inspect".to_string(),
            payload.into_iter().collect(),
        );
        tokio::spawn(async move {
            if let Err(error) = bus.publish(event).await {
                tracing::error!(?error, "记录 context_inspect 失败");
            }
        });
    }

    fn session_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.session_locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn evaluation_route(&self, attempt_id: &str) -> Option<EvaluationRoute> {
        self.evaluation_routes
            .get(attempt_id)
            .map(|route| route.clone())
            .or_else(|| {
                attempt_id
                    .split_once("_reply_retry_")
                    .and_then(|(base, _)| {
                        self.evaluation_routes.get(base).map(|route| route.clone())
                    })
            })
    }

    fn append_evaluation_route(
        &self,
        attempt_id: &str,
        payload: &mut Vec<(String, serde_json::Value)>,
    ) {
        let Some(route) = self.evaluation_route(attempt_id) else {
            return;
        };
        payload.extend([
            ("work_item_id".to_string(), json!(route.work_item_id)),
            ("root_turn_id".to_string(), json!(route.root_turn_id)),
            (
                "trigger_event_id".to_string(),
                json!(route.trigger_event_id),
            ),
            (
                "trigger_sequence".to_string(),
                json!(route.trigger_sequence),
            ),
        ]);
        if let Some(version) = route.context_snapshot_version {
            payload.push(("context_snapshot_version".to_string(), json!(version)));
        }
        if !payload.iter().any(|(key, _)| key == "caused_by") {
            payload.push(("caused_by".to_string(), json!(route.trigger_event_id)));
        }
    }

    fn context_id_for_session(&self, session_id: &str) -> Result<String, DynError> {
        self.session_contexts
            .get(session_id)
            .map(|value| value.clone())
            .ok_or_else(|| format!("Session '{session_id}' 没有挂载 Cognitive Context").into())
    }

    fn cancellation_sender(&self, session_id: &str) -> watch::Sender<u64> {
        self.cancellation_epochs
            .entry(session_id.to_string())
            .or_insert_with(|| watch::channel(0).0)
            .clone()
    }

    fn active_counter(&self, session_id: &str) -> Arc<AtomicUsize> {
        self.active_session_turns
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
            .clone()
    }

    /// Cancels attempts already running or queued for this Session. Later tool
    /// completions stay suppressed until a new explicit user message resumes it.
    pub fn cancel_session(&self, session_id: &str) -> bool {
        let active = self
            .active_session_turns
            .get(session_id)
            .is_some_and(|value| value.load(Ordering::SeqCst) > 0);
        self.cancelled_at.insert(session_id.to_string(), Utc::now());
        let sender = self.cancellation_sender(session_id);
        let next = (*sender.borrow()).wrapping_add(1);
        sender.send_replace(next);
        active
    }

    pub fn resume_session(&self, session_id: &str) {
        self.cancelled_at.remove(session_id);
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
        let context_id = self.context_id_for_session(session_id)?;
        let view = self
            .context_engine
            .build_context_encoding(&context_id, session_id, &HashSet::new())
            .await?;
        Ok(crate::sexpr::parse(&view.sexpr)?)
    }

    pub async fn get_current_context_view(
        &self,
        session_id: &str,
    ) -> Result<ContextView, DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        self.context_engine
            .build_context_encoding(&context_id, session_id, &HashSet::new())
            .await
    }

    pub async fn get_context_encoding(
        &self,
        context_id: &str,
        active_session_id: &str,
    ) -> Result<ContextView, DynError> {
        self.session_contexts
            .insert(active_session_id.to_string(), context_id.to_string());
        self.context_engine
            .build_context_encoding(context_id, active_session_id, &HashSet::new())
            .await
    }

    pub async fn seed_context_from_mind(
        &self,
        source_context_id: &str,
        source_version: Option<u64>,
        target_context_id: &str,
    ) -> Result<crate::orchestrator::context::MindSeedReceipt, DynError> {
        self.context_engine
            .seed_context_from_mind(source_context_id, source_version, target_context_id)
            .await
    }

    pub async fn mind_version(&self, context_id: &str) -> Result<u64, DynError> {
        self.context_engine.mind_version(context_id).await
    }

    pub async fn import_session_projection(
        &self,
        source_context_id: &str,
        source_session_id: &str,
        target_context_id: &str,
        target_session_id: &str,
    ) -> Result<usize, DynError> {
        self.context_engine
            .import_session_projection(
                source_context_id,
                source_session_id,
                target_context_id,
                target_session_id,
            )
            .await
    }

    pub fn register_session_context(&self, session_id: &str, context_id: &str) {
        self.session_contexts
            .insert(session_id.to_string(), context_id.to_string());
    }
}

fn compact_context_inspect_for_persistence(event: &mut Event) {
    if event.topic != "chat/context_inspect" {
        return;
    }
    let mut components = serde_json::Map::new();
    for key in ["text", "messages", "mind", "inbox"] {
        let Some(value) = event.payload.remove(key) else {
            continue;
        };
        let encoded = serde_json::to_vec(&value).unwrap_or_default();
        let chars = value.as_str().map_or_else(
            || String::from_utf8_lossy(&encoded).chars().count(),
            |text| text.chars().count(),
        );
        components.insert(
            key.to_string(),
            json!({
                "sha256": format!("{:x}", Sha256::digest(&encoded)),
                "bytes": encoded.len(),
                "chars": chars,
                "items": value.as_array().map(Vec::len),
            }),
        );
    }
    event
        .payload
        .insert("storage".to_string(), json!("compact-v1"));
    event.payload.insert(
        "components".to_string(),
        serde_json::Value::Object(components),
    );
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

fn extend_exec_output_facts(
    payload: &mut serde_json::Map<String, serde_json::Value>,
    output: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return;
    };
    for key in [
        "execution",
        "process_status",
        "exit_code",
        "task_status",
        "task_id",
        "effective_boundary",
        "artifact_path",
    ] {
        if let Some(value) = value.get(key) {
            payload.insert(key.to_string(), value.clone());
        }
    }
}

fn delegation_mode_from_arguments(arguments: &str) -> &str {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("mode")
                .and_then(|mode| mode.as_str())
                .map(ToOwned::to_owned)
        })
        .map(|mode| {
            if mode == "detached" {
                "detached"
            } else {
                "attached"
            }
        })
        .unwrap_or("attached")
}

fn normalized_delegate_key(arguments: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(arguments).ok()?;
    let task = value.get("task")?.as_str()?.trim();
    let success_when = value
        .get("success_when")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim();
    let context_scope = value
        .get("context_scope")
        .and_then(|value| value.as_str())
        .unwrap_or("current_session");
    let mode = value
        .get("mode")
        .and_then(|value| value.as_str())
        .unwrap_or("attached");
    Some(format!(
        "{task}\u{1f}{success_when}\u{1f}{context_scope}\u{1f}{mode}"
    ))
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
    matches!(phase, "work" | "soft-checkpoint") && pressure == "critical" && !context_tx_available
}

fn tool_call_activity_preview(call: &crate::llm::ToolCallRepr) -> serde_json::Value {
    let original_chars = call.arguments.chars().count();
    let mut arguments = serde_json::from_str::<serde_json::Value>(&call.arguments)
        .map(|mut value| {
            redact_sensitive_tool_arguments(&mut value);
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| call.arguments.clone())
        })
        .unwrap_or_else(|_| call.arguments.clone());
    let rendered_chars = arguments.chars().count();
    let truncated = rendered_chars > TOOL_ARGUMENT_PREVIEW_CHARS;
    if truncated {
        arguments = arguments
            .chars()
            .take(TOOL_ARGUMENT_PREVIEW_CHARS)
            .collect::<String>();
        arguments.push_str(&format!("\n… <参数预览已截断，共 {rendered_chars} 字符>"));
    }
    json!({
        "id": call.id,
        "name": call.func_name,
        "arguments": arguments,
        "arguments_chars": original_chars,
        "truncated": truncated,
    })
}

fn redact_sensitive_tool_arguments(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if is_sensitive_argument_key(key) {
                    *value = serde_json::Value::String("[REDACTED]".to_string());
                } else {
                    redact_sensitive_tool_arguments(value);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_sensitive_tool_arguments(value);
            }
        }
        _ => {}
    }
}

fn is_sensitive_argument_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "password"
            | "passwd"
            | "secret"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "authtoken"
            | "authorization"
            | "cookie"
            | "setcookie"
            | "privatekey"
            | "clientsecret"
    ) || [
        "password",
        "passwd",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "privatekey",
        "clientsecret",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn normalize_context_tx_key(context_id: &str, arguments: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(arguments).map_err(|error| format!("参数 JSON 非法: {error}"))?;
    let transaction = value
        .get("transaction")
        .and_then(|value| value.as_str())
        .ok_or("缺少 transaction 字符串")?;
    let canonical = crate::sexpr::parse(transaction)
        .map_err(|error| format!("transaction SExpr 非法: {error}"))?
        .to_string();
    Ok(format!("{context_id}\u{0}{canonical}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        baseline_system_prompt, classify_reply_response, cognitive_sexpr_vm_system_prompt,
        compact_context_inspect_for_persistence, compose_system_prompt, extend_exec_output_facts,
        render_system_contract, semantic_sexpr_vm_system_prompt,
        should_force_final_for_maintenance, tool_call_activity_preview, ReadTurnGuard,
        ReplyDecision, SystemPromptMode, AGENT_OWNED_CONTEXT_PROMPT_BASE,
    };
    use crate::event::Event;

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
    fn semantic_vm_prompt_is_a_parseable_third_profile_with_shared_rules() {
        let baseline = baseline_system_prompt();
        let cognitive = cognitive_sexpr_vm_system_prompt();
        let semantic = semantic_sexpr_vm_system_prompt();
        assert_ne!(semantic, baseline);
        assert_ne!(semantic, cognitive);
        assert!(semantic.starts_with("(system-prompt morphz"));
        crate::sexpr::parse(semantic).expect("semantic profile must be one S-expression");
        for marker in [
            "(operator seq",
            "(operator call",
            "(operator fallback",
            "(operator bind",
            "(operator if",
            "(operator reply",
            "reply no-reply",
            "runtime-contracts",
            "reality-contract-v1",
            "claims-no-stronger-than-sources",
            "每次响应必须明确选择",
        ] {
            assert!(semantic.contains(marker), "missing marker: {marker}");
        }
        for leaked_task_hint in ["ALPHA", "BETA", "CHARLIE", "approved-current"] {
            assert!(!semantic.contains(leaked_task_hint));
        }
    }

    #[test]
    fn semantic_vm_dynamic_directives_remain_inside_one_sexpr() {
        let stable = semantic_sexpr_vm_system_prompt();
        let composed = compose_system_prompt(
            SystemPromptMode::SemanticSexprVm,
            stable,
            Some(("final-reply", "只调用 reply")),
        );
        assert!(composed.starts_with("(system-evaluation"));
        assert!(composed.contains("(runtime-directive"));
        assert!(composed.contains("(kind final-reply)"));
        crate::sexpr::parse(&composed).expect("dynamic semantic prompt must remain one SExpr");

        let cognitive = compose_system_prompt(
            SystemPromptMode::CognitiveSexprVm,
            cognitive_sexpr_vm_system_prompt(),
            Some(("final-reply", "只调用 reply")),
        );
        assert!(cognitive.ends_with("只调用 reply"));
    }

    #[test]
    fn reply_classifier_requires_an_explicit_exclusive_terminal_decision() {
        let plain = crate::llm::Response {
            content: "done".to_string(),
            tool_calls: Vec::new(),
        };
        assert!(classify_reply_response(&plain).is_err());

        let deliver = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: "reply-1".to_string(),
                r#type: "function".to_string(),
                func_name: "reply".to_string(),
                arguments: json!({"disposition":"deliver","content":"done"}).to_string(),
            }],
        };
        assert_eq!(
            classify_reply_response(&deliver),
            Ok(Some(ReplyDecision::Deliver("done".to_string())))
        );

        let suppress = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: "reply-2".to_string(),
                r#type: "function".to_string(),
                func_name: "reply".to_string(),
                arguments: json!({"disposition":"suppress"}).to_string(),
            }],
        };
        assert_eq!(
            classify_reply_response(&suppress),
            Ok(Some(ReplyDecision::Suppress))
        );
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
        assert!(should_force_final_for_maintenance(
            "soft-checkpoint",
            "critical",
            false
        ));
    }

    #[test]
    fn tool_call_activity_preview_is_structured_redacted_and_bounded() {
        let secret_call = crate::llm::ToolCallRepr {
            id: "exec-1".to_string(),
            r#type: "function".to_string(),
            func_name: "exec".to_string(),
            arguments: json!({
                "cmd": "run",
                "env": {
                    "OPENAI_API_KEY": "local-secret",
                    "max_tokens": 128000
                }
            })
            .to_string(),
        };
        let secret_preview = tool_call_activity_preview(&secret_call);
        let arguments = secret_preview["arguments"].as_str().unwrap();
        assert_eq!(secret_preview["name"], "exec");
        assert_eq!(secret_preview["truncated"], false);
        assert!(arguments.contains("[REDACTED]"));
        assert!(!arguments.contains("local-secret"));
        assert!(arguments.contains("max_tokens"));

        let long_call = crate::llm::ToolCallRepr {
            id: "write-1".to_string(),
            r#type: "function".to_string(),
            func_name: "write".to_string(),
            arguments: json!({"body": "x".repeat(5_000)}).to_string(),
        };
        let long_preview = tool_call_activity_preview(&long_call);
        assert_eq!(long_preview["truncated"], true);
        assert!(long_preview["arguments"]
            .as_str()
            .unwrap()
            .contains("参数预览已截断"));
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

    #[test]
    fn compact_context_inspect_persists_hashes_instead_of_duplicate_prompt_bodies() {
        let mut event = Event::new(
            "inspect-1".to_string(),
            "kernel".to_string(),
            "proposal".to_string(),
            "chat/context_inspect".to_string(),
            serde_json::Map::from_iter([
                ("context_id".to_string(), json!("context-1")),
                ("text".to_string(), json!("(context large-body)")),
                (
                    "messages".to_string(),
                    json!([{"role":"user","content":"hello"}]),
                ),
                ("mind".to_string(), json!({"frames": ["a", "b"]})),
                ("inbox".to_string(), json!([{"ref":"@e1"}])),
                ("pressure".to_string(), json!({"level":"warning"})),
            ]),
        );

        compact_context_inspect_for_persistence(&mut event);

        assert_eq!(event.payload["storage"], "compact-v1");
        assert_eq!(event.payload["context_id"], "context-1");
        assert_eq!(event.payload["pressure"]["level"], "warning");
        for key in ["text", "messages", "mind", "inbox"] {
            assert!(!event.payload.contains_key(key));
            assert_eq!(
                event.payload["components"][key]["sha256"]
                    .as_str()
                    .unwrap()
                    .len(),
                64
            );
            assert!(event.payload["components"][key]["bytes"].as_u64().unwrap() > 0);
        }
    }

    #[test]
    fn exec_results_expose_physical_facts_without_copying_output_fields() {
        let mut payload = serde_json::Map::new();
        extend_exec_output_facts(
            &mut payload,
            &json!({
                "kind":"exec_result",
                "execution":"completed",
                "process_status":"failed",
                "exit_code":7,
                "effective_boundary":{"network_enabled":false},
                "artifact_path":"/tmp/task.log",
                "output":"boom"
            })
            .to_string(),
        );
        assert_eq!(payload["process_status"], "failed");
        assert_eq!(payload["exit_code"], 7);
        assert_eq!(payload["effective_boundary"]["network_enabled"], false);
        assert_eq!(payload["artifact_path"], "/tmp/task.log");
        assert!(!payload.contains_key("output"));
    }
}
