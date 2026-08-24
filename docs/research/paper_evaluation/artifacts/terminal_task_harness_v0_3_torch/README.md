# terminal-task v0.3 Torch 执行轨迹

本目录保存 2026-08-24 预注册的单次 `torch-pipeline-parallelism` Harness v0.3 诊断材料。
本轮 attempts/concurrency/retries 为 `1/1/0`，reward 为 `0.0`，公开异常为
`AgentTimeoutError`。它不是可对外报告的 Terminal-Bench 成绩。

范围限定：这里只保存公开 run metadata、完整性/公开 Gate 与 Morphz 自有 trajectory；不包含或
引用隐藏 verifier、private tests、reference answer 或 verifier 日志。

## 文件

- `result.json`：Harbor 公开结果；
- `strict_result.json`：完整性策略下的严格结果；
- `benchmark_integrity.json`：单 trial 完整性审计；
- `public_run_gate.json`：公开运行 Gate 与冻结身份；
- `trajectory.json`：ATIF JSON；
- `trajectory.readable.md`：ATIF 的可读 Markdown 投影（仅规范化行尾空白）。

## SHA-256

```text
fbf400294729c8f3631154becccb1f7db762ede17c851ff5e2b4ccb0c5f75fd4  benchmark_integrity.json
f931f39090306d7f6b624e073fee52cccad2738c6793dbfe5e1d5a5595f44908  public_run_gate.json
9a5836e11e773ebb765d0074a9c5e51f7c78aef416f6057dfe187e612621c935  result.json
85cfe157343463264b165e046fad989c0d3d2c852077f322566741e604e3a6da  strict_result.json
6ddd83f1f9a61cf53bb181801291e0750828de0bb677c4201877333f2fbc8ce9  trajectory.json
b7441547b3fd525ac675ff9171a464841b177b4b7c6b5f45620b04c60911007d  trajectory.readable.md
```

结论与 v0.2 对照见
[`terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md`](../../terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md)。
