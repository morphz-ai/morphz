# ME-06 长程 Structured Context 与受控 Compaction Pilot 结果

> 日期：2026-08-26
>
> 协议：`me06-long-horizon-compaction-p1.1-frozen`
>
> 有效 Suite：`ME-06-real-p1-20260825T210804.696Z-37187`
>
> 执行二进制 SHA-256：`f0321bc27ef4d18afd160cace1a2c390d7eb9beab9c5731a9ef149efef81ac32`
>
> 执行源码/runner 基线：`ee9d976`；语义重评分器：`3558c12`
>
> 总 cell：`6/6`；装置 Gate：`passed`

## 结论

三个 paired fixtures 各包含 120 个事件、12 个 checkpoint，并覆盖来源权威、显式取代、
跨 Session、并发更新、进程重启和 Context 隔离。受控 compaction 与完整 Morphz 两臂均取得：

- fixture 语义成功：`3/3`；
- 最终状态字段：`24/24`；
- 唯一最终行动：`3/3`；
- Context 隔离：`3/3`；
- 无陈旧事实复活。

因此本 Pilot 没有观察到 Morphz 相对一次现代受控 compaction 的最终任务能力退化，也没有
观察到 Morphz 在这三个容易达到满分的 fixture 上获得更高准确率。Morphz 的额外证据位于
架构层：生产二进制真实执行 SQLite 持久化、跨 Session 共享 Context、Frame 事务、版本冲突
后的重读/重算、进程重启恢复和因果审计；这些不是把基线缺失能力记作 0 分，而是单独报告为
架构能力。

## 语义主评分与原始精确评分

原始 `score.json` 使用字符串精确匹配，把语义等价的 `decision_rule` 文本判为不相等，并要求
最终行动的 `evidence_id` 必须等于来源别名 `approved-release`。完整 Morphz 实际返回的是该来源
对应的具体、可见、稳定事件 ID。协议已经预注册“语义正确为主、精确字符串为诊断”，因此在
不调用模型、不修改原始输出的条件下，使用修正后的确定性评分器重算：两臂均由原始精确
`7/8` 字段恢复为语义 `8/8`，具体证据事件 ID 也被正确接受。原始评分与语义重评分均永久保留。

## 架构轨迹

三个 Morphz cell 共记录 40 次成功 Context transaction（分别 13、14、13 次）。原始轨迹显示：

- checkpoint 8 的两个 Session 从同一基础状态写入不同对象；Runtime 检测版本变化，另一分支
  重读新版本后提交，三项贡献均保留，未发生静默丢失；
- checkpoint 9 对共享对象形成并发更新，轨迹保留基础版本、失败尝试、重读和重新求值；
- checkpoint 10 真实终止并重启 Runtime 进程，状态从同一 SQLite Mind 恢复；
- checkpoint 11 的 foreign Context 返回未知状态，不能读取 primary Context 的私有值；
- 最终 Frame 保留来源、取代关系、并发历史和实际行动证据，`causal_audit_complete=3/3`。

受控 compaction 基线以透明状态文件实现跨 Session、固定 S6 一次 compaction、后续恢复和隔离，
因此这些共同能力也正常计分；但它没有 Frame 事务或 MVCC 能力，相应指标为“不适用”，不是失败。

## 模型、容量与调用成本

两臂使用同一 CLIProxyAPI 路由、`gpt-5.6-sol`、reasoning `max`、批次并发 1。未施加人工
Context 压力。Morphz 的有效物理输入上限为 262,144 tokens、soft limit 为 196,608；运行轨迹
显示模型容量层实际保留 32,768-token maintenance reserve。启动清单里的 3,000 是 runner 写入
的请求配置值，但没有成为该模型容量层的最终有效 reserve；该差异不影响本轮结果，因为所有
checkpoint 都处于 normal pressure，后续报告以实际 `runtime/model_usage` 事件为准。

| arm | Provider calls | input tokens | output tokens | total tokens |
| --- | ---: | ---: | ---: | ---: |
| controlled compaction | 39 | 286,907 | 23,429 | 310,336 |
| full Morphz | 97 | 4,923,739 | 169,882 | 5,093,621 |

本轮完整 Morphz 的总 token 是基线约 `16.4×`，主要来自生产系统提示、工具 schema、完整 Context
投影和 52 次认知维护调用。这是明显的效率代价，不能隐藏，也不能从本 Pilot 宣称 Token 优势。
它同时指出了后续工程优化方向：更小的任务投影、减少无变化 checkpoint 的维护调用、压缩工具
schema 和避免重复重写大型 Frame。论文应把“获得额外状态/事务能力”与“当前实现的调用成本”
同时报告。

## 有效性边界

- 只有三个 paired fixtures，且两臂均满分，不能宣称统计显著优越；
- fixture 由本项目设计，不是外部公开 Benchmark；外部长期记忆效度由 ME-07 检验；
- 一次固定 compaction 是强而透明的现代基线，但不代表所有现有 Agent 产品；
- token 数是 Provider 原始 usage，总系统开销不同，适合报告实际成本，不适合归因模型本身；
- 运行期间只改了评分器的语义等价规则，没有按结果调整模型输出、fixture 或补跑失败 cell。

## 证据与复现

- 冻结协议：[`../../me_06_long_horizon_compaction_protocol_p1.md`](../../me_06_long_horizon_compaction_protocol_p1.md)
- 启动装置事故：[`../../me_06_real_smoke_harness_incidents_20260826.md`](../../me_06_real_smoke_harness_incidents_20260826.md)
- 汇总数据：[`summary.json`](./summary.json)
- 原始有效 Suite：`/private/tmp/morphz-me06-real-20260826-p11-r1/ME-06-real-p1-20260825T210804.696Z-37187`
- 原始 `report.json` SHA-256：`a188508c93dfe08d892e85c02ea76160d960b4b814fc3eb61c89dbf92d85c00f`
- 语义重评分 SHA-256：`fb8c20214dd5516914c7baecc65c0433a9ff6861a26b3a30ad54210cd47e70a6`

## 论文可用主张

可以写：

> Across three paired long-horizon fixtures, Morphz and a controlled-compaction baseline both
> achieved 3/3 semantic task success and 24/24 correct final state fields. Morphz additionally
> exercised persistent cross-session Context, versioned Frame transactions, restart recovery,
> Context isolation, and causal audit, but incurred substantially higher token cost in the current
> implementation.

不能写：Morphz 在准确率或 token 上优于 compaction、三个 fixture 构成统计显著性、当前实现
已经优化到生产成本下限，或本实验代表公开长期记忆榜单成绩。
