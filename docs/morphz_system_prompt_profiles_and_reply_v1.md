# Morphz 三版本 System Prompt 与显式 Reply 协议 v1

日期：2026-07-13
Context Protocol：v11
状态：已进入生产 Runtime；`semantic_sexpr_vm` 为默认候选，旧两版保留回归入口

## 1. 设计结论

Morphz 将 System Prompt 分为三个可选择的版本，但三者共享完全相同的 Runtime、Context Encoding、物理工具、`context_tx` DSL 和标准 Reply 协议：

| `MORPHZ_SYSTEM_PROMPT_MODE` | 定位 | Prompt 结构 |
|---|---|---|
| `agent_owned_context` | 最初的 Agent-Owned Context 基线 | 自然语言 AI Agent 身份与执行规则 |
| `cognitive_sexpr_vm` | 第二版认知 VM 身份 | 外部自然语言定义 Cognitive S-Expression Machine，再复用公共执行规则 |
| `semantic_sexpr_vm` | 第三版语义 SExpr VM，当前默认 | 整个稳定 System Prompt 是一个 SExpr；算子节点内部使用自然语言定义语义 |

这三个版本比较的是模型如何理解身份、Context 和求值过程，而不是比较不同的工具或终止机制。标准 `reply` Function Calling 是通用 Runtime 原语，不属于第三版 Prompt 私有能力。

未设置环境变量时使用：

```shell
MORPHZ_SYSTEM_PROMPT_MODE=semantic_sexpr_vm
```

旧版本仍可直接选择：

```shell
MORPHZ_SYSTEM_PROMPT_MODE=cognitive_sexpr_vm
MORPHZ_SYSTEM_PROMPT_MODE=agent_owned_context
```

## 2. 冻结的最小语义指令集

当前只冻结六个基础算子，不继续扩张语法面：

### `seq`

形式：`(seq step...)`

从左到右求值每个步骤。若后续步骤依赖真实工具结果，必须等待 Observation 返回后继续；正常完成时返回最后一个步骤的值。

### `call`

形式：`(call tool argument...)`

通过标准 Function Calling 发起真实工具调用。参数必须服从工具的标准 JSON schema；工具结果是权威的当前 Observation，而不是供模型模拟的文本。

### `fallback`

形式：`(fallback primary backup)`

先求值主路径。主路径成功时禁止执行备用路径；只有主路径明确失败时才求值备用路径。

### `bind`

形式：`(bind name expression)`

先完整求值表达式，再把精确结果绑定到局部名称。`name` 引用完整结果，`name.field` 引用字段；不得在结果出现前猜值，也不得让不同命名过程调用的局部绑定互相污染。

### `if`

形式：`(if condition when-true when-false)`

先基于真实绑定值判断条件，只求值一个分支。未选分支不得产生工具调用、绑定或 Reply。

### `reply`

语义形式：

```lisp
(reply content)
(reply no-reply)
```

`reply` 是求值终态，但物理执行统一映射到标准 Function Calling，见下一节。

`process` 属于声明层：它定义可复用的命名过程、参数、局部作用域和返回值，不作为第七个基础算子。

## 3. 通用 Reply Runtime 协议

single Session 求值始终暴露一个标准 `reply` 工具：

```json
{"disposition":"deliver","content":"交付给当前 Session 的消息"}
{"disposition":"suppress"}
```

规则如下：

1. `deliver` 必须提供非空 `content`，Runtime 将其发布为 `chat/reply`；
2. `suppress` 明确结束当前求值，但不向 Session 投递消息；Runtime 只记录 `chat/reply_suppressed` 审计事件；
3. `reply` 必须是终态响应中唯一的工具调用，不能与物理工具或 `context_tx` 混合；
4. 带物理工具但不带 `reply` 的响应是合法中间状态，工具执行后继续循环；
5. 普通文本或空响应都不是终态；Runtime 返回紧凑协议错误，要求继续未完成过程并调用 `reply`；
6. Runtime 允许两次纠错；第三次仍不合法时发布 `runtime/reply_protocol_fused` 并安全熔断，防止无响应循环；
7. Reply 纠错是模型请求，会记录 `runtime/model_attempt_started` 和 `runtime/reply_protocol_error`，但终态 `reply` 本身不消耗物理工作 Attempt；
8. `phase=context-closure` 只暴露 `context_tx + reply`；`phase=final-reply` 只暴露 `reply`。

`suppress` 是一个可观测决定，不等于模型什么都没有返回。对于被委派的子 Session，`suppress` 仍会确定性结束子任务并向父级产生空结果状态，避免委派永久悬挂；它不会向外部 Session 伪造一条可见文本。

batch 合并求值仍使用带明确 `session_id` 的 `session_output`，因为一次模型响应可能同时覆盖多个 Session。遗漏的 Session 会降级到 single 求值，并使用上述标准 `reply`。

## 4. 第三版 Prompt 的结构

第三版的稳定 System Prompt 从第一个字符到最后一个字符都是一棵 SExpr，大体结构为：

```lisp
(system-prompt morphz
  (vm morphz
    (identity ...)
    (evaluation ...)
    (declarations (process ...))
    (operators
      (operator seq ...)
      (operator call ...)
      (operator fallback ...)
      (operator bind ...)
      (operator if ...)
      (operator reply ...)))

  (architecture
    (section (index 1) (description "..."))
    ...)

  (runtime-guidance
    (section (index 1) (description "..."))
    ...)

  (runtime-contracts
    (reality-contract ...)
    (epistemic-contract ...)))
```

自然语言没有被删除，而是作为算子、身份、架构、规则和契约节点的语义体存在。这样既保留模型擅长的自然语言理解，又用 SExpr 明确模块边界、作用域和逻辑角色。

