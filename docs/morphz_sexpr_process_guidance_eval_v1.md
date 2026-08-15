# Morphz S-Expression 过程指导评测 v1

> 后续设计：本文记录的是第一版外部自然语言 VM 契约实验。新的候选方案把 System Prompt 本身写成 SExpr，并把基础算子的自然语言执行体放在 SExpr 节点内部；见 [分层 S 表达式认知机与可加载身份架构](./morphz_layered_cognitive_vm_identity_architecture.md)、[语义算子 VM 对照实验](./morphz_semantic_sexpr_vm_ablation_v1.md) 和 [五组正式结果](./morphz_semantic_sexpr_vm_ablation_results_v1.md)。

## 1. 要验证的命题

本评测验证一个窄而关键的命题：

> 当 Runtime 明确告诉 LLM“你是 Cognitive S-Expression VM 的语义处理器”时，模型能否把 `(process ...)` 当作实际过程控制，通过真实 Function Calling 完成动作，而不是解释、复述或模拟表达式。

它不验证完整 Skill 设计、真实网络搜索质量、长期自主学习，也不证明任意复杂的 S-Expression 都能可靠执行。

## 2. 实验设计

模型：`gemini-3-flash-agent`

对照组：等价的自然语言过程指导。

实验组：S-Expression VM 过程指导。固定 VM 契约解释了 `seq`、`if`、`fallback`、`module`、`lambda`、`call` 和 `reply` 的执行语义。

两组使用完全相同的标准 Function Calling 工具：

- `skills_list`：返回紧凑能力索引；
- `skill_view`：加载一个 Skill 的操作说明；
- `skill_run`：执行 Skill；
- `evidence_verify`：验证结果并产生交付令牌。

工具结果由确定性模拟环境产生，以隔离网络、登录状态、真实 Skill 内容质量和站点变化。实验组顺序在不同重复轮次中交替，避免固定后执行带来的偏差。

每个 episode 有四项判据：

1. `required-tool-order`：必须出现指定工具链及参数顺序；
2. `causal-rounds`：依赖调用必须在后续模型轮次发生，不能在尚未看到结果时提前猜测；
3. `branch-discipline`：不能执行条件之外的分支；
4. `final-delivery`：必须在工具链完成后给出正确最终结果。

## 3. 测试任务

| 任务 | 主要验证能力 |
| --- | --- |
| `linear-discovery` | 发现能力、选择 Skill、加载、执行、验证的线性依赖 |
| `conditional-fallback` | 主 Skill 返回 `AUTH_REQUIRED` 后才执行备用分支 |
| `module-reuse` | 定义一个过程模块，并分别对两个输入完整执行 |
| `guard-no-action` | 条件不成立时不调用任何工具，直接回复 |

每个任务、每个实验组重复 3 次，共 24 个 episode。

## 4. 正式结果

| 组别 | 通过数 | 通过率 | 平均得分（满分 4） |
| --- | ---: | ---: | ---: |
| 自然语言过程 | 9 / 12 | 75% | 3.58 |
| S-Expression VM | 12 / 12 | 100% | 4.00 |

逐任务结果：

| 任务 | 自然语言 | S-Expression VM |
| --- | ---: | ---: |
| 线性发现 | 3 / 3 | 3 / 3 |
| 条件回退 | 3 / 3 | 3 / 3 |
| 模块复用 | 0 / 3 | 3 / 3 |
| 无动作分支 | 3 / 3 | 3 / 3 |

S-Expression 组的 12 个 episode 均产生了预期的真实工具轨迹；所有依赖调用都发生在看到前一步工具结果之后，没有出现只解释表达式、错误分支、抢跑依赖或漏掉最终回复。

自然语言组的三个失败均发生在模块复用任务：

- 两次把完整的逐项过程重排为“先运行 Alpha、再运行 Beta、再分别验证”，没有保持模块体的调用边界；
- 一次在加载 Skill 后只输出“接下来调用 `skill_run`”之类的文本，没有产生工具调用，因此按正常 Agent 终止规则结束。

## 5. 结论

第一版事实支持以下判断：

1. **思路是可行的。** Gemini 能把 S-Expression 解释为实际控制逻辑，并映射为标准 Function Calling，而不是只能把它当作数据或待解释代码。
2. **VM 身份契约有效。** `seq`、条件、失败回退、工具调用和回复边界在本轮测试中都能稳定遵循。
3. **模块化表达有初步优势。** 当前最有区分度的结果来自模块复用；S-Expression 比自然语言更稳定地保留了过程边界。
4. **物理动作仍应使用标准工具协议。** S-Expression 适合表达控制、组合和能力路由，真实副作用继续通过模型训练充分的 Function Calling 执行，两者并不冲突。

这还不足以证明 S-Expression 比自然语言普遍更优。样本量小、只有一个模型、工具环境是确定性的，而且实验组固定 VM 契约更长。固定契约未来可以利用 prefix cache 摊薄，但“更省 token”仍需单独测量。

## 6. 对 Skill 机制的直接启示

可以进入下一阶段设计，但不应立刻引入完整 Lisp：

- 先建立最小过程代数：`process`、`seq`、`if/guard`、`fallback`、`bind`、`call`、`reply`；
- 把 `module/apply` 作为实验性复用原语继续验证；
- Skill Index 只表达紧凑的能力签名、适用条件与副作用，不注入全部 Skill 正文；
- 由过程表达式指导 `skills_list/skill_match → skill_view → 标准工具调用`；
- S-Expression 决定“如何组合与继续”，Function Calling 承担“如何触发现实动作”。

## 7. 复现

```bash
cargo run -q -p morphz --bin sexpr_process_eval -- /private/tmp/morphz-sexpr-process-eval 3
```

本次正式报告生成于：

`/private/tmp/morphz-sexpr-process-eval-formal/sexpr-process-eval-v1-20260713T032532.181Z-87021/report.json`
