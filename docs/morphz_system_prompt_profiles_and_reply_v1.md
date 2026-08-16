# Morphz 三版本 System Prompt 与历史显式 Reply 实验 v1

日期：2026-07-13
Context Protocol：v11
状态：三个 Prompt Profile 仍可运行；本文的 `reply(deliver/suppress)` Function Calling 已于 Protocol v16 被普通文本、`no_reply` 和 `send_message` 取代。当前协议见 [单 Session 求值与响应路由协议 v1](./morphz_response_routing_protocol_v1.md)。

> 术语说明：`cognitive_sexpr_vm` 与 `semantic_sexpr_vm` 是需要保持兼容的历史 Profile ID，不是当前产品名称。Morphz 的统一公开身份是 **S-Expression Cognitive Machine（S 表达式认知机）**；LLM 是其中的非确定性语义处理器，Runtime 是确定性事务内核。下文涉及旧 Profile 的词句按历史配置说明保留。

## 1. 设计结论

Morphz 将 System Prompt 分为三个可选择的版本，三者共享完全相同的 Runtime、Context Encoding、物理工具、`context_tx` DSL 和当前响应协议：

| `MORPHZ_SYSTEM_PROMPT_MODE` | 定位 | Prompt 结构 |
|---|---|---|
| `agent_owned_context` | 第一版 Context 所有权行为，兼容保留 | 使用统一认知机身份的自然语言执行规则；旧 AI Agent 原文仅保留在历史实验记录中 |
| `cognitive_sexpr_vm` | 第二版历史认知 VM 身份 | 当时的外部自然语言前言定义机器身份，再复用公共执行规则 |
| `semantic_sexpr_vm` | 第三版 SExpr Prompt，当前默认 | 整个稳定 System Prompt 是一个 SExpr；当前内容统一定义 S 表达式认知机、语义处理器与事务内核 |

这三个版本比较的是模型如何理解身份、Context 和求值过程，而不是比较不同的工具或终止机制。SExpr 的 `(reply content)` 是普通文本回复的语义算子，不是 Function Calling 工具。

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
```

`reply` 把 content 作为无工具普通 assistant 文本返回当前 active Session。`(reply content)`
只是过程定义中的语义记法，不是模型响应的输出格式：对它求值时必须直接输出 content
本身，不能把 `(reply ...)` 包装或代码围栏发送给 Session。明确静默时使用 Runtime 的
`no_reply` 工具。

`process` 属于声明层：它定义可复用的命名过程、参数、局部作用域和返回值，不作为第七个基础算子。

## 3. 当前通用 Response Runtime 协议

每次求值只有一个 active Session：

规则如下：

1. 无工具非空普通文本发布为当前 active Session 的 `chat/reply`；
2. `no_reply` 独占调用表示显式静默，并记录 `chat/no_reply`；
3. `send_message` 向同一 Agent 的另一 Session 发送消息，但不结束当前 Evaluation；
4. 带物理工具或 `context_tx` 的响应是中间状态，工具执行后继续循环；
5. 空响应、`no_reply` 携带正文或与其他工具混用都是协议错误；
6. Runtime 允许两次纠错；第三次仍不合法时发布 `runtime/response_protocol_fused` 并安全熔断；
7. 每个请求只求值一个 active Session，不存在 batch 合并回复。

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

三次 Event History 中的 `chat/assistant_call` 都记录了 `terminal_reply=true`、`reply_disposition=deliver` 和标准 reply Function Calling，随后才由 Runtime 发布 `chat/reply`。因此可确认旧两版与第三版使用的是同一个物理终止协议。

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
Session 的真实挂载解析 Context；当时的评测器排除了 v11 的 Runtime 控制工具。当前评测应只把 `context_tx/no_reply` 视为控制调用，并把 `send_message` 计为真实跨 Session IO。对应自动化回归已补齐。有效原始报告保存在：

`/private/tmp/morphz-semantic-vm-transfer-regression-valid/autonomous_transfer_v1-20260713T083323.698Z-68126/run_report.json`
