use crate::activation_admission::{
    ActivationAdmissionController, ActivationAdmissionError, ActivationAdmissionLimits,
    ActivationAdmissionPermit, RestoreQueuedOutcome,
};
use crate::admission::{AdmissionClass, AdmissionKey};
use crate::approval::{ApprovalDecision, ApprovalRequest, HumanApprovalHub};
use crate::approval_authority::stable_approval_identity;
use crate::config::OrchestratorConfig;
use crate::event::{Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
use crate::execution::{
    ExecutionJobManager, ExecutionJobSpec, JobClaim, JobHeartbeat, JobOutcome, JobReceipt,
};
use crate::llm::{Client, Message, PromptTokenCount};
use crate::memory::{
    ActivationOutcomeCommit, ApprovalFilter, ApprovalMutation, ApprovalRecord, ApprovalResolution,
    ApprovalStatus, ApprovalStore, DelegationStatus, DeliveryFlushCommit, EventAppend, EventStore,
    ExecutionApprovalMutation, ExecutionApprovalStore, ExecutionJobFilter, ExecutionJobRecord,
    ExecutionJobStatus, ExecutionJobStore, NewApprovalRequest, NewCognitiveContext, NewDelegation,
    NewExecutionJob, NewRuntimeTimer, NewSession, NewThread, NewThreadActivation, NewThreadSignal,
    QueryFilter, RuntimeTimerKind, RuntimeTimerRecord, ScheduleStatus, SessionAttentionState,
    SessionAttentionUpdate, SessionMountKind, SessionStatus, SessionStore, SessionUpdate,
    SignalOutboxStatus, ThreadActivationMutation, ThreadActivationRecord, ThreadActivationStatus,
    ThreadKind, ThreadLifecycle, ThreadMutation, ThreadRecord,
};
use crate::objective::{ObjectiveEvaluationRegistry, ObjectiveSupervisor};
use crate::orchestrator::context::{ContextEngine, ContextView};
use crate::orchestrator::context_contract::{render_system_contract, render_system_contract_sexpr};
use crate::permission::{DurableApprovalGrant, PermissionBroker};
use crate::sexpr::SExpr;
use crate::sexpr_vm_contract::ANNOTATED_RESPONSE_KERNEL;
use crate::timer::{TimerDisposition, TimerEngine};
use crate::tool::{
    active_background_task_count, active_background_task_count_for_root, BackgroundTaskScheduler,
    Registry, ThreadScheduler, Tool,
};
use chrono::Utc;
use dashmap::DashMap;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::{mpsc, oneshot, watch, Mutex, Notify};

type DynError = Box<dyn std::error::Error + Send + Sync>;

struct DurableEventWriteRequest {
    entry: EventAppend,
    committed: oneshot::Sender<Result<(), String>>,
}

#[derive(Default)]
struct DurableEventWriterMetrics {
    queue_depth: AtomicUsize,
    committed_events: AtomicU64,
    committed_batches: AtomicU64,
    failed_batches: AtomicU64,
    largest_batch: AtomicUsize,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct DurableEventWriterMetricsSnapshot {
    pub queue_depth: usize,
    pub committed_events: u64,
    pub committed_batches: u64,
    pub failed_batches: u64,
    pub largest_batch: usize,
}

impl DurableEventWriterMetrics {
    fn snapshot(&self) -> DurableEventWriterMetricsSnapshot {
        DurableEventWriterMetricsSnapshot {
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
            committed_events: self.committed_events.load(Ordering::Relaxed),
            committed_batches: self.committed_batches.load(Ordering::Relaxed),
            failed_batches: self.failed_batches.load(Ordering::Relaxed),
            largest_batch: self.largest_batch.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
struct DurableEventWriter {
    sender: mpsc::Sender<DurableEventWriteRequest>,
    metrics: Arc<DurableEventWriterMetrics>,
}

impl DurableEventWriter {
    fn spawn(
        store: Arc<dyn EventStore>,
        config: &crate::config::EventWriterConfig,
        metrics: Arc<DurableEventWriterMetrics>,
    ) -> Self {
        let queue_capacity = config.queue_capacity.max(1);
        let max_batch_size = config.max_batch_size.max(1);
        let flush_interval = std::time::Duration::from_millis(config.flush_interval_ms);
        let (sender, mut receiver) = mpsc::channel::<DurableEventWriteRequest>(queue_capacity);
        let writer_metrics = Arc::clone(&metrics);
        tokio::spawn(async move {
            while let Some(first) = receiver.recv().await {
                let mut requests = vec![first];
                let deadline = tokio::time::Instant::now() + flush_interval;
                while requests.len() < max_batch_size {
                    match tokio::time::timeout_at(deadline, receiver.recv()).await {
                        Ok(Some(request)) => requests.push(request),
                        Ok(None) | Err(_) => break,
                    }
                }
                let mut entries = Vec::with_capacity(requests.len());
                let mut completions = Vec::with_capacity(requests.len());
                for request in requests {
                    entries.push(request.entry);
                    completions.push(request.committed);
                }
                let batch_size = entries.len();
                let result = store
                    .append_batch(entries)
                    .await
                    .map_err(|error| error.to_string());
                writer_metrics
                    .queue_depth
                    .fetch_sub(batch_size, Ordering::Relaxed);
                match &result {
                    Ok(()) => {
                        writer_metrics
                            .committed_events
                            .fetch_add(batch_size as u64, Ordering::Relaxed);
                        writer_metrics
                            .committed_batches
                            .fetch_add(1, Ordering::Relaxed);
                        writer_metrics
                            .largest_batch
                            .fetch_max(batch_size, Ordering::Relaxed);
                        tracing::debug!(batch_size, "Durable Event group commit 完成");
                    }
                    Err(error) => {
                        writer_metrics
                            .failed_batches
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::error!(batch_size, error, "Durable Event group commit 失败");
                    }
                }
                for committed in completions {
                    let _ = committed.send(result.clone());
                }
            }
        });
        Self { sender, metrics }
    }

    async fn append(&self, entry: EventAppend) -> Result<(), DynError> {
        let (committed, receiver) = oneshot::channel();
        self.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
        if self
            .sender
            .send(DurableEventWriteRequest { entry, committed })
            .await
            .is_err()
        {
            self.metrics.queue_depth.fetch_sub(1, Ordering::Relaxed);
            return Err(std::io::Error::other("Durable Event Writer 已停止").into());
        }
        match receiver.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(std::io::Error::other(error).into()),
            Err(_) => Err(std::io::Error::other("Durable Event Writer 未返回提交结果").into()),
        }
    }
}
const MAX_ACTIVATION_SIGNAL_BATCH: usize = 32;
const SIGNAL_OUTBOX_DISPATCH_BATCH: usize = 128;
const SIGNAL_OUTBOX_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

const AGENT_OWNED_CONTEXT_PROMPT_BASE: &str = r#"你是 Morphz，一个能够管理自身工作 Context 的 AI Agent。

Runtime 每轮提供一份自描述 Context。`protocol` 是当前响应模式与 Context DSL 的权威契约；先读取它，再决策。

Context 的状态分为三个权限域：
- kernel：Runtime 拥有，只读。包含 Context 身份、本次求值的 active-session、context version 和物理压力。
- mind：你拥有的长期工作注意力，由稳定 ID 的自由格式 frame 组成。
- inbox：Event Ledger 中尚未被你 retire 的原始 observation。它们是证据，不是 Runtime 替你形成的结论。

一个 Cognitive Context 只有一个共享 Mind，但可以包含多个 Session。Session 是输入输出连接和任务进展边界，不拥有独立 Mind。`kernel.active-session` 只表示本次求值应读取和回复的 Session；它不是 Context 的全局唯一活动状态，其他 Session 可能正在并发求值。inbox 中每条 observation 的 `session` 标记来源，你可以在共享 Context 内跨 Session 复用信息，但当前响应必须路由回 active-session，不能混淆各 Session 的请求和进展。context_tx 修改共享 Mind，由 Runtime 以 Context 为粒度串行提交并校验版本。

每个 Session 有一条长期 Dialogue Lane，用来排序普通对话的首次求值；每条用户输入都会创建一条独立、有限的 DialogueTurn Thread。从某个对话 turn 发起、由工具结果继续推进的工作属于独立 Execution Thread。工具结果只产生其所属 Thread 的 Signal，新用户消息创建新的 DialogueTurn Thread，不应接管或重复旧 Execution Thread。一次模型请求只属于一个 Thread Activation；Context 最后的 `evaluate` 表达式声明本轮唯一活动 Thread、Activation 所领取的 Signal batch、原始输入及 Objective 绑定，是本次执行的权威入口。

你必须自己判断当前目标下什么值得保留、摘要、修订、保护、恢复或遗忘。Runtime 不会自动替你摘要历史、裁剪旧消息或把检索结果写成事实。

每次响应必须明确选择 `protocol.response-contract` 中的一种主模式：
- reply：当前 Evaluation 已到可交付边界时，返回非空普通 assistant 文本且不调用工具。Runtime 将文本流式路由到 kernel.active-session，并在完整响应成功后持久化为终态回复。存在 active Objective 时，它只结束本次 Evaluation，不能代替 objective_update(completed)。
- no-reply：确认本次 Evaluation 无需向 active Session 发送任何消息时，独占调用无参数的 no_reply。DialogueTurn Thread 中它结束本次求值；仍有后台任务的 Execution Thread 中它表示 yield/wait，Thread 保持非终态并在物理事件到达后继续。它不代表 Objective 完成，也不取消后台任务。
- act：确实需要新的外部结果；调用物理工具，可并行附带一个不依赖这些新结果的 context_tx；若有正文则只是可见进度，Runtime 执行工具后必定再次调用你。
- maintain：需要先修改 Mind 时可单独调用 context_tx，不输出最终正文。事务成功后 Runtime 必定再次调用你，并在非 critical 时暂时隐藏 context_tx；maintain 不是用户回合终点，下一响应必须 reply、no-reply 或 act。
- schedule：需要决定串行、并行、依赖或定时执行时，独占调用一次 schedule_tx。enqueue 把意图加入既有 Thread，spawn 创建并行 Thread；not_before/delay_seconds 设置定时，after 设置依赖。inspect 读取调度及 revision；pause/resume/reschedule/cancel 是带 expected_revision 的 CAS 控制，冲突时必须重新 inspect 后再决策，不得盲目重试。每次控制只能包含一个 op。schedule_tx 只提交调度，不代替物理工具，也不结束当前 Evaluation；收到回执后再向 active Session 说明安排。

每个模型请求只有一个 kernel.active-session，普通文本只路由到它。需要主动向同一 Agent 的其他 Session 发送消息时，调用 send_message；该工具不结束当前 Evaluation，也不触发目标 Session 的新求值。context_tx 永远不能代替 Session 消息输出。空响应不是终态；Runtime 会返回协议错误并有限重试。

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
5. context_tx 可以与不依赖本批新结果的物理工具并行；如果新 frame 依赖工具结果，应等结果返回后再提交。当前用户回合内，Runtime 按标准 assistant.tool_calls → role=tool/tool_call_id 返回工具结果；物理结果已同时持久化到 Ledger，并带 observation_ref。同一请求的 Context View 不会重复注入这批结果正文，下一独立快照才按 active/retired 状态展示。status=success 且 output_state=empty 表示工具已经完成但没有文本，不得仅因空输出重复调用。任何包含工具调用的响应都是中间状态：正文只作为当前 Session 的可见进度，Runtime 执行完工具后必定再次调用你。最终回复必须是无工具的普通文本，no_reply 必须独占。
6. 同一响应最多提交一个 context_tx；把多个修改合并进同一事务，避免版本冲突。
   retire 或 unprotect 时 reason 是必需的，使遗忘与解除保护可审计。
7. pressure=normal/notice 时不要仅为降低体积而压缩；只在出现必须跨轮保留的目标、约束或结论变化时做语义维护。pressure=warning 时考虑在最终文本前或随 act 提交压缩事务；pressure=critical 时必须先 maintain-only 释放预算。
8. 完成任务前，确认 Mind 中仍需跨轮保留的目标、约束、结论和开放问题准确；若物理工具结果改变了任务状态，在最终文本之前用一次 context_tx 完成收口。Runtime 会在事务回执后再次调用你，届时返回普通文本或独占调用 no_reply。
9. assistant_call 与 context_tx 回执属于 Runtime 控制轨迹，只保存在 Ledger，不会进入 Inbox；不要为了清理 context_tx 自己产生的记录而连续提交 housekeeping transaction。
   recall/read 等过程 Observation 应在提炼证据的同一事务中按需 retire；事务成功且 Mind 已准确后，不要再为清理刚产生的过程记录继续 recall 或提交 housekeeping，直接 reply。
10. Context 最后的 `evaluate` 是本次模型请求唯一的执行入口。只处理其中的 `root-input` 和显式绑定的 Thread；其他 DialogueTurn / Execution / Objective / Delivery Thread 仅是只读背景。每次调用物理工具前，必须确认它是完成当前 `root-input` 所必需的新信息。当 Mind/inbox 已足以回答，尤其是问候、催问、状态询问或普通对话时，立即返回普通文本；不要替未绑定的 Objective 或旧 Execution Thread 调用工具，不要重复验证、扫描工作区或自行发明后续目标。
11. kernel.turn-control 描述当前用户回合的模型求值进度。phase=soft-checkpoint 是周期性复盘点，不是 Attempt 上限：所有正常工具仍然可用，若任务仍有可靠进展就继续执行；只需检查目标、证据、Mind 和下一步是否一致，避免无进展的重复调用。一次模型响应里并行调用多个工具只计为一次 Attempt。
12. kernel.wake 说明本次为何被唤醒。独立 context_tx 成功后的 context-transaction-result 会触发一次冷却：除非仍处于 critical，否则本次不再提供 context_tx，必须返回普通文本、调用 no_reply 或执行必要的物理动作。
13. 代码任务优先使用 list_files/search 发现文件、read 获取内容与 sha256、edit 做带版本前提的局部修改；write 主要用于 mode=create，新文件已存在或 overwrite 缺少 expected_sha256 时不得绕过保护。exec 用于测试/编译/格式化，不要用 Shell 替代受约束的文件工具。file_change 是已提交修改的可审计证据。相互独立的文件读取必须在同一响应中并行调用；已经进入 Inbox 且 sha256 未被 file_change 改变的内容不得重复 read。完成必要定位后立即修改并验证，不要在反复扫描与阅读中消耗无进展的模型求值。
14. exec 回执中的 execution、process_status、exit_code、task_status 和 effective_boundary 是 Runtime 观测到的物理事实；不得用命令意图或自己的预期取代它们。若非零退出的 stderr/事实明确说明失败源于当前边界缺少网络、边界外读写目录或秘密环境变量，且该能力确为当前任务所必需，应使用同一条必要命令重试一次：sandbox_permissions=require_escalated，并在 requested_permissions 中只申请最小能力、用 justification 说明原因；不得仅因普通命令失败猜测权限问题。命中 protected_paths、审批明确拒绝或 permission_request_available=false 时不可通过重试覆盖。exec 转入后台后，普通等待直接调用 no_reply；任务结束会主动唤醒，不要为了等待而调用工具。只有存在明确截止时间或停滞监督需求时，才用 check_task_after 安排一次检查点；届时可调用 task_status、继续安排检查或 kill_task。不得用 sleep、ps 或重复读取空日志轮询。不得把 token/key 字面量写入命令、进程参数、Mind 或 Ledger；只能由使用者预先配置 Runtime 环境变量，再通过 requested_permissions.secret_env 按变量名申请对单个子进程注入。
15. kernel.objectives 与 evaluate.objective-context 让你看到当前 Session 的 Objective 物理状态，但“可见”不等于“已绑定”。仅当 evaluate.objective-binding 指向某个 Objective 时，本轮才属于它的 Objective Thread 并可推进它；binding=none 时只可用这些状态回答用户的进度问题，不得为其调用工具。绑定的 Objective 仍有工作且不等待时正常交付当前进度，Supervisor 会自动续跑；等待确定事件时先调用 objective_update(status=active, wait_condition=...)；确实无法自动等待或推进时才提交 blocked；只有逐项审计 stated objective 并有真实 Ledger 证据支持时才提交 completed。Objective 状态工具成功后仍需产生普通文本或调用 no_reply 完成本次 IO。
16. 你可以调用 objective_create，把当前 Session 中确实需要跨多次 Evaluation、异步等待或 Runtime 重启继续推进的工作升级为 First-Class Objective。它不是普通 Todo 或延长思考时间的手段：当前 Evaluation 可以可靠完成的任务不得创建 Objective；创建时完整保留用户范围与完成条件，并说明持久化的必要性。Runtime 自动绑定当前 Agent/Context/Session 并生成 ID；成功或返回 existing 后不得为同一目标重复创建。若指定 parent_objective_id，它必须是当前正在求值的 Objective。创建成功后继续工作，普通文本或 no_reply 只结束被收编后的当前 Evaluation，未完成 Objective 将由 Supervisor 自动续跑。
17. 调度决策由你负责，Runtime 只执行并发与时序机制。当前 Thread 内连续物理动作直接调用工具，结果仍回到同一 mailbox；需要让新工作与当前 Thread 并行时用 schedule_tx.spawn，需要等待当前或指定 Thread 完成后串行推进时用 schedule_tx.enqueue/after。已有调度的状态先用 schedule_tx.inspect 读取；只能用其返回的最新 revision 执行 pause/resume/reschedule/cancel，冲突表示事实已变化，必须重新观测和决策。不要用多次相互独立的物理工具调用暗示新 Thread，也不要把 schedule_tx 与 context_tx 或物理工具混在同一响应。定时调度到期只是一条新的 observation；必须根据届时的真实 Context 再决策，不得预先声称结果已完成。

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

每个 Session 有一条 Dialogue Lane，用于排序普通对话的首次求值；每条用户输入创建一条独立且有限的 DialogueTurn Thread。由该 turn 发起、并由工具结果延续的计算形成 Execution Thread。Objective 由 Objective Thread 持续推进。Context 最后的 `evaluate` 表达式选择本周期唯一活动 Thread；其他 Thread 即使可见也只是只读状态。

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
        kernel = ANNOTATED_RESPONSE_KERNEL,
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

const MAINTENANCE_BUDGET_EXHAUSTED_PROMPT: &str = r#"Runtime 检测到 Context 已处于 critical，且本轮普通 context_tx 额度已经耗尽。为避免在不可执行的维护请求中循环，本次 Evaluation 强制进入 final-reply 阶段。请返回无工具的普通文本，如实交付已完成状态、最近一次可靠验证和剩余工作；若确认无需发送消息，可独占调用 no_reply。若存在 active Objective，这不会把 Objective 标记为完成；Supervisor 将按其持久状态决定后续。"#;

const CONTEXT_TX_COOLDOWN_PROMPT: &str = r#"上一次独立 context_tx 已成功提交，且当前不再处于 critical。Runtime 本次隐藏 context_tx 以阻断连续 housekeeping；请返回普通文本结束当前 Evaluation、独占调用 no_reply，或仅执行完成当前任务确实必需的物理动作。新的 user/tool observation 到达后，context_tx 会恢复。"#;
const NO_REPLY_TOOL_NAME: &str = "no_reply";
const MAX_RESPONSE_PROTOCOL_RETRIES: usize = 2;
const TOOL_ARGUMENT_PREVIEW_CHARS: usize = 4_096;
const EMPTY_RESPONSE_ERROR: &str = "既没有非空正文，也没有工具调用";
const RESPONSE_PROTOCOL_ERROR: &str = "Response protocol error：当前 Evaluation 尚未产生合法终态。需要向当前 active Session 回复时，返回非空普通 assistant 文本且不调用工具；确认本次无需发送消息时，独占调用 no_reply。空响应、no_reply 与其他工具混用、或 no_reply 同时携带正文都是协议错误。";
const REASONING_ONLY_RESPONSE_REASON: &str =
    "模型只返回了推理摘要，未产生普通文本、工具调用或 no_reply";
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
    model_attempt_id: Option<String>,
}

#[derive(Debug, Default)]
struct ToolExecutionOutcome {
    context_tx_succeeded: bool,
}

#[derive(Debug, Clone)]
struct ClaimedExecutionJob {
    id: String,
    revision: u64,
    claim_token: String,
}

#[derive(Debug, Clone)]
struct ToolTaskMetadata {
    output_id: String,
    context_id: String,
    session_id: String,
    attempt_id: String,
    tool_call_id: String,
    tool_name: String,
    activation_route: Option<ActivationRoute>,
    execution_job: Option<ClaimedExecutionJob>,
}

struct SpawnedToolTask {
    handle: tokio::task::JoinHandle<Result<SpawnedToolTaskResult, DynError>>,
    metadata: ToolTaskMetadata,
}

struct SpawnedToolTaskResult {
    output: Event,
    already_persisted: bool,
}

enum PreparedPhysicalExecution {
    Claimed(Box<ClaimedPhysicalExecution>),
    Terminal(Event),
}

struct ClaimedPhysicalExecution {
    job: ClaimedExecutionJob,
    context: crate::tool::ToolExecutionJobContext,
    approval: Option<DurableApprovalGrant>,
}

#[derive(Clone)]
pub struct DurableApprovalServices {
    broker: Arc<PermissionBroker>,
    approvals: Arc<dyn ApprovalStore>,
    execution_approvals: Arc<dyn ExecutionApprovalStore>,
    human_approval_hub: HumanApprovalHub,
}

impl DurableApprovalServices {
    pub fn new(
        broker: Arc<PermissionBroker>,
        approvals: Arc<dyn ApprovalStore>,
        execution_approvals: Arc<dyn ExecutionApprovalStore>,
        human_approval_hub: HumanApprovalHub,
    ) -> Self {
        Self {
            broker,
            approvals,
            execution_approvals,
            human_approval_hub,
        }
    }
}

#[derive(Debug, Clone)]
struct ActivationRoute {
    thread_id: String,
    activation_id: String,
    root_turn_id: String,
    trigger_event_id: String,
    trigger_sequence: u64,
    context_snapshot_version: Option<u64>,
    thread_kind: &'static str,
    /// Immutable completion batch that caused a Delivery Activation.  A
    /// reply must only acknowledge results present in this trigger snapshot;
    /// results arriving while the model is running belong to a later
    /// Delivery Activation.
    delivery_thread_ids: Vec<String>,
}

#[derive(Debug, Default)]
struct ModelReasoningSummaryAccumulator {
    text: String,
    complete: bool,
    persist_started: bool,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    failure: Option<String>,
}

#[derive(Debug)]
struct ModelCompletionError {
    source: DynError,
    reasoning_summary: String,
}

impl ModelCompletionError {
    fn without_summary(source: DynError) -> Self {
        Self {
            source,
            reasoning_summary: String::new(),
        }
    }

    async fn with_summary(
        source: DynError,
        accumulator: &Arc<Mutex<ModelReasoningSummaryAccumulator>>,
    ) -> Self {
        Self {
            source,
            reasoning_summary: accumulator.lock().await.text.clone(),
        }
    }
}

impl std::fmt::Display for ModelCompletionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.source.fmt(formatter)
    }
}

impl std::error::Error for ModelCompletionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

struct AdmittedThreadActivation {
    record: ThreadActivationRecord,
    /// Dropping this permit is the physical transition back out of the
    /// single-node running set.  It must span terminal persistence.
    _permit: ActivationAdmissionPermit,
}

#[derive(Debug, Default)]
struct DialogueThreadGate {
    owner_root_turn_id: Mutex<Option<String>>,
    changed: Notify,
}

impl DialogueThreadGate {
    async fn acquire(&self, root_turn_id: &str) {
        loop {
            let changed = self.changed.notified();
            {
                let mut owner = self.owner_root_turn_id.lock().await;
                match owner.as_deref() {
                    None => {
                        *owner = Some(root_turn_id.to_string());
                        return;
                    }
                    Some(current) if current == root_turn_id => return,
                    Some(_) => {}
                }
            }
            changed.await;
        }
    }

    async fn owns(&self, root_turn_id: &str) -> bool {
        self.owner_root_turn_id.lock().await.as_deref() == Some(root_turn_id)
    }

    async fn release(&self, root_turn_id: &str) -> bool {
        let released = {
            let mut owner = self.owner_root_turn_id.lock().await;
            if owner.as_deref() == Some(root_turn_id) {
                *owner = None;
                true
            } else {
                false
            }
        };
        if released {
            self.changed.notify_waiters();
        }
        released
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalDecision {
    Deliver(String),
    NoReply,
}

impl TerminalDecision {
    fn disposition(&self) -> &'static str {
        match self {
            Self::Deliver(_) => "deliver",
            Self::NoReply => "no_reply",
        }
    }
}

fn no_reply_tool_definition() -> crate::llm::ToolDefinition {
    crate::llm::ToolDefinition {
        name: NO_REPLY_TOOL_NAME.to_string(),
        description: "明确本次不向当前 active Session 发送消息。DialogueTurn Thread 中它结束本次求值；存在仍在运行的后台任务时，它只让当前 Execution Thread yield 并进入 waiting，后续任务事件会再次唤醒同一 Thread。它不代表 Objective 完成，也不取消后台任务。no_reply 必须是响应中唯一的工具调用，且不能同时返回正文。".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    }
}

fn classify_terminal_response(
    response: &crate::llm::Response,
) -> Result<Option<TerminalDecision>, String> {
    let no_reply_calls = response
        .tool_calls
        .iter()
        .filter(|call| call.func_name == NO_REPLY_TOOL_NAME)
        .collect::<Vec<_>>();
    if no_reply_calls.is_empty() {
        if response.tool_calls.is_empty() {
            let content = response.content.trim();
            if content.is_empty() {
                return Err("响应既没有非空正文，也没有调用 no_reply".to_string());
            }
            return Ok(Some(TerminalDecision::Deliver(response.content.clone())));
        }
        return Ok(None);
    }
    if no_reply_calls.len() != 1 || response.tool_calls.len() != 1 {
        return Err("no_reply 必须独占响应且只调用一次".to_string());
    }
    if !response.content.trim().is_empty() {
        return Err("no_reply 不能同时携带普通文本".to_string());
    }
    let arguments: serde_json::Value = serde_json::from_str(&no_reply_calls[0].arguments)
        .map_err(|error| format!("no_reply 参数 JSON 非法: {error}"))?;
    if arguments
        .as_object()
        .is_none_or(|object| !object.is_empty())
    {
        return Err("no_reply 不接受参数".to_string());
    }
    Ok(Some(TerminalDecision::NoReply))
}

fn validate_schedule_tx_response(response: &crate::llm::Response) -> Result<(), String> {
    let schedule_calls = response
        .tool_calls
        .iter()
        .filter(|call| call.func_name == "schedule_tx")
        .count();
    if schedule_calls == 0 {
        return Ok(());
    }
    if schedule_calls != 1 || response.tool_calls.len() != 1 {
        return Err(
            "schedule_tx 必须是响应中唯一且只调用一次的工具；不能与物理工具、context_tx 或其他 schedule_tx 混用"
                .to_string(),
        );
    }
    Ok(())
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
    event_writer_metrics: Arc<DurableEventWriterMetrics>,
    pub concurrency_semaphore: Arc<tokio::sync::Semaphore>,
    activation_admission: ActivationAdmissionController,
    /// One ordered Dialogue Lane per Session. Tool/objective continuations do
    /// not take this lock: after a dialogue turn launches an Execution Thread, later
    /// user messages can still be answered while that work continues.
    dialogue_thread_gates: DashMap<String, Arc<DialogueThreadGate>>,
    /// One evaluator at a time may drain a Thread mailbox. Tool calls may
    /// execute concurrently inside an attempt, but their result/timer/exit
    /// events converge here instead of forking independent model chains.
    thread_gates: DashMap<String, Arc<Mutex<()>>>,
    read_turn_guards: DashMap<String, Arc<Mutex<ReadTurnGuard>>>,
    cancellation_epochs: DashMap<String, watch::Sender<u64>>,
    active_session_turns: DashMap<String, Arc<AtomicUsize>>,
    activation_routes: DashMap<String, ActivationRoute>,
    cancelled_at: DashMap<String, chrono::DateTime<Utc>>,
    /// Runtime routing identity: a Session is an IO connection inside one
    /// Cognitive Context. This cache is populated from every incoming routed
    /// event and is deliberately separate from the shared Mind state.
    session_contexts: DashMap<String, String>,
    delegation_start_lock: Mutex<()>,
    objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
    objective_supervisor: Option<Arc<ObjectiveSupervisor>>,
    /// Scheduler Kernel physical clock. Every Orchestrator has one: terminal
    /// Thread delivery and activation leases are not optional features.
    timer_engine: Arc<TimerEngine>,
    thread_scheduler: Option<Arc<ThreadScheduler>>,
    execution_jobs: Option<Arc<ExecutionJobManager<dyn ExecutionJobStore>>>,
    background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
    durable_approvals: Option<DurableApprovalServices>,
}

/// Commit the provider-authored reasoning summary as one independent Ledger
/// artifact. Deltas remain ephemeral; this helper is also used after timeout
/// so a partial summary can survive without waiting for a stuck provider.
async fn persist_model_reasoning_summary(
    bus: &Arc<InMemoryEventBus>,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    route: &[(String, serde_json::Value)],
    accumulator: &Arc<Mutex<ModelReasoningSummaryAccumulator>>,
    force_incomplete: bool,
) -> Result<(), DynError> {
    let (text, complete, prompt_tokens, completion_tokens, total_tokens, failure) = {
        let mut accumulator = accumulator.lock().await;
        if force_incomplete {
            accumulator.complete = false;
        }
        if accumulator.persist_started || accumulator.text.is_empty() {
            return Ok(());
        }
        accumulator.persist_started = true;
        (
            accumulator.text.clone(),
            accumulator.complete,
            accumulator.prompt_tokens,
            accumulator.completion_tokens,
            accumulator.total_tokens,
            accumulator.failure.clone(),
        )
    };

    let mut payload = vec![
        ("context_id".to_string(), json!(context_id)),
        ("session_id".to_string(), json!(session_id)),
        ("attempt_id".to_string(), json!(attempt_id)),
        ("text".to_string(), json!(text)),
        ("complete".to_string(), json!(complete)),
    ];
    if let Some(tokens) = prompt_tokens {
        payload.push(("prompt_tokens".to_string(), json!(tokens)));
    }
    if let Some(tokens) = completion_tokens {
        payload.push(("completion_tokens".to_string(), json!(tokens)));
    }
    if let Some(tokens) = total_tokens {
        payload.push(("total_tokens".to_string(), json!(tokens)));
    }
    if let Some(failure) = failure {
        payload.push(("failure".to_string(), json!(failure)));
    }
    payload.extend_from_slice(route);
    let event = Event::new(
        format!("model_reasoning_summary_{attempt_id}"),
        "Model-Provider".to_string(),
        "runtime_control".to_string(),
        "runtime/model_reasoning_summary".to_string(),
        payload.into_iter().collect(),
    );
    if let Err(error) = bus.publish(event).await {
        accumulator.lock().await.persist_started = false;
        return Err(error);
    }
    Ok(())
}

fn reasoning_continuation_prompt(summaries: &[String]) -> String {
    let reasoning = summaries
        .iter()
        .enumerate()
        .map(|(index, summary)| {
            format!(
                "<reasoning_segment index=\"{}\">\n{}\n</reasoning_segment>",
                index + 1,
                summary
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "之前的物理模型请求只生成了推理摘要，没有生成可提交的正文或工具调用。下面是 Runtime 按顺序保存的全部推理进度；它们不是用户消息，也不是已发送给用户的 assistant 正文。请沿用这些进度继续完成你的推理，不要从头重复分析；推理完成后再产生一种合法终态：返回非空普通 assistant 文本且不调用工具，或执行所需工具调用，或在确实无需消息时独占调用 no_reply。\n\n<previous_reasoning>\n{reasoning}\n</previous_reasoning>"
    )
}

impl Orchestrator {
    pub fn activation_admission_snapshot(
        &self,
    ) -> crate::activation_admission::ActivationAdmissionSnapshot {
        self.activation_admission.snapshot()
    }

    pub fn durable_event_writer_metrics(&self) -> DurableEventWriterMetricsSnapshot {
        self.event_writer_metrics.snapshot()
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn assemble_with_scheduler_kernel(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
        orchestrator_config: OrchestratorConfig,
        context_engine: Arc<ContextEngine>,
        objective_evaluations: Arc<ObjectiveEvaluationRegistry>,
        objective_supervisor: Option<Arc<ObjectiveSupervisor>>,
        timer_engine: Arc<TimerEngine>,
        thread_scheduler: Option<Arc<ThreadScheduler>>,
        execution_jobs: Option<Arc<ExecutionJobManager<dyn ExecutionJobStore>>>,
        background_scheduler: Option<Arc<BackgroundTaskScheduler>>,
        durable_approvals: Option<DurableApprovalServices>,
    ) -> Result<Arc<Self>, DynError> {
        let concurrency_semaphore = Arc::new(tokio::sync::Semaphore::new(
            orchestrator_config.concurrency_limit.max(1),
        ));
        let activation_admission = ActivationAdmissionController::new(ActivationAdmissionLimits {
            total_slots: orchestrator_config.concurrency_limit,
            dialogue_delivery_slots: orchestrator_config
                .activation_admission
                .dialogue_delivery_reserved_slots,
            max_queued: orchestrator_config.activation_admission.max_queued,
            dialogue_delivery_queue_slots: orchestrator_config
                .activation_admission
                .dialogue_delivery_reserved_queue_slots,
            aging_promotion_interval_ms: orchestrator_config
                .activation_admission
                .aging_promotion_interval
                .as_secs()
                .saturating_mul(1_000),
        });
        let tool_definitions = registry.definitions();
        let orchestrator = Arc::new(Self {
            bus,
            store,
            client,
            registry,
            tool_definitions,
            context_engine,
            orchestrator_config,
            event_writer_metrics: Arc::new(DurableEventWriterMetrics::default()),
            concurrency_semaphore,
            activation_admission,
            dialogue_thread_gates: DashMap::new(),
            thread_gates: DashMap::new(),
            read_turn_guards: DashMap::new(),
            cancellation_epochs: DashMap::new(),
            active_session_turns: DashMap::new(),
            activation_routes: DashMap::new(),
            cancelled_at: DashMap::new(),
            session_contexts: DashMap::new(),
            delegation_start_lock: Mutex::new(()),
            objective_evaluations,
            objective_supervisor,
            timer_engine,
            thread_scheduler,
            execution_jobs,
            background_scheduler,
            durable_approvals,
        });
        orchestrator.register_timer_handlers()?;
        Ok(orchestrator)
    }

    /// Safe integration-test factory. It deliberately exposes only the
    /// Scheduler Kernel minimum, requires a durable TimerEngine, and registers
    /// the Orchestrator handlers and starts its dispatcher before returning.
    ///
    /// Product assembly goes through `MorphzRuntimeBuilder`; this function is
    /// public solely because Cargo integration tests are separate crates.
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn new_test_with_context_engine(
        bus: Arc<InMemoryEventBus>,
        store: Arc<dyn EventStore>,
        client: Arc<dyn Client>,
        registry: Arc<Registry>,
        orchestrator_config: OrchestratorConfig,
        context_engine: Arc<ContextEngine>,
        timer_engine: Arc<TimerEngine>,
    ) -> Result<Arc<Self>, DynError> {
        let orchestrator = Self::assemble_with_scheduler_kernel(
            bus,
            store,
            client,
            registry,
            orchestrator_config,
            context_engine,
            Arc::new(ObjectiveEvaluationRegistry::default()),
            None,
            timer_engine,
            None,
            None,
            None,
            None,
        )?;
        orchestrator.timer_engine.start();
        Ok(orchestrator)
    }

    fn register_timer_handlers(self: &Arc<Self>) -> Result<(), DynError> {
        let timers = &self.timer_engine;
        let orchestrator = Arc::downgrade(self);
        timers.register_handler(RuntimeTimerKind::ActivationLease, move |timer| {
            let orchestrator = orchestrator.clone();
            async move {
                let Some(orchestrator) = orchestrator.upgrade() else {
                    return Ok(TimerDisposition::Complete);
                };
                orchestrator.dispatch_activation_lease(timer).await
            }
        })?;
        let orchestrator = Arc::downgrade(self);
        timers.register_handler(RuntimeTimerKind::DeliveryFlush, move |timer| {
            let orchestrator = orchestrator.clone();
            async move {
                let Some(orchestrator) = orchestrator.upgrade() else {
                    return Ok(TimerDisposition::Complete);
                };
                orchestrator.dispatch_delivery_flush(timer).await
            }
        })
    }

    async fn arm_activation_lease(
        &self,
        activation: &ThreadActivationRecord,
    ) -> Result<(), DynError> {
        if activation.status != ThreadActivationStatus::Running {
            return Ok(());
        }
        self.timer_engine
            .schedule(NewRuntimeTimer {
                id: activation_lease_timer_id(&activation.id),
                generation: activation.revision,
                kind: RuntimeTimerKind::ActivationLease,
                owner_id: activation.id.clone(),
                due_at: activation.lease_expires_at.unwrap_or_else(Utc::now),
                payload: json!({
                    "activation_id": activation.id,
                    "revision": activation.revision,
                    "claimed_by": activation.claimed_by,
                    "trigger_event_id": activation.trigger_event_id,
                }),
            })
            .await?;
        Ok(())
    }

    async fn cancel_activation_lease(&self, activation_id: &str) -> Result<(), DynError> {
        self.timer_engine
            .cancel(&activation_lease_timer_id(activation_id))
            .await?;
        Ok(())
    }

    async fn dispatch_activation_lease(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Activation lease 需要持久化 SessionStore")?;
        let Some(current) = session_store.get_thread_activation(&timer.owner_id).await? else {
            return Ok(TimerDisposition::Complete);
        };
        if current.status != ThreadActivationStatus::Running {
            return Ok(TimerDisposition::Complete);
        }
        if current.revision != timer.generation {
            self.arm_activation_lease(&current).await?;
            return Ok(TimerDisposition::Complete);
        }
        if let Some(expires_at) = current.lease_expires_at {
            if expires_at > Utc::now() {
                return Ok(TimerDisposition::Reschedule {
                    due_at: expires_at,
                    reason: Some("Thread Activation lease 尚未到期".to_string()),
                });
            }
        }
        if self.activation_admission.is_in_flight(&current.id) {
            // The durable lease expired while this exact Activation still has
            // its process-local execution permit. Re-dispatching the Trigger
            // would only reach `AlreadyLocal`. Completing this timer after
            // that no-op used to consume the sole crash-recovery opportunity:
            // if the original task subsequently aborted, the row remained
            // `running` forever. Advance the durable generation and arm the
            // next lease before completing the claimed old generation. Timer
            // completion is generation-fenced, so it cannot erase this newer
            // recovery clock.
            let renewed_expires_at = Utc::now() + self.activation_lease_duration();
            match session_store
                .update_thread_activation(
                    &current.id,
                    current.revision,
                    ThreadActivationStatus::Running,
                    current.claimed_by.as_deref(),
                    Some(renewed_expires_at),
                    current.context_snapshot_version,
                )
                .await?
            {
                ThreadActivationMutation::Updated(renewed) => {
                    self.arm_activation_lease(&renewed).await?;
                    tracing::debug!(
                        activation_id = %renewed.id,
                        revision = renewed.revision,
                        lease_expires_at = %renewed_expires_at,
                        "本地 Activation 仍在执行；续租并保留恢复时钟"
                    );
                    return Ok(TimerDisposition::Complete);
                }
                ThreadActivationMutation::Conflict { current }
                    if current.status == ThreadActivationStatus::Running =>
                {
                    // A concurrent snapshot/heartbeat already advanced the
                    // owner revision. Arm that authoritative generation; the
                    // old claimed generation may now complete harmlessly.
                    self.arm_activation_lease(&current).await?;
                    return Ok(TimerDisposition::Complete);
                }
                ThreadActivationMutation::Conflict { .. } | ThreadActivationMutation::NotFound => {
                    return Ok(TimerDisposition::Complete);
                }
            }
        }
        let Some(trigger) = self
            .store
            .query(QueryFilter {
                event_id: Some(current.trigger_event_id.clone()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|event| event.id == current.trigger_event_id)
        else {
            return Err(format!(
                "Activation '{}' 的 Trigger Event '{}' 不存在",
                current.id, current.trigger_event_id
            )
            .into());
        };
        // Dispatch is idempotent at Thread Activation claim. The claimant CAS
        // advances the revision and arms the next lease generation before any
        // model work can be stranded again.
        self.bus.dispatch_persisted(trigger).await?;
        Ok(TimerDisposition::Complete)
    }

    fn activation_lease_duration(&self) -> chrono::Duration {
        let lease_seconds = self
            .orchestrator_config
            .model_attempt_timeout_secs
            .max(1)
            .saturating_mul((MAX_RESPONSE_PROTOCOL_RETRIES + 1) as u64)
            .saturating_add(30)
            .max(
                self.orchestrator_config
                    .tool_timeout_secs
                    .max(1)
                    .saturating_add(30),
            );
        chrono::Duration::seconds(i64::try_from(lease_seconds).unwrap_or(i64::MAX))
    }

    pub fn objective_evaluations(&self) -> Arc<ObjectiveEvaluationRegistry> {
        Arc::clone(&self.objective_evaluations)
    }

    pub async fn start(self: Arc<Self>) -> Result<(), DynError> {
        let store = Arc::clone(&self.store);
        let event_writer = DurableEventWriter::spawn(
            store,
            &self.orchestrator_config.event_writer,
            Arc::clone(&self.event_writer_metrics),
        );
        let persist_full_context_inspect = self.orchestrator_config.persist_full_context_inspect;
        self.bus.subscribe_durable_writer(
            "*".to_string(),
            Arc::new(move |mut event| {
                let event_writer = event_writer.clone();
                Box::pin(async move {
                    if !persist_full_context_inspect {
                        compact_context_inspect_for_persistence(&mut event);
                    }
                    let signal_outbox = event_needs_signal_outbox(&event);
                    event_writer
                        .append(EventAppend {
                            event,
                            signal_outbox,
                        })
                        .await
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

        self.rebuild_activation_admission_queue().await?;
        self.recover_thread_activations().await?;
        self.dispatch_pending_signal_outbox().await?;
        self.recover_pending_thread_signals().await?;
        self.recover_delegations().await?;
        self.reconcile_orphaned_threads().await?;
        self.recover_pending_delivery_flushes().await?;
        self.refill_activation_admission_queue().await?;
        self.start_activation_admission_refill();
        self.start_signal_outbox_dispatcher();
        Ok(())
    }

    fn start_activation_admission_refill(self: &Arc<Self>) {
        let orchestrator = Arc::downgrade(self);
        let admission = self.activation_admission.clone();
        tokio::spawn(async move {
            loop {
                if orchestrator.upgrade().is_none() {
                    break;
                }
                // Never retain the Orchestrator Arc while sleeping on a
                // process-local notification. Otherwise this maintenance task
                // keeps the whole Runtime alive after every external owner has
                // gone away.
                let changed = tokio::select! {
                    _ = admission.wait_for_change() => true,
                    // This is only a lifecycle check; durable admission is
                    // still notification-driven and never polls SQLite.
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => false,
                };
                if !changed {
                    continue;
                }
                // Collapse a burst of permit/queue changes into one durable
                // scan without turning admission into a polling loop.
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                let Some(current) = orchestrator.upgrade() else {
                    break;
                };
                if let Err(error) = current.refill_activation_admission_queue().await {
                    tracing::error!(%error, "Activation admission 持久队列重扫失败；保留 queued 等待下一次唤醒");
                }
            }
        });
    }

    fn start_signal_outbox_dispatcher(self: &Arc<Self>) {
        let orchestrator = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(SIGNAL_OUTBOX_POLL_INTERVAL).await;
                let Some(orchestrator) = orchestrator.upgrade() else {
                    break;
                };
                if let Err(error) = orchestrator.dispatch_pending_signal_outbox().await {
                    tracing::error!(%error, "Signal Outbox 后台派发失败；保留 pending 等待重试");
                }
            }
        });
    }

    async fn dispatch_pending_signal_outbox(&self) -> Result<usize, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Signal Outbox dispatcher 需要持久化 SessionStore")?;
        let pending = session_store
            .list_signal_outbox(SignalOutboxStatus::Pending, SIGNAL_OUTBOX_DISPATCH_BATCH)
            .await?;
        let mut dispatched = 0usize;
        for entry in pending {
            let Some(event) = self
                .store
                .query(QueryFilter {
                    event_id: Some(entry.event_id.clone()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .find(|event| event.id == entry.event_id)
            else {
                return Err(format!(
                    "Signal Outbox Event '{}' 在 Ledger 中不存在",
                    entry.event_id
                )
                .into());
            };
            if !event_needs_signal_outbox(&event) {
                return Err(format!(
                    "Signal Outbox Event '{}' 不是可路由的 chat Signal",
                    event.id
                )
                .into());
            }
            self.bus.dispatch_persisted(event).await?;
            dispatched = dispatched.saturating_add(1);
        }
        Ok(dispatched)
    }

    async fn recover_pending_thread_signals(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        for context in session_store.list_contexts(false).await? {
            let mut dispatched_threads = HashSet::new();
            for signal in session_store
                .list_context_thread_signals(
                    &context.id,
                    Some(crate::memory::ThreadSignalStatus::Pending),
                )
                .await?
            {
                if !dispatched_threads.insert(signal.thread_id.clone()) {
                    continue;
                }
                let Some(event) = self
                    .store
                    .query(QueryFilter {
                        event_id: Some(signal.event_id.clone()),
                        context_id: Some(context.id.clone()),
                        ..Default::default()
                    })
                    .await?
                    .into_iter()
                    .find(|event| event.id == signal.event_id)
                else {
                    tracing::error!(
                        signal_id = %signal.id,
                        event_id = %signal.event_id,
                        "无法恢复 pending Thread Signal：Ledger 中不存在 Event"
                    );
                    continue;
                };
                self.bus.dispatch_persisted(event).await?;
            }
        }
        Ok(())
    }

    async fn rebuild_activation_admission_queue(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let limit = self.activation_admission.limits().max_queued;
        let aging_ms = self
            .activation_admission
            .limits()
            .aging_promotion_interval_ms;
        let reserved_queue_slots = self
            .activation_admission
            .limits()
            .dialogue_delivery_queue_slots;
        for (activation, class) in session_store
            .list_queued_thread_activations_for_admission(limit, reserved_queue_slots, aging_ms)
            .await?
        {
            let outcome = self
                .activation_admission
                .restore_queued(activation_admission_key_for_class(&activation, class))?;
            if outcome == RestoreQueuedOutcome::DeferredWindowFull {
                tracing::debug!(
                    activation_id = %activation.id,
                    "Activation 保留在 SQLite queued；等待进入有界内存准入窗口"
                );
            }
        }
        Ok(())
    }

    /// Fill newly available in-memory scheduling positions from SQLite.  Only
    /// rows actually entering the window are re-dispatched; overflow remains a
    /// durable queued fact and never becomes a synthetic failure reply.
    async fn refill_activation_admission_queue(&self) -> Result<usize, DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(0);
        };
        let mut dispatched = 0usize;
        let limit = self.activation_admission.limits().max_queued;
        let aging_ms = self
            .activation_admission
            .limits()
            .aging_promotion_interval_ms;
        let reserved_queue_slots = self
            .activation_admission
            .limits()
            .dialogue_delivery_queue_slots;
        for (activation, class) in session_store
            .list_queued_thread_activations_for_admission(limit, reserved_queue_slots, aging_ms)
            .await?
        {
            if self.activation_admission.contains(&activation.id) {
                continue;
            }
            let Some(trigger) = self
                .store
                .query(QueryFilter {
                    event_id: Some(activation.trigger_event_id.clone()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .find(|event| event.id == activation.trigger_event_id)
            else {
                tracing::error!(
                    activation_id = %activation.id,
                    trigger_event_id = %activation.trigger_event_id,
                    "无法重扫 queued Activation：Ledger 中不存在 Trigger Event"
                );
                continue;
            };
            match self
                .activation_admission
                .restore_queued(activation_admission_key_for_class(&activation, class))?
            {
                RestoreQueuedOutcome::Restored => {
                    self.bus.dispatch_persisted(trigger).await?;
                    dispatched = dispatched.saturating_add(1);
                }
                RestoreQueuedOutcome::AlreadyTracked | RestoreQueuedOutcome::DeferredWindowFull => {
                }
            }
        }
        Ok(dispatched)
    }

    async fn recover_thread_activations(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        for context in session_store.list_contexts(false).await? {
            let mut interrupted_dialogue_roots = HashSet::new();
            let activations = session_store
                .list_context_thread_activations(&context.id, false)
                .await?;
            if activations.is_empty() {
                continue;
            }
            let events = self
                .store
                .query(QueryFilter {
                    context_id: Some(context.id.clone()),
                    excluded_topics: vec!["chat/context_inspect".to_string()],
                    ..Default::default()
                })
                .await?;
            let events = events
                .into_iter()
                .map(|event| (event.id.clone(), event))
                .collect::<HashMap<_, _>>();
            for activation in activations {
                let Some(trigger) = events.get(&activation.trigger_event_id).cloned() else {
                    tracing::error!(
                        activation_id = %activation.id,
                        trigger_event_id = %activation.trigger_event_id,
                        "无法恢复 Thread Activation：Ledger 中不存在 Trigger Event"
                    );
                    continue;
                };
                if interrupted_dialogue_on_restart(&activation, &events) {
                    let announce =
                        interrupted_dialogue_roots.insert(activation.root_turn_id.clone());
                    match session_store
                        .update_thread_activation(
                            &activation.id,
                            activation.revision,
                            ThreadActivationStatus::Cancelled,
                            None,
                            None,
                            None,
                        )
                        .await?
                    {
                        ThreadActivationMutation::Updated(_) => {
                            self.activation_admission.forget(&activation.id);
                            tracing::info!(
                                activation_id = %activation.id,
                                root_turn_id = %activation.root_turn_id,
                                "Runtime 重启后中止未形成物理工作的 Dialogue Turn"
                            );
                            if announce {
                                self.bus
                                    .publish(Event::new(
                                        format!(
                                            "dialogue_interrupted_{}_{}",
                                            activation.id,
                                            Utc::now().timestamp_nanos_opt().unwrap_or(0)
                                        ),
                                        "Runtime-Recovery".to_string(),
                                        TYPE_AGENT_CALL.to_string(),
                                        "chat/cancelled".to_string(),
                                        vec![
                                            ("context_id".to_string(), json!(activation.context_id)),
                                            ("session_id".to_string(), json!(activation.session_id)),
                                            ("activation_id".to_string(), json!(activation.id)),
                                            (
                                                "root_turn_id".to_string(),
                                                json!(activation.root_turn_id),
                                            ),
                                            (
                                                "trigger_event_id".to_string(),
                                                json!(activation.trigger_event_id),
                                            ),
                                            ("thread_kind".to_string(), json!("dialogue_turn")),
                                            ("status".to_string(), json!("interrupted")),
                                            ("reason".to_string(), json!("runtime_restart")),
                                            (
                                                "text".to_string(),
                                                json!("这条消息的处理因 Runtime 重启而中断；如仍需要，请重新发送。"),
                                            ),
                                        ]
                                        .into_iter()
                                        .collect(),
                                    ))
                                    .await?;
                            }
                        }
                        ThreadActivationMutation::Conflict { .. }
                        | ThreadActivationMutation::NotFound => {}
                    }
                    continue;
                }
                // A persisted assistant decision is the durable recovery
                // boundary. Its original trigger may already be represented
                // by a later Context snapshot, but suppressing that trigger
                // would also suppress resume_persisted_activation and strand
                // the newly materialized Thread. The flag is process
                // local: dispatch_persisted does not append a second Event.
                let mut trigger = trigger;
                if events.contains_key(&format!("call_{}", activation.id)) {
                    trigger
                        .payload
                        .insert("runtime_force_evaluation".to_string(), json!(true));
                    trigger.payload.insert(
                        "runtime_recovery_activation_id".to_string(),
                        json!(&activation.id),
                    );
                }
                match activation.status {
                    ThreadActivationStatus::Queued => {
                        if self.activation_admission.contains(&activation.id) {
                            self.bus.dispatch_persisted(trigger).await?;
                        }
                    }
                    ThreadActivationStatus::Running => {
                        if runtime_claimant_is_definitely_dead(activation.claimed_by.as_deref()) {
                            tracing::warn!(
                                activation_id = %activation.id,
                                claimed_by = ?activation.claimed_by,
                                "恢复由已退出 Runtime 持有的 Thread Activation"
                            );
                            match session_store
                                .update_thread_activation(
                                    &activation.id,
                                    activation.revision,
                                    ThreadActivationStatus::Queued,
                                    None,
                                    None,
                                    None,
                                )
                                .await?
                            {
                                ThreadActivationMutation::Updated(queued) => {
                                    self.cancel_activation_lease(&activation.id).await?;
                                    if self.activation_admission.restore_queued(
                                        activation_admission_key(&queued, &trigger),
                                    )? == RestoreQueuedOutcome::Restored
                                    {
                                        self.bus.dispatch_persisted(trigger).await?;
                                    }
                                }
                                ThreadActivationMutation::Conflict { .. }
                                | ThreadActivationMutation::NotFound => {}
                            }
                            continue;
                        }
                        self.arm_activation_lease(&activation).await?;
                    }
                    ThreadActivationStatus::Succeeded
                    | ThreadActivationStatus::Cancelled
                    | ThreadActivationStatus::Failed => {}
                }
            }
        }
        Ok(())
    }

    /// Close active Thread rows that cannot possibly make progress after a
    /// restart. Waiting Threads are excluded because a background result,
    /// dependency, timer, delegation or Objective supervisor may still own
    /// their next wake. An active Dialogue/Work/Delivery Thread without a
    /// non-terminal Thread Activation or queued schedule is an inconsistent orphan,
    /// usually produced by an older Runtime crossing a persistence boundary.
    async fn reconcile_orphaned_threads(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        let scheduled_threads = session_store
            .list_schedules(None, Some(crate::memory::ScheduleStatus::Queued))
            .await?
            .into_iter()
            .map(|intent| intent.thread_id)
            .collect::<HashSet<_>>();
        for context in session_store.list_contexts(false).await? {
            let activations = session_store
                .list_context_thread_activations(&context.id, true)
                .await?;
            let active_roots = activations
                .iter()
                .filter(|item| !item.status.is_terminal())
                .map(|item| item.root_turn_id.clone())
                .collect::<HashSet<_>>();
            let threads = session_store
                .list_context_threads(&context.id, false)
                .await?;
            for thread in threads {
                if thread.lifecycle != ThreadLifecycle::Open
                    || !matches!(
                        thread.kind,
                        ThreadKind::DialogueTurn | ThreadKind::Execution | ThreadKind::Delivery
                    )
                    || active_roots.contains(&thread.root_turn_id)
                    || scheduled_threads.contains(&thread.id)
                {
                    continue;
                }
                let event_id = format!("thread_reconciled_{}_r{}", thread.id, thread.revision);
                let reason = "Runtime 重启时检测到 active Thread 没有非终态 Thread Activation、待执行调度或已提交终态；已将遗留孤儿状态标记为 cancelled。";
                match session_store
                    .update_thread(
                        &thread.id,
                        thread.revision,
                        None,
                        Some(ThreadLifecycle::Cancelled),
                        Some(reason),
                        Some(&event_id),
                        None,
                        None,
                    )
                    .await?
                {
                    ThreadMutation::Updated(_) => {
                        if let Some(scheduler) = &self.thread_scheduler {
                            scheduler.dependency_completed(&thread.id).await?;
                        }
                        tracing::warn!(
                            thread_id = %thread.id,
                            root_turn_id = %thread.root_turn_id,
                            "Runtime 启动时已收口孤儿 Thread"
                        );
                        self.bus
                            .publish(Event::new(
                                event_id,
                                "Runtime-Recovery".to_string(),
                                "runtime_control".to_string(),
                                "runtime/thread_reconciled".to_string(),
                                vec![
                                    ("agent_id".to_string(), json!(thread.agent_id)),
                                    ("context_id".to_string(), json!(thread.context_id)),
                                    ("session_id".to_string(), json!(thread.session_id)),
                                    ("thread_id".to_string(), json!(thread.id)),
                                    ("root_turn_id".to_string(), json!(thread.root_turn_id)),
                                    ("thread_kind".to_string(), json!(thread.kind.as_str())),
                                    ("status".to_string(), json!("cancelled")),
                                    (
                                        "reason".to_string(),
                                        json!("orphaned_after_runtime_restart"),
                                    ),
                                    ("text".to_string(), json!(reason)),
                                ]
                                .into_iter()
                                .collect(),
                            ))
                            .await?;
                    }
                    ThreadMutation::Conflict { .. } | ThreadMutation::NotFound => {}
                }
            }
        }
        Ok(())
    }

    async fn recover_delegations(&self) -> Result<(), DynError> {
        let Some(session_store) = self.context_engine.session_store() else {
            return Ok(());
        };
        for delegation in session_store.list_delegations().await? {
            if !matches!(
                delegation.status,
                DelegationStatus::Queued | DelegationStatus::Running
            ) {
                continue;
            }
            let activations = session_store
                .list_context_thread_activations(&delegation.child_context_id, false)
                .await?;
            if activations
                .iter()
                .any(|item| item.session_id == delegation.child_session_id)
            {
                continue;
            }

            let terminal = self
                .store
                .query(QueryFilter {
                    session_id: Some(delegation.child_session_id.clone()),
                    types: vec![TYPE_AGENT_CALL.to_string()],
                    latest_k: Some(100),
                    excluded_topics: vec!["chat/context_inspect".to_string()],
                    ..Default::default()
                })
                .await?
                .into_iter()
                .rev()
                .find(|event| matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply"));
            if let Some(terminal) = terminal {
                self.complete_delegation_if_needed(&terminal, &delegation.child_session_id)
                    .await?;
                continue;
            }

            let failure_id = format!(
                "delegation_recovery_failed_{}_{}",
                delegation.id,
                Utc::now().timestamp_nanos_opt().unwrap_or(0)
            );
            session_store
                .update_delegation_status(
                    &delegation.id,
                    DelegationStatus::Failed,
                    Some(&failure_id),
                )
                .await?;
            self.bus
                .publish(Event::new(
                    failure_id,
                    "System-Delegation".to_string(),
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
                        ("tool_name".to_string(), json!("delegate")),
                        ("tool_status".to_string(), json!("error")),
                        (
                            "text".to_string(),
                            json!(json!({
                                "delegation_id": delegation.id,
                                "status": "failed",
                                "error": "Runtime 重启后未发现活跃 Evaluation 或已提交的终态结果；旧 running 状态已回收，未重复执行外部动作。"
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
            && matches!(event.topic.as_str(), "chat/reply" | "chat/no_reply")
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
        let result_event = Event::new(
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
        );
        if session_store
            .commit_delegation_result(&delegation.id, &result_event)
            .await?
        {
            self.bus.dispatch_persisted(result_event).await?;
        }
        Ok(true)
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
                if let Some(store) = self.context_engine.session_store() {
                    store.discard_signal_outbox(&event.id).await?;
                }
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

        // Serialize every durable event belonging to one root turn before it
        // materializes or claims a successor Activation. The original user
        // Activation holds this gate through terminal persistence and the
        // pending-signal handoff below. A physical result that arrives during
        // that window therefore cannot observe the old Activation as running,
        // leave its Signal pending, and race the terminal side's one-shot scan.
        let routed_root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            .unwrap_or(event.id.as_str())
            .to_string();
        let _thread_guard = self.thread_gate(&routed_root_turn_id).lock_owned().await;

        let Some(admitted) = self.claim_thread_activation(&event).await? else {
            tracing::debug!(
                session_id,
                event_id = %event.id,
                "Thread Activation 已由其他 worker claim 或已经终止"
            );
            return Ok(());
        };
        let activation = admitted.record;
        let _activation_admission_permit = admitted._permit;

        // Bind an Objective continuation before any await in the Evaluation
        // body. A concurrent pause/cancel can therefore target this exact
        // Activation instead of falling back to the enclosing Session.
        self.bind_embedded_objective_route(&activation.id, &event);
        if let (Some(supervisor), Some(objective_id), Some(evaluation_id)) = (
            self.objective_supervisor.as_ref(),
            event
                .payload
                .get("objective_id")
                .and_then(|value| value.as_str()),
            event
                .payload
                .get("objective_evaluation_id")
                .and_then(|value| value.as_str()),
        ) {
            let objective_control_receipt = event
                .payload
                .get("tool_name")
                .and_then(|value| value.as_str())
                == Some("objective_update");
            if !supervisor
                .accepts_routed_evaluation(objective_id, evaluation_id, objective_control_receipt)
                .await?
            {
                tracing::info!(
                    session_id,
                    objective_id,
                    evaluation_id,
                    activation_id = %activation.id,
                    "抑制已被暂停、取消或取代的 Objective Evaluation"
                );
                self.finish_thread_activation(&activation, ThreadActivationStatus::Cancelled)
                    .await?;
                self.objective_evaluations.remove_activation(&activation.id);
                return Ok(());
            }
        }

        let mut cancellation = self.cancellation_sender(&session_id).subscribe();
        let start_epoch = *cancellation.borrow();
        let active_counter = self.active_counter(&session_id);
        active_counter.fetch_add(1, Ordering::SeqCst);
        let attempt = tokio::select! {
            biased;
            cancelled = self.objective_evaluations.wait_for_activation_cancellation(&activation.id) => {
                (None, Some(cancelled))
            }
            _ = cancellation.changed() => {
                debug_assert_ne!(*cancellation.borrow(), start_epoch);
                (None, None)
            }
            result = async {
            if let Some(thread) = self
                .context_engine
                .session_store()
                .ok_or("Thread 需要持久化 SessionStore")?
                .get_thread_by_root(&activation.root_turn_id)
                .await?
            {
                if thread.lifecycle.is_terminal() {
                    tracing::debug!(
                        root_turn_id = %activation.root_turn_id,
                        event_id = %event.id,
                        "Thread 已终止，抑制迟到的 mailbox wake"
                    );
                    return Ok(());
                }
            }
            let force_evaluation = event
                .payload
                .get("runtime_force_evaluation")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if event.event_type == TYPE_TOOL_OUTPUT
                && !force_evaluation
                && self
                    .activation_signals_already_covered(&session_id, &activation, &event)
                    .await?
            {
                tracing::debug!(
                    session_id,
                    event_id = %event.id,
                    "跳过已被更新 Context view 覆盖的排队 tool wakeup"
                );
                self.release_dialogue_thread(&session_id, &activation.root_turn_id)
                    .await;
                return Ok(());
            }
            if let Some(supervisor) = &self.objective_supervisor {
                supervisor.prepare_routed_event(&event, &activation.id).await?;
            }
            self.run_attempt(&session_id, &activation).await
            } => (Some(result), None),
        };
        active_counter.fetch_sub(1, Ordering::SeqCst);
        let (result, final_status) = match attempt {
            (Some(result), _) => {
                let status = if result.is_ok() {
                    ThreadActivationStatus::Succeeded
                } else {
                    ThreadActivationStatus::Failed
                };
                (result, status)
            }
            (None, Some(cancelled)) => {
                tracing::info!(
                    session_id,
                    objective_id = %cancelled.objective_id,
                    evaluation_id = %cancelled.evaluation_id,
                    activation_id = %activation.id,
                    "当前 Objective Evaluation 已取消；Session 与其他 Evaluation 继续运行"
                );
                let result = self
                    .request_cancel_execution_jobs_for_activation(
                        &activation.id,
                        &format!(
                            "Objective '{}' Evaluation '{}' 已被暂停或取消",
                            cancelled.objective_id, cancelled.evaluation_id
                        ),
                    )
                    .await
                    .map(|_| ());
                (result, ThreadActivationStatus::Cancelled)
            }
            (None, None) => {
                tracing::info!(session_id, "当前 Session 执行已由用户取消");
                let result = self
                    .request_cancel_execution_jobs_for_activation(
                        &activation.id,
                        &format!("Session '{session_id}' 已由用户取消"),
                    )
                    .await
                    .map(|_| ());
                (result, ThreadActivationStatus::Cancelled)
            }
        };
        if matches!(
            final_status,
            ThreadActivationStatus::Cancelled | ThreadActivationStatus::Failed
        ) {
            self.release_dialogue_thread(&session_id, &activation.root_turn_id)
                .await;
        }
        if let Err(error) = self
            .finish_thread_activation(&activation, final_status)
            .await
        {
            self.activation_routes.remove(&activation.id);
            self.objective_evaluations.remove_activation(&activation.id);
            if result.is_ok() {
                return Err(error);
            }
            tracing::warn!(
                activation_id = %activation.id,
                error = %error,
                "Thread Activation 终态提交失败；保留原始执行错误"
            );
        }
        self.activation_routes.remove(&activation.id);
        self.objective_evaluations.remove_activation(&activation.id);
        if matches!(
            final_status,
            ThreadActivationStatus::Succeeded | ThreadActivationStatus::Failed
        ) {
            self.dispatch_next_pending_thread_signal(&activation.root_turn_id)
                .await?;
        }
        result
    }

    async fn dispatch_next_pending_thread_signal(
        &self,
        root_turn_id: &str,
    ) -> Result<(), DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Signal dispatch 需要持久化 SessionStore")?;
        let Some(thread) = session_store.get_thread_by_root(root_turn_id).await? else {
            return Ok(());
        };
        let Some(signal) = session_store.next_pending_thread_signal(&thread.id).await? else {
            return Ok(());
        };
        let Some(event) = self
            .store
            .query(QueryFilter {
                event_id: Some(signal.event_id.clone()),
                context_id: Some(thread.context_id),
                session_id: Some(thread.session_id),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|event| event.id == signal.event_id)
        else {
            return Err(format!(
                "Pending Thread Signal '{}' 的 Event '{}' 不存在",
                signal.id, signal.event_id
            )
            .into());
        };
        self.bus.dispatch_persisted(event).await?;
        Ok(())
    }

    async fn claim_thread_activation(
        &self,
        event: &Event,
    ) -> Result<Option<AdmittedThreadActivation>, DynError> {
        let session_id = required_payload_str(event, "session_id")?;
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Activation 需要持久化 SessionStore")?;
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
                    event_id: Some(event.id.clone()),
                    session_id: Some(session_id.to_string()),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .find(|stored| stored.id == event.id)
                .and_then(|stored| stored.sequence)
                .ok_or_else(|| {
                    format!(
                        "Trigger Event '{}' 尚未进入 Ledger，不能创建 Thread Activation",
                        event.id
                    )
                })?,
        };
        let parent_activation_id = event
            .payload
            .get("activation_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
        let parent = match parent_activation_id.as_deref() {
            Some(id) => session_store.get_thread_activation(id).await?,
            None => None,
        };
        let root_turn_id = event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
            .or_else(|| parent.as_ref().map(|item| item.root_turn_id.clone()))
            .unwrap_or_else(|| event.id.clone());
        let initial_thread_kind = if event.topic == "chat/thread_completion_ready" {
            ThreadKind::Delivery
        } else if event.event_type == TYPE_USER_MESSAGE {
            ThreadKind::DialogueTurn
        } else {
            ThreadKind::Execution
        };
        let thread = session_store
            .ensure_thread(NewThread {
                id: stable_thread_id(&root_turn_id),
                agent_id: session.agent_id.clone(),
                context_id: session.context_id.clone(),
                session_id: session.id.clone(),
                root_turn_id: root_turn_id.clone(),
                kind: initial_thread_kind,
                executor_kind: "self".to_string(),
                executor_id: None,
            })
            .await?;
        let digest = Sha256::digest(event.id.as_bytes());
        let activation_id = format!("work_{:x}", digest);
        let activation_id = activation_id[..29].to_string();
        let signal_id = format!("signal_{:x}", digest);
        let signal_id = signal_id[..31].to_string();
        let Some(activation) = session_store
            .claim_thread_signal_batch(
                NewThreadSignal {
                    id: signal_id,
                    thread_id: thread.id,
                    event_id: event.id.clone(),
                    sequence: trigger_sequence,
                    kind: event.topic.clone(),
                    parent_activation_id: parent_activation_id.clone(),
                },
                NewThreadActivation {
                    id: activation_id,
                    agent_id: session.agent_id.clone(),
                    context_id: session.context_id.clone(),
                    session_id: session.id.clone(),
                    trigger_event_id: event.id.clone(),
                    trigger_sequence,
                    trigger_kind: event.topic.clone(),
                    parent_activation_id,
                    root_turn_id,
                },
                MAX_ACTIVATION_SIGNAL_BATCH,
            )
            .await?
        else {
            return Ok(None);
        };
        if activation.status.is_terminal() {
            self.activation_admission.forget(&activation.id);
            return Ok(None);
        }
        let now = Utc::now();
        if activation.status == ThreadActivationStatus::Running
            && activation
                .lease_expires_at
                .is_some_and(|expires_at| expires_at > now)
        {
            self.activation_admission.forget(&activation.id);
            return Ok(None);
        }
        let admission_permit = match self
            .activation_admission
            .acquire(activation_admission_key(&activation, event))
            .await
        {
            Ok(permit) => permit,
            Err(ActivationAdmissionError::AlreadyLocal(_)) => return Ok(None),
            Err(error @ ActivationAdmissionError::WindowFull { .. }) => {
                // The Activation and its claimed Signal batch remain durably
                // queued. A permit/window change wakes the refill loop, which
                // re-dispatches this Trigger when it can enter the window.
                tracing::info!(
                    activation_id = %activation.id,
                    session_id = %activation.session_id,
                    %error,
                    "Activation 受到有界 backpressure；延迟而非失败"
                );
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        let lease_expires_at = now + self.activation_lease_duration();
        match session_store
            .update_thread_activation(
                &activation.id,
                activation.revision,
                ThreadActivationStatus::Running,
                Some(&format!("runtime:{}", std::process::id())),
                Some(lease_expires_at),
                None,
            )
            .await?
        {
            ThreadActivationMutation::Updated(claimed) => {
                self.arm_activation_lease(&claimed).await?;
                Ok(Some(AdmittedThreadActivation {
                    record: claimed,
                    _permit: admission_permit,
                }))
            }
            ThreadActivationMutation::Conflict { .. } => Ok(None),
            ThreadActivationMutation::NotFound => {
                Err(format!("Thread Activation '{}' 在 claim 时消失", activation.id).into())
            }
        }
    }

    async fn finish_thread_activation(
        &self,
        activation: &ThreadActivationRecord,
        status: ThreadActivationStatus,
    ) -> Result<ThreadActivationRecord, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Activation 需要持久化 SessionStore")?;
        let Some(current) = session_store.get_thread_activation(&activation.id).await? else {
            return Err(format!("Thread Activation '{}' 在结束时消失", activation.id).into());
        };
        if current.status.is_terminal() {
            self.cancel_activation_lease(&current.id).await?;
            return Ok(current);
        }
        let updated = match session_store
            .update_thread_activation(
                &current.id,
                current.revision,
                status,
                None,
                None,
                current.context_snapshot_version,
            )
            .await?
        {
            ThreadActivationMutation::Updated(updated) => updated,
            ThreadActivationMutation::Conflict { current } if current.status.is_terminal() => {
                current
            }
            ThreadActivationMutation::Conflict { current } => {
                return Err(format!(
                    "Thread Activation '{}' 终态提交冲突：当前 revision={} status={}",
                    current.id,
                    current.revision,
                    current.status.as_str()
                )
                .into())
            }
            ThreadActivationMutation::NotFound => {
                return Err(format!("Thread Activation '{}' 在结束时消失", activation.id).into());
            }
        };
        self.cancel_activation_lease(&updated.id).await?;
        Ok(updated)
    }

    async fn record_activation_context_snapshot(
        &self,
        activation: &ThreadActivationRecord,
        context_version: u64,
    ) -> Result<(), DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread Activation 需要持久化 SessionStore")?;
        let Some(current) = session_store.get_thread_activation(&activation.id).await? else {
            return Err(format!("Thread Activation '{}' 在记录快照时消失", activation.id).into());
        };
        if current.status.is_terminal() || current.context_snapshot_version == Some(context_version)
        {
            return Ok(());
        }
        match session_store
            .update_thread_activation(
                &current.id,
                current.revision,
                current.status,
                current.claimed_by.as_deref(),
                current.lease_expires_at,
                Some(context_version),
            )
            .await?
        {
            ThreadActivationMutation::Updated(updated) => {
                self.arm_activation_lease(&updated).await?;
                Ok(())
            }
            ThreadActivationMutation::Conflict { current }
                if current.context_snapshot_version == Some(context_version) =>
            {
                Ok(())
            }
            ThreadActivationMutation::Conflict { current } => Err(format!(
                "Thread Activation '{}' Context snapshot 提交冲突：revision={}",
                current.id, current.revision
            )
            .into()),
            ThreadActivationMutation::NotFound => Err(format!(
                "Thread Activation '{}' 在记录 Context snapshot 时消失",
                activation.id
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
                    event_id: Some(trigger.id.clone()),
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
                after_sequence: trigger_sequence,
                topic: Some("chat/context_inspect".to_string()),
                search_query: trigger_root_turn_id.map(ToOwned::to_owned),
                top_k: Some(1),
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

    async fn activation_signals_already_covered(
        &self,
        session_id: &str,
        activation: &ThreadActivationRecord,
        dispatched_event: &Event,
    ) -> Result<bool, DynError> {
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Activation Signal coverage 需要持久化 SessionStore")?;
        let signals = session_store
            .list_activation_signals(&activation.id)
            .await?;
        if signals.is_empty() {
            return self
                .tool_output_already_covered(session_id, dispatched_event)
                .await;
        }
        for signal in signals {
            let event = if signal.event_id == dispatched_event.id {
                dispatched_event.clone()
            } else {
                self.context_engine
                    .find_event(&activation.context_id, &signal.event_id)
                    .await?
                    .ok_or_else(|| {
                        format!(
                            "Activation '{}' 领取的 Signal Event '{}' 不存在",
                            activation.id, signal.event_id
                        )
                    })?
            };
            if event.event_type != TYPE_TOOL_OUTPUT
                || !self.tool_output_already_covered(session_id, &event).await?
            {
                return Ok(false);
            }
        }
        Ok(true)
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
                types: vec![TYPE_AGENT_CALL.to_string(), TYPE_TOOL_OUTPUT.to_string()],
                excluded_topics: vec!["chat/context_inspect".to_string()],
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

    async fn request_model_completion(
        &self,
        session_id: &str,
        attempt_id: &str,
        messages: Vec<Message>,
        tools: Vec<crate::llm::ToolDefinition>,
        prompt_measurement: Option<PromptTokenCount>,
    ) -> Result<crate::llm::Response, ModelCompletionError> {
        let deadline = std::time::Duration::from_secs(
            self.orchestrator_config.model_attempt_timeout_secs.max(1),
        );
        // The configured model deadline covers both queueing for a provider
        // slot and the physical request.  Without a shared absolute deadline,
        // a saturated semaphore could wait forever after the old whole-
        // Attempt watchdog was removed, or consume one full timeout before
        // starting another full timeout for the request itself.
        let model_deadline = tokio::time::Instant::now() + deadline;
        let _permit =
            match tokio::time::timeout_at(model_deadline, self.concurrency_semaphore.acquire())
                .await
            {
                Ok(permit) => permit.map_err(|error| {
                    ModelCompletionError::without_summary(Box::new(error) as DynError)
                })?,
                Err(error) => {
                    return Err(ModelCompletionError::without_summary(
                        Box::new(error) as DynError
                    ))
                }
            };
        let client = Arc::clone(&self.client);
        let (stream_tx, mut stream_rx) = tokio::sync::mpsc::unbounded_channel();
        let stream_bus = Arc::clone(&self.bus);
        let stream_session_id = session_id.to_string();
        let stream_context_id = self
            .context_id_for_session(session_id)
            .map_err(ModelCompletionError::without_summary)?;
        let stream_attempt_id = attempt_id.to_string();
        let mut stream_route = Vec::new();
        self.append_activation_route(attempt_id, &mut stream_route);
        let reasoning_summary = Arc::new(Mutex::new(ModelReasoningSummaryAccumulator::default()));
        let forward_bus = Arc::clone(&stream_bus);
        let forward_session_id = stream_session_id.clone();
        let forward_context_id = stream_context_id.clone();
        let forward_attempt_id = stream_attempt_id.clone();
        let forward_route = stream_route.clone();
        let forward_reasoning_summary = Arc::clone(&reasoning_summary);
        let stream_forwarder = tokio::spawn(async move {
            let stream_started_at = tokio::time::Instant::now();
            let mut text_delta_count = 0u64;
            let mut text_chars = 0usize;
            let mut reasoning_summary_delta_count = 0u64;
            let mut reasoning_summary_chars = 0usize;
            let mut first_text_delta_ms = None;
            while let Some(stream_event) = stream_rx.recv().await {
                match &stream_event {
                    crate::llm::ModelStreamEvent::TextDelta { text } => {
                        text_delta_count = text_delta_count.saturating_add(1);
                        text_chars = text_chars.saturating_add(text.chars().count());
                        first_text_delta_ms.get_or_insert_with(|| {
                            u64::try_from(stream_started_at.elapsed().as_millis())
                                .unwrap_or(u64::MAX)
                        });
                    }
                    crate::llm::ModelStreamEvent::ReasoningSummaryDelta { text } => {
                        reasoning_summary_delta_count =
                            reasoning_summary_delta_count.saturating_add(1);
                        reasoning_summary_chars =
                            reasoning_summary_chars.saturating_add(text.chars().count());
                        forward_reasoning_summary.lock().await.text.push_str(text);
                    }
                    crate::llm::ModelStreamEvent::Usage {
                        prompt_tokens,
                        completion_tokens,
                        total_tokens,
                    } => {
                        let mut summary = forward_reasoning_summary.lock().await;
                        summary.prompt_tokens = prompt_tokens.or(summary.prompt_tokens);
                        summary.completion_tokens = completion_tokens.or(summary.completion_tokens);
                        summary.total_tokens = total_tokens.or(summary.total_tokens);
                    }
                    crate::llm::ModelStreamEvent::Completed => {
                        forward_reasoning_summary.lock().await.complete = true;
                        tracing::info!(
                            session_id = %forward_session_id,
                            attempt_id = %forward_attempt_id,
                            text_delta_count,
                            text_chars,
                            reasoning_summary_delta_count,
                            reasoning_summary_chars,
                            first_text_delta_ms,
                            total_stream_ms = u64::try_from(stream_started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
                            "模型原生流已完成"
                        );
                    }
                    crate::llm::ModelStreamEvent::Failed { message } => {
                        forward_reasoning_summary.lock().await.failure = Some(message.clone());
                    }
                    _ => {}
                }
                let mut payload = vec![
                    ("context_id".to_string(), json!(&forward_context_id)),
                    ("session_id".to_string(), json!(&forward_session_id)),
                    ("attempt_id".to_string(), json!(&forward_attempt_id)),
                    ("stream".to_string(), json!(stream_event)),
                ];
                payload.extend(forward_route.clone());
                let event = Event::new(
                    format!(
                        "model_stream_{}",
                        Utc::now().timestamp_nanos_opt().unwrap_or(0)
                    ),
                    "Model-Provider".to_string(),
                    "runtime_ephemeral".to_string(),
                    "runtime/model_stream".to_string(),
                    payload.into_iter().collect(),
                );
                if let Err(error) = forward_bus.publish_ephemeral(event).await {
                    tracing::debug!(%error, "发布瞬时模型流事件失败");
                }
            }
            persist_model_reasoning_summary(
                &forward_bus,
                &forward_context_id,
                &forward_session_id,
                &forward_attempt_id,
                &forward_route,
                &forward_reasoning_summary,
                false,
            )
            .await
        });
        let result = if client.supports_async_cancellation() {
            // Protocol-native clients are fully asynchronous. Keeping their
            // future in this task means timeout/cancellation drops the reqwest
            // future itself and therefore closes the underlying HTTP request.
            match tokio::time::timeout_at(
                model_deadline,
                client.create_completion_measured_stream(
                    messages,
                    tools,
                    prompt_measurement,
                    stream_tx,
                ),
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    stream_forwarder.abort();
                    let _ = stream_forwarder.await;
                    persist_model_reasoning_summary(
                        &stream_bus,
                        &stream_context_id,
                        &stream_session_id,
                        &stream_attempt_id,
                        &stream_route,
                        &reasoning_summary,
                        true,
                    )
                    .await
                    .map_err(|persist_error| {
                        ModelCompletionError::without_summary(persist_error)
                    })?;
                    return Err(ModelCompletionError::with_summary(
                        Box::new(error) as DynError,
                        &reasoning_summary,
                    )
                    .await);
                }
            }
        } else {
            // Compatibility boundary for custom clients and test doubles that
            // may synchronously block inside an async method. A Tokio timeout
            // cannot pre-empt such code, so keep it off the Runtime workers.
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
                })
                .map_err(|error| {
                    ModelCompletionError::without_summary(Box::new(error) as DynError)
                })?;
            match tokio::time::timeout_at(model_deadline, model_rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => Err(error.into()),
                Err(error) => {
                    stream_forwarder.abort();
                    let _ = stream_forwarder.await;
                    persist_model_reasoning_summary(
                        &stream_bus,
                        &stream_context_id,
                        &stream_session_id,
                        &stream_attempt_id,
                        &stream_route,
                        &reasoning_summary,
                        true,
                    )
                    .await
                    .map_err(|persist_error| {
                        ModelCompletionError::without_summary(persist_error)
                    })?;
                    return Err(ModelCompletionError::with_summary(
                        Box::new(error) as DynError,
                        &reasoning_summary,
                    )
                    .await);
                }
            }
        };
        let forward_result = stream_forwarder.await;
        match (result, forward_result) {
            (Err(error), _) => {
                Err(ModelCompletionError::with_summary(error, &reasoning_summary).await)
            }
            (Ok(_), Err(error)) => Err(ModelCompletionError::with_summary(
                Box::new(error) as DynError,
                &reasoning_summary,
            )
            .await),
            (Ok(_), Ok(Err(error))) => {
                Err(ModelCompletionError::with_summary(error, &reasoning_summary).await)
            }
            (Ok(response), Ok(Ok(()))) => Ok(response),
        }
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
        let measurement_deadline = tokio::time::Instant::now() + deadline;
        let token_scope = format!("{}:{}", context.context_id, context.active_session_id);
        let measurement = tokio::time::timeout_at(measurement_deadline, async {
            let _permit = self.concurrency_semaphore.acquire().await?;
            self.client
                .count_prompt_tokens(&token_scope, messages, tools)
                .await
        })
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
    /// owning Thread Activation reached a terminal state. Re-asking the model here could produce a new
    /// set of call IDs and repeat an external side effect, so recovery always reuses the exact
    /// persisted plan. `execute_tool_calls` also reuses any already durable output events.
    async fn resume_persisted_activation(
        &self,
        session_id: &str,
        activation: &ThreadActivationRecord,
    ) -> Result<bool, DynError> {
        let assistant_event_id = format!("call_{}", activation.id);
        let Some(assistant_call) = self
            .context_engine
            .find_event(&activation.context_id, &assistant_event_id)
            .await?
        else {
            return Ok(false);
        };
        if assistant_call.topic != "chat/assistant_call" {
            return Err(format!(
                "Thread Activation '{}' 的恢复边界 '{}' 不是 assistant_call",
                activation.id, assistant_event_id
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
            .get("terminal_outcome")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            let decision = classify_terminal_response(&response)
                .map_err(|error| -> DynError { error.into() })?
                .ok_or_else(|| {
                    format!(
                        "Thread Activation '{}' 的持久化终态响应不合法",
                        activation.id
                    )
                })?;
            let parent = self
                .parent_session_for(&activation.context_id, session_id)
                .await?;
            tracing::info!(
                activation_id = %activation.id,
                disposition = decision.disposition(),
                "从持久化 assistant_call 恢复 Evaluation 终态"
            );
            match decision {
                TerminalDecision::Deliver(content) => {
                    let model_attempt_id = assistant_call
                        .payload
                        .get("model_attempt_id")
                        .and_then(|value| value.as_str());
                    self.publish_reply_for_model_attempt(
                        session_id,
                        &activation.id,
                        model_attempt_id,
                        content,
                        parent.as_deref(),
                    )
                    .await?;
                }
                TerminalDecision::NoReply => {
                    self.publish_no_reply(session_id, &activation.id, parent.as_deref())
                        .await?;
                }
            }
            return Ok(true);
        }

        if response.tool_calls.is_empty() {
            return Err(format!(
                "Thread Activation '{}' 的持久化 assistant_call 既非终态回复也没有工具调用",
                activation.id
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
        let model_attempt_id = assistant_call
            .payload
            .get("model_attempt_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
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
            activation_id = %activation.id,
            tool_calls = response.tool_calls.len(),
            "从持久化 assistant_call 恢复工具执行计划"
        );
        self.execute_tool_calls(
            session_id,
            &activation.id,
            response,
            phase,
            ToolExecutionOptions {
                context_tx_allowed,
                wake_on_output: true,
                transcript_tool_calls,
                allowed_tool_names,
                record_assistant_call: false,
                model_attempt_id,
            },
        )
        .await?;
        Ok(true)
    }

    async fn run_attempt(
        &self,
        session_id: &str,
        activation: &ThreadActivationRecord,
    ) -> Result<(), DynError> {
        let attempt_id = activation.id.clone();
        let persisted_assistant_call = self
            .context_engine
            .find_event(&activation.context_id, &format!("call_{}", activation.id))
            .await?;
        let persisted_physical_plan = persisted_assistant_call
            .as_ref()
            .is_some_and(event_contains_physical_tool_plan);
        let persisted_terminal = persisted_assistant_call.as_ref().is_some_and(|event| {
            event
                .payload
                .get("terminal_outcome")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        });
        let dialogue_gate = self.dialogue_thread_gate(session_id);
        let dialogue_bound =
            if activation.trigger_kind == "chat/user_message" && !persisted_physical_plan {
                dialogue_gate.acquire(&activation.root_turn_id).await;
                true
            } else {
                dialogue_gate.owns(&activation.root_turn_id).await
            };
        let thread_kind = if activation.trigger_kind == "chat/thread_completion_ready" {
            "delivery"
        } else if self
            .objective_evaluations
            .get_for_activation(&activation.id)
            .is_some()
        {
            "objective"
        } else if dialogue_bound {
            "dialogue_turn"
        } else {
            "execution"
        };
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread 需要持久化 SessionStore")?;
        let mut thread = session_store
            .get_thread_by_root(&activation.root_turn_id)
            .await?
            .ok_or_else(|| format!("Root Turn '{}' 缺少 Thread", activation.root_turn_id))?;
        let desired_kind = match thread_kind {
            "dialogue_turn" => ThreadKind::DialogueTurn,
            "objective" => ThreadKind::Objective,
            "delivery" => ThreadKind::Delivery,
            _ => ThreadKind::Execution,
        };
        let delivery_thread_ids = if thread_kind == "delivery" {
            self.context_engine
                .find_event(&activation.context_id, &activation.trigger_event_id)
                .await?
                .and_then(|event| {
                    event
                        .payload
                        .get("completed_thread_ids")
                        .and_then(serde_json::Value::as_array)
                        .map(|ids| {
                            ids.iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(ToOwned::to_owned)
                                .collect::<Vec<_>>()
                        })
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if thread.kind != desired_kind {
            if let ThreadMutation::Updated(updated) = session_store
                .update_thread(
                    &thread.id,
                    thread.revision,
                    Some(desired_kind),
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await?
            {
                thread = updated;
            }
        }
        self.activation_routes.insert(
            attempt_id.clone(),
            ActivationRoute {
                thread_id: thread.id.clone(),
                activation_id: activation.id.clone(),
                root_turn_id: activation.root_turn_id.clone(),
                trigger_event_id: activation.trigger_event_id.clone(),
                trigger_sequence: activation.trigger_sequence,
                context_snapshot_version: activation.context_snapshot_version,
                thread_kind,
                delivery_thread_ids,
            },
        );
        if self
            .resume_persisted_activation(session_id, activation)
            .await?
        {
            if dialogue_bound && persisted_terminal {
                dialogue_gate.release(&activation.root_turn_id).await;
            }
            return Ok(());
        }
        if thread_kind == "delivery" && self.pending_delivery_threads(session_id).await?.is_empty()
        {
            tracing::info!(
                session_id,
                activation_id = %activation.id,
                "Completion Inbox 已由并发 Delivery Thread 清空；跳过重复模型求值"
            );
            self.publish_no_reply(session_id, &attempt_id, None).await?;
            return Ok(());
        }
        let transcript = self
            .turn_tool_transcript(
                session_id,
                Some(&activation.root_turn_id),
                Some(&activation.trigger_event_id),
            )
            .await?;
        let context_id = activation.context_id.clone();
        let mut context = self
            .context_engine
            .build_context_encoding_for_activation(
                &context_id,
                activation,
                &transcript.delivered_output_ids,
            )
            .await?;
        self.record_activation_context_snapshot(activation, context.state.version)
            .await?;
        if let Some(mut route) = self.activation_routes.get_mut(&attempt_id) {
            route.context_snapshot_version = Some(context.state.version);
        }
        let context_tx_receipt = self.context_tx_receipt(&context).await?;
        let objective_control_available = self
            .objective_evaluations
            .get_for_activation(&activation.id)
            .is_some_and(|active| {
                context.objectives.iter().any(|objective| {
                    objective.id == active.objective_id
                        && objective.coordinator_session_id == session_id
                        && objective.status == crate::memory::ObjectiveStatus::Active
                })
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
        if thread_kind == "delivery" {
            measurement_tools.clear();
        }
        if !objective_control_available {
            measurement_tools.retain(|tool| tool.name != "objective_update");
        }
        measurement_tools.push(no_reply_tool_definition());
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
            if let Err(error) = supervisor
                .record_prompt_tokens_for_activation(&activation.id, tokens)
                .await
            {
                tracing::warn!(
                    session_id,
                    activation_id = %activation.id,
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
        if thread_kind == "delivery" {
            tools.clear();
        }
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
        tools.push(no_reply_tool_definition());
        let allowed_tool_names = tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<HashSet<_>>();
        self.record_context_inspect(session_id, &attempt_id, &context, &messages);
        let base_protocol_messages = messages;
        let mut protocol_messages = base_protocol_messages.clone();
        let mut protocol_errors = 0usize;
        let mut model_request_index = 0usize;
        let mut reasoning_continuations = 0usize;
        let mut reasoning_history = Vec::new();
        let (response, terminal_decision, terminal_model_attempt_id) = loop {
            let request_index = model_request_index;
            model_request_index = model_request_index.saturating_add(1);
            let model_attempt_id = if request_index == 0 {
                attempt_id.clone()
            } else {
                format!("{attempt_id}_response_retry_{request_index}")
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
                    (request_index == 0)
                        .then(|| prompt_measurement.clone())
                        .flatten(),
                )
                .await;
            let response = match completion {
                Ok(response) => response,
                Err(error) if !error.reasoning_summary.trim().is_empty() => {
                    reasoning_continuations = reasoning_continuations.saturating_add(1);
                    self.record_reasoning_continuation(
                        session_id,
                        &model_attempt_id,
                        reasoning_continuations,
                        error.reasoning_summary.chars().count(),
                        &error.to_string(),
                    )
                    .await?;
                    // This is a continuation, not a fresh protocol retry: the
                    // next physical request receives the latest saved
                    // reasoning progress. Keep the configured reasoning level
                    // unchanged so the model can finish its reasoning on its
                    // own terms. Replace older recovery prompts to avoid
                    // repeatedly inflating Context across retries.
                    reasoning_history.push(error.reasoning_summary);
                    protocol_messages = base_protocol_messages.clone();
                    protocol_messages.push(Message {
                        role: "user".to_string(),
                        content: reasoning_continuation_prompt(&reasoning_history),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                    continue;
                }
                Err(error) if error.to_string().contains(EMPTY_RESPONSE_ERROR) => {
                    protocol_errors += 1;
                    self.record_response_protocol_error(
                        session_id,
                        &model_attempt_id,
                        protocol_errors,
                        "empty",
                        "模型返回空响应",
                    )
                    .await?;
                    if protocol_errors > MAX_RESPONSE_PROTOCOL_RETRIES {
                        return self
                            .publish_response_protocol_failure(
                                session_id,
                                &model_attempt_id,
                                context.parent_session_id.as_deref(),
                            )
                            .await;
                    }
                    protocol_messages.push(Message {
                        role: "user".to_string(),
                        content: RESPONSE_PROTOCOL_ERROR.to_string(),
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
                            &error,
                            context.parent_session_id.as_deref(),
                        )
                        .await;
                }
            };

            let classification = validate_schedule_tx_response(&response)
                .and_then(|_| classify_terminal_response(&response))
                .and_then(|decision| {
                    if decision.is_none() && effective_phase == "final-reply" {
                        Err("final-reply 阶段必须返回普通文本或独占调用 no_reply".to_string())
                    } else {
                        Ok(decision)
                    }
                });
            match classification {
                Ok(decision) => break (response, decision, model_attempt_id),
                Err(reason) => {
                    protocol_errors += 1;
                    self.record_response_protocol_error(
                        session_id,
                        &model_attempt_id,
                        protocol_errors,
                        "invalid",
                        &reason,
                    )
                    .await?;
                    if protocol_errors > MAX_RESPONSE_PROTOCOL_RETRIES {
                        return self
                            .publish_response_protocol_failure(
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
                        content: format!("{reason}。{RESPONSE_PROTOCOL_ERROR}"),
                        name: None,
                        tool_call_id: None,
                        tool_calls: None,
                    });
                }
            }
        };

        if let Some(decision) = terminal_decision {
            let active_root_tasks = active_background_task_count_for_root(
                session_id,
                &activation.context_id,
                &activation.root_turn_id,
            );
            let pending_schedules = session_store
                .list_schedules(Some(&thread.id), Some(ScheduleStatus::Queued))
                .await?
                .len();
            if thread_kind != "dialogue_turn" && (active_root_tasks > 0 || pending_schedules > 0) {
                if let TerminalDecision::Deliver(content) = &decision {
                    self.publish_progress(session_id, &attempt_id, content.clone())
                        .await?;
                }
                self.yield_thread(
                    session_id,
                    &attempt_id,
                    active_root_tasks,
                    pending_schedules,
                    decision.disposition(),
                )
                .await?;
                if dialogue_bound {
                    dialogue_gate.release(&activation.root_turn_id).await;
                }
                return Ok(());
            }
            self.record_terminal_response(
                session_id,
                &attempt_id,
                &terminal_model_attempt_id,
                effective_phase,
                &response,
                &decision,
            )
            .await?;
            let direct_interactive_execution = thread_kind == "execution"
                && self
                    .execution_result_is_interactive(&thread, activation)
                    .await?;
            let result = match decision {
                TerminalDecision::Deliver(content) => {
                    if thread_kind == "execution" && !direct_interactive_execution {
                        self.publish_thread_result(
                            session_id,
                            &attempt_id,
                            &terminal_model_attempt_id,
                            content,
                        )
                        .await
                    } else {
                        self.publish_reply_for_model_attempt(
                            session_id,
                            &attempt_id,
                            Some(&terminal_model_attempt_id),
                            content,
                            context.parent_session_id.as_deref(),
                        )
                        .await
                    }
                }
                TerminalDecision::NoReply => {
                    self.publish_no_reply(
                        session_id,
                        &attempt_id,
                        context.parent_session_id.as_deref(),
                    )
                    .await
                }
            };
            if dialogue_bound {
                dialogue_gate.release(&activation.root_turn_id).await;
            }
            return result;
        }

        debug_assert_ne!(effective_phase, "final-reply");

        if !response.tool_calls.is_empty() {
            if !response.content.trim().is_empty() {
                self.publish_progress(session_id, &attempt_id, response.content.clone())
                    .await?;
            }
            let context_maintenance_only = response
                .tool_calls
                .iter()
                .all(|call| call.func_name == "context_tx");
            if dialogue_bound && !context_maintenance_only {
                dialogue_gate.release(&activation.root_turn_id).await;
            }
            let result = self
                .execute_tool_calls(
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
                        model_attempt_id: Some(terminal_model_attempt_id.clone()),
                    },
                )
                .await;
            if result.is_err() && dialogue_bound && context_maintenance_only {
                dialogue_gate.release(&activation.root_turn_id).await;
            }
            result?;
            return Ok(());
        }

        unreachable!("无工具响应应由终态协议分类、纠错或熔断处理")
    }

    async fn execution_result_is_interactive(
        &self,
        thread: &ThreadRecord,
        activation: &ThreadActivationRecord,
    ) -> Result<bool, DynError> {
        let root = self
            .context_engine
            .find_event(&activation.context_id, &activation.root_turn_id)
            .await?;
        if root.is_none_or(|event| event.event_type != TYPE_USER_MESSAGE) {
            return Ok(false);
        }
        let store = self
            .context_engine
            .session_store()
            .ok_or("Interactive Execution 路由需要持久化 SessionStore")?;
        if !store
            .list_schedules(Some(&thread.id), None)
            .await?
            .is_empty()
        {
            return Ok(false);
        }
        let Some(manager) = &self.execution_jobs else {
            return Ok(true);
        };
        let jobs = manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                thread_id: Some(thread.id.clone()),
                include_terminal: true,
                ..Default::default()
            })
            .await?;
        Ok(!jobs.iter().any(|job| {
            job.tool_name == "exec/background"
                || job.request.get("mode").and_then(serde_json::Value::as_str) == Some("detached")
                || job
                    .request
                    .get("detached")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        }))
    }

    async fn record_response_protocol_error(
        &self,
        session_id: &str,
        attempt_id: &str,
        error_count: usize,
        response_state: &str,
        reason: &str,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("error_count".to_string(), json!(error_count)),
            (
                "max_retries".to_string(),
                json!(MAX_RESPONSE_PROTOCOL_RETRIES),
            ),
            ("response_state".to_string(), json!(response_state)),
            ("reason".to_string(), json!(reason)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "response_protocol_error_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/response_protocol_error".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn record_reasoning_continuation(
        &self,
        session_id: &str,
        attempt_id: &str,
        continuation_count: usize,
        reasoning_chars: usize,
        provider_error: &str,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("continuation_count".to_string(), json!(continuation_count)),
            ("reasoning_chars".to_string(), json!(reasoning_chars)),
            ("response_state".to_string(), json!("reasoning_only")),
            ("reason".to_string(), json!(REASONING_ONLY_RESPONSE_REASON)),
            ("provider_error".to_string(), json!(provider_error)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "reasoning_continuation_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_control".to_string(),
                "runtime/reasoning_continuation".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    async fn publish_response_protocol_failure(
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
                json!(MAX_RESPONSE_PROTOCOL_RETRIES + 1),
            ),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "response_protocol_fused_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime-Orchestrator".to_string(),
                "runtime_error".to_string(),
                "runtime/response_protocol_fused".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        self.publish_reply(
            session_id,
            attempt_id,
            "模型连续三次没有返回合法的普通文本或 no_reply，Runtime 已安全熔断本回合；已提交的 Mind、文件修改和 Ledger 均已保留。".to_string(),
            parent_session_id,
        )
        .await
    }

    async fn record_terminal_response(
        &self,
        session_id: &str,
        attempt_id: &str,
        model_attempt_id: &str,
        phase: &str,
        response: &crate::llm::Response,
        decision: &TerminalDecision,
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
            ("model_attempt_id".to_string(), json!(model_attempt_id)),
            ("phase".to_string(), json!(phase)),
            ("text".to_string(), json!(response.content)),
            ("tool_calls".to_string(), json!(tool_calls)),
            ("terminal_outcome".to_string(), json!(true)),
            (
                "outcome_disposition".to_string(),
                json!(decision.disposition()),
            ),
        ];
        self.append_activation_route(attempt_id, &mut payload);
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

    async fn publish_no_reply(
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
            ("disposition".to_string(), json!("no_reply")),
            ("text".to_string(), json!("")),
            (
                "active_background_tasks".to_string(),
                json!(active_background_tasks),
            ),
        ];
        if let Some(parent_session_id) = parent_session_id {
            payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        if let Some(route) = self
            .activation_route(attempt_id)
            .filter(|route| route.thread_kind == "delivery")
        {
            if !route.delivery_thread_ids.is_empty() {
                payload.push(("defer_covers".to_string(), json!(route.delivery_thread_ids)));
            }
        }
        self.append_activation_route(attempt_id, &mut payload);
        self.append_objective_activation_route(attempt_id, &mut payload);
        let event = Event::new(
            format!("no_reply_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/no_reply".to_string(),
            payload.into_iter().collect(),
        );
        if self.commit_and_dispatch_outcome(attempt_id, &event).await? {
            if let Some(supervisor) = &self.objective_supervisor {
                supervisor.terminal_outcome(&event).await?;
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
        self.publish_reply_for_model_attempt(
            session_id,
            attempt_id,
            None,
            content,
            parent_session_id,
        )
        .await
    }

    async fn publish_reply_for_model_attempt(
        &self,
        session_id: &str,
        attempt_id: &str,
        model_attempt_id: Option<&str>,
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
        if let Some(model_attempt_id) = model_attempt_id {
            payload.push(("model_attempt_id".to_string(), json!(model_attempt_id)));
        }
        if let Some(parent_session_id) = parent_session_id {
            payload.push(("parent_session_id".to_string(), json!(parent_session_id)));
        }
        if let Some(route) = self
            .activation_route(attempt_id)
            .filter(|route| route.thread_kind == "delivery")
        {
            if !route.delivery_thread_ids.is_empty() {
                payload.push(("covers".to_string(), json!(route.delivery_thread_ids)));
            }
        }
        self.append_activation_route(attempt_id, &mut payload);
        self.append_objective_activation_route(attempt_id, &mut payload);
        let event = Event::new(
            format!("reply_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0)),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "chat/reply".to_string(),
            payload.into_iter().collect(),
        );
        if self.commit_and_dispatch_outcome(attempt_id, &event).await? {
            if let Some(supervisor) = &self.objective_supervisor {
                supervisor.terminal_outcome(&event).await?;
            }
        }
        Ok(())
    }

    async fn publish_thread_result(
        &self,
        session_id: &str,
        attempt_id: &str,
        model_attempt_id: &str,
        content: String,
    ) -> Result<(), DynError> {
        let context_id = self.context_id_for_session(session_id)?;
        let route = self
            .activation_route(attempt_id)
            .ok_or_else(|| format!("Work result '{}' 缺少 Evaluation route", attempt_id))?;
        let result_event_id = format!(
            "thread_result_{}_{}",
            route.thread_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("model_attempt_id".to_string(), json!(model_attempt_id)),
            (
                "disposition".to_string(),
                json!("complete_pending_delivery"),
            ),
            ("text".to_string(), json!(content)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.append_objective_activation_route(attempt_id, &mut payload);
        let result_event = Event::new(
            result_event_id.clone(),
            "Agent-Morphz".to_string(),
            TYPE_AGENT_CALL.to_string(),
            "runtime/thread_result".to_string(),
            payload.into_iter().collect(),
        );
        if !self
            .commit_and_dispatch_outcome(attempt_id, &result_event)
            .await?
        {
            return Ok(());
        }

        self.arm_delivery_flush(session_id).await?;
        Ok(())
    }

    async fn arm_delivery_flush(&self, session_id: &str) -> Result<(), DynError> {
        let timers = &self.timer_engine;
        let store = self
            .context_engine
            .session_store()
            .ok_or("Completion delivery 需要持久化 SessionStore")?;
        let timer_id = delivery_flush_timer_id(session_id);
        let Some(timer) = store
            .arm_delivery_flush_timer(
                &timer_id,
                session_id,
                self.orchestrator_config
                    .scheduler
                    .delivery_merge_window
                    .as_secs(),
                self.orchestrator_config
                    .scheduler
                    .delivery_max_wait
                    .as_secs(),
            )
            .await?
        else {
            return Ok(());
        };
        // The store already armed the authoritative generation atomically.
        // Scheduling the same generation only wakes a sleeping dispatcher.
        timers
            .schedule(NewRuntimeTimer {
                id: timer.id,
                generation: timer.generation,
                kind: timer.kind,
                owner_id: timer.owner_id,
                due_at: timer.due_at,
                payload: timer.payload,
            })
            .await?;
        Ok(())
    }

    async fn recover_pending_delivery_flushes(&self) -> Result<usize, DynError> {
        let Some(store) = self.context_engine.session_store() else {
            return Ok(0);
        };
        let sessions = store.list_pending_delivery_sessions().await?;
        for session_id in &sessions {
            self.arm_delivery_flush(session_id).await?;
        }
        if !sessions.is_empty() {
            tracing::info!(
                sessions = sessions.len(),
                "已从 pending/deferred Thread 恢复 Delivery Flush Timer"
            );
        }
        Ok(sessions.len())
    }

    async fn dispatch_delivery_flush(
        self: Arc<Self>,
        timer: RuntimeTimerRecord,
    ) -> Result<TimerDisposition, DynError> {
        let store = self
            .context_engine
            .session_store()
            .ok_or("Delivery Flush 需要持久化 SessionStore")?;
        let session_id = timer.owner_id.clone();
        let direct_event_id = delivery_flush_reply_event_id(&timer.id, timer.generation);
        if let Some(reply) = self
            .store
            .query(QueryFilter {
                event_id: Some(direct_event_id.clone()),
                ..Default::default()
            })
            .await?
            .into_iter()
            .find(|event| event.id == direct_event_id && event.topic == "chat/reply")
        {
            // The atomic fast-path commit may have succeeded immediately before
            // a process exit or transient dispatch failure. Covered Threads are
            // already `delivered`, so recover the stable reply by Event ID before
            // consulting the live pending set.
            self.bus.dispatch_persisted(reply).await?;
            return Ok(TimerDisposition::Complete);
        }
        let threads = store
            .list_session_delivery_threads(&session_id, true)
            .await?;
        if threads.is_empty() {
            return Ok(TimerDisposition::Complete);
        }
        let session = store
            .get_session(&session_id)
            .await?
            .ok_or_else(|| format!("Delivery Flush Session '{}' 不存在", session_id))?;
        let completed_thread_ids = timer
            .payload
            .get("completed_thread_ids")
            .and_then(serde_json::Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|ids| !ids.is_empty())
            .unwrap_or_else(|| threads.iter().map(|thread| thread.id.clone()).collect());
        let mut live_by_id = threads
            .into_iter()
            .map(|thread| (thread.id.clone(), thread))
            .collect::<HashMap<_, _>>();
        let snapshot_threads = completed_thread_ids
            .iter()
            .filter_map(|thread_id| live_by_id.remove(thread_id))
            .collect::<Vec<_>>();
        if snapshot_threads.is_empty() {
            return Ok(TimerDisposition::Complete);
        }
        let completed_thread_ids = snapshot_threads
            .iter()
            .map(|thread| thread.id.clone())
            .collect::<Vec<_>>();
        let result_event_ids = snapshot_threads
            .iter()
            .filter_map(|thread| thread.result_event_id.clone())
            .collect::<Vec<_>>();
        if let Some((content, strategy)) = self
            .render_delivery_without_model(&snapshot_threads)
            .await?
        {
            let mut reply = Event::new(
                direct_event_id.clone(),
                "Runtime-Delivery".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/reply".to_string(),
                vec![
                    ("context_id".to_string(), json!(session.context_id)),
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(direct_event_id)),
                    ("root_turn_id".to_string(), json!(direct_event_id)),
                    ("thread_kind".to_string(), json!("delivery")),
                    ("disposition".to_string(), json!("deliver")),
                    ("delivery_strategy".to_string(), json!(strategy)),
                    (
                        "delivery_timer_generation".to_string(),
                        json!(timer.generation),
                    ),
                    ("covers".to_string(), json!(completed_thread_ids)),
                    ("result_event_ids".to_string(), json!(result_event_ids)),
                    ("text".to_string(), json!(content)),
                ]
                .into_iter()
                .collect(),
            );
            reply.timestamp = delivery_flush_timestamp(&timer);
            match store
                .commit_delivery_flush_reply(&timer.id, timer.generation, &reply)
                .await?
            {
                DeliveryFlushCommit::Committed | DeliveryFlushCommit::Existing { .. } => {
                    self.bus.dispatch_persisted(reply).await?;
                }
                DeliveryFlushCommit::Stale | DeliveryFlushCommit::Empty => {}
            }
            return Ok(TimerDisposition::Complete);
        }
        let delivery_event_id = delivery_flush_event_id(&timer.id, timer.generation);
        let mut event = Event::new(
            delivery_event_id.clone(),
            "Runtime-Delivery".to_string(),
            TYPE_TOOL_OUTPUT.to_string(),
            "chat/thread_completion_ready".to_string(),
            vec![
                ("context_id".to_string(), json!(session.context_id)),
                ("session_id".to_string(), json!(session_id)),
                ("root_turn_id".to_string(), json!(delivery_event_id)),
                ("thread_kind".to_string(), json!("delivery")),
                (
                    "delivery_timer_generation".to_string(),
                    json!(timer.generation),
                ),
                (
                    "completed_thread_ids".to_string(),
                    json!(completed_thread_ids),
                ),
                ("result_event_ids".to_string(), json!(result_event_ids)),
                (
                    "text".to_string(),
                    json!("一个或多个 Thread 已完成。请只交付本次 completion snapshot 在 kernel.thread-scheduler 中呈现的 delivery=pending/deferred 结果，并结合最新并发状态形成一条清晰且不重复的消息；本次求值开始后新完成的结果属于下一次 Delivery，不要提前声称已覆盖。确实无需通知时才独占调用 no_reply。不得重复已经 delivered 的结果。"),
                ),
            ]
            .into_iter()
            .collect(),
        );
        // Retrying one Timer generation must produce byte-identical Event
        // content. The latest pending timestamp is immutable for that
        // generation and survives process restart.
        event.timestamp = delivery_flush_timestamp(&timer);
        match store
            .commit_delivery_flush(&timer.id, timer.generation, &event)
            .await?
        {
            DeliveryFlushCommit::Committed => {
                self.bus.dispatch_persisted(event).await?;
            }
            DeliveryFlushCommit::Existing { .. }
            | DeliveryFlushCommit::Stale
            | DeliveryFlushCommit::Empty => {}
        }
        Ok(TimerDisposition::Complete)
    }

    async fn render_delivery_without_model(
        &self,
        threads: &[ThreadRecord],
    ) -> Result<Option<(String, &'static str)>, DynError> {
        if threads.is_empty() {
            return Ok(None);
        }
        let texts = threads
            .iter()
            .map(|thread| thread.result_text.as_deref().unwrap_or(""))
            .collect::<Vec<_>>();
        if texts.iter().any(|text| text.trim().is_empty()) {
            return Ok(None);
        }
        if threads.len() == 1 {
            return Ok(Some((texts[0].to_string(), "passthrough")));
        }
        let policy = &self.orchestrator_config.scheduler;
        let total_chars = texts.iter().map(|text| text.chars().count()).sum::<usize>();
        if threads.len() > policy.delivery_deterministic_batch_max_items
            || total_chars > policy.delivery_deterministic_batch_max_chars
            || threads.iter().any(|thread| {
                thread.kind != ThreadKind::Execution || thread.executor_kind != "self"
            })
        {
            return Ok(None);
        }
        for thread in threads {
            let Some(result_event_id) = thread.result_event_id.as_deref() else {
                return Ok(None);
            };
            let result = self
                .store
                .query(QueryFilter {
                    event_id: Some(result_event_id.to_string()),
                    ..Default::default()
                })
                .await?;
            if result.iter().any(|event| {
                event
                    .payload
                    .get("delivery_requires_composition")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            }) {
                return Ok(None);
            }
        }
        let mut content = format!("以下 {} 项工作已完成：", texts.len());
        for (index, text) in texts.iter().enumerate() {
            content.push_str(&format!("\n\n{}. {}", index + 1, text.trim()));
        }
        Ok(Some((content, "deterministic_batch")))
    }

    async fn pending_delivery_threads(&self, session_id: &str) -> Result<Vec<String>, DynError> {
        self.delivery_threads(session_id, false).await
    }

    async fn delivery_threads(
        &self,
        session_id: &str,
        include_deferred: bool,
    ) -> Result<Vec<String>, DynError> {
        let store = self
            .context_engine
            .session_store()
            .ok_or("Completion delivery 需要持久化 SessionStore")?;
        Ok(store
            .list_session_delivery_threads(session_id, include_deferred)
            .await?
            .into_iter()
            .map(|thread| thread.id)
            .collect())
    }

    async fn commit_and_dispatch_outcome(
        &self,
        attempt_id: &str,
        event: &Event,
    ) -> Result<bool, DynError> {
        let Some(route) = self.activation_route(attempt_id) else {
            self.bus.publish(event.clone()).await?;
            return Ok(true);
        };
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Evaluation outcome 需要持久化 SessionStore")?;
        match session_store
            .commit_activation_outcome(&route.activation_id, event)
            .await?
        {
            ActivationOutcomeCommit::Committed => {
                self.bus.dispatch_persisted(event.clone()).await?;
                if let Some(scheduler) = &self.thread_scheduler {
                    if let Err(error) = scheduler.dependency_completed(&route.thread_id).await {
                        // The terminal Thread and outcome are already
                        // durable. Startup recovery re-arms every queued
                        // schedule, so dependency notification failure must
                        // not suppress the user-visible terminal outcome.
                        tracing::error!(
                            thread_id = %route.thread_id,
                            %error,
                            "Thread 已终止，但依赖 Schedule 即时唤醒失败；等待恢复路径重放"
                        );
                    }
                }
                Ok(true)
            }
            ActivationOutcomeCommit::Existing { event_id } => {
                tracing::warn!(
                    activation_id = %route.activation_id,
                    duplicate_event_id = %event.id,
                    committed_event_id = %event_id,
                    "抑制同一 Thread Activation 的重复终态输出"
                );
                Ok(false)
            }
        }
    }

    async fn yield_thread(
        &self,
        session_id: &str,
        attempt_id: &str,
        active_background_tasks: usize,
        pending_schedules: usize,
        model_disposition: &str,
    ) -> Result<(), DynError> {
        let route = self
            .activation_route(attempt_id)
            .ok_or_else(|| format!("Evaluation '{}' 缺少 Thread route", attempt_id))?;
        let session_store = self
            .context_engine
            .session_store()
            .ok_or("Thread phase 投影需要持久化 SessionStore")?;
        let Some(current) = session_store.get_thread(&route.thread_id).await? else {
            return Err(format!("Thread '{}' 不存在", route.thread_id).into());
        };
        if current.lifecycle.is_terminal() {
            return Ok(());
        }
        let context_id = self.context_id_for_session(session_id)?;
        let mut payload = vec![
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            (
                "active_background_tasks".to_string(),
                json!(active_background_tasks),
            ),
            ("pending_schedules".to_string(), json!(pending_schedules)),
            ("model_disposition".to_string(), json!(model_disposition)),
        ];
        self.append_activation_route(attempt_id, &mut payload);
        self.bus
            .publish(Event::new(
                format!(
                    "thread_waiting_{}",
                    Utc::now().timestamp_nanos_opt().unwrap_or(0)
                ),
                "Runtime".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "runtime/thread_waiting".to_string(),
                payload.into_iter().collect(),
            ))
            .await?;
        Ok(())
    }

    fn append_objective_activation_route(
        &self,
        attempt_id: &str,
        payload: &mut Vec<(String, serde_json::Value)>,
    ) {
        let Some(active) = self.objective_evaluations.get_for_activation(attempt_id) else {
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

    fn bind_embedded_objective_route(&self, activation_id: &str, event: &Event) {
        let Some(objective_id) = event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
        else {
            return;
        };
        let Some(evaluation_id) = event
            .payload
            .get("objective_evaluation_id")
            .and_then(|value| value.as_str())
        else {
            return;
        };
        self.objective_evaluations.bind_activation(
            activation_id,
            crate::objective::ActiveObjectiveEvaluation {
                objective_id: objective_id.to_string(),
                evaluation_id: evaluation_id.to_string(),
                revision: event
                    .payload
                    .get("objective_revision")
                    .and_then(|value| value.as_u64())
                    .unwrap_or_default(),
                started_at: event.timestamp,
            },
        );
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
        self.append_activation_route(attempt_id, &mut payload);
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
        self.append_activation_route(attempt_id, &mut payload);
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
        self.append_activation_route(attempt_id, &mut payload);
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

    #[allow(clippy::too_many_arguments)]
    async fn prepare_physical_execution(
        &self,
        tool: &Arc<dyn Tool>,
        route: &ActivationRoute,
        agent_id: &str,
        thread_id: &str,
        context_id: &str,
        session_id: &str,
        attempt_id: &str,
        call: &crate::llm::ToolCallRepr,
        output_id: &str,
        timeout_secs: u64,
    ) -> Result<PreparedPhysicalExecution, DynError> {
        let manager = self
            .execution_jobs
            .as_ref()
            .ok_or("Physical Execution 缺少 ExecutionJobManager")?;
        let request = serde_json::from_str(&call.arguments).unwrap_or_else(|_| {
            json!({
                "raw_arguments": call.arguments,
            })
        });
        let requirement = tool.approval_requirement(&call.arguments)?;
        let spec = ExecutionJobSpec {
            activation_id: route.activation_id.clone(),
            thread_id: thread_id.to_string(),
            agent_id: agent_id.to_string(),
            context_id: context_id.to_string(),
            session_id: session_id.to_string(),
            tool_call_id: call.id.clone(),
            tool_name: call.func_name.clone(),
            request,
            retry_safety: tool.retry_safety(),
            requires_approval: requirement.is_some(),
        };
        let lease_expires_at = Utc::now()
            + chrono::Duration::seconds(
                i64::try_from(timeout_secs.saturating_add(60)).unwrap_or(i64::MAX),
            );
        let claim_token = format!(
            "claim_{}_{}_{}",
            crate::execution::deterministic_job_id(&route.activation_id, &call.id)?,
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );

        let (mut job, durable_grant) = match requirement {
            None => {
                let job = manager.ensure(spec).await?;
                if let Some(event) = self.terminal_execution_event(&job).await? {
                    return Ok(PreparedPhysicalExecution::Terminal(event));
                }
                if job.status != ExecutionJobStatus::Queued {
                    return Err(format!(
                        "Execution Job '{}' 当前为 {}，不能重复开始物理执行",
                        job.id,
                        job.status.as_str()
                    )
                    .into());
                }
                let job = applied_execution_job(
                    manager
                        .claim(
                            &job.id,
                            job.revision,
                            JobClaim {
                                worker_id: "morphz-local-executor",
                                claim_token: &claim_token,
                                lease_expires_at,
                                approval_ref: None,
                            },
                        )
                        .await?,
                    "claim",
                )?;
                (job, None)
            }
            Some(requirement) => {
                let services = self.durable_approvals.as_ref().ok_or(
                    "Physical Execution 需要审批，但 Runtime 未配置持久化 Approval authority",
                )?;
                let new_job = spec.into_new_job()?;
                let action = serde_json::to_value(&requirement.action)?;
                let requested = serde_json::to_value(&requirement.requested)?;
                let identity = stable_approval_identity(
                    &new_job.id,
                    &action,
                    &requested,
                    &services.broker.policy_digest(),
                )?;
                let new_approval = NewApprovalRequest {
                    id: identity.approval_id.clone(),
                    job_id: new_job.id.clone(),
                    request_digest: identity.request_digest.clone(),
                    policy_digest: identity.policy_digest.clone(),
                    action: action.clone(),
                    requested: requested.clone(),
                    justification: requirement.justification.clone(),
                    pending_status: services.broker.pending_approval_status(),
                };
                let request_event =
                    approval_request_event(&new_job, &new_approval, attempt_id, route);
                let (job, mut approval, created) = execution_approval_records(
                    services
                        .execution_approvals
                        .ensure_execution_job_with_approval(new_job, new_approval, &request_event)
                        .await?,
                    "create approval authority",
                )?;
                // A persisted request is an immutable fact, but UI delivery is
                // process-local. Re-dispatch an exact still-pending replay so
                // restart never leaves a human Approval invisible merely
                // because its Event already existed in the Ledger.
                if created || approval.status.is_pending() {
                    self.bus.dispatch_persisted(request_event).await?;
                }
                if let Some(event) = self.terminal_execution_event(&job).await? {
                    return Ok(PreparedPhysicalExecution::Terminal(event));
                }

                if approval.status.is_pending() {
                    let decision = services
                        .broker
                        .review(&ApprovalRequest {
                            approval_id: approval.id.clone(),
                            context_id: context_id.to_string(),
                            session_id: session_id.to_string(),
                            attempt_id: attempt_id.to_string(),
                            action: requirement.action.clone(),
                            requested: requirement.requested.clone(),
                            justification: requirement.justification.clone(),
                        })
                        .await?;
                    let resolution = match decision {
                        ApprovalDecision::AllowOnce {
                            rationale,
                            risk_tags,
                        } => ApprovalResolution::Allow {
                            rationale,
                            risk_tags,
                        },
                        ApprovalDecision::Deny {
                            rationale,
                            risk_tags,
                        } => ApprovalResolution::Deny {
                            rationale,
                            risk_tags,
                        },
                        ApprovalDecision::AskHuman { rationale, .. } => {
                            return Err(format!(
                                "Approval provider 返回 ask_human 但未完成人工审批: {rationale}"
                            )
                            .into());
                        }
                    };
                    let commit = services
                        .approvals
                        .commit_approval_decision(&approval.id, approval.revision, resolution)
                        .await?;
                    let (updated, _changed) = approval_record_from_mutation(
                        commit.mutation,
                        "persist approval decision",
                    )?;
                    approval = updated;
                    if commit.event_created {
                        let decision_event = commit
                            .event
                            .ok_or("Approval 审计 Event 已原子创建，但 Store 未返回持久化投影")?;
                        self.bus.dispatch_persisted(decision_event).await?;
                    }
                }

                match approval.status {
                    ApprovalStatus::Denied | ApprovalStatus::Cancelled => {
                        let output = approval_denied_tool_output(
                            output_id, context_id, session_id, attempt_id, call, route, &approval,
                        );
                        let reason = approval
                            .rationale
                            .clone()
                            .or(approval.cancel_reason.clone())
                            .unwrap_or_else(|| "审批未授权该物理操作".to_string());
                        applied_execution_job(
                            manager
                                .finish_with_event(
                                    &job.id,
                                    job.revision,
                                    None,
                                    JobOutcome::Cancelled {
                                        result_event_id: Some(output.id.clone()),
                                        result_refs: Vec::new(),
                                        reason: Some(reason),
                                        exit_code: None,
                                    },
                                    &output,
                                )
                                .await?,
                            "approval denial terminal commit",
                        )?;
                        return Ok(PreparedPhysicalExecution::Terminal(output));
                    }
                    ApprovalStatus::Allowed => {}
                    ApprovalStatus::PendingAuto | ApprovalStatus::PendingHuman => {
                        return Err(format!(
                            "Approval '{}' 审批源返回后仍处于 {}",
                            approval.id,
                            approval.status.as_str()
                        )
                        .into());
                    }
                }

                let grant_id = approval
                    .grant_id
                    .clone()
                    .ok_or("Allowed Approval 缺少持久化 grant_id")?;
                let (job, consumed_approval, _) = execution_approval_records(
                    services
                        .execution_approvals
                        .claim_execution_job_with_grant(
                            &job.id,
                            job.revision,
                            &approval.id,
                            approval.revision,
                            "morphz-local-executor",
                            &claim_token,
                            lease_expires_at,
                        )
                        .await?,
                    "consume approval grant and claim",
                )?;
                let grant = DurableApprovalGrant {
                    approval_id: consumed_approval.id,
                    grant_id,
                    policy_digest: consumed_approval.policy_digest,
                    action: serde_json::from_value(consumed_approval.action)?,
                    requested: serde_json::from_value(consumed_approval.requested)?,
                };
                (job, Some(grant))
            }
        };

        job = applied_execution_job(
            manager
                .heartbeat(
                    &job.id,
                    job.revision,
                    JobHeartbeat {
                        claim_token: &claim_token,
                        lease_expires_at,
                        side_effect_started_at: Some(Utc::now()),
                        progress_ref: None,
                    },
                )
                .await?,
            "side-effect boundary",
        )?;
        Ok(PreparedPhysicalExecution::Claimed(Box::new(
            ClaimedPhysicalExecution {
                context: crate::tool::ToolExecutionJobContext {
                    parent_job_id: job.id.clone(),
                    activation_id: route.activation_id.clone(),
                    thread_id: thread_id.to_string(),
                    agent_id: agent_id.to_string(),
                    context_id: context_id.to_string(),
                    session_id: session_id.to_string(),
                    tool_call_id: call.id.clone(),
                },
                job: ClaimedExecutionJob {
                    id: job.id,
                    revision: job.revision,
                    claim_token,
                },
                approval: durable_grant,
            },
        )))
    }

    async fn terminal_execution_event(
        &self,
        job: &ExecutionJobRecord,
    ) -> Result<Option<Event>, DynError> {
        if !job.status.is_terminal() {
            return Ok(None);
        }
        let event_id = job
            .result_event_id
            .as_deref()
            .ok_or_else(|| format!("终态 Execution Job '{}' 缺少 result_event_id", job.id))?;
        let event = self
            .context_engine
            .find_event(&job.context_id, event_id)
            .await?
            .ok_or_else(|| {
                format!(
                    "终态 Execution Job '{}' 引用的结果 Event '{}' 不存在",
                    job.id, event_id
                )
            })?;
        Ok(Some(event))
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
        let activation_route = self.activation_route(attempt_id);
        let read_guard_key = activation_route
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
                "执行拒绝: CONTEXT_TX_BUDGET_EXHAUSTED：当前用户回合的 Context transaction 已达到 {} 次上限。物理工具、普通文本和 no_reply 仍然可用；请使用现有 Mind 继续必要工作，避免连续 housekeeping transaction。",
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
        if let Some(model_attempt_id) = options.model_attempt_id.as_deref() {
            assistant_call_payload.push(("model_attempt_id".to_string(), json!(model_attempt_id)));
        }
        if options.record_assistant_call {
            self.append_activation_route(attempt_id, &mut assistant_call_payload);
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
        if let Some(model_attempt_id) = options.model_attempt_id.as_deref() {
            selected_payload.push(("model_attempt_id".to_string(), json!(model_attempt_id)));
        }
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
            self.append_activation_route(attempt_id, &mut selected_payload);
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
        let durable_execution_identity = match (&self.execution_jobs, &activation_route) {
            (Some(_), Some(route)) => {
                let session_store = self
                    .context_engine
                    .session_store()
                    .ok_or("Execution Job 需要持久化 SessionStore")?;
                let thread = session_store
                    .get_thread(&route.thread_id)
                    .await?
                    .ok_or_else(|| {
                        format!("Execution Job 的 Thread '{}' 不存在", route.thread_id)
                    })?;
                if thread.context_id != context_id || thread.session_id != session_id {
                    return Err("Execution Job 的 Thread 路由与当前 Evaluation 不一致".into());
                }
                Some((thread.agent_id, thread.id))
            }
            _ => None,
        };
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
            self.append_activation_route(attempt_id, &mut payload);
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
                    self.append_activation_route(attempt_id, &mut payload);
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
            let tool = self.registry.get(&call.func_name);
            let timeout_secs = self.orchestrator_config.tool_timeout_secs;
            let mut claimed_execution_job = None;
            let mut tool_execution_job_context = None;
            let mut durable_approval_grant = None;
            if let (Some(tool), Some(route), Some((agent_id, thread_id))) = (
                tool.as_ref().filter(|tool| {
                    tool.execution_class() == crate::tool::ToolExecutionClass::PhysicalJob
                }),
                activation_route.as_ref(),
                durable_execution_identity.as_ref(),
            ) {
                let prepared = self
                    .prepare_physical_execution(
                        tool,
                        route,
                        agent_id,
                        thread_id,
                        &context_id,
                        session_id,
                        attempt_id,
                        &call,
                        &output_id,
                        timeout_secs,
                    )
                    .await;
                match prepared? {
                    PreparedPhysicalExecution::Claimed(claimed) => {
                        claimed_execution_job = Some(claimed.job);
                        tool_execution_job_context = Some(claimed.context);
                        durable_approval_grant = claimed.approval;
                    }
                    PreparedPhysicalExecution::Terminal(event) => {
                        outputs.push((event, true));
                        continue;
                    }
                }
            }
            let session_id = session_id.to_string();
            let context_id = context_id.clone();
            let attempt_id = attempt_id.to_string();
            let activation_route = activation_route.clone();
            let tool_causal_route =
                activation_route
                    .as_ref()
                    .map(|route| crate::tool::ToolCausalRoute {
                        thread_id: route.thread_id.clone(),
                        activation_id: route.activation_id.clone(),
                        root_turn_id: route.root_turn_id.clone(),
                        trigger_event_id: route.trigger_event_id.clone(),
                        trigger_sequence: route.trigger_sequence,
                    });
            let metadata = ToolTaskMetadata {
                output_id: output_id.clone(),
                context_id: context_id.clone(),
                session_id: session_id.clone(),
                attempt_id: attempt_id.clone(),
                tool_call_id: call.id.clone(),
                tool_name: call.func_name.clone(),
                activation_route: activation_route.clone(),
                execution_job: claimed_execution_job.clone(),
            };
            let execution_jobs = self.execution_jobs.clone();
            let objective_evaluation = self.objective_evaluations.get_for_activation(&attempt_id);
            let handle = tokio::spawn(async move {
                crate::permission::CURRENT_DURABLE_APPROVAL
                        .scope(durable_approval_grant, async move {
                            crate::tool::CURRENT_EXECUTION_JOB
                                .scope(tool_execution_job_context, async move {
                                    crate::tool::CURRENT_CAUSAL_ROUTE
                                        .scope(tool_causal_route, async move {
                                            crate::tool::CURRENT_ATTEMPT_ID
                                                .scope(attempt_id.clone(), async move {
                                                    crate::tool::CURRENT_CONTEXT_ID
                                                        .scope(context_id.clone(), async move {
                                                            crate::tool::CURRENT_SESSION_ID
                                                    .scope(session_id.clone(), async move {
                                                        let result = tokio::time::timeout(
                                                            tokio::time::Duration::from_secs(
                                                                timeout_secs,
                                                            ),
                                                            async {
                                                                match tool {
                                                                    Some(tool) => {
                                                                        tool.execute(
                                                                            &call.arguments,
                                                                        )
                                                                        .await
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
                                                                let status =
                                                                    infer_tool_status(&output);
                                                                (output, status)
                                                            }
                                                            Ok(Err(error)) => (
                                                                format!("执行失败: {}", error),
                                                                "error",
                                                            ),
                                                            Err(_) => (
                                                                format!(
                                                                    "执行超时: 超过 {} 秒限额",
                                                                    timeout_secs
                                                                ),
                                                                "timeout",
                                                            ),
                                                        };
                                                        let wake_policy = if call.func_name
                                                            == "delegate"
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
                                                            (
                                                                "context_id".to_string(),
                                                                json!(context_id),
                                                            ),
                                                            (
                                                                "session_id".to_string(),
                                                                json!(session_id),
                                                            ),
                                                            (
                                                                "attempt_id".to_string(),
                                                                json!(attempt_id),
                                                            ),
                                                            (
                                                                "tool_call_id".to_string(),
                                                                json!(call.id),
                                                            ),
                                                            (
                                                                "caused_by".to_string(),
                                                                json!(call.id),
                                                            ),
                                                            (
                                                                "tool_name".to_string(),
                                                                json!(call.func_name),
                                                            ),
                                                            (
                                                                "tool_status".to_string(),
                                                                json!(tool_status),
                                                            ),
                                                            (
                                                                "wake_policy".to_string(),
                                                                json!(wake_policy),
                                                            ),
                                                            (
                                                                "output_empty".to_string(),
                                                                json!(output_empty),
                                                            ),
                                                            ("text".to_string(), json!(output)),
                                                        ]
                                                        .into_iter()
                                                        .collect::<serde_json::Map<_, _>>();
                                                        if let Some(route) = activation_route {
                                                            payload.insert(
                                                                "thread_id".to_string(),
                                                                json!(route.thread_id),
                                                            );
                                                            payload.insert(
                                                                "activation_id".to_string(),
                                                                json!(route.activation_id),
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
                                                                    "context_snapshot_version"
                                                                        .to_string(),
                                                                    json!(version),
                                                                );
                                                            }
                                                        }
                                                        if call.func_name == "exec" {
                                                            extend_exec_output_facts(
                                                                &mut payload,
                                                                &output,
                                                            );
                                                        }
                                                        let mut output = Event::new(
                                                            format!(
                                                                "output_{}_{}",
                                                                attempt_id, call.id
                                                            ),
                                                            "System-Executor".to_string(),
                                                            TYPE_TOOL_OUTPUT.to_string(),
                                                            "chat/tool_output".to_string(),
                                                            payload,
                                                        );
                                                        if let Some(active) = objective_evaluation {
                                                            output.payload.insert(
                                                                "objective_id".to_string(),
                                                                json!(active.objective_id),
                                                            );
                                                            output.payload.insert(
                                                                "objective_evaluation_id".to_string(),
                                                                json!(active.evaluation_id),
                                                            );
                                                            output.payload.insert(
                                                                "objective_revision".to_string(),
                                                                json!(active.revision),
                                                            );
                                                        }
                                                        let already_persisted = match (
                                                            execution_jobs,
                                                            claimed_execution_job,
                                                        ) {
                                                            (Some(manager), Some(job)) => {
                                                                finish_claimed_physical_job(
                                                                    manager.as_ref(),
                                                                    &job,
                                                                    &mut output,
                                                                )
                                                                .await?;
                                                                true
                                                            }
                                                            (None, None) | (Some(_), None) => false,
                                                            (None, Some(_)) => {
                                                                return Err(
                                                                    "工具任务与 Execution Job Manager 边界不一致"
                                                                        .into(),
                                                                );
                                                            }
                                                        };
                                                        Ok(SpawnedToolTaskResult {
                                                            output,
                                                            already_persisted,
                                                        })
                                                    })
                                                    .await
                                                        })
                                                        .await
                                                })
                                                .await
                                        })
                                        .await
                                })
                                .await
                        })
                        .await
            });
            tasks.push(SpawnedToolTask { handle, metadata });
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
                self.append_activation_route(attempt_id, &mut payload);
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
            let metadata = task.metadata;
            let (mut output, already_persisted, job_outcome) = match task.handle.await {
                Ok(Ok(result)) => (result.output, result.already_persisted, None),
                Ok(Err(error)) => {
                    tracing::error!(
                        tool = %metadata.tool_name,
                        tool_call_id = %metadata.tool_call_id,
                        %error,
                        "工具任务在持久化终态前失败"
                    );
                    return Err(error);
                }
                Err(error) => {
                    let reason = format!(
                        "工具 '{}' 的执行任务异常终止，外部结果未知：{error}",
                        metadata.tool_name
                    );
                    tracing::error!(
                        tool = %metadata.tool_name,
                        tool_call_id = %metadata.tool_call_id,
                        ?error,
                        "工具任务 join 失败；生成显式 lost 结果"
                    );
                    let output = lost_tool_output(&metadata, &reason);
                    let outcome = metadata.execution_job.as_ref().map(|_| JobOutcome::Lost {
                        result_event_id: Some(output.id.clone()),
                        reason,
                    });
                    (output, false, outcome)
                }
            };
            if let Some(attempt_id) = output
                .payload
                .get("attempt_id")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
            {
                self.stamp_objective_activation_route(&attempt_id, &mut output.payload);
            }
            let already_persisted = match (metadata.execution_job, job_outcome) {
                (Some(job), Some(outcome)) => {
                    let manager = self
                        .execution_jobs
                        .as_ref()
                        .ok_or("Execution Job 完成时 Manager 不存在")?;
                    applied_execution_job(
                        manager
                            .finish_with_event(
                                &job.id,
                                job.revision,
                                Some(&job.claim_token),
                                outcome,
                                &output,
                            )
                            .await?,
                        "terminal result commit",
                    )?;
                    true
                }
                (_, None) => already_persisted,
                _ => return Err("工具任务与 Execution Job 结果边界不一致".into()),
            };
            outputs.push((output, already_persisted));
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
        // Persist every non-waking result before arming the one batch barrier.
        // This preserves model Function Calling semantics even when physical
        // tools finish out of order: the resumed Activation can observe all
        // call IDs, and no early result creates a partial Evaluation.
        let mut wake_output = None;
        for (index, (output, already_persisted)) in outputs.into_iter().enumerate() {
            if wake_index == Some(index) {
                wake_output = Some(output);
            } else if !already_persisted {
                self.store.append(output).await?;
            }
        }
        if let Some(output) = wake_output {
            self.store.append_with_signal_outbox(output.clone()).await?;
            self.bus.dispatch_persisted(output).await?;
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
        self.append_activation_route(attempt_id, &mut payload);
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

    fn activation_route(&self, attempt_id: &str) -> Option<ActivationRoute> {
        self.activation_routes
            .get(attempt_id)
            .map(|route| route.clone())
            .or_else(|| {
                attempt_id
                    .split_once("_response_retry_")
                    .and_then(|(base, _)| {
                        self.activation_routes.get(base).map(|route| route.clone())
                    })
            })
    }

    fn append_activation_route(
        &self,
        attempt_id: &str,
        payload: &mut Vec<(String, serde_json::Value)>,
    ) {
        let Some(route) = self.activation_route(attempt_id) else {
            return;
        };
        payload.extend([
            ("thread_id".to_string(), json!(route.thread_id)),
            ("activation_id".to_string(), json!(route.activation_id)),
            ("root_turn_id".to_string(), json!(route.root_turn_id)),
            (
                "trigger_event_id".to_string(),
                json!(route.trigger_event_id),
            ),
            (
                "trigger_sequence".to_string(),
                json!(route.trigger_sequence),
            ),
            ("thread_kind".to_string(), json!(route.thread_kind)),
        ]);
        if let Some(version) = route.context_snapshot_version {
            payload.push(("context_snapshot_version".to_string(), json!(version)));
        }
        if !payload.iter().any(|(key, _)| key == "caused_by") {
            payload.push(("caused_by".to_string(), json!(route.trigger_event_id)));
        }
        if let Some(active) = self.objective_evaluations.get_for_activation(attempt_id) {
            payload.extend([
                ("objective_id".to_string(), json!(active.objective_id)),
                (
                    "objective_evaluation_id".to_string(),
                    json!(active.evaluation_id),
                ),
                ("objective_revision".to_string(), json!(active.revision)),
            ]);
        }
    }

    fn stamp_objective_activation_route(
        &self,
        attempt_id: &str,
        payload: &mut serde_json::Map<String, serde_json::Value>,
    ) {
        let Some(active) = self.objective_evaluations.get_for_activation(attempt_id) else {
            return;
        };
        payload.insert("objective_id".to_string(), json!(active.objective_id));
        payload.insert(
            "objective_evaluation_id".to_string(),
            json!(active.evaluation_id),
        );
        payload.insert("objective_revision".to_string(), json!(active.revision));
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

    fn dialogue_thread_gate(&self, session_id: &str) -> Arc<DialogueThreadGate> {
        self.dialogue_thread_gates
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(DialogueThreadGate::default()))
            .clone()
    }

    fn thread_gate(&self, root_turn_id: &str) -> Arc<Mutex<()>> {
        // Gates are a single-process serialization aid, not durable Thread
        // state.  Keep the cache bounded: an entry whose Arc is owned only by
        // the map has no holder or waiter and can be recreated safely.  DashMap
        // retains a gate that a concurrent caller has already cloned.
        const MAX_CACHED_IDLE_THREAD_GATES: usize = 4_096;
        if self.thread_gates.len() >= MAX_CACHED_IDLE_THREAD_GATES {
            self.thread_gates
                .retain(|_, gate| Arc::strong_count(gate) > 1);
        }
        self.thread_gates
            .entry(root_turn_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn release_dialogue_thread(&self, session_id: &str, root_turn_id: &str) -> bool {
        let gate = self.dialogue_thread_gate(session_id);
        gate.release(root_turn_id).await
    }

    /// Cancel only the Activation(s) bound to one persistent Objective
    /// Evaluation. This deliberately does not mutate Session cancellation
    /// state and therefore cannot suppress dialogue or sibling Objectives.
    pub async fn cancel_objective_evaluation(
        &self,
        objective_id: &str,
        evaluation_id: &str,
    ) -> Result<bool, DynError> {
        let reason =
            format!("Objective '{objective_id}' Evaluation '{evaluation_id}' 已被暂停或取消");
        // The physical cancellation intent is durable before the in-memory
        // signal drops the model/Activation future. This ordering prevents a
        // fast cancellation from orphaning already-materialized Actions.
        let mut cancellation_error = None;
        for activation_id in self
            .objective_evaluations
            .activation_ids_for_evaluation(objective_id, evaluation_id)
        {
            if let Err(error) = self
                .request_cancel_execution_jobs_for_activation(&activation_id, &reason)
                .await
            {
                tracing::error!(
                    objective_id,
                    evaluation_id,
                    activation_id,
                    error = %error,
                    "Objective 已停止调度，但物理 Execution Job 取消意图未能完整持久化"
                );
                if cancellation_error.is_none() {
                    cancellation_error = Some(error);
                }
            }
        }
        let was_running = self
            .objective_evaluations
            .cancel_evaluation(objective_id, evaluation_id);
        if let Some(error) = cancellation_error {
            return Err(error);
        }
        Ok(was_running)
    }

    /// Persist cancellation intent for every non-terminal physical Action
    /// materialized by one Activation. Jobs that have not crossed the side-
    /// effect boundary are closed immediately with a deterministic cancelled
    /// Event; running work remains owned by its executor until physical exit.
    async fn request_cancel_execution_jobs_for_activation(
        &self,
        activation_id: &str,
        reason: &str,
    ) -> Result<usize, DynError> {
        let Some(manager) = self.execution_jobs.as_ref() else {
            return Ok(0);
        };
        let jobs = manager
            .store()
            .list_execution_jobs(ExecutionJobFilter {
                activation_id: Some(activation_id.to_string()),
                include_terminal: false,
                ..Default::default()
            })
            .await?;
        let mut requested = 0usize;
        for job in jobs {
            let job_id = job.id.clone();
            let mut current = job;
            let mut settled = false;
            for _ in 0..16 {
                match manager
                    .request_cancel(&job_id, current.revision, Some(reason))
                    .await?
                {
                    JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => {
                        current = job;
                    }
                    JobReceipt::Conflict {
                        current: changed, ..
                    } if !changed.status.is_terminal() => {
                        current = changed;
                        continue;
                    }
                    JobReceipt::Conflict { .. }
                    | JobReceipt::Rejected { .. }
                    | JobReceipt::NotFound { .. } => {
                        // A concurrent executor may have committed the real
                        // terminal fact before this control request won CAS.
                        settled = true;
                        break;
                    }
                }

                requested = requested.saturating_add(1);
                if matches!(
                    current.status,
                    ExecutionJobStatus::Queued | ExecutionJobStatus::WaitingApproval
                ) && current.side_effect_started_at.is_none()
                {
                    self.cancel_pending_approval_for_job(&current, reason)
                        .await?;
                    let output = unstarted_cancelled_tool_output(&current, reason);
                    match manager
                        .finish_with_event(
                            &current.id,
                            current.revision,
                            None,
                            JobOutcome::Cancelled {
                                result_event_id: Some(output.id.clone()),
                                result_refs: Vec::new(),
                                reason: Some(reason.to_string()),
                                exit_code: None,
                            },
                            &output,
                        )
                        .await?
                    {
                        JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => {
                            settled = true;
                            break;
                        }
                        JobReceipt::Conflict {
                            current: changed, ..
                        } if !changed.status.is_terminal() => {
                            current = changed;
                            continue;
                        }
                        JobReceipt::Conflict { .. }
                        | JobReceipt::Rejected { .. }
                        | JobReceipt::NotFound { .. } => {
                            settled = true;
                            break;
                        }
                    }
                }
                settled = true;
                break;
            }
            if !settled {
                return Err(format!(
                    "Execution Job '{job_id}' 在连续 revision 竞争下未能持久化取消请求"
                )
                .into());
            }
        }
        if let Some(scheduler) = self.background_scheduler.as_ref() {
            scheduler
                .cancel_live_tasks_for_activation(activation_id, reason)
                .await?;
        }
        Ok(requested)
    }

    async fn cancel_pending_approval_for_job(
        &self,
        job: &ExecutionJobRecord,
        reason: &str,
    ) -> Result<(), DynError> {
        let Some(services) = self.durable_approvals.as_ref() else {
            return Ok(());
        };
        let approvals = services
            .approvals
            .list_approvals(ApprovalFilter {
                job_id: Some(job.id.clone()),
                pending_only: false,
                limit: Some(2),
                ..Default::default()
            })
            .await?;
        for approval in approvals {
            let approval_id = approval.id.clone();
            let mut current = approval;
            let mut settled = false;
            for _ in 0..16 {
                let cancellable = current.status.is_pending()
                    || (current.status == ApprovalStatus::Allowed
                        && current.grant_consumed_at.is_none());
                if !cancellable {
                    settled = true;
                    break;
                }
                let commit = services
                    .approvals
                    .commit_approval_cancellation(&current.id, current.revision, reason)
                    .await?;
                match commit.mutation {
                    ApprovalMutation::Updated(cancelled)
                    | ApprovalMutation::Existing(cancelled) => {
                        // Durable authority changes first. Only then wake and
                        // remove the process-local waiter.
                        let decision = ApprovalDecision::Deny {
                            rationale: cancelled
                                .cancel_reason
                                .clone()
                                .unwrap_or_else(|| reason.to_string()),
                            risk_tags: vec!["runtime-cancelled".to_string()],
                        };
                        if let Err(error) = services
                            .human_approval_hub
                            .notify_decision(&cancelled.id, decision)
                        {
                            tracing::warn!(approval_id = %cancelled.id, %error, "Approval 已持久取消，但进程内 waiter 通知失败");
                        }
                        if commit.event_created {
                            let event = commit.event.ok_or(
                                "Approval 审计 Event 已原子创建，但 Store 未返回持久化投影",
                            )?;
                            self.bus.dispatch_persisted(event).await?;
                        }
                        settled = true;
                        break;
                    }
                    ApprovalMutation::Conflict {
                        current: changed, ..
                    } => current = changed,
                    ApprovalMutation::Rejected { .. } | ApprovalMutation::NotFound => {
                        settled = true;
                        break;
                    }
                    ApprovalMutation::Created(_) => {
                        return Err("Approval cancel 返回了不可能的 Created 状态".into());
                    }
                }
            }
            if !settled {
                return Err(
                    format!("Approval '{approval_id}' 在连续 revision 竞争下未能取消").into(),
                );
            }
        }
        Ok(())
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

    pub async fn audit_mind_projection(
        &self,
        context_id: &str,
    ) -> Result<crate::orchestrator::context::MindProjectionAudit, DynError> {
        self.context_engine.audit_mind_projection(context_id).await
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

fn interrupted_dialogue_on_restart(
    activation: &ThreadActivationRecord,
    events: &HashMap<String, Event>,
) -> bool {
    let Some(root) = events.get(&activation.root_turn_id) else {
        return false;
    };
    if root.topic != "chat/user_message"
        || root.event_type != TYPE_USER_MESSAGE
        || root.payload.get("delegation_id").is_some()
    {
        return false;
    }

    !events.values().any(|event| {
        event
            .payload
            .get("root_turn_id")
            .and_then(|value| value.as_str())
            == Some(activation.root_turn_id.as_str())
            && event_contains_physical_tool_plan(event)
    })
}

fn stable_thread_id(root_turn_id: &str) -> String {
    let digest = Sha256::digest(root_turn_id.as_bytes());
    let id = format!("thread_{digest:x}");
    id[..31].to_string()
}

fn delivery_flush_timer_id(session_id: &str) -> String {
    let digest = Sha256::digest(format!("delivery-flush:{session_id}").as_bytes());
    format!("delivery-flush:{digest:x}")
}

fn delivery_flush_event_id(timer_id: &str, generation: u64) -> String {
    let digest = Sha256::digest(format!("{timer_id}:{generation}").as_bytes());
    format!("delivery_ready_{digest:x}")
}

fn delivery_flush_reply_event_id(timer_id: &str, generation: u64) -> String {
    let digest = Sha256::digest(format!("delivery-reply:{timer_id}:{generation}").as_bytes());
    format!("delivery_reply_{digest:x}")
}

fn delivery_flush_timestamp(timer: &RuntimeTimerRecord) -> chrono::DateTime<Utc> {
    timer
        .payload
        .get("latest_pending_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .unwrap_or(timer.created_at)
}

fn activation_admission_key(activation: &ThreadActivationRecord, trigger: &Event) -> AdmissionKey {
    activation_admission_key_for_class(activation, activation_admission_class(trigger))
}

fn activation_admission_class(trigger: &Event) -> AdmissionClass {
    if trigger.event_type == TYPE_USER_MESSAGE {
        AdmissionClass::InteractiveControl
    } else if trigger.topic == "chat/thread_completion_ready" {
        AdmissionClass::Delivery
    } else if trigger.payload.get("objective_id").is_some()
        || trigger.payload.get("objective_evaluation_id").is_some()
        || trigger.topic.starts_with("objective/")
    {
        AdmissionClass::Objective
    } else if trigger
        .payload
        .get("runtime_maintenance")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || matches!(
            trigger.topic.as_str(),
            "runtime/context_maintenance" | "chat/context_maintenance"
        )
    {
        AdmissionClass::Maintenance
    } else if trigger.topic == "chat/schedule_due" || trigger.payload.get("schedule_id").is_some() {
        AdmissionClass::ScheduledBackground
    } else {
        // Ordinary tool/background wakes are not interactive merely because
        // they eventually deliver to a Session. Their completed result enters
        // the Delivery Router; only complex batches use the reserved Composer lane.
        AdmissionClass::ScheduledBackground
    }
}

fn activation_admission_key_for_class(
    activation: &ThreadActivationRecord,
    class: AdmissionClass,
) -> AdmissionKey {
    AdmissionKey::new(
        activation.id.clone(),
        activation.agent_id.clone(),
        activation.context_id.clone(),
        activation.session_id.clone(),
        class,
        activation.created_at.timestamp_millis(),
    )
}

fn event_contains_physical_tool_plan(event: &Event) -> bool {
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
}

/// A persisted lease is meaningful only while its owning Runtime is alive.
/// Unknown/non-local claimant formats deliberately return false so recovery
/// falls back to the normal lease timeout instead of stealing work.
fn activation_lease_timer_id(activation_id: &str) -> String {
    format!("activation-lease:{activation_id}")
}

fn runtime_claimant_is_definitely_dead(claimed_by: Option<&str>) -> bool {
    let Some(raw_pid) = claimed_by.and_then(|value| value.strip_prefix("runtime:")) else {
        return false;
    };
    let Ok(raw_pid) = raw_pid.parse::<i32>() else {
        return false;
    };
    if raw_pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(raw_pid), None),
            Err(nix::errno::Errno::ESRCH)
        )
    }
    #[cfg(not(unix))]
    {
        false
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

fn approval_request_event(
    job: &NewExecutionJob,
    approval: &NewApprovalRequest,
    attempt_id: &str,
    route: &ActivationRoute,
) -> Event {
    Event::new(
        format!("approval_requested_{}", approval.id),
        "System-ApprovalAuthority".to_string(),
        "approval_requested".to_string(),
        "runtime/approval_requested".to_string(),
        serde_json::Map::from_iter([
            ("approval_id".to_string(), json!(approval.id)),
            ("job_id".to_string(), json!(job.id)),
            ("request_digest".to_string(), json!(approval.request_digest)),
            ("policy_digest".to_string(), json!(approval.policy_digest)),
            ("activation_id".to_string(), json!(job.activation_id)),
            ("thread_id".to_string(), json!(job.thread_id)),
            ("context_id".to_string(), json!(job.context_id)),
            ("session_id".to_string(), json!(job.session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("tool_call_id".to_string(), json!(job.tool_call_id)),
            ("tool_name".to_string(), json!(job.tool_name)),
            ("action".to_string(), approval.action.clone()),
            ("requested".to_string(), approval.requested.clone()),
            ("justification".to_string(), json!(approval.justification)),
            ("thread_id".to_string(), json!(route.thread_id)),
            ("activation_id".to_string(), json!(route.activation_id)),
            ("root_turn_id".to_string(), json!(route.root_turn_id)),
            (
                "text".to_string(),
                json!(format!(
                    "审批请求 {} 正在等待决定：{}",
                    approval.id, approval.justification
                )),
            ),
        ]),
    )
}

fn approval_denied_tool_output(
    output_id: &str,
    context_id: &str,
    session_id: &str,
    attempt_id: &str,
    call: &crate::llm::ToolCallRepr,
    route: &ActivationRoute,
    approval: &ApprovalRecord,
) -> Event {
    let reason = approval
        .rationale
        .as_deref()
        .or(approval.cancel_reason.as_deref())
        .unwrap_or("未提供理由");
    Event::new(
        output_id.to_string(),
        "System-ApprovalAuthority".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!(context_id)),
            ("session_id".to_string(), json!(session_id)),
            ("attempt_id".to_string(), json!(attempt_id)),
            ("tool_call_id".to_string(), json!(call.id)),
            ("caused_by".to_string(), json!(call.id)),
            ("tool_name".to_string(), json!(call.func_name)),
            ("tool_status".to_string(), json!("rejected")),
            ("executed".to_string(), json!(false)),
            ("wake_policy".to_string(), json!("immediate")),
            ("approval_id".to_string(), json!(approval.id)),
            (
                "approval_status".to_string(),
                json!(approval.status.as_str()),
            ),
            ("thread_id".to_string(), json!(route.thread_id)),
            ("activation_id".to_string(), json!(route.activation_id)),
            ("root_turn_id".to_string(), json!(route.root_turn_id)),
            (
                "text".to_string(),
                json!(format!("执行拒绝: 权限审批未授权本次操作: {reason}")),
            ),
        ]),
    )
}

fn execution_approval_records(
    mutation: ExecutionApprovalMutation,
    operation: &str,
) -> Result<(ExecutionJobRecord, ApprovalRecord, bool), DynError> {
    match mutation {
        ExecutionApprovalMutation::Created { job, approval } => Ok((job, approval, true)),
        ExecutionApprovalMutation::Updated { job, approval } => Ok((job, approval, false)),
        ExecutionApprovalMutation::Existing { job, approval } => Ok((job, approval, false)),
        ExecutionApprovalMutation::Conflict {
            job,
            approval,
            reason,
        }
        | ExecutionApprovalMutation::Rejected {
            job,
            approval,
            reason,
        } => Err(format!(
            "Execution/Approval 在 {operation} 时被拒绝: {reason} (job={:?}, approval={:?})",
            job.as_ref()
                .map(|record| (&record.id, record.revision, record.status)),
            approval
                .as_ref()
                .map(|record| (&record.id, record.revision, record.status))
        )
        .into()),
        ExecutionApprovalMutation::NotFound => {
            Err(format!("Execution/Approval 在 {operation} 时不存在").into())
        }
    }
}

fn approval_record_from_mutation(
    mutation: ApprovalMutation,
    operation: &str,
) -> Result<(ApprovalRecord, bool), DynError> {
    match mutation {
        ApprovalMutation::Created(record) | ApprovalMutation::Updated(record) => Ok((record, true)),
        ApprovalMutation::Existing(record) => Ok((record, false)),
        ApprovalMutation::Conflict { current, reason }
        | ApprovalMutation::Rejected { current, reason } => Err(format!(
            "Approval '{}' 在 {operation} 时被拒绝（r{} / {}）: {reason}",
            current.id,
            current.revision,
            current.status.as_str()
        )
        .into()),
        ApprovalMutation::NotFound => Err(format!("Approval 在 {operation} 时不存在").into()),
    }
}

fn applied_execution_job(
    receipt: JobReceipt,
    operation: &str,
) -> Result<ExecutionJobRecord, DynError> {
    match receipt {
        JobReceipt::Applied { job, .. } | JobReceipt::Existing { job, .. } => Ok(job),
        JobReceipt::Conflict { current, .. } => Err(format!(
            "Execution Job '{}' 在 {operation} 时发生 revision 冲突（当前 r{} / {}）",
            current.id,
            current.revision,
            current.status.as_str()
        )
        .into()),
        JobReceipt::Rejected {
            current, reason, ..
        } => Err(format!(
            "Execution Job '{}' 在 {operation} 时被拒绝（{}）：{reason}",
            current.id,
            current.status.as_str()
        )
        .into()),
        JobReceipt::NotFound { .. } => Err(format!("Execution Job 在 {operation} 时不存在").into()),
    }
}

fn execution_job_outcome(event: &Event) -> JobOutcome {
    let tool_status = event
        .payload
        .get("tool_status")
        .and_then(|value| value.as_str())
        .unwrap_or("error");
    let exit_code = event
        .payload
        .get("exit_code")
        .and_then(|value| value.as_i64())
        .and_then(|value| i32::try_from(value).ok());
    if tool_status == "success" {
        JobOutcome::Succeeded {
            result_event_id: Some(event.id.clone()),
            result_refs: Vec::new(),
            exit_code,
        }
    } else {
        JobOutcome::Failed {
            result_event_id: Some(event.id.clone()),
            result_refs: Vec::new(),
            error: event
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("工具执行失败但没有提供错误文本")
                .to_string(),
            exit_code,
        }
    }
}

async fn finish_claimed_physical_job(
    manager: &ExecutionJobManager<dyn ExecutionJobStore>,
    claimed: &ClaimedExecutionJob,
    output: &mut Event,
) -> Result<(), DynError> {
    for _ in 0..8 {
        let current = manager
            .store()
            .get_execution_job(&claimed.id)
            .await?
            .ok_or_else(|| format!("Execution Job '{}' 在终态提交前消失", claimed.id))?;
        if current.status.is_terminal() {
            if current.result_event_id.as_deref() == Some(output.id.as_str()) {
                return Ok(());
            }
            return Err(format!(
                "Execution Job '{}' 已由不同结果 '{}' 终结",
                current.id,
                current.result_event_id.as_deref().unwrap_or("<none>")
            )
            .into());
        }

        let outcome = if current.cancel_requested_at.is_some() {
            let reason = current
                .cancel_reason
                .clone()
                .unwrap_or_else(|| "Runtime 已请求取消该物理 Action".to_string());
            let prior = output
                .payload
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            output
                .payload
                .insert("tool_status".to_string(), json!("cancelled"));
            for key in ["process_status", "task_status", "execution"] {
                if output.payload.contains_key(key) {
                    output.payload.insert(key.to_string(), json!("cancelled"));
                }
            }
            output.payload.insert(
                "text".to_string(),
                json!(format!(
                    "物理 Action 已取消：{reason}\n--- 已观测输出 ---\n{prior}"
                )),
            );
            let exit_code = output
                .payload
                .get("exit_code")
                .and_then(|value| value.as_i64())
                .and_then(|value| i32::try_from(value).ok());
            JobOutcome::Cancelled {
                result_event_id: Some(output.id.clone()),
                result_refs: Vec::new(),
                reason: Some(reason),
                exit_code,
            }
        } else {
            execution_job_outcome(output)
        };
        match manager
            .finish_with_event(
                &current.id,
                current.revision,
                Some(&claimed.claim_token),
                outcome,
                output,
            )
            .await?
        {
            JobReceipt::Applied { .. } | JobReceipt::Existing { .. } => return Ok(()),
            JobReceipt::Conflict { .. } => continue,
            JobReceipt::Rejected { current, .. }
                if !current.status.is_terminal() && current.cancel_requested_at.is_some() =>
            {
                continue;
            }
            JobReceipt::Rejected {
                current, reason, ..
            } => {
                return Err(format!(
                    "Execution Job '{}' 终态提交被拒绝（{}）：{reason}",
                    current.id,
                    current.status.as_str()
                )
                .into());
            }
            JobReceipt::NotFound { .. } => {
                return Err(format!("Execution Job '{}' 在终态提交时不存在", claimed.id).into());
            }
        }
    }
    Err(format!(
        "Execution Job '{}' 在终态提交时持续发生 revision 竞争",
        claimed.id
    )
    .into())
}

fn lost_tool_output(metadata: &ToolTaskMetadata, reason: &str) -> Event {
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(metadata.context_id.clone())),
        ("session_id".to_string(), json!(metadata.session_id.clone())),
        ("attempt_id".to_string(), json!(metadata.attempt_id.clone())),
        (
            "tool_call_id".to_string(),
            json!(metadata.tool_call_id.clone()),
        ),
        (
            "caused_by".to_string(),
            json!(metadata.tool_call_id.clone()),
        ),
        ("tool_name".to_string(), json!(metadata.tool_name.clone())),
        ("tool_status".to_string(), json!("lost")),
        ("wake_policy".to_string(), json!("immediate")),
        ("output_empty".to_string(), json!(false)),
        ("text".to_string(), json!(reason)),
    ]);
    if let Some(route) = &metadata.activation_route {
        payload.insert("thread_id".to_string(), json!(route.thread_id));
        payload.insert("activation_id".to_string(), json!(route.activation_id));
        payload.insert("root_turn_id".to_string(), json!(route.root_turn_id));
        payload.insert(
            "trigger_event_id".to_string(),
            json!(route.trigger_event_id),
        );
        payload.insert(
            "trigger_sequence".to_string(),
            json!(route.trigger_sequence),
        );
    }
    Event::new(
        metadata.output_id.clone(),
        "System-Executor".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        payload,
    )
}

fn unstarted_cancelled_tool_output(job: &ExecutionJobRecord, reason: &str) -> Event {
    Event::new(
        format!("output_cancelled_{}", job.id),
        "System-Executor".to_string(),
        TYPE_TOOL_OUTPUT.to_string(),
        "chat/tool_output".to_string(),
        serde_json::Map::from_iter([
            ("context_id".to_string(), json!(job.context_id)),
            ("session_id".to_string(), json!(job.session_id)),
            ("attempt_id".to_string(), json!(job.activation_id)),
            ("tool_call_id".to_string(), json!(job.tool_call_id)),
            ("caused_by".to_string(), json!(job.tool_call_id)),
            ("tool_name".to_string(), json!(job.tool_name)),
            ("tool_status".to_string(), json!("cancelled")),
            ("executed".to_string(), json!(false)),
            ("wake_policy".to_string(), json!("none")),
            ("output_empty".to_string(), json!(false)),
            ("thread_id".to_string(), json!(job.thread_id)),
            ("activation_id".to_string(), json!(job.activation_id)),
            (
                "text".to_string(),
                json!(format!(
                    "物理 Action 在副作用开始前已取消，因此没有执行：{reason}"
                )),
            ),
        ]),
    )
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

fn event_needs_signal_outbox(event: &Event) -> bool {
    event.topic.starts_with("chat/")
        && matches!(
            event.event_type.as_str(),
            TYPE_USER_MESSAGE | TYPE_TOOL_OUTPUT
        )
        && event
            .payload
            .get("context_id")
            .and_then(|value| value.as_str())
            .is_some()
        && event
            .payload
            .get("session_id")
            .and_then(|value| value.as_str())
            .is_some()
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
        activation_admission_class, baseline_system_prompt, classify_terminal_response,
        cognitive_sexpr_vm_system_prompt, compact_context_inspect_for_persistence,
        compose_system_prompt, event_needs_signal_outbox, extend_exec_output_facts,
        persist_model_reasoning_summary, render_system_contract, semantic_sexpr_vm_system_prompt,
        should_force_final_for_maintenance, tool_call_activity_preview, DurableEventWriter,
        DurableEventWriterMetrics, ModelReasoningSummaryAccumulator, ReadTurnGuard,
        SystemPromptMode, TerminalDecision, AGENT_OWNED_CONTEXT_PROMPT_BASE,
    };
    use crate::admission::AdmissionClass;
    use crate::config::EventWriterConfig;
    use crate::event::{Event, InMemoryEventBus, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{EventAppend, EventStore, QueryFilter};
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::{Barrier, Mutex};

    #[tokio::test]
    async fn durable_event_writer_groups_concurrent_publishers_and_reports_capacity() {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(tmp.path().join("writer.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let metrics = Arc::new(DurableEventWriterMetrics::default());
        let writer = DurableEventWriter::spawn(
            Arc::clone(&store) as Arc<dyn EventStore>,
            &EventWriterConfig {
                queue_capacity: 32,
                max_batch_size: 32,
                flush_interval_ms: 100,
            },
            Arc::clone(&metrics),
        );
        let barrier = Arc::new(Barrier::new(13));
        let mut publishers = Vec::new();
        for index in 0..12 {
            let writer = writer.clone();
            let barrier = Arc::clone(&barrier);
            publishers.push(tokio::spawn(async move {
                barrier.wait().await;
                writer
                    .append(EventAppend {
                        event: Event::new(
                            format!("writer-{index}"),
                            "fixture".to_string(),
                            "fixture".to_string(),
                            "runtime/writer_fixture".to_string(),
                            serde_json::Map::new(),
                        ),
                        signal_outbox: false,
                    })
                    .await
                    .unwrap();
            }));
        }
        barrier.wait().await;
        for publisher in publishers {
            publisher.await.unwrap();
        }
        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.queue_depth, 0);
        assert_eq!(snapshot.committed_events, 12);
        assert!(snapshot.committed_batches < 12);
        assert!(snapshot.largest_batch > 1);
        assert_eq!(
            store
                .query(QueryFilter {
                    topic: Some("runtime/writer_fixture".to_string()),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            12
        );
    }

    #[tokio::test]
    async fn partial_reasoning_summary_is_persisted_once_with_stable_attempt_identity() {
        let bus = Arc::new(InMemoryEventBus::new());
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let durable_capture = Arc::clone(&captured);
        bus.subscribe_durable(
            "runtime/model_reasoning_summary".to_string(),
            Arc::new(move |event| {
                let capture = Arc::clone(&durable_capture);
                Box::pin(async move {
                    capture.lock().unwrap().push(event);
                    Ok(())
                })
            }),
        );
        let accumulator = Arc::new(Mutex::new(ModelReasoningSummaryAccumulator {
            text: "partial provider summary".to_string(),
            complete: true,
            persist_started: false,
            ..Default::default()
        }));
        let route = vec![
            ("activation_id".to_string(), json!("activation-1")),
            ("thread_kind".to_string(), json!("dialogue_turn")),
        ];

        for _ in 0..2 {
            persist_model_reasoning_summary(
                &bus,
                "context-1",
                "session-1",
                "attempt-1",
                &route,
                &accumulator,
                true,
            )
            .await
            .unwrap();
        }

        let events = captured.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "model_reasoning_summary_attempt-1");
        assert_eq!(events[0].payload["text"], "partial provider summary");
        assert_eq!(events[0].payload["complete"], false);
        assert_eq!(events[0].payload["activation_id"], "activation-1");
        assert_eq!(events[0].payload["thread_kind"], "dialogue_turn");
    }

    #[test]
    fn activation_admission_class_is_runtime_owned_and_deterministic() {
        let event =
            |event_type: &str, topic: &str, payload: serde_json::Map<String, serde_json::Value>| {
                Event::new(
                    format!("class-{topic}"),
                    "fixture".to_string(),
                    event_type.to_string(),
                    topic.to_string(),
                    payload,
                )
            };
        assert_eq!(
            activation_admission_class(&event(
                TYPE_USER_MESSAGE,
                "chat/user_message",
                serde_json::Map::new(),
            )),
            AdmissionClass::InteractiveControl
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "chat/thread_completion_ready",
                serde_json::Map::new(),
            )),
            AdmissionClass::Delivery
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "objective/resume",
                serde_json::Map::new(),
            )),
            AdmissionClass::Objective
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "chat/schedule_due",
                serde_json::Map::new(),
            )),
            AdmissionClass::ScheduledBackground
        );
        assert_eq!(
            activation_admission_class(&event(
                TYPE_TOOL_OUTPUT,
                "runtime/context_maintenance",
                serde_json::Map::from_iter([("schedule_id".to_string(), json!("schedule-1"),)]),
            )),
            AdmissionClass::Maintenance,
            "explicit Runtime maintenance must not be reclassified by an incidental schedule field"
        );
    }

    #[test]
    fn signal_outbox_is_reserved_for_routable_scheduler_inputs() {
        let routed_payload = serde_json::Map::from_iter([
            ("context_id".to_string(), json!("context-1")),
            ("session_id".to_string(), json!("session-1")),
        ]);
        for (event_type, topic) in [
            (TYPE_USER_MESSAGE, "chat/user_message"),
            (TYPE_TOOL_OUTPUT, "chat/tool_output"),
        ] {
            assert!(event_needs_signal_outbox(&Event::new(
                format!("{event_type}-routed"),
                "fixture".to_string(),
                event_type.to_string(),
                topic.to_string(),
                routed_payload.clone(),
            )));
        }

        let missing_session = Event::new(
            "missing-session".to_string(),
            "fixture".to_string(),
            TYPE_USER_MESSAGE.to_string(),
            "chat/user_message".to_string(),
            serde_json::Map::from_iter([("context_id".to_string(), json!("context-1"))]),
        );
        assert!(!event_needs_signal_outbox(&missing_session));

        let audit_event = Event::new(
            "audit-only".to_string(),
            "fixture".to_string(),
            "proposal".to_string(),
            "chat/context_inspect".to_string(),
            routed_payload,
        );
        assert!(!event_needs_signal_outbox(&audit_event));
    }

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
        assert!(first.contains("sandbox_permissions=require_escalated"));
        assert!(first.contains("不得仅因普通命令失败猜测权限问题"));
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
            "普通 assistant 文本",
            "不是模型响应的输出格式",
            "绝不能把 (reply ...) 的括号、算子名或代码围栏发送给 Session",
            "no_reply",
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
            Some(("final-reply", "返回普通文本")),
        );
        assert!(composed.starts_with("(system-evaluation"));
        assert!(composed.contains("(runtime-directive"));
        assert!(composed.contains("(kind final-reply)"));
        crate::sexpr::parse(&composed).expect("dynamic semantic prompt must remain one SExpr");

        let cognitive = compose_system_prompt(
            SystemPromptMode::CognitiveSexprVm,
            cognitive_sexpr_vm_system_prompt(),
            Some(("final-reply", "返回普通文本")),
        );
        assert!(cognitive.ends_with("返回普通文本"));
    }

    #[test]
    fn response_classifier_accepts_plain_text_and_exclusive_no_reply() {
        let plain = crate::llm::Response {
            content: "done".to_string(),
            tool_calls: Vec::new(),
        };
        assert_eq!(
            classify_terminal_response(&plain),
            Ok(Some(TerminalDecision::Deliver("done".to_string())))
        );

        let no_reply = crate::llm::Response {
            content: String::new(),
            tool_calls: vec![crate::llm::ToolCallRepr {
                id: "no-reply-1".to_string(),
                r#type: "function".to_string(),
                func_name: "no_reply".to_string(),
                arguments: json!({}).to_string(),
            }],
        };
        assert_eq!(
            classify_terminal_response(&no_reply),
            Ok(Some(TerminalDecision::NoReply))
        );

        let mixed = crate::llm::Response {
            content: "not silent".to_string(),
            tool_calls: no_reply.tool_calls,
        };
        assert!(classify_terminal_response(&mixed).is_err());
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
