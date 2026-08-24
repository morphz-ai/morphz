# Terminal Harness 最小干预设计与 v0.5 冻结说明

> 状态：`candidate-frozen / model-run-not-yet-started`
>
> 日期：2026-08-24
>
> 依据：`raman-fitting` 三种 Agent 方式单次归因案例；不得外推为总体因果结论

## 1. 设计结论

`terminal-task@0.4.0` 不是少量提醒，而是同时注入了任务合同、验收账本、收敛合同、
闭环协议、认识纪律、执行纪律、验证纪律和领域规则。它在事实上建立了第二套 Supervisor，
与原生 Agent 争夺任务分解、方法选择和停止决策。`raman-fitting` 单次案例中，原生
Morphz 通过，而 v0.4 未提交产物；该案例不足以证明所有 Harness 都有害，却足以关闭
v0.4，并阻止继续加强命令。

v0.5 采用相反方向：Harness 只提供极少数**可选认知对象**，不规定行动顺序、工具、
轮数、时间、验证强度、任务策略或完成阈值。默认产品基线仍是无 Harness；v0.5 只有在
多题配对实验中不劣于原生 Agent 后，才可能成为建议配置。

## 2. v0.4 拆解结果

| v0.4 作用域 | 实际作用 | v0.5 处理 |
| --- | --- | --- |
| identity | 声明权限边界，但重复基础 Agent 合同 | 压缩为一条 scope |
| task-contract | 强制模型先定义交付物、限制与完成条件 | 删除，归还 Agent |
| acceptance-ledger | 要求建立并维护验收账本 | 改成可选 state，不作为 gate |
| convergence-contract | 规定每个重要动作的价值条件 | 删除，归还 Agent |
| closure-protocol | 用 only/before/immediately 等命令控制收口 | 删除 |
| epistemic-discipline | 通用认识习惯 | 删除，避免重复基础能力 |
| execution-discipline | 环境检查、最小修改和保全规则 | 删除，避免重复基础 Agent |
| verification-discipline | 跨领域验证方法 | 移交领域 Skill/评测器 |
| domain-guards | research/service/recovery/software 特例 | 移交领域 Skill/评测器 |
| final-readiness | 把进度、终态和产物存在性写成模型指令 | 移交 Runtime I/O 协议 |
| mind | 汇总整套执行方法 | 改成可选认知对象 |
| infer | 再次命令模型执行全部流程 | 改为中性入口 |

完整机器可读审计见
[`terminal_task_v0_4_intervention_audit.json`](../../../benchmarks/harbor/terminal_task_v0_4_intervention_audit.json)。

## 3. v0.5 的唯一新增能力

v0.5 只暴露五类可选对象：

1. 当前交付物；
2. 实质证据；
3. 未决不确定性；
4. 可用 checkpoint；
5. 候选下一动作的预期价值。

模型可以创建、修改或完全不使用这些对象。Harness 不要求它们同时存在，不要求固定顺序，
也不把任何字段当作完成 gate。具体分析、工具、行动、验证与交付仍由 Agent 自己选择。

包：[`terminal-task.hns`](../../../morphz-evals/harnesses/terminal-task.hns)

- ID/version：`terminal-task@0.5.0`；
- source SHA-256：
  `bacde4c7777aa2f3aa800d3052f982a51243f6eb9340f880237cbb3648eb745f`；
- normalized artifact：
  `sha256:82d9664e6014120d6d1d972e28360859a77123c92e1594d997faa91e25a26320`。

## 4. 静态门禁

新门禁不是性能证明，只负责阻止明显的干预升级：

- 最多 4 个干预作用域；
- 自然语言最多 1800 字符；
- 禁止 must、do not、continue only、return immediately 等强命令模式；
- 每个作用域必须声明 owner、分类、是否重复基础 Agent、是否领域特化和保留理由；
- 只有 capability description、optional state、neutral question 可进入模型实验。

v0.5 实测为 4 个作用域、995 个自然语言字符、0 个强命令命中；v0.4 为关闭且拒绝状态。
门禁实现见
[`harness_intervention_gate.py`](../../../benchmarks/harbor/harness_intervention_gate.py)。

## 5. 因果边界

静态门禁只能约束文本形状，无法证明它不会干扰模型。真正的判定来自冻结任务集上的配对
结果。v0.5 如果在主要指标上低于原生 Morphz，不用次要指标挽救，也不围绕具体失败题
继续修改 Prompt；应退回默认无 Harness，并从跨题轨迹寻找新的机制解释。
