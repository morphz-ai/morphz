# Hermes 智能体运行循环 (Conversation Loop) 与上下文压缩深度剖析

本报告深度剖析 `hermes-agent` 中关于智能体异步执行循环（Conversation Loop）与上下文压缩器（ContextCompressor）的源码实现，展示 Python 异步架构下智能体运行机制的工程细节。

---

## 1. Python 异步协同 Loop (conversation_loop.py)

与 TS 基于事件分发和状态订阅的架构不同，Hermes 在 Python 侧通过一个超大型的、顺序编排的控制函数 `run_conversation` 驱动单次交互。其核心特征在于**状态持久性**、**故障降级机制**以及**请求级中间件拦截**。

```
     [ run_conversation ] ➔ 接收 user_message
              │
              ▼
   [ Preflight 预检压缩 ] ➔ 避免大消息直接请求导致 4xx 崩溃
              │
              ▼
    [ while (api_call_count < max_iterations) ] ➔ 迭代循环
              │
              ├─► [ 组装 api_messages & Anthropic 缓存 Breakpoints ]
              │
              ├─► [ LLM 客户端 API 调用 ] (支持 Backoff 重试与 Fallback)
              │
              ├─► [ _execute_tool_calls ] (并行/串行多线程分发)
              │
              └─► [ 判定是否结束或继续迭代 ]
```

### 1.1 迭代预算控制 (IterationBudget)
在 Loop 启动前，系统初始化 `IterationBudget(agent.max_iterations)`。每一次 LLM 迭代，执行 `consume()` 扣减预算。
*   **优雅调用 (Grace Call)**：如果迭代次数正好耗尽，但上一步执行产生了一个非常关键的 Tool 调用还没有收尾，系统会给予一次宽限期（`agent._budget_grace_call = False`），允许最后执行一轮，防止强行掐断导致状态损坏。

### 1.2 故障自愈与 Fallback 模型降级
当 API 调用失败（如遇到 429 频控、5xx 服务器错误、或 Nous Portal 达到限制）时，Hermes 的重试算法 `while retry_count < max_retries:` 会发挥作用：
*   **模型降级**：捕获错误后，调用 `_try_activate_fallback()`，利用配置文件中定义的 backup provider/model 列表进行平滑切换，重置重试计数器并在此次 loop 中使用备用模型重试，极大地增强了生产环境的鲁棒性。
*   **Alternation 角色修复 (repaired_seq)**：在请求发送前，`_repair_message_sequence` 会强制校验消息角色的“User/Assistant/Tool”交替正确性。如果由于历史消息手动干预或空响应剥离产生了 violation，它会自动补齐空内容或进行角色翻转，从源头上杜绝了 API 端报 400 错。

---

## 2. 增量上下文压缩引擎 (ContextCompressor)

[context_compressor.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/agent/context_compressor.py) 包含着 Hermes 最具工业价值的设计之一。它是针对长对话超出 LLM context 限制时的动态滑动窗口与自适应摘要引擎。

### 2.1 廉价前置裁剪 (Prune Tool Results)
在向 LLM 发起摘要（Compaction）前，如果直接把庞大的历史消息抛给模型，会产生天价的 token 费用。
*   `_prune_old_tool_results` 会在不调用 LLM 的情况下，遍历保护范围外的历史 tool 消息。
*   如果是纯文本或含有巨型 JSON 返回值的 tool 结果，直接用静态占位符 `_PRUNED_TOOL_PLACEHOLDER`（`"[Old tool output cleared to save context space]"`）进行替换；如果是历史图片（如电脑桌面的大图），则通过 `_strip_historical_media` 替换为 `"[screenshot removed to save context]"`。
*   **这步动作能瞬间清除 80% 以上无用的 token 垃圾**，然后再将精炼过的历史提交给 LLM 进行逻辑层面的摘要总结，极大缩减了成本。

