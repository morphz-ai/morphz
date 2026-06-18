# Hermes Curator 技能自演化与后台审查机制深度剖析

本报告深入解剖 `Hermes` 智能体框架中最具特色的技能自演化系统：**Curator (策展人)** 机制与 **Background Review (后台自我审查)** 链。我们将重点纠正与解答关于“自我审查触发频次与 Token 消耗”的核心疑问，并结合您提出的 **基于 yao-lang DSL 混合的可编程 Skill 构想**，为 `Morphz` 梳理全新的自演化技术落地方案。

---

## 1. 后台自我审查评估链的触发机制与 Token 优化

在 Hermes 架构中，后台审查（Background Review）负责从执行轨迹（Trajectories）中提炼新知识与记忆。

### 1.1 它是每轮对话结束都执行吗？
**答案是否定的。** 每一轮对话（User Turn）结束后，系统**绝不**盲目启动大模型执行自我审查，否则会造成极高且不必要的 API Token 账单与算力开销。

### 1.2 周期性触发的“Nudge（唤醒）机制”
通过走读 `agent/conversation_loop.py`，我们发现后台审查受控于一套极其严密的周期性触发器：

```
                          [ 主交互 Turn 结束 ]
                                   │
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
            [ 检查记忆 Nudge ]            [ 检查技能 Nudge ]
          turns_since_memory++         iters_since_skill += iters
                     │                           │
                     ▼                           ▼
            turns_since_memory           iters_since_skill
                    >=                           >=
          memory_nudge_interval        skill_nudge_interval ?
                     │                           │
                     ├─── [ 只要任一为 True ] ────┤
                     │                           │
                     ▼                           ▼
           [ 触发后台异步线程 spawn_background_review ]
```

1.  **Memory Nudge (记忆唤醒间隔)**：
    *   主交互循环中使用 `_turns_since_memory` 累加经历的对话轮数。
    *   只有当轮数达到配置的 `_memory_nudge_interval`（如 10 轮以上）时，才会将 `_should_review_memory` 设为 `True`，并在当前 turn 结束时触发审查。
2.  **Skill Nudge (技能唤醒间隔)**：
    *   主交互循环中使用 `_iters_since_skill` 计数器。由于一轮对话中 LLM 可能会触发多次 Tool Call 迭代（Tool iteration），计数器会累加这些迭代步骤。
    *   只有迭代步数达到 `_skill_nudge_interval` 时，才会将 `_should_review_skills` 置为 `True`，重置计数器并触发审查。
3.  **异步低成本模型运行**：
    *   当满足上述触发条件时，`spawn_background_review` 将会在后台开启一个异步守护线程（非阻塞，不占用前台用户交互时间）。
    *   执行审查时，后台线程使用**成本低廉、处理速度快的小模型**（如 Claude 3 Haiku / GPT-4o-mini）来替代昂贵的主模型，极大地优化了 Token 资费。

---

## 2. 防自我设限 (Do NOT capture) 的黄金法则

在 AI 自我提炼记忆和技能时，最怕它把**偶然错误**固化为**刻板偏见**（例如，AI 遇到了一次网络超时，就记录了一条记忆“我无法访问网络”，并在随后的会话中反复引用并拒绝网络请求）。

`_COMBINED_REVIEW_PROMPT` 对此设计了极其严密的“负向排除法”，严禁模型捕获以下内容：
1.  **环境依赖性失败**：缺少某个 binary 命令行、未安装包、未配置凭证。这些应当由用户在环境里自愈，AI 绝不能将其归结为永久性的“durable rules”去自我设限。
2.  **对工具的否定性断言**：禁止总结出“浏览器工具坏了”、“无法在 execute_code 中使用 Y”这样的结论，以防在缺陷被修复后，AI 仍以此为由进行“历史拒绝 (Refusal)”。
3.  **单次短暂错误**：如果第 2 次重试成功了，要总结的是重试模式，而不是第 1 次的报错。

---

## 3. 技能代码 AST 安全性审计 (skills_ast_audit.py)