动态阶段指令也不会破坏这个性质。第三版在 final、closure 或 batch 时实际发送：

```lisp
(system-evaluation
  (system-prompt morphz ...)
  (runtime-directive
    (kind final-reply)
    (description "...")))
```

因此第三版不存在“稳定前缀是 SExpr，但末尾又拼接外部自然语言”的隐性退化。稳定主体仍位于前缀，便于模型服务利用 prefix cache。

## 5. 为什么保留三个版本

三个版本分别保留了设计演进中的三个可验证基线：

- 第一版验证 Agent 自主管理 Context 的基本思想；
- 第二版验证把 LLM 定义为持续运行的认知 VM 不会退化；
- 第三版验证 SExpr 不仅承载 Context，也能承载 VM 身份、算子语义和执行规则。

旧版本不能只保留在文档中。可运行的 profile 才能在模型升级、任务族变化或第三版出现退化时做真实回归。三版共享 Reply Runtime 后，比较结果不会再被“纯文本终止与工具终止不同”混淆。

## 6. 当前证据与边界

支持第三版的直接证据来自两轮 Gemini 真实测试：

- 五组消融中，SExpr 内自然语言算子描述没有退化，并在过程复用上表现出更清楚的结构边界；
- 显式 Reply 双组正式回归中，第三版核心 Kernel 25/25 干净成功，外部自然语言 VM 为 23/25 干净、25/25 结果成功；旧 `module-reuse` 空回复失败场景 10/10 干净通过。

详见：

- [语义 SExpr VM 五组对照结果](./morphz_semantic_sexpr_vm_ablation_results_v1.md)
- [显式 Reply 决策双组回归结果](./morphz_explicit_reply_ab_results_v1.md)

这些结果足以支持把 `semantic_sexpr_vm` 设为当前默认候选，但还不足以证明 SExpr 对所有模型、所有任务深度和所有自然语言都更优。三个可切换 Profile 正是为持续验证这一边界而保留。

## 7. 实现位置

- 三版本选择、第三版 Prompt 编排与 Reply 状态机：`morphz/src/orchestrator/orchestrator.rs`
- 六算子共享 Kernel：`morphz/src/sexpr_vm_contract.rs`
- Reality/Epistemic 契约的自然语言与 SExpr 双渲染：`morphz/src/orchestrator/context_contract.rs`
- Context Protocol v11 自描述：`morphz/src/orchestrator/context.rs`
- Runtime 回归：`morphz/tests/attempt_loop.rs`

## 8. 生产链路真实冒烟

2026-07-13 使用 `gemini-3-flash-agent` 对三个 Profile 分别启动独立 Morphz Runtime，要求只交付一个固定文本且不调用物理工具：

| Profile | 交付文本 | 标准 `reply(deliver)` | 协议纠错 | 物理工具 |
|---|---|---:|---:|---:|
| `semantic_sexpr_vm` | `SEMANTIC-VM-READY` | 1 | 0 | 0 |
| `cognitive_sexpr_vm` | `COGNITIVE-PROMPT-REPLY-OK` | 1 | 0 | 0 |
| `agent_owned_context` | `AGENT-PROMPT-REPLY-OK` | 1 | 0 | 0 |

三次 Ledger 中的 `chat/assistant_call` 都记录了 `terminal_reply=true`、`reply_disposition=deliver` 和标准 reply Function Calling，随后才由 Runtime 发布 `chat/reply`。因此可确认旧两版与第三版使用的是同一个物理终止协议。

## 9. 旧长程基准回归

2026-07-13 使用 `gemini-3-flash-agent`、Context Protocol v11 和默认
`semantic_sexpr_vm`，重新运行未修改任务内容的 `Autonomous Transfer v1` 六阶段基准。
这个场景同时覆盖证据审查、策略抽象、正迁移、反例修订、Mind 持久化和进程重启恢复。

| 指标 | 本次单样本结果 |
|---|---:|
| 外部状态通过 | 6/6 |
| 活动 Mind 通过 | 6/6 |
| 行为约束通过 | 6/6 |
| 语义通过 | 6/6 |
| Reply 通过 | 5/6 |
| 严格通过 | 5/6 |
| 重启恢复 | 通过 |
| 模型请求 | 17 |
| 物理工具 | 14 |
| Context commit | 5 |
| standalone Context transaction | 2 |
| 重复物理调用 / 同路径重读 / Read guard | 0 / 0 / 0 |
| Reply 协议纠错 | 0 |

唯一严格扣分发生在第二阶段：模型正确创建并保护了
`EVIDENCE-AUTHORITY-BEFORE-RECENCY`，活动 Mind 也保留了 `ALPHA-17`，但交付给用户的策略说明没有再次逐字写出 `ALPHA-17`。这是回复完整性扣分，不是状态、推理或持久化失败。

旧 Gemini v8 五样本的同场景聚合为语义 30/30、Reply 27/30、平均 19.0 次模型请求和
14.6 个物理工具，只有 2/5 样本整轮严格全通过。因此本次 6/6 语义、5/6 严格、17/14
处于旧基线的正常区间，并没有显示换成完整 SExpr System Prompt 后发生能力退化。单次样本只能用于回归门，不能据此宣称效率提升。

第一次试跑还暴露了两项旧评测器兼容问题，因此被标记为无效诊断样本：评分器仍把
`session_id` 当作 `context_id` 读取 Mind，并把新的 Runtime `reply` 算作物理工具。评测器现已按
Session 的真实挂载解析 Context，同时排除 `context_tx/reply/session_output` 三种 Runtime 控制工具；对应自动化回归已补齐。有效原始报告保存在：

`/private/tmp/morphz-semantic-vm-transfer-regression-valid/autonomous_transfer_v1-20260713T083323.698Z-68126/run_report.json`
