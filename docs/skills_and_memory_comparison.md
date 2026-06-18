# openclaw 与 Hermes 记忆系统与技能自演化对比报告

本报告对比 `openclaw` 与 `Hermes` 两个开源项目的记忆沉淀（Memory）与技能管理（Skills）体系，解答关于“流式信道过滤原理”与“审查频次”的核心设计疑问，并围绕您的 **EventHistory ➔ GraphMemory ➔ Context 三层记忆构想** 与 **基于 yao-lang DSL 混合的可编程 Skill 构想**，为构建可自演进的 `Morphz` 智能体框架提供具体的落地架构指南。

---

## 1. 记忆与技能演化对比矩阵

| 对比维度 | OpenClaw (TypeScript) | Hermes (Python) | Morphz (设计规划) |
| :--- | :--- | :--- | :--- |
| **记忆体系架构** | 静态扫描 `MEMORY.md` 包装进 System Prompt | `MemoryManager` 周期托管，Prefetch 语义召回至 Context，后台 Sync 沉淀 | **三层解耦记忆**：只读 EventHistory ➔ 异步提炼 GraphMemory ➔ 动态求值 Context |
| **KV 缓存稳定策略** | 无，中途写入直接修改 System Prompt，导致 Prefix Cache 击穿 | **冷热双层缓存**：冻结 System Prompt，中途 Live 写入仅通过 Tool 增量读取 | **冷热双轨物理隔离**：System Prompt 保持静态，召回记忆以增量 Context 信道按需注入 |
| **流式信息泄露防线** | 无专门流式记忆隐藏，常公开显示 | `StreamingContextScrubber` 流状态机，过滤 LLM 回复流中复读出的敏感标签及 Prefill 数据 | **信道物理解耦 + 标签防复读过滤器**：Chat 流与内部 Trace 流完全解耦；过滤器用于兜底 LLM 的标签幻觉复读 |
| **技能库演化机制** | 静态目录组织，完全依赖人工在外部用编辑器手工修改 | **Curator (策展人)** + **Background Review** 异步提炼并语义归并 Python 技能文件 | **Curator 协程 + 混合 Skill 架构**：后台提炼自然语言与 yao-lang DSL 混合的可编程技能包 |
| **技能运行安全沙箱** | 依赖 Docker/SSH 外部黑盒沙箱（沉重且慢） | **skills_ast_audit** 利用 `ast.parse` 白盒静态检测 Python 注入 | **轻量级 WASM 沙箱**：yao-lang 编译为 WebAssembly 运行于 WASM 虚拟沙箱，安全隔离且极其轻量 |

---

## 2. 深度设计疑问解答

### 2.1 为什么 Hermes 需要流式 Scrubber？后端不应该是直接隔离 Context 的吗？
您的直觉非常深刻。事实上，Hermes 的后端**确实**是在发送给 LLM 请求前才进行 Context 组装，并且前端**确实**只订阅了 `ResponseStream`。那为什么大模型吐出的 ResponseStream 中还会带出 `<memory-context>` 呢？

通过走读测试用例 `test_streaming_context_scrubber.py` 和 agent 执行流，我们发现这源于大模型自身的局限性：
1.  **大模型的“幻觉复读”（Echoing & Hallucination）**：
    被召回的记忆被包裹在 `<memory-context>` 中放入了 prompt。某些大模型（如 Claude 或早期本地模型）在遵循少样本指示生成回复时，会因为注意力偏置，直接在最终的回复流中把这些系统私有标签复读吐出来（例如吐出：“*根据您记忆里提到的 `<memory-context> 用户不喜欢喝茶 </memory-context>`，我建议你……*”）。
2.  **引导填充泄露（System Prefill Leaking）**：
    Hermes 使用了 Prefill (前置填充引导) 技术。在流式输出中，有些 API 提供商会将 Prompt 尾部或引导 Context 的分包一并回吐到 Response Stream。
*   **结论**：`StreamingContextScrubber` 并不是后端发给前端的 Context 转发流的过滤器，而是**对大模型最终输出流（LLM Response Stream）的拦截清洗器**。它是为了防止大模型自己“把内部 Context 和私有控制标签复读吐给用户”而设计的安全过滤器。

> [!TIP]
> ### 🏆 Morphz 的安全信道与过滤方案
> *   **物理隔离**：前端只订阅 `ChatResponseStream`，后端绝对不将 Context 直接转发给前端。
> *   **防复读过滤器（Anti-Echo Scrubber）**：在后端向前端转交 LLM Response 字节流时，依旧保留一个轻量级过滤器，防止 LLM 由于注意力权重产生“标签幻觉复读”，确保用户体验的纯净性。

