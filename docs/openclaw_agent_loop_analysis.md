# OpenClaw 智能体运行循环 (Agent Loop) 与流订阅深度剖析

本报告深入解剖 `openclaw` 中关于智能体执行循环（Agent Loop）与流式事件分发的源码实现。我们将重点走读并分析其生命周期调度、执行状态机、熔断保护以及 stream 净化状态机的实现细节。

---

## 1. 智能体生命周期与队列调度 (run.ts)

智能体的每一次交互或自动化任务在底层都是通过 [run.ts](file:///Users/shafreeck/Codes/Morphz/openclaw/src/agents/embedded-agent-runner/run.ts) 的 `runEmbeddedAgent` 统一承接的。其核心架构围绕**并发控制**、**优先级排队**与**超时容错**展开。

```
                    [ 触发源 Trigger ] (user, cron, heartbeat...)
                            │
                            ▼
           [ resolveEmbeddedRunSessionQueuePriority ]
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
     (Foreground Lane)               (Background Lane)
  [ 优先处理, 占用终端 ]             [ 后台排队, 低优先级 ]
            │                               │
            └───────────────┬───────────────┘
                            ▼
          [ runEmbeddedAttemptWithBackend ] ➔ 启动单轮 LLM 执行
```

### 1.1 会话 Lane 队列划分
`runEmbeddedAgent` 通过会话的特征信息（SessionKey 或 SessionId）和触发源类型（Trigger）来规划不同的调度通道（Lanes）：
*   **会话 Lane (Session Lane)**：通过 `resolveSessionLane` 将同一个会话的所有指令排队。这确保了在同一个聊天窗口中，用户连续发送的消息或工具链调用绝对按顺序执行，避免数据库写入锁（Session Write Lock）冲突。
*   **全局 Lane (Global Lane) 与优先级**：根据 Trigger 的类型（如 `user`、`manual` 映射为 `foreground` 前台通道；`cron`、`heartbeat`、`memory` 映射为 `background` 后台通道），放入全局队列中抢占线程。前台任务能够快速插队响应。

### 1.2 强制超时与 Compaction 宽限延时
在进入 Attempt 时，调度器通过 `scheduleAbortTimer` 来做全局的时间控制：
*   **超时防护**：传入的 `params.timeoutMs` （如 10 分钟）会被转换为 abort 控制信号，一旦触发则通过 `runAbortController.abort()` 强行中断 LLM API 传输及工具子进程。
*   **Compaction 自动宽限 (Compaction Grace)**：如果 LLM 在进行 Context Compaction（上下文压缩）时超时，因为该操作旨在清理和挽救当前会话，所以调度器会给予一次 30 秒的宽限期（`compactionGraceUsed = true` 并执行 `scheduleAbortTimer(compactionTimeoutMs, "compaction-grace")`），防止在压缩进行到一半时被无情掐断导致状态受损。

---

## 2. 单轮执行状态机 (attempt.ts)

单轮推理的编排在 [attempt.ts](file:///Users/shafreeck/Codes/Morphz/openclaw/src/agents/embedded-agent-runner/run/attempt.ts) 的 `runEmbeddedAttempt` 中实现，这是智能体的“单步决策核心”。

### 2.1 准备阶段与安全沙箱隔离
在 LLM 执行前，`runEmbeddedAttempt` 会执行复杂的依赖就绪工作：
1.  **沙箱环境决策 (resolveSandboxContext)**：检测会话对应的 Sandbox 是否开启。若开启，将 `workspaceDir` 重定向到沙箱的隔离目录，以保证生成的临时文件与脚本绝对在受控容器（Daytona/Docker）中运行。
2.  **工具安全策略过滤 (applyEmbeddedAttemptToolsAllow)**：
    *   首先通过 `resolveGroupToolPolicy` 等读取全局、群组的安全 Policy（如 `inherited-tool-deny`）。
    *   通过 `applyFinalEffectiveToolPolicy` 将最终允许执行的工具白名单传递给 `createOpenClawCodingTools`。如果触发了 DenyAll 拦截，则清空白名单，并在 System Prompt 中硬注入防范规则，直接由 LLM 反馈拒绝说明。
3.  **上下文与提示词组装 (assembleAttemptContextEngine)**：加载 `AGENTS.md`、`BOOTSTRAP.md` 注入底层 System Context，并通过 `analyzeBootstrapBudget` 评估 Token 预算。若超出上限，会触发截断警告。

### 2.2 运行循环 (run.ts Loop) 中的 Compact 状态翻转
在 `run.ts` 内部，主循环包裹着 Attempt 的执行过程，并处理极其重要的**上下文溢出（Context Overflow）**：
*   当 LLM 推理或者 Prompt 组装抛出 `LikelyContextOverflowError` 时，主循环会捕获该错误并开启 Compact 挽救：
    ```typescript
    timeoutCompactResult = await compactContextEngineWithSafetyTimeout(
      contextEngine,
      {
        sessionId: activeSessionId,
        sessionKey: params.sessionKey,
        sessionFile: activeSessionFile,
        tokenBudget: ctxInfo.tokens,
        force: true,
        compactionTarget: "budget",
        runtimeContext: timeoutCompactionRuntimeContext,
      },
      ...
    );
    ```
*   **Session 动态旋转 (Session Rotation)**：如果 Compaction 成功压缩了历史，它会输出一个新的 `sessionId` 和 `sessionFile`。此时，主循环会执行 `adoptCompactionTranscript(compactResult)`，**动态将当前运行指针指向压缩后的 Session 分支**，接着执行 `continue` 重新发起 attempt 推理。这使得长对话即便在单轮中爆掉 Token 限制，也能原地满血复活继续回答。
*   **死循环判定 (PostCompactionGuard)**：为了防止 LLM 在压缩之后，重新产生一模一样的工具死循环或无休止的重新触发，系统内置了 `createPostCompactionLoopGuard`，如果判定在压缩后重复发起了完全一致的 Tool 序列，则视为 Loop 死锁，强制熔断。

---

## 3. 空转熔断保护机制 (idle-timeout-breaker.ts)

在复杂的工具调用链中，LLM 可能会出现格式解析错误、不断地做没有输出的思考（Commentary Phase），或者遇到接口偶发异常进入空转。这可能在几分钟内产生数百次昂贵的 API 调用。

OpenClaw 引入了 [idle-timeout-breaker.ts](file:///Users/shafreeck/Codes/Morphz/openclaw/src/agents/embedded-agent-runner/run/idle-timeout-breaker.ts) 进行保护：
*   **判定基准**：每一个 attempt 结束后，调用 `hasCompletedModelProgressForIdleBreaker` 评估是否产生了“实质性进展”：
    *   是否产生了可见文字输出？
    *   是否发起了 Tool Call 或者是 client-side Tool？
    *   是否有出站通信（Outbound Delivery Evidence）？
*   **断路器触发**：如果一个 attempt 被判定为 `idleTimedOut`（空转超时），且没有产生实质进展，熔断器状态 `idleTimeoutBreakerState` 的计数器加一。
*   一旦连续空转次数达到限制 `MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT`，断路器直接拉闸，中止执行循环并抛出异常，从而有效阻断由于代码 Bug 或 LLM 幻觉造成的资费爆炸。

---

## 4. Stream 标签过滤状态机 (embedded-agent-subscribe.ts)

LLM 的流式输出在推送到前端前，必须通过 `subscribeEmbeddedAgentSession` 进行在线清洗。其中，过滤算法 [stripBlockTags](file:///Users/shafreeck/Codes/Morphz/openclaw/src/agents/embedded-agent-subscribe.ts#L732-L900) 是最精彩的模块。

### 4.1 核心算法：残缺标签挂起 (Trailing Tag Fragment Preservation)
当 LLM 吐出 `"I will use a tool now. <thi"` 时，如果直接发给前端，用户会看到残缺的 XML 标签 `"I will use a tool now. <thi"`，并且这会影响 Markdown 渲染器。
*   **挂起机制**：`splitTrailingBlockTagFragment` 会分析最后一段字符是否为未闭合的标签（即以 `<` 开头但不包含 `>`）。若符合条件，将其从当前 chunk 中剥离（`pendingTagFragment`），放进缓冲：
    ```typescript
    const { text: scanText, pendingTagFragment } = splitTrailingBlockTagFragment(fenceInput, initialCodeSpans.isInside);
    stateLocal.pendingTagFragment = pendingTagFragment;
    ```
*   在下一个 chunk 到达时，该 fragment 会被自动拼接到开头：
    ```typescript
    const input = `${stateLocal.pendingFenceFragment ?? ""}${stateLocal.pendingTagFragment ?? ""}${text}`;
    ```
    直到闭合的 `>` 出现，从而在不影响流式输出延迟的前提下，彻底避免了残缺标签的瞬时呈现。

### 4.2 Markdown 语法感知与逃逸防止
在 Markdown 中，普通文本的 `<think>` 代表开始推理，必须隐藏；而处于 \`\`\` xml\n <think>\n \`\`\` 代码块内部的 `<think>` 则是用户需要展示的示范代码，必须保留。
*   `stripBlockTags` 并非简单地进行全局正则替换，而是通过 `buildCodeSpanIndex` 构建了临时语法树，提取出当前行内代码（Inline Code）及围栏代码块（Fenced Code）的区间索引。
*   在执行正则匹配（`THINKING_TAG_SCAN_RE`）时，通过 `codeSpans.isInside(idx)` 判断匹配到的标签是否在代码块中。若在其中，则跳过过滤，完美保持了 Markdown 的原样格式展示，防止标签在代码展示中逃逸或误判。

### 4.3 隐藏推理流的独立状态隔离
当隐藏 `<think>...</think>` 内部的内容时，被屏蔽的内容里依然可能存在各种未闭合的 markdown 围栏。
*   为了防止这些隐藏的 markdown 围栏破坏后面可见回答的排版，算法在屏蔽推理文本时，用一套独立的 `hiddenInlineState` 和 `hiddenFenceState` 隔离追踪推理文本内部的格式开闭状态：
    ```typescript
    stateLocal.reasoningInlineCode = inThinking ? hiddenInlineState : undefined;
    stateLocal.reasoningFence = inThinking ? hiddenFenceState : undefined;
    ```
    可见内容继续使用外部的 `inlineCode` 和 `fence` 状态，真正实现了格式层面的“逻辑双轨制”。

---

## 5. 对 Morphz 的架构启示

1.  **Session 隔离与队列重定向**：在构建 Morphz 时，必须像 OpenClaw 一样将 WebSocket/HTTP 网关发来的消息按 Session 隔离排队（Session Lanes），严禁同一个用户的连续交互在多进程/多协程中并发执行，以规避数据库写锁死锁。
2.  **动态上下文旋转机制**：长对话智能体设计必须支持动态旋转，一旦触发 Compaction，自动将底层的 Session 文件换成压缩后的新版本，并在运行上下文中动态更新，而不是简单地阻断会话或裁切头尾。
3.  **流式过滤器状态机**：这是高水准 Web APP Agent 必不可少的组件。必须在智能体流式输出组件中加入“Markdown 代码块感知的 Trailing XML 过滤器”，否则前端 UI 的流式显示会经常出现布局撕裂或代码块排版失控。
