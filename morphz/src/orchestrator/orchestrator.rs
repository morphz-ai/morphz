use crate::config::OrchestratorConfig;
use crate::event::{Event, InMemoryEventBus, TYPE_AGENT_CALL, TYPE_TOOL_OUTPUT, TYPE_USER_MESSAGE};
use crate::llm::{Client, Message};
use crate::memory::{EventStore, QueryFilter};
use crate::orchestrator::context::{ContextEngine, ContextView};
use crate::tool::Registry;
use chrono::Utc;
use dashmap::DashMap;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex;

type DynError = Box<dyn std::error::Error + Send + Sync>;

const AGENT_OWNED_CONTEXT_PROMPT: &str = r#"你是 Morphz，一个能够管理自身工作 Context 的 AI Agent。

Runtime 每轮提供一份自描述 Context。`protocol` 是当前响应模式与 Context DSL 的权威契约；先读取它，再决策。

Context 的状态分为三个权限域：
- kernel：Runtime 拥有，只读。包含 session、context version 和物理压力。
- mind：你拥有的长期工作注意力，由稳定 ID 的自由格式 frame 组成。
- inbox：Event Ledger 中尚未被你 retire 的原始 observation。它们是证据，不是 Runtime 替你形成的结论。

你必须自己判断当前目标下什么值得保留、摘要、修订、保护、恢复或遗忘。Runtime 不会自动替你摘要历史、裁剪旧消息或把检索结果写成事实。

每次响应必须明确选择 `protocol.response-contract` 中的一种模式：
- reply：当前任务已完成或需要说明阻塞；不调用任何工具，正文直接交付用户。
- act：确实需要新的外部结果；调用物理工具，正文只是控制轨迹，不是最终回复。
- maintain：需要修改 Mind；调用唯一的 context_tx。事务回执不是 observation，也不是最终回复。

使用 context_tx 原子修改 Mind，并严格遵循 `protocol.context-tx-contract` 展示的语法。每次事务使用 kernel 中当前的 version。reason 是 context-tx 的事务级子项，绝不能作为 retire/unprotect 的参数。

重要规则：
1. frame 的内部结构由你根据任务自由创造；不要假设固定 goal/todo/history schema。
2. 重要目标、用户约束、关键结论和未完成工作应进入 frame；适合时使用 protect。
   用户明确声明“始终、整个任务期间、不得、必须”等持续约束时，应将其写入受保护 frame，直到用户明确撤销或任务生命周期真正结束。
3. 大段 observation 可先 derive 成忠实摘要，再在同一 transaction 中 retire 原始 observation。不要把假设写成事实。
4. 用户要求在已知文件中查证具体结论时，直接使用 read.query 取得带行号的窄证据；需要连续上下文时再用 start_line/end_line 精确分页。不要先整读长文件，也不要用 exec/grep 反复产生大段重复输出。被 truncated 的 observation 可使用 recall 按 full-ref 分段读取原文；exec 若给出 artifact path，则使用 read 按需读取完整归档。recall/read 结果只进入 inbox，你决定是否写入 Mind。
5. context_tx 可以和无需依赖新结果的物理工具并行调用；如果新 frame 依赖工具结果，应等结果进入 inbox 后再 derive。
6. 同一响应最多提交一个 context_tx；把多个修改合并进同一事务，避免版本冲突。
   retire 或 unprotect 时 reason 是必需的，使遗忘与解除保护可审计。
7. pressure 为 warning/critical 时优先主动释放 Context 预算，但由你决定 retire 哪些内容。
8. 完成任务前，确认 Mind 中仍需跨轮保留的目标、约束、结论和开放问题已经准确；不再有价值的过程 observation 应由你主动 retire。
9. assistant_call 与 context_tx 回执属于 Runtime 控制轨迹，只保存在 Ledger，不会进入 Inbox；不要为了清理 context_tx 自己产生的记录而连续提交 housekeeping transaction。
10. 每次调用物理工具前，必须确认它是完成当前用户明确任务所必需的新信息。当 Mind/inbox 已足以回答时，立即使用 reply；不要重复验证、扫描工作区或自行发明后续目标。
11. kernel.turn-budget 是当前用户回合的物理 Attempt 预算。剩余 3 次以内时停止重复验证并收敛；force-final=true 时工具会被移除，你必须基于已有证据给出最终答案或明确说明阻塞原因。
12. kernel.wake 说明本次为何被唤醒。context-transaction-result 表示 Mind 修改已经提交；若任务已完成，必须直接 reply，不能把事务回执当作继续行动的理由。
13. 代码任务优先使用 list_files/search 发现文件、read 获取内容与 sha256、edit 做带版本前提的局部修改；write 主要用于 mode=create，新文件已存在或 overwrite 缺少 expected_sha256 时不得绕过保护。exec 用于测试/编译/格式化，不要用 Shell 替代受约束的文件工具。file_change 是已提交修改的可审计证据。

