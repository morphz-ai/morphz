# 交互设计与自演变架构对比及 Morphz 设计方案

本报告深入对比 `openclaw` 的 Canvas 动态画布与 `hermes` 的文本/静态 Dashboard 机制，并基于用户提出的 **“yao-lang DSL 混合 Skill”** 和 **“三层记忆架构 (EventHistory ➔ GraphMemory ➔ Context)”**，设计下一代智能体 `Morphz` 的核心交互与自愈执行环境。

---

## 1. OpenClaw 与 Hermes 交互设计对比

### 1.1 OpenClaw 的 Canvas 画布与 A2UI 机制
*   **交互形态**：支持双向的富客户端（A2UI）模式。Agent 不仅能输出文字，还能生成 UI 组件树，并在专用的 Canvas 区渲染，实现交互图表、按钮、输入框的实时投送。
*   **通信管道**：利用本地 HTTP + WebSocket 负责静态资源分发和热加载（Live Reload），WebView Bridge 传递点击和输入事件，实现 Native 与 Web 的无缝互通。
*   **局限**：对前端技术栈有强依赖（目前使用 Lit / Web Components），且需要定义繁复的组件协议。

### 1.2 Hermes 的文本终端与静态 Dashboard 机制
*   **交互形态**：以命令行和聊天气泡为主，偶尔在插件中提供静态 HTML 的 Dashboard 展示，无法实现模型在执行过程中对界面的动态操控。
*   **流式 Scrubber 的真实用途**：
    *   在 Hermes 源码中，`StreamingContextScrubber` 被用于对大模型最终输出流（LLM Response Stream）的清洗。
    *   **解答关于“信道隔离”的疑问**：正如您所虑，Hermes 确实在后端构造 Prompt 时组装 Context，前端也只订阅最终的 `ResponseStream`。而之所以在最外层加这一层状态机清洗，核心是为了**防范 LLM 最终生成流中的幻觉复读**。由于在 Prompt 中携带了 `<memory-context>` 私有 XML 标签，LLM 有概率因为注意力权重导致在最终的回复中把这些私有标签或内部背景数据直接“复读”并吐出。因此，这是为大模型回复流做的一层 Anti-Echo 安全防线。

---

## 2. Morphz 架构设计：三层记忆与可编程 DSL 技能沙箱

结合两者的长处和您的理念构想，我们为 `Morphz` 提出如下核心架构方案。

### 2.1 三层解耦记忆系统设计 (EventHistory ➔ GraphMemory ➔ Context)

在 Morphz 中，我们不将记忆粗暴地硬编码在 System Prompt 中，而是通过以下三层架构来保证缓存高命中率与语义联想的平衡：

1.  **EventHistory（事件日志层）**：
    *   **职责**：Append-Only 的日志库，记录智能体和客观世界的一切行为（Chat 消息、API 调用、系统状态变更、报错等）。
    *   **实现**：采用本地 SQLite (启用 WAL 模式) 异步持久化，确保多会话并发下数据写入的隔离与不锁死。
2.  **GraphMemory（图谱记忆层）**：
    *   **职责**：通过后台 `Curator` 协程，在系统闲置时读取 `EventHistory`。使用较小、廉价的大模型提取实体（Entity）与关系（Relation）构建成知识图谱。
    *   **提炼逻辑**：通过共现权重机制与遗忘曲线对图谱关系进行剪枝。
        *   边权重更新：$W_{new} = W_{old} + \alpha$
        *   遗忘衰减模型：$W_{new} = W_{old} \times e^{-\lambda \Delta t}$
        *   当 $W$ 低于阈值 $\theta$ 时自动剔除。
3.  **Context（上下文装配层）**：
    *   **职责**：在前台发送请求给主模型前，检索并精简内容，组装成 Prefix-Cache 友好的 Prompt。
    *   **实现**：将图谱召回记忆以独立 Context 块作为 User Message 的最前端或者单独 Message 传入，维持主 System Prompt 字符级别的绝对不变，保证 100% 缓存命中。

### 2.2 基于 yao-lang 与 WASM 的可编程 Skill 机制
为了实现无需容器化即可达到的完美沙箱，Morphz 将与您开发的 `yao-lang`（类 Lisp 中文 DSL）深度结合：

```
+-------------------------------------------------------------+
|                        Morphz 宿主                          |
|  +-----------------+  (Compile)  +-----------------------+  |
|  | yao-lang 源码   | -----------> | WASM 字节码 (.wasm)    |  |
|  +-----------------+             +-----------------------+  |
|          |                                   | (Run)        |
|     (yao-parser)                             v              |
|          v                       +-----------------------+  |
|      AST 静态审计                 |   WASM 沙箱虚拟机     |  |
| (拦截 FFI/非法 syscall)          | (无 syscall, 内存隔离)|  |
|                                  +-----------------------+  |
+----------------------------------------------|--------------+
                                               v (Render)
                                       [ Canvas 交互画布 ]
```

*   **自然语言 + DSL 混合 Skill**：
    *   AI 提炼和自动优化的技能，不再是高风险的 Python 脚本，而是格式化好的 `yao-lang`（类 Lisp 中文 DSL）源码段。例如：
        ```lisp
        (行
          (引 "data_tool")
          ;; 定义数据清理过程
          (定 处理数据
            (函数 (输入数据)
              (行
                (定 干净数据 (过滤符号 输入数据))
                (返回 (转换为JSON 干净数据)))))
        )
        ```
*   **WASM 极速沙箱运行**：
    *   使用 `yao-compiler` 将 `yao-lang` 代码编译成标准的 `.wasm` 文件。
    *   宿主直接运行内置的 WASM 虚拟机（如在 Go 下使用 `Wasmtime`，在 Rust 下使用 `Wasmer`）加载运行。
    *   由于 WASM 沙箱在进程内运行且默认隔离了系统 API，它拥有微秒级的启动速度，且无需依赖复杂的 Docker 容器就能提供绝对安全的执行屏障。
*   **AST 白盒静态审计**：
    *   在编译前，Morphz 自动读取 `yao-lang` 源码，使用 `yao-parser` 生成抽象语法树（AST），静态检测其引用的外部函数（FFI）是否安全，从双重维度守住安全防线。
*   **向 Canvas 输出 UI 指令**：
    *   `yao-lang` 的执行结果可动态生成标准的 A2UI 指令，通过 Local WebSocket 推送给前端交互画布，实现交互式前端组件的安全渲染。
