# ME-09 r6：同 Runtime、无 Harness 的共享 Context 完整 89 题结果

## 结论

本轮完整闭合 Terminal-Bench 2.1 的 89 道题，官方 verifier `raw_reward` 为
**70/89（78.65%）**。同一 Runtime 的隔离 Context ME-08 控制为
**72/89（80.90%）**；逐题配对差为 **−2.25 个百分点**，任务级 bootstrap 95% 区间
`[−10.11,+5.62]` 个百分点，双侧精确检验 `p=0.774414`。这次单次配对没有解析出显著的
准确率差异。

这不是历史上受 Harness 污染的 ME-09 r3/r4/r5。r6 的 89/89 Trial 均为
`harness_mode=none`，数据库中 `runtime/evaluation_harness_binding` 事件为 0，并且与隔离控制
使用完全相同的 Runtime commit 和二进制。

最能解释“为什么看起来退化”的配对事实是：ME-08 独赢的七题中，四题在 ME-09 超时、一题
触发模型安全拒绝、两题是普通实现失败；与此同时 ME-09 也独赢了五题。因此现有证据更符合
“共享 Context 的维护与等待成本放大了部分长任务失败”，而不是模型能力在所有任务上系统性
倒退。不过，延长时间并不保证八个超时全部转为正确：只有 `train-fasttext` 存在接近完成的
强证据；其余题从“Runtime 贡献很强”到“任务本身两组都做不完”不等。

## 冻结运行身份

- 运行根目录：`/opt/morphz-benchmark/me09-runs/shared-context-full-r6-d6e6d80-max-sessions-50-20260828`
- Protocol：`ME-09-TB2.1-shared-context-8-session-v1`
- 基础设施 commit：`09477921ae35ac94823cb026bf5394a9445b6667`
- Runtime commit：`d6e6d80053d95577811971e6048033374e4d6901`
- Runtime 二进制 SHA-256：`6e7df6e0491947e21f1ca39492c0d7a3732c7950736ba853568ac4dbbcd43037`
- 模型：精确 `gpt-5.6-sol`，`max` reasoning，`full_access`，无 fallback
- 拓扑：一个 Agent、一个共享 Context、八个稳定 Session、八个稳定 Edge Execution Target，
  并发 8；另有 Runtime 内建 `target-default`
- Session 工作集：`max_sessions=50`
- Harness：无
- 样本：89 题，每题一次，零任务/模型重试
- 开始：`2026-08-28T15:45:47.903553Z`
- 结束：`2026-08-28T18:24:20.121734Z`
- 墙钟：9,512.22 秒（约 2 小时 38 分 32 秒）

八个 Target ID 在全部任务中稳定复用。每道 Harbor 题使用新的容器，因而 SQLite 留下 89 个
短生命周期 Edge Node 记录；这表示每题一容器，而不是 89 个并发实例。运行时峰值仍是两个
基础设施容器加八条任务 lane，共 10 个运行容器。

## 完整性 Gate

`RUN_AUDIT.json` 的全部检查均通过：

- `launcher_result.json` 精确记录 89 个唯一任务、八条 lane，所有 Harbor 子进程返回码为 0；
- 89 份官方结果、89 条轨迹、89 份 Runtime receipt 和 89 份完整性记录全部存在，摘要哈希逐项
  一致；
- 一个 Agent、一个 Context、八个共享 Session、八个 Edge Target 加 `target-default`，89 个
  正式任务 Thread 与 89 个唯一 root turn；
- `max_sessions=50`、基础设施/Runtime/二进制身份均与冻结值一致，源 checkout clean；
- Harness 绑定为 0，PlanExecution 为 0；
- 316 个合法资源样本覆盖 9,453 秒，基本覆盖完整运行。

辅助完整性诊断仅把已经由官方判为 0 的 `password-recovery` 标为不合规；它**不覆盖官方
verifier，也不产生额外扣分**。本报告的唯一得分始终是官方 70/89。

## 与同 Runtime ME-08 的逐题配对

| 结果 | 题数 |
| --- | ---: |
| 两组均通过 | 65 |
| 仅 ME-09 共享 Context 通过 | 5 |
| 仅 ME-08 隔离 Context 通过 | 7 |
| 两组均失败 | 12 |

