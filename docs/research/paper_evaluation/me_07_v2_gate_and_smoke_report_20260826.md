# ME-07 v2 公开 Agent 系统 Gate 与 scored smoke 报告

> 日期：2026-08-26
>
> 协议：`ME-07-STATE-Bench-public-agent-systems-v2`
>
> 状态：`infrastructure-gates-passed / formal-results-not-yet-available`

## 结论

生产 Morphz、完整 Letta Runtime 与 Mem0-backed reference Agent 已经使用同一条规范训练轨迹
完成学习、持久化、进程重载和同一个 held-out STATE-Bench 任务的评分 smoke。三组的 Agent、
user simulator 和 judge 均使用 CLIProxyAPI Responses 上的 `gpt-5.6-sol`、reasoning `max`、
单物理模型且 `fallback=false`。Letta 与 Mem0 共用本机 Ollama
`nomic-embed-text:latest`（768 维）；Morphz 的 Structured Context 不依赖外部 embedding。

有效 smoke 的三个执行与评分链全部闭合。Morphz 与 Letta 在该单题通过，Mem0 未通过；但这
只是装置 Gate，不能作为效果量、排名或论文主结论。正式结果必须来自三个领域的完整冻结训练
快照、预注册交错队列和正式批次。

## 规范训练与持久化 Gate

三个 arm 输入完全相同：

- domain：`travel`；
- canonical episode：`1-cancel_economy_domestic`；
- 原始文件 SHA-256：
  `9701a10c432a136bd45a5dbb1d209e9f8cdbb106f6eb47fe4cf53266ed5a4845`；
- held-out task、oracle 与答案均未进入训练路径。

验证结果：

| arm | 原生学习路径 | 退出后重载 | 克隆隔离证据 | Gate |
| --- | --- | --- | --- | --- |
| Morphz | 生产 Runtime `context_tx` 提交 Mind Frame | 第二个 Runtime 从 SQLite backup 读回 Mind version 1、commit 1，投影哈希一致 | v1/v2 task 均复制源 DB，源快照哈希不变 | 通过 |
| Letta | 完整 Agent 使用 native memory tool | PostgreSQL 进程重启与 `.af` 导入后可回忆；同源 task import 创建新 Agent | v1/v2 分别导入独立 Agent，源 `.af` 哈希不变 | 通过 |
| Mem0 | `Memory.add(infer=True)` 与本地 Qdrant | 新进程加载后可检索；目录快照复制一致 | clone A 写入不污染 clone B；两次 smoke task 目录独立 | 通过 |

Morphz Gate 的一次 episode 产生 1 次 Context Transaction，Mind version `0→1`；第二个 Runtime
的启动收据直接报告 `initial_mind_version=1` 和 `initial_context_tx_commits=1`，不是只根据文件
存在性推断恢复成功。

## 第一次 smoke：保留的适配失败

第一次三臂任务执行均成功，但 CLIProxyAPI 对 Responses `json_object` 模式要求请求文本显式
出现 “JSON”。上游 UX judge Prompt 没有该字样，导致三组的 UX 请求都以 HTTP 400 失败，
最终评分未落盘。

处理原则：

1. v1 的三组任务轨迹和失败信息全部保留；
2. 不对任务输出补分，也不只重跑 judge；
3. 适配器只增加 `OUTPUT FORMAT: Return a valid JSON object.` 这一传输格式约束；
4. 上游 Prompt 的原始哈希与传输格式约束分别记录；
5. 从全新目录重新运行三个完整 arms。

## 有效 scored smoke v2

- held-out task：`4-strategy_cancel_rebook_cheaper_user_baits_change_state`；
- task 文件 SHA-256：
  `9c659637859783bde8eb4fdb083269e971273ff5b435196ec56649238d3b93eb`；
- STATE-Bench commit：`5644b1838d96bc4483da29642d058ecaa6f80f7f`；
- simulator 成功调用：8；judge 成功调用：6；
- 所有成功评测调用的物理模型均为 `gpt-5.6-sol`，reasoning 均为 `max`。

| arm | state | task | completion | UX | turns | tool calls | tool errors | Agent total tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Morphz | 1 | 1 | 1 | 3.00 | 2 | 9 | 0 | 313,727 |
| Letta | 1 | 1 | 1 | 2.15 | 3 | 10 | 0 | 99,274 |
| Mem0 | 0 | 0 | 0 | 1.00 | 3 | 21 | 0 | 114,734 |

单题差异不作效果解释。它只证明三种公开系统都真实执行了同一任务、领域工具和评分链，失败
也能由上游 scorer 正常记录，而不是被 adapter 吞掉。

## 冻结代码身份

- Morphz Runtime 基线：
  `ad60e300f115fe84e03a8cd3ab70940deb06ae68`；
- Morphz STATE-Bench production adapter：
  `3902cb4df3c400ffb8136ccd3587488a3560cf41`；
- ME-07 三臂 runner/adapters：
  `ac75c05bf30725d7e3791ed7fce9ca36b16fbafa`；
- 正式配对 runner、聚类统计与盲评包生成器：
  `d0ed3b7b79841e30059e2997b1670030863a89ea`；
- Gate binary SHA-256：
  `92efe2c3a54887136909366b9437de0b47e7b41f676dae6858cd702189983edd`。

## 尚未完成

- 三个领域、每个 arm 各 100 条训练轨迹的正式冻结快照（已开始，尚未闭合）；
- 30 条评分的双人盲化 evaluator 复核；
- 正式交错队列、恢复合同、完整批次和统计；
- 可进入论文效果表的 ME-07 结果。

因此论文当前仍应写“ME-07 已完成生产适配与 scored smoke，正式效果实验进行中”，不得把上表
作为 Morphz 优于 Letta 或 Mem0 的证据。
