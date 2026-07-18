# Context Scalability Baseline — 2026-07-18

这是一份可复现的本地存储微基准，不是公网服务容量承诺。它用于验证 `Mind Projection`、Snapshot 增量恢复和 SQLite Event group commit 的方向是否产生可测收益，并为后续配置阈值提供第一组基线。

## 环境

- CPU：Apple M4 Pro
- 内存：24 GiB
- OS/Arch：macOS / aarch64
- Rust：1.93.1
- 构建：`--release`
- Event：5000 条，每条 payload 512 bytes
- Mind：257 次顺序 Context transaction
- Event Batch：64 条/commit

复现命令：

```bash
cargo run --release -p morphz-evals \
  --bin context_scalability_benchmark -- 5000 257 64
```

## 结果

| 路径 | 操作数 | 物理 commit | 耗时 | 吞吐 |
| --- | ---: | ---: | ---: | ---: |
| 单条 Event append | 5000 | 5000 | 442.500 ms | 11,299 ops/s |
| Event append_batch(64) | 5000 | 79 | 65.076 ms | 76,833 ops/s |
| Context transaction CAS commit | 257 | 257 | 45.407 ms | 5,660 ops/s |
| Mind Projection 热读 | 2570 | 0 | 54.968 ms | 46,754 ops/s |

在这组参数下，SQLite Batch Event 写入相对单条事务提升约 **6.8 倍**。这证明 group commit 值得保留，但默认 `2ms / 64 events` 是否最优仍需在真实对话与工具负载下观察尾延迟。

Projection 审计结果：

| 检查 | 结果 |
| --- | ---: |
| Projection revision | 257 |
| 最近 Snapshot revision | 256 |
| Genesis 全量重放扫描 | 257 transactions |
| Snapshot 增量重放扫描 | 1 transaction |
| Genesis 全量重放 | 672 µs |
| Snapshot 增量重放 | 195 µs |
| 在线 Projection 读取与验证 | 21 µs |
| 三方状态/hash 一致 | true |

只有 257 个小事务时，全量重放已经很快，因此这里更重要的证据是复杂度边界：Snapshot 路径只扫描 Snapshot 之后的 1 条事务，而不是 257 条。更大 Ledger、Frame body 和 Observation 引用下的收益需要长程基准继续验证。

## 当前可以得出的结论

1. SQLite 单写者并不意味着必须逐 Event commit；有界 group commit 明显提高物理写入效率。
2. Mind Projection 的正常读取不再随 Ledger 长度线性增长。
3. Snapshot 增量恢复确实按 Snapshot 之后的事务数量工作，完整 Genesis 重放可以留在显式审计路径。
4. 当前测试没有覆盖网络 Provider、模型延迟、跨进程 Worker、SQLite busy 尾延迟或一百万 Session 注册量，不能据此宣称公开服务可承载 76k 用户请求/秒。

## 下一轮基准

- 1/8/32/128 并发 Session producer 下的 p50/p95/p99 commit latency；
- 1KiB、16KiB、256KiB payload 分层；
- 10k/100k Mind Transactions 下的全量与 Snapshot 增量恢复；
- Context transaction 冲突率与重试成本；
- SQLite WAL busy、checkpoint 和数据库增长速度；
- Provider in-flight 与 Event Writer queue depth 的联合压力。