ME-09 独赢：`filter-js-from-html`、`install-windows-3.11`、`mteb-leaderboard`、
`pytorch-model-recovery`、`sam-cell-seg`。

ME-08 独赢：`compile-compcert`、`feal-differential-cryptanalysis`、`password-recovery`、
`qemu-startup`、`rstan-to-pystan`、`torch-pipeline-parallelism`、`train-fasttext`。

这里的配对数据来自同 Runtime 隔离控制根目录
`me08-current-runtime-d6e6d80-r1-20260828`。论文先前冻结的另一轮 ME-08 汇总也恰为 72/89，
但运行身份与逐题轨迹不能互换；本报告没有因为两者总分相同而复用旧的配对行。

## 失败与超时

19 个官方失败原样保留：

- 8 个计零的 `AgentTimeoutError`：`compile-compcert`、`extract-moves-from-video`、
  `make-doom-for-mips`、`model-extraction-relu-logits`、`password-recovery`、`qemu-startup`、
  `raman-fitting`、`train-fasttext`；
- 3 个模型安全拒绝：`break-filter-js-from-html`、`feal-differential-cryptanalysis`、
  `vulnerable-secret`；
- 8 个普通实现/verifier 失败：其余零分题。

此外 `sanitize-git-repo` 也触发了外层超时异常，但它在 deadline 前已留下正确产物，官方
verifier 3/3 通过，所以它仍是官方 1 分。故应表述为“9 个超时异常，其中 8 个计零”，不能把
两种计数混用。

### 八个计零超时的归因

| 任务 | 同 Runtime ME-08 | 主要归因 |
| --- | ---: | --- |
| `compile-compcert` | 通过 | 混合问题。首次 exec 为 335 秒，对照为 20 秒；三次 Context 维护后又走入较慢的 Coq/opam 路径，且留下一条失去终态的旧 Edge child Job。 |
| `qemu-startup` | 通过 | Runtime/共享 Context 贡献很强。首次 exec 411 秒，对照 9 秒；QEMU 阶段出现 Running 但无 live owner/PGID checkpoint 的状态，最终 readiness gateway 未收口。 |
| `train-fasttext` | 通过 | 共享 Context 前置耗时加等待边界。首次 exec 357 秒，对照 14 秒；强模型训练在 deadline 前成功并立即唤醒模型，但模型又选择默认 180 秒 wait，下一次唤醒晚于外层 deadline 约 5 秒。旧 `/app/model.bin` 只有 0.599，阈值为 0.62。 |
| `password-recovery` | 通过 | 主要是模型策略波动。没有 Context 事务或遗留 Job；模型把大部分时间花在错误的 TrueCrypt/keyfile 假设上，对照 115 秒即找到密码。 |
| `make-doom-for-mips` | 超时 | 两组都做不完；共享轮首次 exec 又晚约 366 秒，Context 维护放大了固有难度。 |
| `raman-fitting` | 失败 | 两组都未通过；共享轮把昂贵拟合启动得更晚。有限 wait 正常唤醒，没有证据证明单靠加时即可得到正确拟合。 |
| `extract-moves-from-video` | 超时 | 两组都耗尽 1,800 秒。共享轮有真实 OCR 进展，但采用高成本反复细化流程；无遗留非终态 Job。 |
| `model-extraction-relu-logits` | 失败 | 无 Context 事务，27 秒即开始执行；主要是算法/推理在有限时间内未形成任何必需文件，不支持 Runtime 主因。 |

`train-fasttext` 同时验证了有界等待修复：180 秒 timer 反复按期唤醒，后台 Job 完成也生成了
即时 activation；旧的“永久 no_reply 不再唤醒”没有重现。这里暴露的是默认 180 秒在有限外层
预算下过粗，以及模型在收到成功事件后仍再次选择 wait，而不是完成事件丢失。

八个普通失败均可由 verifier 直接定位：棋题少写一个合法着法；两个 DNA 题的 primer Tm
差超限；G-code flag 抄错字符；gRPC proto 把 `value` 写成 `val`；PyStan 没有生成四个 CSV；
pipeline backward 梯度不匹配；视频跳跃检测在测试视频上泛化错误。完整逐题证据见
`failure_audit.json`。

