# ME-09 r4：共享 Context、八 Session 与单 Session 工作集

> **解释状态更正（2026-08-28）：不可作为 ME-08 的单变量对照。** 冻结数据库显示
> 89/89 个 Evaluation 均绑定了 `terminal-task@0.5.0`，而 ME-08 的 89/89 个
> Evaluation 均为无 Harness。所以下述 70/89 是“共享 Context + Harness + r4 Runtime/
> 配置”的历史事实，只能用于工程诊断；原文所有 ME-08 配对统计均不得解释为共享 Context
> 的单独效应。原始结果和数字保留，不作删除或改写。

## 结论

本次正式运行完整闭合 89 道 Terminal-Bench 2.1 任务，Morphz 官方 verifier 原始得分为
**70/89（78.65%）**。由于处理组额外绑定了 Harness，冻结的 ME-08 无 Harness 结果
**72/89（80.90%）**不再构成单变量对照；历史配对差为
**−2.25 个百分点**，任务级自助法 95% 区间为 **[−10.11,+5.62]** 个百分点，双侧精确
配对检验 `p=0.774`，但这些统计混合了 Harness 与共享 Context 差异，不能据此判断共享
Context 的性能效应，也没有形成正向迁移证据。

`max_sessions=1` 后，先前探索性运行观察到的大幅回退没有重现：正式 r4 与隔离 Context
对照只差两题。但共享 Context 并发的工程成本仍然明显，输入 Token 为 ME-08 的 1.84 倍，
总 Provider Token 为 1.83 倍，墙钟时间为 1.89 倍。

## 冻结运行边界

- Protocol：`ME-09-terminal-bench-shared-context-v1`
- Runtime commit：`dfd3307a494cf27bea62afd8f9b4822b18d33186`
- 实际部署二进制 SHA-256：
  `27c85faf224bbdb3980f6433e205d5e120a06ccd5497cfbf7f69e7d56a7bc34c`
- 模型：精确 `gpt-5.6-sol`，`max` reasoning，`full_access`，无 fallback
- 拓扑：一个 Agent、一个共享 Context、八个稳定 Session、八个 Execution Target，并发 8
- Session 工作集：`max_sessions=1`
- Harness：`terminal-task@0.5.0`（误绑定；因此本轮不可与无 Harness 的 ME-08 作单变量比较）
- 样本：89 题，每题一次，模型与任务均零重试
- 主指标：官方 verifier `raw_reward`
- 开始：`2026-08-27T22:30:19.842473Z`
- 结束：`2026-08-28T01:30:52.851465Z`
- 墙钟：约 3 小时 0 分 33 秒

监控说明中曾记录另一个预期二进制摘要；最终 `launcher_result.json`、89 题 Runtime receipt
和服务器上实际部署文件一致指向上面的 `...7bc34c`。本报告以实际执行身份为准，并保留这项
元数据差异，不把它静默改写为预期值。Runtime commit 本身一致。

## 完整性 Gate

- `launcher_result.json` 存在，Harbor 子进程失败数为 0；
- 89 个唯一官方 Trial、89 个 verifier 结果、89 份 Runtime receipt 和 89 条轨迹均存在；
- 八条 lane 全部出现，题数为 `12,11,11,11,11,11,11,11`；
- 一个共享 Agent/Context、八个 Session/Target、一个 Runtime 身份；
- Runtime SQLite、Context 事务和 Mind 投影可读取；
- 359 个资源样本覆盖完整运行；
- 本地完整性诊断没有剔除任何 Trial。

## 配对结果

| 指标 | ME-09 共享 Context | ME-08 隔离 Context |
| --- | ---: | ---: |
| 通过 | 70/89 | 72/89 |
| 通过率 | 78.65% | 80.90% |
| 仅该组通过 | 5 | 7 |
| 两组均通过 | 65 | 65 |
| 两组均失败 | 12 | 12 |

ME-09 只通过的五题是 `configure-git-webserver`、`build-pov-ray`、`cancel-async-tasks`、
`torch-pipeline-parallelism` 和 `feal-differential-cryptanalysis`。这些题均没有观察到显式的
跨 Session Frame 使用，因而不能解释为迁移收益。

