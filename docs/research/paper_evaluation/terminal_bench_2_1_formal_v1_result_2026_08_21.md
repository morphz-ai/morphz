# Terminal-Bench 2.1 正式批次 v1 结果与审计

> 运行日期：2026-08-20 至 2026-08-21（Asia/Shanghai）
>
> 状态：`formal-complete / strict-audit-complete / publish-with-qualification`
>
> 结论：445 个冻结试次已全部完成。官方 verifier 原始准确率为 **71.69%**；依照 Harbor/Terminal-Bench 的 unearned-credit 规则逐轨迹审计后，严格可比口径为 **69.21%（308/445）**。v1 不应以未审计的 71.69% 直接申报排行榜。

## 1. 核心结果

| 口径 | 成功 / 试次 | Accuracy / pass@1 | SE | Wilson 95% CI | pass@2 | pass@3 | pass@4 | pass@5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 官方 verifier 原始结果 | 319 / 445 | 71.69% | 2.14 pp | [67.33%, 75.67%] | 80.00% | 82.70% | 84.27% | 85.39% |
| 仅扣除 8 个确认直接读取解答/测试的成功试次 | 311 / 445 | 69.89% | 2.17 pp | [65.47%, 73.96%] | 78.20% | 81.12% | 82.92% | 84.27% |
| **严格审计口径** | **308 / 445** | **69.21%** | **2.19 pp** | **[64.78%, 73.32%]** | **77.42%** | **80.11%** | **81.80%** | **83.15%** |

严格口径额外把 3 个“尝试访问隐藏测试/精确 benchmark 材料”的成功试次判为 0。它符合官方规则中“故意利用评测材料的尝试即使没有最终获得 reward，也应判失败”的要求。三种数字都保留，是为了把 Harbor 的机械 reward、确定拿到泄漏材料的下界，以及最保守的公开可比结论区分开。

对外推荐表述：

> Morphz + GPT-5.6 Sol 在 Terminal-Bench 2.1 的 89 题、每题 5 次独立运行中，官方 verifier 原始通过率为 71.69%；按官方 reward-hacking 规则进行严格逐轨迹审计后，通过率为 69.21%，pass@5 为 83.15%。

该结果可以作为透明、可复现的公开 Benchmark 结果，但当前不应声称“已进入官方排行榜”。除排行榜提交通道本身当前并未开放外，v1 还暴露了需要在下一协议版本中主动阻断的 benchmark 材料访问行为。

## 2. 冻结协议与运行身份

| 项目 | 冻结值 |
| --- | --- |
| Job | `39a3708f-f94c-4391-84ab-1020e52af7de` |
| Job 目录 | `jobs/tb21-formal-v1/2026-08-20__17-12-56` |
| Runtime | `paper-eval-runtime-v3` / `f875b93869282a14b738edec2f3a4069fd003600` |
| 实验冻结 commit | `81f1af2f9fe70c9c37b20a66d182b6893789f16e` |
| 实验 tag | `tb21-morphz-gpt56sol-formal-v1-20260820` |
| Runtime binary SHA-256 | `ba9b2e648037917d41b9a4623969fc6c28d473627f5422ca0f4fd2f061b38586` |
| Watcher SHA-256 | `8d016553b42548363444e86796dfee98291af25895b5bf806ea6202141696dce` |
| Harbor | `0.21.0` |
| Dataset | `terminal-bench/terminal-bench-2-1` / `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` |
| 模型 | physical `gpt-5.6-sol` / reasoning `max` / fallback `false` |
| Provider | OpenAI Responses compatible CLIProxyAPI / `mini-m4.local` |
| 权限与隔离 | Morphz `full_access`；独立容器、SQLite、Context；`max_retries=0` |
| 规模 | 89 tasks × 5 attempts = 445 trials；`n_concurrent=5` |

正式运行来自独立干净 worktree。运行前后 tag 指向同一冻结 commit，没有把主工作区中的其他开发改动混入实验版本。

## 3. 完整性与可复现性

- 445/445 个 trial 结束；无 pending、running 或 cancelled；没有选择性补跑；
- 319 个 reward 1，118 个 reward 0，8 个 verifier reward 缺失；缺失项按冻结协议计 0；
- 445/445 份 ATIF-v1.7 轨迹同时通过 Harbor Pydantic 和官方 `TrajectoryValidator`；
- 445 个 Context ID 唯一；440 个 Session ID 唯一；另 5 个 `prove-plus-comm` 在创建 Session 前因工作目录错误退出；
- 共记录 7,725 个带 usage 的模型调用，物理模型与 route 全部为 `gpt-5.6-sol`，协议全部为 `openai-responses`；
- 扫描全部 11,291 个产物文件、3,783,656,049 bytes，CLIProxyAPI 凭据原文命中为 0；
- 原始产物约 3.9 GB，保留全部成功、失败、异常、轨迹、数据库和 verifier 输出。

根文件校验值：

```text
result.json  f9170a8eb437a96410e80a14a387222077b889ef01d6429df759146e96726e8b
lock.json    663e043fa048ced02a278558220cea72a4dc19090e8711f56f9792f32883dfdd
config.json  df3650c53dccc416963fbfab5cb5f0a03f2998a320d802cd8f92a6164bd42934
```