---

## 3. Morphz 自演化成长体系架构指南 (自然语言 + yao-lang DSL)

基于您的构想，技能不需要局限于 Python 或编译 Go 插件。我们将采用 **自然语言（前提/避坑说明） + yao-lang DSL（逻辑控制流）混合的可编程 Skill**，并引入 **WASM 虚拟沙箱**，这不仅与 Morphz 的核心开发语言（Rust 或 Go）解耦，更在安全性和性能上实现了重大跃升。

### 3.1 混合可编程 Skill 的定义与结构
每个 Skill 文件（例如 `SKILL.md`）包含两部分：
1.  **自然语言文档 (Markdown)**：描述技能的适用场景（Usage Scenario）、前置约束条件、执行步骤（User Guidelines）以及历史避坑提示（Pitfalls）。这部分直接供大模型在 Context 求值时检索与阅读。
2.  **可编程 DSL 代码块**：以 `yao-lang` 类 Lisp 的中文 S-expression 语法编写的核心计算逻辑（如数据管道、循环处理、条件重试、状态合并）。
    ```yao
    (行
      (引 "data_tool")
      
      ;; 定义清理与 JSON 转换过程
      (定 处理数据
        (函数 (输入数据)
          (行
            (定 干净数据 (过滤符号 输入数据))
            (返回 (转换为JSON 干净数据)))))
    )
    ```

### 3.2 yao-lang ➔ WASM 沙箱的运行与审计闭环

```
        [ AI 生成的 yao-lang DSL 技能 ]
                      │
                      ▼
        [ yao-lexer & yao-parser 语法分析 ]
                      │
         ┌────────────┴────────────┐
         ▼ (AST 树静态审计)          ▼ (编译字节码)
    [ 检查 yao-ast 语义限制 ]   [ yao-compiler 编译 ]
    • 严禁高危外部绑定(FFI)              │
    • 限制敏感系统 API 访问               ▼
                                 [ result.wasm ]
                                        │
                                        ▼
                           [ yao-vm WASM 虚拟沙箱 ]
                           • 轻量、高效、硬件级安全隔离
```

1.  **静态语法审计 (yao-ast)**：
    *   在编译前，调用 `yao-parser` 构造出 `yao-ast`。
    *   通过遍历 AST 树，静态检测代码中是否存在未授权的外部环境绑定调用（FFI 导入）或危险的动态反射。由于 yao-lang 的编译器是可控的，我们可以从 AST 层面绝对保证其安全。
2.  **编译为 WebAssembly**：
    *   通过编译管线将 `yao-lang` 代码编译为标准轻量级的 `.wasm` 字节码。
3.  **运行在 WASM 虚拟机 (yao-vm) 中**：
    *   当 Agent 需要执行此技能时，直接加载 `.wasm` 并在 Morphz 内置的 WASM 虚拟机（如 `wasmtime` 或者是 `wasmer` 运行库）中运行。
    *   **安全防御的降维打击**：WASM 具有天然的沙箱隔离。它没有任何系统调用（syscall）权限，不能读写宿主机文件，不能发送网络包（除非主程序显式向其注入受控 API 句柄）。这彻底摆脱了起重型 Docker 容器的耗时和开销，兼具白盒静态审计的安全和黑盒沙箱的隔离。

### 3.3 EventHistory ➔ GraphMemory ➔ Context 提炼架构的实现
根据三层记忆设计，无论 Morphz 基于 Go 还是 Rust 实现，我们建议：
1.  **EventHistory (SQLite + WAL)**：
    *   使用 SQLite 并开启 WAL 模式存储 Append-only 事件流。使用异步管道写入，防止阻塞主会话。
2.  **GraphMemory (轻量关联图谱)**：
    *   由后台 `Curator` 协程/线程在闲置（Idle）时段异步唤醒提炼。
    *   **周期触发器（Turns & Iters Nudge）**：引入 `TurnsSinceMemory` 和 `ItersSinceSkill`。每次 turn 结束后，只有计数器达到 nudge_interval 时，才在后台调用 Haiku/GPT-4o-mini 等超廉价模型进行图提取与关联更新。
    *   **遗忘衰减模型**：未被激活的关系在每个提炼周期按照遗忘曲线进行折旧 $W = W \times e^{-\lambda \Delta t}$，权重过低则剔除。
3.  **Context (Prefix Cache 友好召回)**：
    *   大模型发送请求时，通过时序事件 + 图语义双路召回 Context，将其作为独立的 User Message 段插入历史最前端，保持核心 System Prompt 绝对静态（100% 缓存命中）。
