# ME-08：Terminal-Bench 2.1 剩余 49 题双臂协议

> 协议：`terminal-bench-two-arm-remaining-49-v1`
>
> 状态：`frozen-before-model-run`
>
> 日期：2026-08-26

## 1. 研究问题

在相同 Terminal-Bench 2.1 任务、Linux/amd64 容器、GPT-5.6 Sol/max、CLIProxyAPI
订阅路由和 full-access 条件下，原生 Morphz 与官方 Codex CLI 的单次任务完成率是否存在
明显差异；把该结果与已经冻结的前 40 题配对结果合并后，两者在完整 89 题上的表现如何。

## 2. 两个 Arm

1. 原生 Morphz，无 Harness；
2. 官方 Codex CLI `0.149.1`。

不再运行 v0.5 Harness 或哲学 Mind Frame。两个 Arm 每题一次、`max_retries=0`、每臂
`n_concurrent=1`，共 98 个正式 trial。两臂并行，总节点最多同时运行两个任务容器。

## 3. 冻结身份

- 剩余任务：官方 89 题减去 `first_40_tasks_v1.json` 的精确集合差，共 49 题；
- task manifest：`benchmarks/harbor/remaining_49_tasks_v1.json`；
- 云端入口：`benchmarks/harbor/run_me08_cloud.sh`；入口只在进程内读取受管 CLIProxyAPI
  配置，不把代理 Key 写入参数、manifest、任务容器镜像或仓库；
- Harbor `0.21.0`；Terminal-Bench 2.1 registry digest
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`；
- Morphz Runtime：`paper-eval-runtime-v4@5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- Morphz binary SHA-256：
  `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67`；
- Codex CLI：`0.149.1`；
- 模型：`gpt-5.6-sol`，reasoning `max`，fallback `false`；
- Provider：云节点本机 CLIProxyAPI，以用户订阅/OAuth 设备授权为底层账户；Agent 容器
  只收到代理端点及网关访问 Key，不使用 OpenAI 开发者按量 API Key；
- 权限：Morphz `full_access`；Codex 官方 full-access 等价模式；
- 每个 trial 使用独立容器、SQLite、Context、Session 与产物目录。

## 4. 评分与完整性

主指标始终采用 Terminal-Bench 官方 verifier 的 `raw_reward`。本地完整性审计作为附加证据，
不得用粗糙静态规则推翻官方得分。所有失败、超时、安全拒绝和 Provider 错误均保留，不因
得分不理想补跑或删题。

分别报告后 49 题和合并 89 题的：

- 官方通过数与平均 reward；
- 同题 Morphz 胜、Codex 胜、同过、同败；
- discordant pairs 的双侧 exact binomial 检验；
- Provider/Agent/Verifier 异常；
- Token 与墙钟；
- 30 秒采样的主机 load、可用内存与活动容器数。

前 40 和后 49 只有在数据集 digest、模型、权限、Codex 版本、Runtime commit 与 binary
hash 全部相同时才合并；否则只能分层报告。