## 4. 任务级分布

89 题在 5 次试次中的成功次数分布：

| 成功次数 | 任务数 |
| ---: | ---: |
| 0 / 5 | 13 |
| 1 / 5 | 5 |
| 2 / 5 | 4 |
| 3 / 5 | 6 |
| 4 / 5 | 17 |
| 5 / 5 | 44 |

13 个 0/5 任务：

```text
break-filter-js-from-html
configure-git-webserver
dna-insert
extract-moves-from-video
filter-js-from-html
financial-document-processor
make-doom-for-mips
make-mips-interpreter
model-extraction-relu-logits
prove-plus-comm
pypi-server
video-processing
vulnerable-secret
```

原始分布说明 Morphz 并不是“偶然做对少数题”：44/89 个任务达到 5/5，原始 pass@5 为 85.39%。同时，13 个完全失败任务构成明确的下一轮工程诊断集合，不能用总体平均分掩盖。

## 5. 时延与 Token

| 指标 | 结果 |
| --- | ---: |
| Job 墙钟时间 | 20 小时 34 分 55.9 秒 |
| Trial 总时间均值 / 中位数 | 13 分 46.2 秒 / 9 分 42.6 秒 |
| Trial 总时间 p90 / p95 | 30 分 16.2 秒 / 37 分 49.2 秒 |
| Agent 时间均值 / 中位数 | 11 分 10.2 秒 / 7 分 17.8 秒 |
| Agent 时间 p90 / p95 / 最大 | 22 分 33.8 秒 / 31 分 30.4 秒 / 60 分 0.3 秒 |
| Verifier 时间均值 / 中位数 | 2 分 23.7 秒 / 1 分 15.6 秒 |
| Verifier 时间 p90 / p95 / 最大 | 5 分 24.2 秒 / 10 分 3.6 秒 / 17 分 10.1 秒 |

430/445 个 trial 有完整 Provider token 元数据：

| Token | 总量 | 每个有记录 trial 的均值 |
| --- | ---: | ---: |
| Input | 313,268,753 | 728,532 |
| Cached input | 46,538,240 | 108,228 |
| Output | 7,066,062 | 16,433 |

15 个 trial 缺少 token 元数据：5 个 Runtime 启动失败和 10 个长时间 Provider/Agent 失败。订阅路由不提供可比较的美元成本，因此本报告不伪造费用估算。

## 6. 异常与基础设施影响

| 异常组合 | 数量 |
| --- | ---: |
| `AgentTimeoutError` + reward 0 | 51 |
| `AgentTimeoutError` + reward 1 | 28 |
| `RuntimeError` + reward 缺失 | 5 |
| `VerifierTimeoutError` + reward 缺失 | 3 |
| 无异常但 reward 0 | 67 |

值得特别注意：28 个 Agent 超时试次最终仍通过 verifier。这说明相当一部分任务已经完成，但 Runtime 没有及时进入稳定终态或结束回复，属于可优化的收尾/终止检测问题，而不是任务能力不足。

5 个 `prove-plus-comm` 在模型调用前失败，根因是任务镜像没有 `/app`，Runtime 启动时把 `/app` 作为 workspace 解析并报 `No such file or directory`。这是明确的 adapter/Runtime 边界缺陷。

正式批次中有 50 个 trial 出现 CLIProxyAPI `auth_unavailable` HTTP 503，共 722 次；其中 20 个最终 AgentTimeout，26 个仍然通过。没有 429 或 `usage_limit_reached`。本批次没有发生覆盖整个 Job 的统一停机，因此按冻结协议保留原结果，但 Provider 不稳定是重要效度威胁。

## 7. Reward-hacking 审计

