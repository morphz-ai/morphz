# Four-arm prior-40 artifact bundle

该目录是 `terminal-bench-four-arm-prior-40-v1` 的非敏感冻结证据包。正式运行完成 160/160
trial；三个 Morphz Gate 通过，官方 Codex Gate 因一个保守完整性取消资格未通过。

主要入口：

- [`RESULT.md`](./RESULT.md)：结果、配对统计、异常与解释；
- `*_strict_result.json`：四份不可改写的逐题 strict 结果；
- `*_job_result.json`：Harbor Token、耗时、reward 和异常汇总；
- `*_public_run_gate.json`：三个 Morphz 隔离及凭据 Gate；
- `official_codex_dna_insert_integrity_finding.json`：Codex 唯一取消资格证据；
- `full_launcher_result.json`：四臂 launcher 终态；
- `smoke_summary.json`：不计入正式分数的 smoke 结果。

正式报告使用 strict 分数，不在看到结果后覆盖 Codex 的保守取消资格。此包不包含 Provider
凭据、完整 stdout、SQLite 数据库、任务容器或私有 verifier 内容。
