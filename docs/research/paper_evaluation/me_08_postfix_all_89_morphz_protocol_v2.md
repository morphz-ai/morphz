# ME-08：新 Runtime 下 Terminal-Bench 2.1 完整 89 题 Morphz 协议 v2

> 协议：`me08-terminal-bench-postfix-all89-morphz-v2`  
> 状态：24 题 Gate 已通过；云端 run-2 正式运行中；运行中发现的后续 Runtime 修复不追改本批次
> 主结果：Terminal-Bench 官方 verifier `raw_reward`

## 1. 目的

旧 Runtime 的完整 89 题一次性结果永久保留为历史基线。修复后 24 题定向复测只回答“修复是否
改变了原失败路径”，不得把局部结果拼接进旧分数。本协议在最新 Runtime 上重新运行完整 89 题，
形成最新 Runtime 的正式完整分数。为控制订阅额度，本轮不重复运行 Codex。

## 2. 正式 Arm 与历史参考

正式运行只有原生 Morphz：Runtime commit
`ad60e300f115fe84e03a8cd3ab70940deb06ae68`，关闭 Harness。

模型为 `gpt-5.6-sol`、reasoning `max`、fallback `false`、full-access 权限；沿用同一
CLIProxyAPI 订阅路由、云节点和 Terminal-Bench 2.1 digest。

此前已经完成的 Codex CLI `0.149.1` 全 89 题结果可作为历史同环境参考，但它运行于不同时间且
`n_concurrent=1`。因此允许报告逐题描述性差异，不得将其称为本轮同步、同并发的确认性双臂结果。

## 3. 并发与执行顺序

- Morphz `n_concurrent=8`；
- 每题一次，`max_retries=0`；
- 节点任一时刻最多运行 8 个 trial；
- 每个 trial 仍使用独立容器、工作区、SQLite、Context、Session 与产物目录；
- 全程每 30 秒记录 CPU load、可用内存和运行中容器数。

并发 8 也作为规划中 ME-09 的负载基线。ME-08 的 Morphz trial 彼此 Context 隔离；ME-09
拟由一个 Morphz 通过 8 个 Session 共享同一 Context。二者不只相差并发，还相差共享认知状态，
但统一并发可消除明显的负载差异。

## 4. 评分和结果边界

- 官方 verifier 的逐题 `raw_reward` 是唯一主分数；
- 本地完整性扫描只作诊断，不推翻官方评分；
- Provider 拒绝、超时、Agent 错误和 verifier 失败均原样保留；
- 不补跑、不删题、不以修复后局部结果替换正式失败；
- 正式报告 Morphz 通过数、均值与 Wilson 区间；
- 若引用旧 Codex 结果，必须显式标为历史参考；描述性同题胜负、精确检验或 bootstrap 不得
  被解释为同批次同并发的确认性比较；
- 旧并发 1 结果和本轮并发 1 的 24 题诊断均单独保留，不与本结果合并。

## 5. 启动 Gate

以下条件已经在调用正式模型前核验：

1. 24 题定向诊断生成 `launcher_result.json`、`postfix_summary.json` 和完整
   `strict_result.json`；
2. 89 题集合、Runtime 二进制 SHA-256、Provider、数据集 digest 和启动器 commit 全部写入
   只读 manifest；
3. `validate`、专用单元测试、格式检查和 diff-check 全部通过；
4. 云节点没有残留的正式 benchmark 容器或 launcher。

## 6. 当前运行身份

- runner commit：`a226bfef1b555e2d83fa4b3ce6d90790bc522705`；
- annotated tag：`me08-postfix-all89-morphz-v2`；
- Runtime binary SHA-256：
  `af41ba739096f1970a5439d97d21e7ea237937278a7b2c689d990990b00ab0a6`；
- run-1 在首个任务、首个模型调用前因 systemd `PATH` 缺少 Harbor 可执行文件而失败，原目录保留；
- run-2 只修正云端包装器的 `PATH`，核心 runner、Runtime、任务、模型和协议均未改变；
- run-2 根目录：
  `/opt/morphz-benchmark/postfix-runs/me08-postfix-all89-morphz-v2/run-2`；
- systemd unit：`morphz-me08-postfix-all89-morphz-run2-20260826.service`。

## 7. 运行后 handoff 修复边界

run-2 冻结后，`build-pov-ray` 暴露 terminal commit—delivery 竞态：任务结果和 Thread 终态已经
持久化，但旧 revocation watcher 在 EventBus/Delivery 交接完成前把执行 future 取消；同时，
被取消的手工 `BEGIN IMMEDIATE` 可能把开放写事务归还连接池。该问题由通用 Runtime commit
`ac3344ef557d749f0c2f1d1c3ab572586e852e91` 修复，并通过完整 lib、Clippy、格式及针对性回归。

正式 run-2 使用的是更早的 `ad60e300f115fe84e03a8cd3ab70940deb06ae68` 二进制。为保持冻结
协议，运行中的容器、timeout、official reward 和产物均不修改；run-2 闭合后仍按全部 89 个
原始 official reward 报告。随后允许只对确认受该缺陷影响的任务运行一次 `ac3344e` 后诊断，
用于验证通用修复是否恢复交付路径。该诊断必须使用新目录和新 manifest，不能替换 run-2 的
任务 reward、不能拼接成新 89 题总分，也不能冒充与历史 Codex 的同期对照。
