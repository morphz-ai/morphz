# Terminal-Bench 2.1 `terminal-task@0.3.0` 未见 20 题安全归档

本目录保存 2026-08-24 固定 registry 顺序第 21–40 题、每题一次、并发 5 的开发验证结果。
原始云端 job 为：

```text
/opt/morphz-benchmark/diagnostic-jobs/unseen-20-v03-r1/2026-08-24__13-59-22
```

## 内容

- 根目录 `result.json`：Harbor 原始汇总；
- 根目录 `strict_result.json`：完整性审计后的严格汇总；
- 根目录 `public_run_gate.json`：运行完成时生成的 public Gate；
- 根目录 `config.json`、`lock.json`：Harbor 配置与锁定身份；
- 每个 trial 的 `result.json`、`benchmark_integrity.json`；
- 每个 trial 的 Morphz 所有、ATIF-v1.7 `agent/trajectory.json`。

共 65 个文件，约 4.3 MiB，包含 20/20 条轨迹。本目录不包含任务 workspace、SQLite
数据库、Provider 凭据、隐藏 verifier、private tests、verifier 日志或参考答案。

## 校验值

```text
safe archive   e09d17d10273162ab595889b32968d7dd9e424beb88ff8df4a3b3cff69890714
result.json    0a7a1ddf504e44e0c43589c7d43caa041a9a1619f266b70457f27662cdaa447f
strict_result  e972c5164920fcf4e0cc4213442039039575adbd34daa9a4cf0cc2ebd07d0b72
public gate    d4d3b889549191201abcffa72afb11d1ca99061febe3a74e95d92027b63a6ac9
```

每个 trial 的 `trajectory_sha256` 还记录在 `public_run_gate.json` 中。

## 重要的事后审计更正

`public_run_gate.json` 原样保留、不得追改。它把本批标记为 `provider_clean=true`，但该版
Gate 只统计 429、503、额度、认证和一般请求失败，没有统计 OpenAI Responses 的
`cyber_policy` 错误。只读检查 Morphz 运行日志确认：`vulnerable-secret` 的所有模型请求
均被 Provider 安全审核拒绝，Runtime 又把该永久拒绝误分为 `server_unavailable` 并反复
恢复。完整解释见同级结果报告。此更正不调整 Harbor 原始或严格 reward。