Context 的修改是你的元认知行为；read/write/exec/spawn 等工具是对外部世界的行为。保持二者边界清晰。"#;

pub struct Orchestrator {
    bus: Arc<InMemoryEventBus>,
    store: Arc<dyn EventStore>,
    client: Arc<dyn Client>,
    registry: Arc<Registry>,
    context_engine: Arc<ContextEngine>,
    orchestrator_config: OrchestratorConfig,
    pub concurrency_semaphore: Arc<tokio::sync::Semaphore>,
    session_locks: DashMap<String, Arc<Mutex<()>>>,
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
        Self {
            bus,
            store,
            client,
            registry,
            context_engine,
            orchestrator_config,
            concurrency_semaphore,
            session_locks: DashMap::new(),
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

    async fn run_attempt(&self, session_id: &str) -> Result<(), DynError> {
        let attempt_id = format!(
            "attempt_{}_{}",
            session_id,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let context = self.context_engine.build_view(session_id).await?;
        let messages = vec![
            Message {
                role: "system".to_string(),
                content: AGENT_OWNED_CONTEXT_PROMPT.to_string(),
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

        self.publish_context_inspect(session_id, &attempt_id, &context, &messages)
            .await?;

        let mut tools = self.registry.definitions();
        if context.turn_budget.force_final {
            tracing::warn!(
                session_id,
                attempt = context.turn_budget.attempt,
                limit = context.turn_budget.limit,
                "Turn Attempt Budget 已耗尽：强制进入无工具最终答复"
            );
            tools.clear();
        } else if context.pressure.level == "critical" {
            tracing::warn!(
                session_id,
                "Context pressure critical：暂停外部高成本动作，要求 Agent 先维护 Context"
            );
            tools.retain(|tool| tool.name == "context_tx" || tool.name == "recall");
        }

        let _permit = self.concurrency_semaphore.acquire().await?;
        let response = self.client.create_completion(messages, tools).await?;

        if context.turn_budget.force_final && !response.tool_calls.is_empty() {
            let content = if response.content.trim().is_empty() {
                format!(
                    "本轮已达到 {} 次 Attempt 上限，Runtime 已停止继续执行工具。现有信息不足以形成最终答复，请缩小任务或提供新的指令。",
                    context.turn_budget.limit
                )
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
            self.execute_tool_calls(session_id, &attempt_id, response)
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

    async fn execute_tool_calls(
        &self,
        session_id: &str,
        attempt_id: &str,
        response: crate::llm::Response,
    ) -> Result<(), DynError> {
        let mapped_tool_calls = response
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
        self.bus
            .publish(Event::new(
                format!("call_{}", attempt_id),
                "Agent-Morphz".to_string(),
                TYPE_AGENT_CALL.to_string(),
                "chat/assistant_call".to_string(),
                vec![
                    ("session_id".to_string(), json!(session_id)),
                    ("attempt_id".to_string(), json!(attempt_id)),
                    ("text".to_string(), json!(response.content)),
                    ("tool_calls".to_string(), json!(mapped_tool_calls)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;

        let mut tasks = Vec::new();
        for call in response.tool_calls {
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
                        let output = match result {
                            Ok(Ok(output)) => output,
                            Ok(Err(error)) => format!("执行失败: {}", error),
                            Err(_) => format!("执行超时: 超过 {} 秒限额", timeout_secs),
                        };
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
                                ("text".to_string(), json!(output)),
                            ]
                            .into_iter()
                            .collect(),
                        )
                    })
                    .await
            }));
        }

        let mut outputs = Vec::new();
        for task in tasks {
            match task.await {
                Ok(output) => outputs.push(output),
                Err(error) => tracing::error!(?error, "工具任务 join 失败"),
            }
        }
        if outputs.is_empty() {
            return Err("所有工具任务都在产生结果前异常终止".into());
        }
        let output_count = outputs.len();
        for (index, output) in outputs.into_iter().enumerate() {
            if index + 1 == output_count {
                self.bus.publish(output).await?;
            } else {
                self.store.append(output).await?;
            }
        }
        Ok(())
    }

    async fn publish_context_inspect(
        &self,
        session_id: &str,
        attempt_id: &str,
        context: &ContextView,
        messages: &[Message],
    ) -> Result<(), DynError> {
        self.bus
            .publish(Event::new(
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
                    ("wake".to_string(), json!(context.wake)),
                ]
                .into_iter()
                .collect(),
            ))
            .await?;
        Ok(())
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

fn required_payload_str<'a>(event: &'a Event, key: &str) -> Result<&'a str, DynError> {
    event
        .payload
        .get(key)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("事件 '{}' 缺少字符串字段 '{}'", event.id, key).into())
}
