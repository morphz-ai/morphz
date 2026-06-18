# openclaw 与 Hermes Agent Loop & Tools 终极对比报告

本报告针对 `openclaw`（TypeScript）与 `Hermes`（Python）两个开源项目的智能体运行循环（Agent Loop）与工具分发体系（Tools）进行系统化对比，拆解其技术异同，并为自主开发 `Morphz` 智能体框架提炼核心架构设计建议。

---

## 1. 核心维度对比矩阵

| 对比维度 | OpenClaw (TypeScript) | Hermes (Python) |
| :--- | :--- | :--- |
| **并发模型与执行流** | 事件循环 + 会话/全局 Lanes 顺序消息排队 | 协程主循环（asyncio）+ 线程池（ThreadPoolExecutor）并发执行 Tools |
| **上下文溢出控制** | 运行时 attempt 级异常重试 + 动态 Session 文件旋转 | Preflight 预检压缩 + 运行时错误捕获 + Tool 输出前置廉价修剪 |
| **防空转/计费熔断** | 实质性进展评估（文字/Tool/出站证据）+ Idle 断路器 | IterationBudget 控制次数 + 异常错误分类器 + Fallback 自动切换 |
| **流式标签清洗与 UI 适配** | Markdown 感知的 `stripBlockTags` 状态机，支持残缺挂起与推理状态隔离 | `stream_context_scrubber` 简易字符串擦除与 prefill 重试 |

---

## 2. 深度架构差异拆解

### 2.1 并发与执行控制流：TS 单线程队列 vs Python 线程池
*   **OpenClaw (TS)**：
    *   利用 TS 天然的非阻塞 Event Loop，将所有并发输入放入 `resolveSessionLane` 排队，从根源上避开了由于多线程带来的数据库写冲突和文件竞态。
    *   它的 Tool 执行依然在单线程异步模型下，利用非阻塞 I/O（如 exec 子进程）交由系统处理。
*   **Hermes (Python)**：
    *   由于 Python 存在 GIL（全局解释器锁）以及 `asyncio` 在 CPU 密集型任务上的限制，Hermes 选择了 **ThreadPoolExecutor (多线程池)** 来处理 LLM 分发的多个 `tool_calls`。
    *   **核心痛点与解决**：多线程执行会丢失主线程的 `ContextVar` 上下文。Hermes 通过 `propagate_context_to_thread` 跨线程拷贝并同步了 `session_id` 和安全凭证，解决了在多线程并发下的变量丢失问题。

### 2.2 上下文压缩（Compaction）算法：Session 旋转 vs 廉价修剪与 Tail 融合
当上下文溢出（Context Overflow）时，两者的设计体现了两种不同的哲学：
*   **OpenClaw 的 Session 旋转**：
    *   当发现 overflow 错误时，调用 compaction 任务。由于 TS 的数据一般是以日志追加（JSONL）形式存放的，因此它通过物理新建并旋转 Session 文件（`adoptCompactionTranscript`）来改变当前 Attempt 轮次的持久化实体，状态转换比较彻底，但由于涉及到文件句柄的重新绑定，架构略显繁重。
*   **Hermes 的前置修剪与 Tail 融合**：
    *   **前置廉价修剪 (Pruning)**：在做 LLM 压缩前，利用静态逻辑把历史 Tool 的巨型 JSON 结果和 Base64 图片强行裁剪成文本占位符（`_PRUNED_TOOL_PLACEHOLDER`），免去了让 LLM 直接读超大历史去压缩的昂贵费用。
    *   **Tail 拼接融合 (Alternation Fix)**：在回填 Summary 消息时，若因角色交替限制（User 必须交替 Assistant）无法插入，Hermes 会直接把 summary 格式化并强行 prepend 拼接到 Tail 区间第一条消息的最前面（`merged_prefix`），巧妙地避开了角色交替违规。
    *   **指令隔离墙**：加上 `--- END OF CONTEXT SUMMARY ---`，在物理上断绝了弱模型把过去的 Active Task 识别为当前新请求的幻觉。

