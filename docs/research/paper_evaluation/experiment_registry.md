# Morphz 论文实验总账

> 最后更新：2026-08-17
> 维护规则：任何状态、协议或结果变化都更新本表；不得删除已执行实验的历史记录。

## Runtime 基线

论文和路演当前默认 Runtime 源码基线为 [`paper-eval-runtime-v2`](./runtime_baseline_v2.md)，对应完整 commit `03a32f864a3c38026672b4076855137e0bbb5627`。历史 v1 在 author/committer 重写后对应 [`cbfc540cedcdba8fba2dcbfbe6f37f1cc37d6df5`](./runtime_baseline_v1.md)。每个 Run 必须记录实际 Runtime 与实验包 commit；后续修复不得静默改写既有基线。

## 总览

| ID | 实验 | RQ | 优先级 | 当前证据 | 状态 | 当前协议 | 下一门槛 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ME-00 | 实验基础设施与校准 | 全部 | P0 | 部分既有 runner | `planned` | — | 冻结 manifest、目录、评分与重放规范 |
| ME-01 | 核心机制拆解对比（结构化 Context 与结果回流消融） | RQ2 | P0 | 零散 `F` | `protocol-draft` | p1 待写 | 三核心 arm 的任务/评分器设计 |
| ME-02 | 表示形式拆解对比（等信息表示形式消融） | RQ1 | P0 | `F` | `protocol-draft` | 历史 v1；正式 p1 待写 | 修正信息量和样本设计 |
| ME-03 | 非确定性认知求值特征 | RQ3 | P0 | 理论与个案 | `planned` | — | 定义 bounded-open、干预和 closed control |
| ME-04 | Runtime 权威边界与故障注入 | RQ4 | P0 | 多项 `D` 分散存在 | `planned` | — | 建立面向论文主张的覆盖矩阵 |
| ME-05 | 跨模型能力与采用倾向 | RQ5 | P1 | `F` | `planned` | — | 冻结模型矩阵与 capacity/adoption 分组 |
| ME-06 | 长期、多 Session、迁移与恢复 | RQ6 | P1 | `F` | `planned` | 历史协议多版 | 固定事件流、基线和隐藏行动评分 |
| ME-07 | Mem2ActBench 外部验证 | RQ5 | P1 | 无 | `planned` | — | 完成许可/环境/适配范围审计 |
| ME-08 | 第二公开 Benchmark | RQ5/RQ6 | P2 | 无 | `planned` | — | ME-07 后选择 |

## 依赖

```text
ME-00 ─┬─> ME-01 ─> ME-05 ─┬─> ME-06
       ├─> ME-02 ───────────┤
       ├─> ME-03 ───────────┤
       ├─> ME-04 ───────────┘
       └─> ME-07 ─> ME-08
```

ME-05 使用 ME-01/02/03 中冻结的核心子集，不重新设计任务；ME-06 只有在核心状态机制及评分器稳定后才扩成长运行。

## 已有材料映射

| 既有材料 | 对应实验 | 证据标签 | 处理方式 |
| --- | --- | --- | --- |
| `morphz_semantic_sexpr_vm_ablation_*` | ME-02 | F | 保留历史结果；正式实验等信息、多模型、更多配对样本重跑 |
| `morphz_bind_if_operator_eval_v1.md` | ME-01/ME-02 | F | 作为 Observation 进入绑定/分支的微基准 |
| `morphz_context_pressure_eval.md` | ME-05/ME-06 | F | 作为容量与跨模型可行性，不当作核心对照 |
| `morphz_context_long_run_eval.md` | ME-06 | F | 提炼任务与失败模式，冻结新协议后重跑 |
| `morphz_concurrent_objective_coordination_*` | ME-04/ME-06 | F | 并发、恢复案例和后续故障 fixture 来源 |
| `morphz_reality_contract_v1_validation.md` | ME-01/ME-04 | F/D | 提炼来源、时序和权威冲突评分项 |
| Rust/CLI/集成测试 | ME-04 | D | 建立“主张—测试—commit”覆盖矩阵 |
| Harbor、π-Bench adapter | 通用能力 | F | 附录/系统案例；不替代 ME-07 |

## 状态更新记录

### 2026-08-17

- 将新论文实验与路演 Runtime 默认基线提升为 `paper-eval-runtime-v2`；
- v2 对应 commit `03a32f864a3c38026672b4076855137e0bbb5627`；
- 记录 v1 在 Git 历史作者邮箱重写后的等价 commit `cbfc540cedcdba8fba2dcbfbe6f37f1cc37d6df5`；
- 冻结论文实验 Runtime 基线 `paper-eval-runtime-v1`；
- v1 原始历史中的 commit 为 `45ed92a1535f952cdac1b5b08dcce19b7d627c55`；
- 记录全量测试、release 构建、真实数据库迁移和部署运行验证状态；
- 从该基线开始，核心语义进入实验期冻结，阻塞性修复须建立新的版本化基线。

### 2026-08-11

- 建立实验总计划、总账和三类模板；
- 将历史实验统一降噪为 `D/F` 证据，不再与未来确认性结果混算；
- 确定第一执行目标为 ME-00 → ME-01 Pilot，并行整理 ME-04 的确定性覆盖；
- 尚未启动新的模型实验，也未产生 API 成本。
