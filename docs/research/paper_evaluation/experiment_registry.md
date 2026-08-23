# Morphz 论文实验总账

> 最后更新：2026-08-24
> 维护规则：任何状态、协议或结果变化都更新本表；不得删除已执行实验的历史记录。

## Runtime 基线

论文、路演和公开 Benchmark 的新实验当前默认 Runtime 源码基线为 [`paper-eval-runtime-v4`](./runtime_baseline_v4.md)，对应完整 commit `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`。历史 v3 继续对应 [`f875b93869282a14b738edec2f3a4069fd003600`](./runtime_baseline_v3.md)，历史 v2 对应 [`03a32f864a3c38026672b4076855137e0bbb5627`](./runtime_baseline_v2.md)，历史 v1 对应 [`cbfc540cedcdba8fba2dcbfbe6f37f1cc37d6df5`](./runtime_baseline_v1.md)。每个 Run 必须记录实际 Runtime 与实验包 commit；后续修复不得静默改写既有基线或追改历史结果。

## 新实验统一运行约束

- 主模型：`gpt-5.6-sol`；reasoning effort：`max`；
- Provider transport：CLIProxyAPI 兼容的 OpenAI Responses 路由；精确物理模型必须
  校验为 `gpt-5.6-sol`，且 `fallback=false`；
- 授权模式：隔离实验节点使用 `full-access`，episode 中不得混入人工审批等待；
- 隔离：专用 Morphz 节点、专用数据库、专用 Context；不同 arm/run 使用独立可写
  状态，不读取共享 Context、产品数据库或历史 Session；
- `full-access` 不改变公开 Benchmark 自身的 sandbox、网络、数据和工具规则。

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

### 2026-08-24

- Terminal-Bench 2.1 中国区云节点已完成无模型门禁：89 题官方数据集已缓存，固定
  5 题 Pilot `install-only` 为 5/5 完成、0 错误，Harbor adapter 云端全量测试
  7/7 通过；详见
  [`terminal_bench_2_1_cloud_node_readiness_2026_08_24.md`](./terminal_bench_2_1_cloud_node_readiness_2026_08_24.md)；
- 云节点 CLIProxyAPI 只监听 Docker bridge，长运行由 systemd 托管并通过文件锁防止
  重复启动；中国大陆出口的 Codex device-code 请求被 Provider 以
  `403 unsupported_country_region_territory` 明确拒绝，须先迁移到支持地区节点或提供
  稳定境外上游出口，再完成精确 `gpt-5.6-sol` 在线预检；本轮没有调用模型、没有消耗
  额度；
- 将尚未启动的新论文、路演与公开 Benchmark 实验默认基线提升为
  `paper-eval-runtime-v4` / `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- v4 纳入 Session 模型切换后的定向恢复、`路由 × 账户` Provider 健康隔离、
  持久 Plan 的异步任务边界，以及多项并发取消/恢复测试的确定性收口；
- 默认环境完整 `morphz --lib` Gate 为 984 passed、0 failed、6 ignored，Clippy、
  Store conformance、全目标检查和 Dashboard 160 项测试均通过；
- Linux/AMD64 正式二进制已在固定 Rust `1.97.1` builder 上生成；中国区构建只把
  Rustup/Cargo 传输路径切换到 RSProxy，工具链、Cargo.lock 和最终 SHA-256 仍固定；
- Terminal-Bench 2.1 历史 v1 结果继续保留 v3 身份，不追写为 v4。

### 2026-08-21

- Terminal-Bench 2.1 正式批次 v1 已完成：89 tasks × 5 attempts，445/445 个试次完成，`max_retries=0`，未选择性补跑；
- 官方 verifier 原始结果为 319/445（71.69%），原始 pass@5 为 85.39%；
- 依据 Harbor `unearned_credit` 规则完成逐轨迹审计：8 个成功试次确认直接读取 exact solution/private tests/reference data，另 3 个成功试次按“故意尝试也判失败”的严格规则判 0；
- 对外严格审计结果为 308/445（69.21%），SE 2.19 个百分点，Wilson 95% CI [64.78%, 73.32%]，pass@5 83.15%；
- v1 原始数据与 Harbor reward 原样封存，不追改；完整报告见 [`terminal_bench_2_1_formal_v1_result_2026_08_21.md`](./terminal_bench_2_1_formal_v1_result_2026_08_21.md)；
- 下一公开榜版本须先加入 anti-cheat Activation/Gate、修复缺失 `/app` 的 workspace 启动边界，并优化“任务已完成但 Runtime 未及时终止”的 28 个 timeout-pass 案例；正式 v2 如启动，必须重新运行全部 445 个 trial，不与 v1 混算。

### 2026-08-20

- 完成 Terminal-Bench 2.1 无推理执行门禁：固定 Harbor `0.21.0`、官方 89-task 数据集 commit、Linux/AMD64 Runtime 与等待器校验值；`path-tracing` 的 `install-only` 通过；
- 修正公开榜协议：正式运行默认使用 Harbor registry 的 canonical dataset digest，不再使用本地 `--path`；固定 89 tasks × 5 trials、`max_retries=0`、默认 timeout/resource，并在 Harbor agent kwargs 中显式记录 `reasoning_effort=max`；
- Harbor adapter 已实现 ATIF-v1.7 只读投影并通过官方 validator；下一 Gate 为单任务、单次真实模型 smoke，尚无可报告 Benchmark 成绩；
- 冻结新实验统一运行约束：`gpt-5.6-sol` + `max` + CLIProxyAPI、`full-access`、独立 Morphz 节点/数据库/Context；
- 将尚未启动的新论文、路演与公开 Benchmark 实验默认基线提升为 `paper-eval-runtime-v3`；
- v3 对应 commit `f875b93869282a14b738edec2f3a4069fd003600`；
- 纳入 v2 之后的并发投递、Shared Runtime 恢复、Principal 绑定、Provider Account CAS、响应 continuation 和 Managed SSH 存活边界修复；
- 保留 v1/v2 及既有 DEMO-001 运行的历史身份，不追写为 v3；
- 第一次真实模型 Pilot 前，仍需从 v3 的干净 checkout 重新执行并记录完整验证门禁。

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
