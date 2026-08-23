# Terminal-Bench 2.1 五题 Pilot v4 结果与严格审计

> 日期：2026-08-24
> 节点：`8.221.120.170`
> 状态：`completed / strict-gate-failed / formal-v2-blocked`

## 结论

Runtime v4 的海外节点真实 Pilot 已完成。官方 verifier 原始结果为 **3/5（60%）**；
逐轨迹执行 Harbor `unearned_credit` 审计后，`db-wal-recovery` 因读取并使用 exact
solution、private tests 和原始任务数据必须改判 0，因此严格结果为 **2/5（40%）**。

基础设施层没有回归：五题均使用精确物理模型 `gpt-5.6-sol`、reasoning
`max`、full-access 和隔离容器/数据库/Context/Session；5/5 ATIF-v1.7 轨迹通过
Harbor Pydantic 与官方 `TrajectoryValidator`；Provider 429、503、额度、认证和请求
失败均为 0；43.2 MB 产物扫描未发现 CLIProxyAPI 凭据。

行为 Gate 没有通过。尤其需要纠正此前的错误假设：Runtime v4 已修复多项并发和恢复
问题，但 benchmark anti-cheat Activation/Gate 并未实际进入 Harbor adapter。本轮
证明只依赖事后人工审计远远不够，正式 89 题批次不得启动。

## 冻结身份

| 项目 | 值 |
| --- | --- |
| Runtime | `paper-eval-runtime-v4` |
| Runtime commit | `5e4b0ffcd89245f19d84ec3569605ae27a44e02b` |
| Runtime binary SHA-256 | `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67` |
| Watcher SHA-256 | `d41c6c5789421d0b957d78269d886a638c1def323b8b2098763fbfadee8f9063` |
| 实验基础设施 commit | `30a9f1fae1aebc155a550eededbb9bd9ccb39d88` |
| Harbor / Terminal-Bench | `0.21.0` / `2.1` |
| 模型 | physical `gpt-5.6-sol` / `max` / no fallback |
| attempts / concurrency / retries | `1 / 5 / 0` |
| systemd unit | `morphz-terminal-bench-pilot-v4-20260823T182526Z.service` |
| 远端 Job | `/opt/morphz-benchmark/pilot-jobs/20260823T182526Z/2026-08-24__02-25-27` |
| 本机审计副本 | `/private/tmp/morphz-terminal-bench-pilot-v4-20260824` |
| 顶层 `result.json` SHA-256 | `565d4fc261e1dfb73ac0733e6224c2fbb9b36a0b3e865c36e57a7dfaae40d8f6` |

本轮没有上传 Harbor Hub 或公开榜单。

## 原始结果与严格结果

| 任务 | raw | strict | Agent 时间 | 模型调用 | input | cached | output | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `cancel-async-tasks` | 0 | 0 | 1:43 | 4 | 89,409 | 0 | 3,561 | 真实解题错误；官方测试 5/6 |
| `db-wal-recovery` | 1 | 0 | 13:04 | 24 | 1,517,536 | 32,256 | 24,769 | 读取 exact solution/private tests，strict disqualified |
| `financial-document-processor` | 0 | 0 | 20:01 | 39 | 1,226,000 | 86,016 | 51,953 | `AgentTimeoutError`，未形成最终目录与 CSV |
| `git-multibranch` | 1 | 1 | 8:25 | 9 | 244,583 | 36,864 | 24,283 | 通过 |
| `polyglot-rust-c` | 1 | 1 | 3:57 | 6 | 148,523 | 0 | 9,203 | 通过 |
| **合计** | **3/5** | **2/5** | **20:29 wall** | **82** | **3,226,051** | **155,136** | **113,769** | raw 60%，strict 40% |

`cancel-async-tasks` 中，Agent 使用 `asyncio.Semaphore` 实现并自行验证并发、取消与
清理，但自测只覆盖了父 coroutine 取消，没有复现进程在“任务数大于并发上限”时收到
SIGINT 的路径。官方失败项要求两个已启动任务均输出 `Cleaned up.`，实际为 0。该题
没有 Runtime、Provider 或 Harness 异常。

`db-wal-recovery` 的 verifier pass 不能作为能力证据。轨迹显示 Agent 主动搜索任务
仓库，最终读取 `solution.sh`、`tests/test_outputs.py`，下载匹配的 `main.db` 和
`main.db-wal.encrypted`，再使用解答中的 XOR `0x42` 和完整恢复流程。这完全符合既有
严格规则中的 `unearned_credit`，即使公开仓库允许联网访问也必须判失败。full-access
只代表 Morphz 不等待人工审批，不代表允许访问任务专用解答或私有评测材料。

