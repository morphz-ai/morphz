# ContextDB SQLite 单机实验与基准 v1

> 日期：2026-09-01
> 状态：实验结果；不代表当前 Morphz Runtime 已迁移
> 特性门：Cargo `experimental-context-db` + Runtime `context-db` permit

## 1. 本轮验证的问题

本轮不是把现有 EventStore 换一种表结构，而是验证一个更基础的命题：把当前 Context AST 作为权威状态以后，单机数据库能否同时满足以下条件：

- Context revision 提供确定提交顺序；
- 稳定 Node ID 与 Node revision 提供细粒度 OCC；
- 不相交 Node 的过期事务可以安全 semantic rebase；
- 相关 Node 的并发写入不会退化成 blind last-write-wins；
- 局部修改不读取或重写完整 Context；
- Agent 与 Runtime 的 authority domain 不会相互越权；
- 相同幂等请求不会产生第二次逻辑写入；
- Snapshot 的 Meta、Node 和规范 S 表达式属于同一个一致版本；
- 未启用 Archive / Recall 时，retire 是物理删除，不暗中保留应用 Event History；
- 进程重启后能够从当前 AST 恢复。

## 2. 实现边界

实验代码位于 `morphz/src/experimental/context_db.rs`，默认构建和现有 Runtime 都不会使用它。

SQLite 中只创建三个带 `experimental_contextdb_` 前缀的对象集合：

- `contexts`：Context head、revision、root hash 与归属信息；
- `nodes`：稳定 Node、parent/order、authority、Node revision、规范 body 和 Merkle hash；
- `receipts`：有界幂等回执，不保存可 Recall 的应用历史或模型内容历史。

当前基础操作包括：

- `InsertNode`；
- `ReplaceNode`；
- `DeleteSubtree`；
- `MoveSubtree`。

本轮尚未实现 Reference Edge、Selector、Watch、Historical Snapshot、Archive / Recall 扩展、PostgreSQL 后端和 Runtime Adapter。它们不能因为 SQLite 原型通过而被宣称完成。

## 3. 热路径设计

### 3.1 一致 Snapshot

Context Meta 和 Node arena 在同一个 SQLite read transaction 中读取，避免把提交前的 Context head 与提交后的 Node 混成一个 Snapshot。

### 3.2 局部写入

叶子 body 更新一次完成：

1. 在取得 writer lock 之前校验并规范化新的 S 表达式；
2. 对规范请求计算幂等 digest，因此空白差异不会制造假冲突；
3. 取得事务后校验 Node revision 与 authority；
4. 更新目标 Node 的 body、content hash、subtree hash 和 Node revision；
5. 用一个递归 CTE 取得受影响的祖先闭包；
6. 批量读取这些祖先的直接 child hash；
7. 自底向上只更新 hash 实际变化的祖先；
8. 提交一个新的 Context revision 和幂等回执。

未受影响的子树只以 64 字节 Merkle root 参与祖先计算，其 body 不进入修改热路径。

单事务当前限制为 4096 个操作、合计 64 MiB Node body。它允许验证 10 MiB Context，同时避免无界请求占用单机 writer。

### 3.3 并发语义

SQLite `BEGIN IMMEDIATE` 为单文件写入提供确定提交顺序。全局 Context revision 不是唯一冲突边界：

- `base_revision` 落后但目标 Node revision / subtree hash 仍满足时，事务可以 rebase；
- 同一 Node 的并发 replace 只有一个满足预期 revision；
- 不同 Context 在语义上独立，但 SQLite 单文件物理写入仍由单 writer 串行化。

最后一点意味着 SQLite 适合单机参考实现、Edge Node 和前期验证，不代表它就是未来云端分片后端。

## 4. 正确性测试

定向测试覆盖：

1. 规范 AST 创建、稳定排序与完整性审计；
2. 只更新目标 Node 和祖先路径；
3. stale disjoint rebase 与 related write conflict；
4. 幂等回放、幂等键误用检测和多操作事务回滚；
5. Agent / Runtime / System authority 边界；
6. subtree move、环检测与物理 retire；
7. SQLite close/reopen 后的精确恢复；
8. 24 路不相交写入全部提交；
9. 8 路同 Node 竞态恰好一个成功；
10. 并发读写不混合 Context head 与 Node 版本；
11. 1 MiB 未触碰子树不被重写；
12. 物理 hash 损坏可被 audit 发现；
13. `:memory:` 模式保持单一、连贯的 SQLite 数据库；
14. 自动补括号的既有容错被保留，但多个顶层表达式会被拒绝；
15. future revision、root 删除、重复 Context 和非法 S 表达式均失败且不留下部分状态。