## 迁移机制证据

- **E0 拓扑**：通过。数据库中精确存在一个 Agent、一个 Context、八个 Session、八个
  Execution Target、89 个任务 Thread 和 89 条根用户消息。
- **E1 可见性**：观察到 4,101 次“其他 Session 在 Frame 已进入 Context 后进行模型调用”
  的暴露事件，涉及 364 个唯一 Frame/Session/任务组合。这证明共享状态确实可见，但不证明
  模型实际使用了它。
- **E2 显式跨 Session 使用**：0。没有后续 Context 事务直接引用或修订另一个 Session 形成的
  稳定 Frame ID。
- **E3 结果相关迁移案例**：0。没有“显式使用跨 Session Frame，并且 ME-09 对而 ME-08 错”
  的案例。

运行共提交 17 次 Context 事务，最终 revision 为 17，其中两次自动细粒度 rebase；操作包含
11 次 derive、6 次 revise、1 次 relate 和 Context 维护产生的 retire。1,259 条
`chat/assistant_call` 均没有记录 Context transaction rejection。现有证据不支持“Frame
相互误改导致回退”的解释。

## 失败诊断

19 个官方失败全部保留为零分。诊断分类不替换官方成绩：

- 7 个 Harbor `AgentTimeoutError`：`train-fasttext`、`query-optimize`、
  `install-windows-3.11`、`extract-moves-from-video`、`make-doom-for-mips`、
  `raman-fitting`、`crack-7z-hash`；
- 3 个 Provider 安全拒绝：`model-extraction-relu-logits`、`vulnerable-secret`、
  `break-filter-js-from-html`；
- 9 个普通任务实现或 verifier 失败：其余零分任务。

因此，r4 仍有 **7/89** 的正式超时，高于 ME-08 的 3/89。`max_sessions=1` 消除了此前明显的
共享工作集膨胀，但没有消除并发下的长任务超时和模型调用放大。

## Token、调用与资源

| 指标 | ME-09 r4 | ME-08 Morphz | 比值 |
| --- | ---: | ---: | ---: |
| Provider 输入 Token | 106,085,406 | 57,541,202 | 1.844× |
| 其中缓存输入 Token | 14,004,736 | 9,389,568 | 1.492× |
| Provider 输出 Token | 1,435,497 | 1,246,760 | 1.151× |
| 输入+输出 Token | 107,520,903 | 58,787,962 | 1.829× |
| 缓存输入/输入 | 13.20% | 16.32% | — |
| 墙钟时间 | 10,833 秒 | 5,723 秒 | 1.893× |

ME-09 共记录 1,309 次模型 usage：1,222 次 Execution、87 次 Dialogue。八个并发任务持续
读取同一个变化中的 Context，使相邻请求不再拥有单一稳定前缀；`max_sessions=1` 限制了每次
投影携带的 Session 工作集，但不能避免共享状态在不同请求中重复发送。超时任务和额外模型
轮次也参与了放大，因此这里报告系统级观测，不把全部差值单独归因于 prefix cache。

资源侧没有出现持续饱和：16 logical CPU，1 分钟 load 平均 2.51、p95 8.18、峰值 38.86；
内存使用平均 4.20 GiB、p95 5.85 GiB、峰值 8.39 GiB；运行容器平均 6.97、峰值 10。

## 论文边界

本次结果足以关闭 ME-09 的工程问题：共享 Context 在单 Session 工作集下没有观察到显著准确率
退化，但也没有观察到可归因的跨 Session 正向迁移；并发成本和超时仍需单独优化。当前论文已经
闭合，ME-09 继续作为补充/后续并发研究证据，不用于追改当前论文的主要结论。

## 产物

- `me09_summary.json`：89 题正式统计、配对结果与 E0/E1/E2/E3 证据；
- `failure_audit.json`：独立失败分类；
- `launcher_result.json`：非敏感运行身份和 lane 收口；
- `me09_task_manifest_v1.json`：冻结的 89 题/八 lane 清单；
- `resource_samples_v2.jsonl`：完整资源采样。

原始数据库和轨迹保留在评测服务器及受控审计包中，不提交到 Git；仓库只保留非敏感摘要和
可复核的派生证据。