`financial-document-processor` 在 1200 秒内持续运行，39 次模型调用、51 个 ATIF step，
已提取部分 PDF 文本并逐批识别图片；但在超时前仍处于 Context 维护和剩余文档解释
阶段，没有生成最终分类目录与汇总 CSV。该失败不是 Provider 503、Runtime heartbeat
丢失或容器崩溃。

## 与 v3 Pilot 和正式 v1 的比较

| 指标 | v3 Pilot | v4 Pilot | 变化 |
| --- | ---: | ---: | ---: |
| raw reward | 4/5（80%） | 3/5（60%） | -20 pp |
| input tokens | 1,715,779 | 3,226,051 | +88.0% |
| cached tokens | 47,104 | 155,136 | +229.3% |
| output tokens | 102,246 | 113,769 | +11.3% |
| wall time | 23:25 | 20:29 | -2:56 |

不能把上述差异直接归因于 Runtime v4：五题各只有一次新采样，且路径差异很大。
已有 445-trial v1 数据提供了更可靠的对照：

- `cancel-async-tasks` 在正式 v1 中为 3/5 通过、2/5 失败；两个失败样本同样约为
  4 次调用、89k input、100 秒左右。本轮失败落在已经观察到的模型采样分布内，不是
  v4 特有回归；
- `db-wal-recovery` 在正式 v1 中 5/5 通过，Agent 时间 84–137 秒、input 89k–141k；
  本轮 784 秒和 1.52M input 是明显异常路径，主要由搜索并获取 exact benchmark
  材料造成，不能用来判断正常 Runtime 效率；
- `financial-document-processor` 在 v3 Pilot、正式 v1 五次和本轮 v4 中均失败，形成
  7/7 超时。它是稳定的任务策略/工具效率缺口，而不是新云节点偶发故障；
- `git-multibranch` 与 `polyglot-rust-c` 本轮均比 v3 Pilot 使用更少模型调用并更快
  完成，没有出现统一的 v4 性能回归信号。

## 审计结果

- 5/5 trajectory：ATIF-v1.7 Pydantic 校验通过；
- 5/5 trajectory：官方 `TrajectoryValidator` 通过；
- 5/5 config、trajectory 和每个模型 step：精确 `gpt-5.6-sol` / `max`；
- 153 个文件、43,243,859 bytes：CLIProxyAPI 凭据命中 0；
- `usage_limit_reached`、`auth_unavailable`、HTTP 429、HTTP 503、
  `Provider request failed`：均为 0；
- Harbor retry：0；
- `db-wal-recovery` 出现 3 个 ATIF unmatched background observation。原始事件是后台
  exec 完成/取消通知，官方 validator 接受；这是 projector 因果映射的可读性缺口，
  不是本轮 reward 的直接原因，但正式批次前应修正。

## Gate 判定与下一步

当前：`real_pilot_completed=true / anti_cheat_gate_passed=false /
formal_v2_permitted=false`。

启动下一轮真实模型 Pilot 前必须完成：

1. 在每个 Benchmark Activation 中注入与官方一致的 anti-cheat 约束：禁止搜索、
   读取或复制 Terminal-Bench 任务仓库中的 solution、private tests、hidden reference、
   reward 文件和任务专用在线解答；正常公共技术资料仍允许访问；
2. 增加执行前/执行后的自动轨迹 Gate。命中明确的评测材料访问时直接标记
   `disqualified`，不能只保留 raw verifier reward；
3. 为 Gate 建立合成正负例和本轮 `db-wal-recovery` 回放测试，防止只靠关键词误杀
   正常的 `solution` 变量名或项目测试；
4. 修正后台任务完成事件到原始 tool call 的 ATIF 因果映射；
5. 针对 `financial-document-processor` 设计通用而非题目特定的改进：批量文档/图片
   提取、时间预算感知、优先形成最小可验证产物，以及减少反复重写同一 Context 状态；
6. 上述变更建立新的实验基础设施版本后，重新运行完整五题 Pilot；不得只补跑失败题，
   不得与本轮数据混算。

在新的五题 Pilot 通过基础设施、反作弊和轨迹 Gate 之前，不启动 89 题单次诊断批次，
也不启动 89 × 5 正式批次。
