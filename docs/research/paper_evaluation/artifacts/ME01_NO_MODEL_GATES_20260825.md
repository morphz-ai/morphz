# ME-01 无模型 Gate 产物索引（2026-08-25）

> 这些产物验证 fixture、评分器和 Runtime 接线，不是模型效果数据，不得进入论文或宣传的
> 模型成功率。

## 代码身份

- fixture、评分器、只读 Context capability：`02bbc03`；
- 内嵌生产 Runtime 因果 Gate：`88b4003`；
- 独立进程、重启、隔离与重评分 Gate：`96ae872`。

## 仓库内产物

1. [`me01_fixture_scorer_gate_20260825`](./me01_fixture_scorer_gate_20260825/)：5 个 fixture、
   三臂 15 个正例、5 个故意负例的 `observed_episode.json` 和 `score.json`；
2. [`me01_embedded_runtime_gate_20260825`](./me01_embedded_runtime_gate_20260825/)：同一生产
   Runtime 路径下 full/read-only 两组 capability 差异；
3. [`me01_standalone_process_gate_20260825`](./me01_standalone_process_gate_20260825/)：5 个
   fixture × 3 arms 的进程阶段报告、消息 transcript、observed episode、score 和总表。

仓库归档只包含脱敏 JSON。独立进程 Gate 的 10 个 SQLite/WAL 原件约 50 MiB，保留在本机：

```text
/private/tmp/morphz-me01-standalone-20260825-r2/
  ME-01-standalone-process-gate-20260825T034133.078Z-52861/
```

该完整原件目录的 `checksums.sha256` 自身 SHA-256 为：

```text
726e9bdabc3465390a76ad9d1c38d78eb54ca06a067bda1ac91b5c8cdca6a1ef
```

临时目录不是长期备份；可复核的 JSON 证据已进入 Git。后续真实模型 Pilot 必须使用新的
不可变 artifact root，并将数据库备份位置与整包校验值写入对应结果报告。

## 已确认结论

- fixture/scorer：15/15 正例通过，5/5 负例被拒绝；
- 内嵌因果链：full arm 为 1 次 `context_tx` 尝试、1 次提交且 Frame 进入后续投影；
  read-only arm 为 0 尝试、0 提交、工具不可见；
- 独立进程 Gate：15/15 接线正例通过；两个 Morphz arms 的 10/10 episode 均由不同 PID
  执行重启前后阶段，并从各自独立 SQLite 恢复；
- 跨 Session 同 Context 挂载通过；不同 Context 隔离通过；15/15 原始 observed episode
  重评分逐字节一致；
- 三轮 Gate 真实模型调用数均为 0。

## 尚不能得出的结论

- 不能据此声称 Morphz 比 append-only messages 更准确；
- 不能据此声称结果直接回流已经提高模型成功率；
- 不能据此声称真实 Provider、Sol/max、usage 或 full-access 绑定已通过；
- 不能跳过真实三臂 smoke 直接进入完整 Pilot。
