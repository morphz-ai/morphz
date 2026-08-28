# ME-08：当前 Runtime 下 Terminal-Bench 2.1 完整 89 题 Morphz 协议 v4

> 协议：`me08-terminal-bench-current-runtime-all89-morphz-v4`
> 状态：冻结；按 `3289fe4` Runtime 基线执行
> 主结果：Terminal-Bench 官方 verifier `raw_reward`

## 1. 目的

旧 Runtime 的完整 89 题一次性结果永久保留为历史基线。修复后 24 题定向复测只回答“修复是否
改变了原失败路径”，不得把局部结果拼接进旧分数。本协议在最新 Runtime 上重新运行完整 89 题，
形成最新 Runtime 的正式完整分数。为控制订阅额度，本轮不重复运行 Codex。

## 2. 正式 Arm 与历史参考

正式运行只有原生 Morphz：Runtime commit
`3289fe42056c45c357c4b21b7dfd9390b1d4f1a0`，二进制 SHA-256 为
`4ac3668d219cd25529c287b4dc4f4292f7a77b15f565fea718771ac61dfcd19b`，关闭 Harness。
本轮用于验证统一 Edge/exec 后台执行修复后的完整系统表现；在 89 题全部闭合并完成失败审计前，
不替换论文采用的 `4bbc3d63` 历史同期配对结果。

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

只有以下条件全部满足才可启动：

1. 24 题定向诊断已经生成 `launcher_result.json`、`postfix_summary.json` 和完整
   `strict_result.json`；
2. 89 题集合、Runtime 二进制 SHA-256、Provider、数据集 digest 和启动器 commit 全部写入
   只读 manifest；
3. `validate`、专用单元测试、格式检查和 diff-check 全部通过；
4. 云节点没有残留的正式 benchmark 容器或 launcher。