### 2.3 防费用逃逸（熔断）：Idle 断路器 vs 错误分类 Fallback
*   **OpenClaw 的 IdleBreaker**：
    *   由于 LLM 的空转可能是由细微的输出格式错误引起的，OpenClaw 通过检测 `assistantTexts`、`toolMetas` 和 `itemLifecycle` 来判定是否产生了实质进展。若连续无进展（空转），断路器立即Tripped（跳闸），防止产生无限空转的天价账单。这在复杂自主 Agent 中是极其优秀的安全网。
*   **Hermes 的 Error Classifier 与 Fallback**：
    *   Hermes 更加关注异常处理的稳定性。如果当前 provider 出错或达到频控，它会通过 `error_classifier.py` 判定 Failover 理由。如果属于 rate limit / outage，它会自动切换到 fallback 备用模型并在此轮 loop 中直接自愈。

### 2.4 流式渲染与 UI 净化：Markdown 状态机 vs 文本擦除
*   **OpenClaw 的 Markdown 感知状态机 (`stripBlockTags`)**：
    *   这也许是 OpenClaw 最惊艳的设计。在流式传输时，由于 chunk 可能断在标签中间（如 `<thi`），算法支持将 fragment 挂起（`pendingTagFragment`），待拼齐后过滤。
    *   通过 `buildCodeSpanIndex`，它能感知尖括号 `<think>` 是否在 \`\`\` xml 这样的代码块里，代码块里的保留，普通文本的屏蔽，从而彻底解决了“前端渲染撕裂”与“代码展示误剥离”这两个难题。
*   **Hermes**：
    *   Hermes 在流式处理上仅通过 `think_scrubber` 做基础正则屏蔽和清理，不具备高级的 Markdown 语法树感知能力，因此如果要在前端画布上做精细流式 UI 渲染，其鲁棒性低于 OpenClaw。

---

## 3. Morphz 的推荐设计决策

根据 openclaw 与 Hermes 的利弊得失，我们在构建 **Morphz** 的 Agent Loop 与 Tools 时，推荐采用以下“融汇重构”方案：

```
                ┌──────────────────────────────────┐
                │        Morphz Agent Loop         │
                └────────────────/ \───────────────┘
                                /   \
                               /     \
  ┌───────────────────────────┐       ┌───────────────────────────┐
  │  TypeScript Frontend-Side │       │    Python Backend-Side    │
  │     (A2UI Event Loop)     │       │ (Concurrent Execution Loop)│
  └─────────────┬─────────────┘       └─────────────┬─────────────┘
                │                                   │
                ▼                                   ▼
    • stripBlockTags (残缺挂起)        • ThreadPoolExecutor + Propagate
    • Markdown 语法树感知过滤           • Preflight 廉价剪枝 + Tail 融合
    • Session Lane 单线程顺序排队        • Error Classifier Fallback 自愈
```

1.  **架构分工**：
    *   **控制与调度侧**（如果用 Node.js/TS 编写）：采用 OpenClaw 的 **Session Lanes 队列排队** 方案。单线程排队能够彻底规避并发事务锁。同时，前端流式输出处理必须全盘继承 OpenClaw 的 **Markdown 感知 `stripBlockTags` 算法**，解决残缺标签和代码块的防逃逸展示。
    *   **执行与策略侧**（如果用 Python 编写）：继承 Hermes 的 **Preflight 压缩、前置廉价 Pruning 算法**（大降 Token 成本），以及 **Tail 拼接融合与指令隔离墙**，以提高长对话压缩后的模型响应准确度。
2.  **安全防护标配**：
    *   在 Morphz 核心 Loop 中，必须同时部署 **IdleBreaker（防空转断路器）** 与 **Error Classifier Fallback（模型自动切换降级）**。这两者分别针对了“AI 逻辑死循环”和“API 连接物理故障”，能够共同保障智能体 24 小时无人值守运行的安全底线。
