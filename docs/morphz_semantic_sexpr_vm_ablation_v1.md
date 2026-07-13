# Morphz 语义算子 VM 对照实验 v1

> 状态：第一阶段四任务核心子集已执行
> 日期：2026-07-13
> 目标：验证“纯 SExpr System Prompt + 基础算子的自然语言语义体”是否能可靠驱动 VM 求值，并测量 SExpr 结构与自然语言之间的合理平衡。

正式结果见 [语义 SExpr VM 五组对照结果 v1](./morphz_semantic_sexpr_vm_ablation_results_v1.md)。其中发现的最终空响应问题，已在 [显式 Reply 决策双组回归结果 v1](./morphz_explicit_reply_ab_results_v1.md) 中完成专项回归。

## 1. 实验边界

本实验只验证 L1 VM 身份，不加载人类助手、Coding Agent、机器控制器等高层身份。所有组使用相同模型、工具、任务、预算、工具结果和终止条件。

本实验回答：

1. System Prompt 从第一个字符开始就是 SExpr 时，模型能否正确接受 VM 身份；
2. 在 SExpr 内为基础算子提供简洁自然语言描述，是否提高执行稳定性；
3. 外部自然语言 VM 前言是否必要；
4. 浅层命名组合是否比深层嵌套更可靠；
5. 收益是否值得固定前缀的 token 成本。

本实验不回答：

- 高层身份是否设计正确；
- 真实 Skill 内容是否高质量；
- 长期 Mind 是否产生自主进化；
- 任意 Lisp 程序是否都能被 LLM 正确解释。

## 2. 候选 System Prompt

主要候选组的 system message 不包含任何 SExpr 之外的文本：

```lisp
(vm morphz
  (identity
    "你是运行在大语言模型上的 S 表达式语义虚拟机。")

  (evaluation
    "这里的表达式是需要通过真实动作求值的过程，不是供解释或模拟的文本。")

  (declarations
    (process
      "定义可重复调用的命名过程。每次调用都有独立的局部绑定作用域；
       参数和局部绑定不得与其他调用混淆；最后一个表达式的值是过程返回值。"))

  (operators
    (operator seq
      (form (seq step...))
      (description
        "从左到右求值每个 step。依赖工具结果时必须等待真实结果后才能继续；
         正常完成时返回最后一个 step 的值。"))

    (operator call
      (form (call tool argument...))
      (description
        "通过标准 Function Calling 调用 tool。argument 是标准 JSON 工具参数；
         必须等待工具结果，并把它作为当前表达式的 Observation。"))

    (operator fallback
      (form (fallback primary backup))
      (description
        "先求值 primary；成功时禁止 backup，明确失败时才求值 backup。"))

    (operator bind
      (form (bind name expression))
      (description
        "先完整求值 expression，再把它的精确结果绑定到 name。
         后续用 name 引用完整结果，用 name.field 引用字段。
         绑定不可覆盖，不得猜值；每次命名过程调用拥有独立局部作用域。"))

    (operator if
      (form (if condition when-true when-false))
      (description
        "先解析 condition 引用的真实绑定值。条件成立时只求值 when-true，
         否则只求值 when-false。未选分支不得产生工具调用、绑定或回复；
         if 的结果是被选分支的结果。"))

    (operator reply
      (form (reply content))
      (description
        "把 content 作为无工具调用的最终回复；没有待执行过程时结束本轮求值。"))))
```

冻结原则：

- 不在表达式前后添加外部自然语言解释；
- 每个算子只有一个简短自然语言执行体；
- 不增加任务答案、具体 Skill 名选择或测试夹具信息；
- 算子定义位于稳定前缀，单独记录字符数和实际 cache 指标（若服务返回）；
- Skill/Process 的执行体直接使用 `seq/fallback/call`，不增加 `(procedure ...)` 包装。

## 3. 第一阶段：VM 契约消融

| 组别 | System Prompt | 任务表达 |
| --- | --- | --- |
| A `external_nl_vm` | 当前英文自然语言 VM 契约 | 可读 SExpr |
| B `bare_readable` | 仅普通 tool-using agent 身份 | 可读 SExpr，无算子定义 |
| C `symbolic_kernel` | 纯 SExpr，只声明算子形式和符号摘要，不含完整自然语言执行体 | 可读 SExpr |
| D `annotated_kernel` | 本文候选：纯 SExpr，算子内部有简洁自然语言执行体 | 可读 SExpr |
| E `direct_prose` | 普通 tool-using agent 身份 | 等价自然语言过程 |

D 是产品候选组；其余组用于区分：

- SExpr 表达结构本身的收益；
- 模型对 `seq/call/fallback` 的既有先验；
- SExpr 内自然语言算子定义的增量价值；
- 外部自然语言 VM 前言的必要性。

主结论比较 D 与 A/B/C。E 只作为普通过程能力参考，不以 E 失败证明 SExpr 普遍优越。

## 4. 第二阶段：结构与自然语言平衡

在第一阶段冻结表现最好的 VM 契约后，对完全相同的语义过程测试三种表达：

### 4.1 深层内联

所有控制逻辑嵌套在一个表达式中，用于测量深度退化：

```lisp
(seq
  (bind result
    (fallback
      (call primary-search (input subject))
      (call browser-search (input subject))))
  (if result.ok
    (call verify (evidence result.evidence))
    (reply "搜索失败")))
```