由于 AI 会自动修改或编写 Python 格式的 Skill 脚本，为防止大模型发生幻觉写入了破坏性代码，或者遭到 Prompt 注入而在生成的技能中藏入恶意代码（例如，悄悄使用 `importlib` 加载高危模块），Hermes 引入了 [skills_ast_audit.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/skills_ast_audit.py) 做编译前 AST（抽象语法树）级静态审查。

*   **实现原理**：通过 Python 的 `ast.parse(content)` 模块，将 AI 生成的代码文件转换成抽象语法树。
*   **NodeVisitor 访问器拦截**：
    *   **拦截 Call 节点**：一旦检测到代码调用了 `importlib.import_module`（动态加载）、`__import__`、或者 `getattr(obj, computed_name)`（使用非字面量的计算字符串进行动态属性获取），直接标记为高危 dynamic_import。
    *   **拦截 Subscript 节点**：防止 AI 试图通过 `__dict__[computed]` 逃过属性反射校验来篡改属性。
    *   **拦截 Import 节点**：一旦检测到 AI 导入了 `importlib` 等高危包，立刻触发安全预警。

---

## 4. 给 Morphz 的自演化体系设计建议：自然语言 + yao-lang DSL 混合 Skill 架构

在构建 `Morphz` 时，我们摒弃了纯 Python 或 Go-plugin 的设计，转而围绕您提出的 **基于 yao-lang DSL 混合的可编程 Skill 构想**（参考 [yao-lang 源码](file:///Users/shafreeck/Codes/yao/yao-lang)），规划一套跨平台的自演化技能体系。

根据对 `yao-lang` 项目结构（内含编译器、AST 定义与 VM 虚拟机）的分析，我们在 Morphz 中的自演化和安全方案推荐如下：

### 4.1 yao-lang + WASM 隔离：安全沙箱的降维打击
*   **痛点**：传统智能体执行动态生成的 Python 代码时，要么完全依赖沉重的 Docker 容器隔离，要么依靠脆弱的宿主进程限制。
*   **Morphz 方案**：
    *   大模型在提炼新技能时，编写包含自然语言说明与 **yao-lang DSL 代码** 混合的 Skill 规范。
    *   Morphz 的编译器将 `yao-lang` 代码编译成标准的 **WebAssembly (WASM)** 字节码（例如 `test.wasm`）。
    *   运行时将 WASM 扔进内置的 `yao-vm` 或 WASM 沙箱中运行。
    *   **安全优势**：WASM 具有天然的、极其轻量级的硬件级沙箱隔离，它无法越权访问宿主机的进程空间、文件系统和敏感系统 API，**从根本上消除了 Docker 挂载的沉重成本，并对 Python AST 白盒审计形成了安全性的降维打击**。

### 4.2 基于 yao-ast 语法树的编译前白盒审计
在 yao-lang 代码被编译为 WASM 之前，Morphz 可以直接在 `yao-compiler` 的前端解析器处实施白盒静态代码审计：
1.  **yao-parser 语义分析**：通过 `yao-lexer` 和 `yao-parser` 构造出 `yao-ast`。
2.  **静态规则过滤**：
    *   检测 AST 树中是否存在未经显式声明的外部环境绑定调用（FFI 导入）。
    *   禁止动态构造和执行包含网络包收发、本地敏感路径读写等破坏性的闭包（Closure）指令。
    *   由于 yao-lang 拥有自己清晰控制的 AST 节点定义，这种审计非常高效且 100% 可控。

### 4.3 周期性提炼与防自我设限
*   **低频触发**：参考 Hermes 的 nudge 机制，在 Morphz 中同样加入基于 turns（对话轮数）和 iters（工具调用次数）累加的计数器。只有处于闲置时段才在后台拉起低成本、轻量级小模型的异步协程去执行提炼，杜绝前台交互卡顿与 Token 账单失控。
*   **混合 Skill 生成**：大模型不需要生成庞杂的底层代码，只需用 yao-lang 描述工作流逻辑的核心 DSL（如状态转移、数据过滤、并发配置），用自然语言描述工作流的前提条件与陷阱约束。
