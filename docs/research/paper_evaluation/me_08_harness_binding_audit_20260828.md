# ME-08 Harness 绑定独立复核（2026-08-28）

## 结论

当前论文采用的 ME-08 Morphz **72/89** 完整运行没有使用 Harness。启动参数、冻结产物与
服务器原始 SQLite 事件三层证据一致，不能用 `terminal-task@0.5.0` 解释 ME-08 与 Codex
之间的得分差异。

## 冻结产物证据

- `run_me08_postfix_all89_morphz.py` 对 Morphz 臂显式传入
  `--harness-mode none`；
- 当前 72/89 运行的 `launcher_manifest.json` 记录
  `harness_mode = "none"`、`harness = null`；
- `strict_result.json` 与逐题 `public_run_gate.json` 均记录无 Harness，逐题轨迹中没有
  Harness 身份。

## 原始数据库复核

对服务器保留的三轮完整 ME-08 逐题数据库做只读聚合，查询：

```sql
SELECT count(*)
FROM events
WHERE topic = 'runtime/evaluation_harness_binding';
```

结果：

| 冻结运行根目录 | 数据库数 | Harness 绑定事件 |
| --- | ---: | ---: |
| `repeat-runs/me08-4bbc3d6-r1-20260827` | 89 | 0 |
| `repeat-runs/me08-new-account-morphz-finalfix-r1-20260827` | 89 | 0 |
| `postfix-runs/me08-postfix-all89-morphz-v2/run-2` | 89 | 0 |
| **合计** | **267** | **0** |

本次复核只读访问冻结数据库，没有重启、补跑、改写或替换任何 Benchmark 结果。