### 4.2 浅层命名组合

把相同逻辑拆为命名过程，顶层只做浅层组合：

```lisp
(process search
  (fallback
    (call primary-search (input subject))
    (call browser-search (input subject))))

(process verify-result
  (call verify (evidence result.evidence)))

(process search-and-verify
  (seq
    (bind result (search subject))
    (verify-result result)))
```

### 4.3 自然语言叶子膨胀对照

保持浅层 SExpr，但把每个节点拆成更长的自然语言说明，用于确认过度解释是否增加注意力负担。该组不作为产品候选，只测量“更多说明不一定更好”。

复杂度阶梯至少覆盖：

- 2 个依赖步骤；
- 4 个依赖步骤；
- 8 个依赖步骤；
- 1 层、3 层、5 层嵌套；
- 单分支、失败回退、嵌套条件；
- 一次与两次命名模块复用。

不预设硬性最大深度；根据正确率曲线决定设计纪律。

## 5. 任务集

沿用确定性模拟工具，避免网络、登录和真实站点变化污染 VM 结论：

| 任务 | 核心能力 |
| --- | --- |
| Linear Discovery | 列出能力、选择、加载、执行、验证 |
| Conditional Fallback | 主调用明确失败后才执行备用调用 |
| Module Reuse | 同一命名过程依次应用于两个输入 |
| Guard No Action | 条件不成立时禁止任何工具调用 |
| Bind Across Observation | 后一步参数必须来自前一步真实工具结果 |
| Nested Recovery | 主调用失败、备用调用失败、第二备用成功 |
| Reply Boundary | 只有文本且无工具调用时正确终止 |

每个任务不得在 System Prompt 中出现具体答案、证据 ID 或预期工具参数。工具输出由夹具按调用输入确定性产生。

## 6. 评分

每个 episode 同时报告语义成功和精确成功。

### 6.1 语义成功

- 必要工具及参数出现；
- 依赖调用发生在后续模型轮次，不能提前猜测 Observation；
- 条件与回退分支正确；
- 最终回复包含由真实结果产生的交付值；
- 没有用普通文本模拟工具调用。

### 6.2 精确成功

在语义成功基础上进一步要求：

- 工具轨迹与预期计划完全一致；
- 无重复调用、错误参数后重试或额外探索；
- 无 standalone 心智维护代替外部任务；
- 最终交付值必须是独立 token，不能只作为错误字符串的子串出现。

### 6.3 成本与结构

- prompt/completion/total/cached tokens；
- System Prompt 与任务字符数；
- 模型请求次数；
- 物理工具调用次数；
- 首次正确动作延迟与最终完成延迟；
- 最大 SExpr 深度、节点数、自然语言字符占比；
- 中途文本、空回复和无工具终止次数。

## 7. 实验纪律

- 主测模型使用 `gemini-3-flash-agent`，其他模型作为对照；
- 每组每任务至少 5 次正式重复；pilot 不进入正式统计；
- 组别执行顺序采用轮换，避免固定后执行偏差；
- 正式运行前冻结 Prompt、任务、工具定义、评分器和失败处理；
- 单个 episode 的空回复、服务错误和参数错误必须落盘，不能中止或隐藏整批实验；
- 报告所有失败轨迹，不只报告最好一次；
- 中途审计只能修正评测器漏洞；修正后旧批次作废并完整重跑；
- 不根据某组中途表现改写提示词。

为判断模型是否真正读取算子定义，可保留一个小型诊断子集：每轮把算子替换为不透明名字，并只在某组的 SExpr 内提供自然语言定义。该子集用于因果诊断，不代表产品语法；产品元语应使用模型先验最强、最可读的名字。

## 8. 预注册结论标准

### 8.1 候选通过

D `annotated_kernel` 满足：

- 语义正确率不低于 A `external_nl_vm`；
- 精确正确率不低于 B `bare_readable`；
- 没有新增系统性的重复调用、错误分支或空回复；
- 固定前缀成本可被 cache 或长期会话复用合理摊薄。

### 8.2 自然语言算子定义有增量价值

D 相对 C/B 在陌生组合、较长依赖或回退任务上稳定提高精确成功率，且提升不能由服务错误差异解释。

### 8.3 仅证明不退化

D 与 B/C 相同但不更好，说明内部自然语言定义是安全的自描述和未来扩展基础，但尚无证据证明它提高当前模型正确率。

### 8.4 不支持

D 因固定说明过长而系统性降低工具选择、依赖跟踪或最终回复，或者深层结构在命名拆分后仍没有改善。

## 9. 与已有实验的关系

- [Cognitive SExpr VM Prompt A/B](./morphz_cognitive_sexpr_vm_prompt_ab.md) 已证明 VM 身份相对传统 Agent 身份不退化；
- [SExpr 过程指导评测 v1](./morphz_sexpr_process_guidance_eval_v1.md) 已证明可读 SExpr 能驱动真实 Function Calling；
- [`bind` / `if` 算子真实评测 v1](./morphz_bind_if_operator_eval_v1.md) 已对精确引用、重复局部作用域和真假分支完成聚焦测试；
- 本实验进一步验证 System Prompt 的表达形式、算子自然语言语义体和结构深度；
- 高层身份、多身份组合与 Session 角色测试不进入本轮，待 VM Kernel 冻结后另行设计。
