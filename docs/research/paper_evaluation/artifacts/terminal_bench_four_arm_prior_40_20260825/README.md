# Four-arm prior-40 artifact bundle

该目录是 `terminal-bench-four-arm-prior-40-v1` 的非敏感冻结证据包。正式运行完成 160/160
trial。对外主口径采用 Harbor/Terminal-Bench 官方评分器：原生 Morphz 75.0%，官方 Codex
70.0%。我们自行增加的完整性 Gate 因一条 `-prune /tests` 命令产生保守误报，仅作为附加
审计历史保留。

主要入口：

- [`RESULT.md`](./RESULT.md)：结果、配对统计、异常与解释；
- `*_strict_result.json`：四份不可改写的逐题官方 reward 与本地附加审计结果；
- `*_job_result.json`：Harbor Token、耗时、reward 和异常汇总；
- `*_public_run_gate.json`：三个 Morphz 隔离及凭据 Gate；
- `official_codex_dna_insert_integrity_finding.json`：Codex 唯一取消资格证据；
- `full_launcher_result.json`：四臂 launcher 终态；
- `smoke_summary.json`：不计入正式分数的 smoke 结果。

正式报告和对外比较使用官方 `raw_reward`；本地 `strict_reward` 不取代官方评分。此包不
包含 Provider 凭据、完整 stdout、SQLite 数据库、任务容器或私有 verifier 内容。