测试命令：

```bash
cargo test -p morphz --lib --features experimental-context-db context_db::tests
```

最终回归结果：

- 默认特性：1098 passed，6 ignored；
- 启用 `experimental-context-db` 的单线程全量回归：1112 passed，6 ignored；
- `--all-features` 下 ContextDB 定向测试：15 passed；
- ContextDB 文档测试与严格 Clippy 检查通过。本轮 Clippy 命令仅屏蔽了工作树其他并行改动产生的既有 warning，没有屏蔽 ContextDB warning。

并行全量回归两次只出现同一个既有
`runtime::tests::live_session_signal_is_symmetric_and_runs_target_concurrently`
60 秒时序超时；该用例单独复跑通过，完整套件使用单线程调度也通过。它没有依赖 ContextDB，但说明现有测试套件仍有一个负载敏感的稳定性问题，应独立跟踪，不能把失败轮次隐藏成全绿。

## 5. Release 基准

运行环境为本次开发机；数字只用于比较同一实现的增长趋势，不外推为生产 SLA。每组执行 200 次同一小叶子 replace、25 次完整 Context 读取，以及 8 个独立 Context 各 25 次并发写入。

```bash
cargo run -p morphz --release \
  --features experimental-context-db \
  --example context_db_sqlite_benchmark
```

| 冷 sibling payload | 局部提交 mean | p50 | p95 | p99 | 完整读取 mean | 独立 Context 吞吐 |
|---:|---:|---:|---:|---:|---:|---:|
| 0 MiB | 0.243 ms | 0.226 ms | 0.323 ms | 0.413 ms | 0.057 ms | 1318.2 tx/s |
| 1 MiB | 0.318 ms | 0.308 ms | 0.352 ms | 0.409 ms | 2.511 ms | 1596.1 tx/s |
| 2 MiB | 0.427 ms | 0.410 ms | 0.446 ms | 0.608 ms | 5.144 ms | 1797.8 tx/s |
| 10 MiB | 1.216 ms | 1.200 ms | 1.305 ms | 1.429 ms | 26.205 ms | 1032.1 tx/s |

不同组的并发吞吐受短基准、文件大小、WAL checkpoint、操作系统缓存与调度抖动影响，不能按 payload 推导单调关系。更可信的两个结论是：

- 完整 Context 读取与实际输出字节近似线性增长，这是预期成本；
- 10 MiB 冷 sibling 存在时，小叶子提交仍为约 1.2 ms，而测试 trigger 证明大 sibling 行没有发生 UPDATE，说明热路径没有重写完整 Context。

基准程序可通过以下环境变量扩展：

- `MORPHZ_CONTEXTDB_BENCH_MIB`；
- `MORPHZ_CONTEXTDB_BENCH_ITERATIONS`；
- `MORPHZ_CONTEXTDB_BENCH_CONTEXTS`；
- `MORPHZ_CONTEXTDB_BENCH_WRITES_PER_CONTEXT`。

## 6. 本轮结论与迁移门禁

SQLite 单机实验已经证明：Context AST authority、Node 级局部修改、细粒度 OCC 和物理持久化可以同时成立，而且不需要把应用 Event History 继续作为核心事实源。

该结果足以进入下一阶段，但还不足以直接替换当前 Runtime。迁移前至少还需要：

1. 将当前 Morphz `derive / revise / retire / relate` 确定性编译成 Context Transaction；
2. 建立旧存储与 ContextDB 的语义 conformance / A-B suite；
3. 补齐 Reference Edge、Thread/Session 控制节点、Selector 与 Ready Index；
4. 做真实长时间 Agent、工具恢复和多 Session 压测；
5. 把后端无关的事务语义从 SQLite 适配器中抽出，再实现 PostgreSQL 后端；
6. 只有双写、校验、故障注入和回滚门禁通过后，才改变 Runtime authority。

因此当前决定是：保留该实现为默认关闭的实验特性，以它作为 ContextDB 语义和性能基线；不在缺少兼容证明时直接替换现有生产路径。