## 共享 Context 与 Observation frontier

本轮提交 115 个 Context transaction，最终 revision 为 115，其中 46 个自动细粒度 rebase；
事务包含 57 次 derive、53 次 revise，以及 Context 压力下的 protect/unprotect/retire。最终 Mind
投影有 59 个活跃 Frame、3,631 个 retired object；存在一条带跨 Session 来源的
`doom-mips-elf-build-current` Frame，但没有结果相关的正向迁移案例。

机制摘要记录：

- E1：29,502 次跨 Session 可见暴露，涉及 2,097 个唯一 Frame/Session/任务组合；
- E2：17 次显式跨 Session Frame 引用；
- E3：0 个“跨 Session 使用导致 ME-09 独赢”的结果相关案例。

`frontier_audit.json` 对冻结 Runtime 的确定性可见性谓词进行数据库重放：89 个 root、1,461 个
activation 中，post-root 普通跨 Session Observation 有 2,545,928 个候选出现被排除，自己的
因果链 Observation 有 89,200 个候选出现保留；pre-root、仍活跃的跨 Session 历史有 129,448
个候选出现可见。运行没有产生 context-wide broadcast 或 directed cross-session trigger，故这
两条许可路由未被实际覆盖。该重放证明 post-root 普通串扰按设计被阻断；它不是 Provider 请求体
中完整 Observation ID 列表的逐字节复原。

## Token、缓存、墙钟与资源

| 指标 | ME-09 共享 Context | ME-08 隔离 Context | 比值 |
| --- | ---: | ---: | ---: |
| Provider 输入 Token | 176,699,468 | 55,933,502 | 3.159× |
| 其中缓存输入 Token | 21,167,616 | 13,879,296 | 1.525× |
| Provider 输出 Token | 1,870,305 | 1,171,816 | 1.596× |
| 输入+输出 Token | 178,569,773 | 57,105,318 | 3.127× |
| 缓存输入/输入 | 11.98% | 24.81% | — |
| 墙钟 | 9,512.22 秒 | 5,320.20 秒 | 1.788× |

共享 Context 的调用量和输入量显著放大，与 115 次 Context 更新、重复维护轮次和长任务超时一致。
但两轮缓存数字仍处于已知显式缓存封装缺陷影响范围，只作工程诊断，不进入论文成本结论，也不把
全部差额单独归因于 prefix cache。

主机没有持续饱和：16 个逻辑 CPU；1 分钟 load 平均 1.45、p95 4.35、峰值 19.03；内存使用
平均 4.09 GiB、p95 5.81 GiB、峰值 8.88 GiB；运行容器众数和峰值均为 10。资源证据不支持
“CPU/内存耗尽导致总体退化”。

## 结论边界

本轮支持三个工程结论：

1. 无 Harness、同 Runtime 的共享 Context 单次运行与隔离控制只差两题，差异不显著；
2. 回退主要集中在超时、等待和少数安全/实现波动，不是普遍能力坍塌；
3. 共享 Context 在 `max_sessions=50` 下带来约 3.13 倍总逻辑 Token 和更多维护延迟，但尚未产生
   可归因的结果相关正迁移。

它不支持“加时后八题一定全部通过”，也不支持把每个超时都归咎于单一 Runtime bug。本轮作为
ME-09 的有效补充实验登记，不追改已经闭合的中英文论文。

## 产物

- `launcher_result.json`：冻结身份、八 lane 与 89 个任务终态；
- `me09_summary.json`：官方结果、逐题配对和 E0/E1/E2/E3 摘要；
- `RUN_AUDIT.json`：文件哈希、拓扑、身份、资源与完整性 Gate；
- `failure_audit.json`：19 个官方失败、9 个超时异常和逐题归因；
- `frontier_audit.json`：Observation frontier 确定性重放；
- `resource_samples_v2.jsonl`：316 个资源样本；
- `me09_task_manifest_v1.json`：冻结任务清单。

完整 Runtime SQLite、逐题原始 Trial 和轨迹继续不可变地保留在服务器运行根目录；Git 只提交
非敏感摘要和可复核派生证据。