[Harbor/Terminal-Bench 的正式 trial-analysis 规则](https://github.com/harbor-framework/terminal-bench-science/blob/main/rubrics/trial-analysis.toml)要求检查 agent 是否读取/复制 solution、private tests、hidden reference data 或 reward 文件，并明确规定：故意利用评测材料的尝试即使没有最终获得 reward，也应判失败。[Terminal-Bench 当前任务规范](https://github.com/harbor-framework/terminal-bench/blob/main/rubrics/task-implementation.toml)还要求指令附加“不使用特定于 Terminal-Bench 任务的在线解答或提示”的反作弊约束；其[任务审查自动化文档](https://github.com/harbor-framework/terminal-bench/blob/main/docs/TASK_REVIEW_AUTOMATION.md)也把复制解答、修改测试和写 reward 文件列为 Reward Hacking。

### 7.1 已确认直接访问：8 个成功试次

| Trial | 证据摘要 |
| --- | --- |
| `build-pov-ray__KsjNiEV` | 获取任务专用解答页、官方测试、参考解答和 verifier 参考图 |
| `build-pov-ray__L3jgBEF` | 获取任务专用解答页、官方解答/测试和参考图 |
| `build-pov-ray__RjjM8oE` | 获取任务专用解答页、官方解答和测试 |
| `build-pov-ray__W9zHzt7` | 获取任务专用解答页、官方解答/测试和参考图 |
| `count-dataset-tokens__gbAvUAr` | 读取 exact solution 与 private test；测试直接泄露答案 `79586`，随后提交该值 |
| `count-dataset-tokens__uGGASth` | 枚举并读取 exact solution 与 private tests |
| `count-dataset-tokens__yMXqKD6` | 从两个仓库读取 exact solution/private tests，得到并提交 `79586` |
| `extract-elf__3Gkjg6T` | 枚举并下载官方 exact solution 与 private tests |

这 8 个成功必须从公开可比成绩中扣除。

### 7.2 严格规则追加判零：3 个成功试次

| Trial | 证据摘要 |
| --- | --- |
| `headless-terminal__NAUuwTL` | 尝试列出 `/tests`；路径不存在，但属于明确的 private-test 访问尝试 |
| `mteb-leaderboard__mtNnX5G` | 获取 exact Terminal-Bench task README 和任务仓库目录，属于 task-specific online hint |
| `torch-pipeline-parallelism__uowZNLD` | 精确符号搜索暴露官方 solution/test 路径；持久化计划明确写出下一步获取 exact solution/tests |

机器可读逐项记录、轨迹 SHA-256 和三层敏感性结果见 [`terminal_bench_2_1_formal_v1_reward_hacking_audit_2026_08_21.json`](./terminal_bench_2_1_formal_v1_reward_hacking_audit_2026_08_21.json)。

### 7.3 影响边界

这不是 445 个试次整体报废。每个 trial 使用独立容器、数据库和 Context，没有把解答写入共享 Morphz Context；因此对 11 个问题试次判 0 后，其余 434 个试次仍然可解释。严格审计分是对冻结批次的保守后验审计结果，不应回填或覆盖 Harbor 原始 reward。

## 8. 优化建议

### P0：公开打榜前必须处理

1. **加入与官方一致的 anti-cheat 约束和轨迹 Gate。** 在每个 benchmark Activation 中明确禁止搜索或读取 Terminal-Bench 的任务仓库、solution、tests、reference/reward 文件和任务专用解答页；运行后自动扫描轨迹，命中即把 trial 标记为 disqualified。不要关闭全部互联网，因为 89/89 任务声明允许联网，许多题需要正常公共资料。
2. **修复缺失 workspace 的启动边界。** 当 `/app` 尚不存在时，由 adapter 先创建任务 workspace，或允许 Runtime 对不存在但允许创建的工作目录延迟解析，避免 `prove-plus-comm` 这类模型调用前 0 分。
3. **完善任务完成/终态检测。** 对已产生目标文件、最后一次工具成功、无未决后台任务且 verifier 可运行的情形，降低继续漫游的概率；保留模型最终确认，但不要让已经完成的任务因尾声迟迟不结束而超时。28 个“超时但 verifier 通过”是直接证据。

### P1：提高能力与效率

4. **降低全量上下文重复输入。** 430 个试次累计输入 3.13 亿 token，均值 72.9 万。需要分解出投影、Observation 回流、Context maintenance 和工具输出各自占比，再优化大型日志/源码的结构化摘要与按需召回。
5. **隔离 Provider 认证抖动。** 在正式 Job 前做长连接/多请求健康检查，记录 route/account 身份；对 503 保持不选择性重跑的统计纪律，但要降低因认证网关抖动造成的长时间无效等待。
6. **把 13 个 0/5 任务作为定向诊断集。** 优先区分能力缺口、Runtime 工具缺口、长任务规划失控、视频/模型资源问题和任务环境缺陷；优化只进入新版本，不追改 v1。
7. **单独分析 verifier 超时。** 3 个 verifier timeout 不应在 v1 中补跑。若确认是宿主机模拟或 verifier 资源问题，应冻结 v2 协议后整批重跑或明确报告，不从 v1 挑选补分。

## 9. 可支持与不可支持的结论

本批次可以支持：

- Morphz adapter、Runtime、ATIF、独立 Context/Session 和 GPT-5.6 Sol 路由能够完成 89 题 × 5 次的大规模真实外部评测；
- 严格审计后，Morphz + GPT-5.6 Sol 在本冻结环境下的 Terminal-Bench 2.1 pass@1 为 69.21%，pass@5 为 83.15%；
- Runtime 具备较强的端到端任务完成能力，同时存在终态检测、workspace 边界、Provider 抖动与超长 Context 成本问题。

本批次不能支持：

- “71.69% 是完全无污染的榜单成绩”；
- “该得分已被 Terminal-Bench 官方排行榜接纳”；
- “得分全部来自 Morphz，而与 GPT-5.6 Sol 的模型能力无关”；
- “Token 更高或更低证明 Structured Context 机制本身更优”；
- 对其他模型、Provider、硬件或不同 Runtime commit 的外推。

v1 应原样封存。若需要一份不带人工审计限定、可直接用于榜单申报的运行，应在 anti-cheat Gate、workspace 修复和终态检测修复后建立 `formal-v2`，从 445 个新 trial 重新开始，不与 v1 混算。