### 2.2 滑动窗口保护模型
压缩器通过计算 token，将对话划分为三个区间：
1.  **Head（头部保护区）**：固定保留前 N 条（如 System Prompt + 首次交谈），以保证智能体不会忘记初心（最初的指令目标）。
2.  **Tail（尾部保护区）**：利用 Token 预算（例如留出 20K tokens，由 `_find_tail_cut_by_tokens` 计算）反向框定最近的上下文。这里面包含了正在进行的任务和最新交互，严禁压缩。
3.  **Middle（可压缩区）**：Head 与 Tail 之间的部分。通过一个便宜且快速的辅助模型（Auxiliary Model，如 Claude Haiku 或 GPT-4o-mini）对这部分进行压缩，生成 structured summary（包含“Resolved Question”、“Remaining Work”等结构）。

### 2.3 增量合并与防角色冲突设计
在将 LLM 摘要插入历史队列时，因为 API 强制要求 `User -> Assistant` 的轮流交互，插入一个 `role="user"` 的摘要可能导致角色重复冲突。
*   **拼接融合机制**：如果直接插入 standalone 消息会导致前后角色冲突，算法会放弃插入独立消息，而是**把 summary 作为前缀（merged_prefix），强行追加到 Tail 区间第一条可见消息的 content 最前面**：
    ```python
    msg["content"] = _append_text_to_content(
        msg.get("content"),
        merged_prefix,
        prepend=True,
    )
    ```
    这确保了在不改变消息队列结构的前提下，平滑地把历史摘要传递给 LLM。
*   **防止 LLM 指令错读**：摘要末尾被强行加上了分隔符：
    `"--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---"`
    这解决了弱模型（如 7B/8B 规格）在读到“Remaining Work”时，误以为是用户新发送的指令而去重复跑旧任务的 Bug（#11475）。

---

## 3. 并发工具执行器 (tool_executor.py)

当 LLM 单轮输出多个并行 `tool_calls` 时，Hermes 提供了多线程执行环境 [tool_executor.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/agent/tool_executor.py)。

### 3.1 线程池与并发调度 (ThreadPoolExecutor)
*   **并发分发**：在 `_execute_tool_calls_concurrent` 中，通过 Python 的 `ThreadPoolExecutor(max_workers=8)` 将多个 tool 执行任务分发给不同的工作线程。
*   这允许诸如并发扫描目录、并发拉取网络数据的工具在线程内并行传输，将总体 IO 耗时降低到最高单次 tool 调用时间的量级。

### 3.2 跨线程上下文传递 (ContextVar Propagation)
在 Python 异步/多线程开发中，环境变量和 session 数据（如 write origin、session_id、task_id）通常存储在 Thread Local 或 ContextVar 中。
*   当主线程将任务分发给 ThreadPoolExecutor 时，如果直接运行，子线程将读取不到这些核心上下文变量，导致文件权限判断出错或日志 session 串号。
*   Hermes 通过 `propagate_context_to_thread`，在提交 task 前，将主线程的 ContextVar 镜像一份并绑定到子线程的运行空间，保障了并发多线程执行下的上下文完整与隔离安全性。

---

## 4. 对 Morphz 的架构启示

1.  **廉价前置裁切与分级 Token 压缩**：开发 Morphz 时，上下文压缩绝对不能直接拿原 transcript 去调用 LLM 摘要。一定要分步：先进行 regex/静态替换过滤（把 oversized 的 tool json、base64 screenshots 用占位符剪掉），再将残留物送入低成本 LLM 摘要。
2.  **增量 Hand-off 模板化**：压缩摘要的 Prompt 必须规定为结构化（如 Remaining Work、Active File Mentions），并且必须带有 “END OF CONTEXT SUMMARY” 提示屏障，以阻断小模型的指令混淆。
3.  **多线程 Tool 执行的上下文透传**：如果 Morphz 选用 Python 技术栈，并且支持多工具并发，必须在 `concurrent.futures` 分发时提供 ContextVar 的同步桥（即 propagate 机制），否则会导致子线程的数据库 Session 和 Auth Tokens 全面丢失。
