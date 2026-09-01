# ContextDB SQLite 单机实验与基准 v1

> 日期：2026-09-01
> 状态：实验结果 + 默认关闭的 SQLite Runtime Integration Preview
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

基础数据库位于 `morphz/src/experimental/context_db.rs`，Runtime Adapter 位于
`morphz/src/experimental/context_db_runtime.rs`。默认构建不会启用它；同时打开 Cargo
`experimental-context-db` 和 Runtime `context-db` permit 后，SQLite Runtime 使用
ContextDB 作为当前 Mind 的权威存储。

SQLite 中只创建三个带 `experimental_contextdb_` 前缀的对象集合：

- `contexts`：Context head、revision、root hash 与归属信息；
- `nodes`：稳定 Node、parent/order、authority、Node revision、规范 body 和 Merkle hash；
- `receipts`：有界幂等回执，不保存可 Recall 的应用历史或模型内容历史。

当前基础操作包括：

- `InsertNode`；
- `ReplaceNode`；
- `DeleteSubtree`；
- `MoveSubtree`。

Runtime Integration Preview 已实现：

- 完整 `MindState` 与开放 Frame body 的结构化 AST 往返；
- 稳定 Node ID、局部 AST Diff 与当前 Mind 权威读取；
- Agent Trajectory、Session Projection、Recall outbox 和 Runtime Control 的同事务提交；
- 失败回滚、重启恢复、真实对话与完整 Agent Trajectory 导出；
- 旧 SQLite Runtime 数据的一次性精确导入；导入后 ContextDB 优先于兼容行；
- ContextDB 模式下的 Mind、Context Encoding、Runtime Directory 和 Head List 权威读取。

当前尚未实现 Reference Edge、Selector、Watch、Historical Snapshot、独立 Archive 后端、
PostgreSQL ContextDB 后端和 Runtime Control 全量 AST 化。迁移期仍同步维护旧 Mind 行作为
兼容读模型，但 ContextDB 模式不从这些行读取当前 Mind。

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
16. 旧 Runtime Mind 精确导入一次，重复启动不会覆盖 ContextDB 权威状态；
17. AST、Agent Trajectory、Session retire/restore、Recall outbox 在同一事务中共同提交或回滚；
18. 兼容 Mind 行被物理破坏后，Mind、Runtime Directory 和 Head List 仍从 ContextDB 精确读取；
19. 稳定 Node ID 被物理篡改时，优化加载器 fail closed；
20. ContextDB 模式完成真实消息—模型回复，并导出可验证的完整 Agent Trajectory；
21. Runtime 重启后恢复待处理工作，不丢失当前 Mind 或控制语义。

测试命令：

```bash
cargo test -p morphz --lib --features experimental-context-db context_db::tests
```

变基到主线 `d86f815c` 后的最终回归结果：

- 默认特性单线程全量回归：1100 passed，6 ignored；
- 启用 `experimental-context-db` 的单线程全量回归：1118 passed，6 ignored；
- ContextDB 定向测试：18 passed。
- `cargo check -p morphz --all-targets --all-features` 通过；
- `cargo clippy -p morphz --all-targets --all-features -- -D warnings` 通过。

并行全量回归曾出现一个权限测试命中 SQLite busy 保护分支；该用例单独复跑通过，包含它的
完整单线程套件也通过。它没有依赖 ContextDB，但说明现有并行测试套件仍存在负载敏感性，
应独立跟踪，不能把失败轮次隐藏成全绿。

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

### 5.1 Runtime Adapter A/B

底层 AST 基准不能代表完整 Runtime 提交。为此增加：

```bash
cargo run -p morphz --release \
  --features experimental-context-db \
  --example context_db_runtime_benchmark
```

该基准让旧 SQLite 路径和 ContextDB 路径提交完全相同的 `MindState`、Agent Trajectory
Event 和事务控制，只改变当前 Mind authority。每轮修改一个 Frame，同时保持整体 Mind
尺寸稳定；计时包含调用侧 JSON 构造、state hash、数据库事务和持久化。

| Mind JSON | Frame 数 | 路径 | 完整 Runtime commit p50 / p95 / p99 | 权威 Mind read p50 / p95 / p99 |
|---:|---:|---|---:|---:|
| 193,809 B | 256 | 旧 SQLite | 1.193 / 1.618 / 6.012 ms | 0.181 / 0.189 / 0.196 ms |
| 193,809 B | 256 | ContextDB | 3.060 / 3.674 / 4.224 ms | 1.937 / 2.137 / 2.201 ms |
| 1,111,313 B | 256 | 旧 SQLite | 4.488 / 6.171 / 11.096 ms | 0.405 / 0.419 / 0.438 ms |
| 1,111,313 B | 256 | ContextDB | 9.096 / 10.427 / 12.124 ms | 6.723 / 6.994 / 7.076 ms |

当前结论必须诚实分成两层：

- ContextDB 核心局部 AST Mutation 已证明不随未触碰大子树线性重写；
- 兼容 Runtime Adapter 仍接收完整 `MindState`，因此需要一次结构快照加载、逐 Node
  校验和 AST Diff。它在约 1.1 MB Mind 下仍保持本机 p95 commit 10.427 ms、read
  6.994 ms，但尚未比旧单 JSON 行更快。

这不是通过减少语义换性能：Agent Trajectory、Session Projection、Recall 与 Runtime
Control 仍完整提交。后续优化方向是让 Context domain 直接提交已确定的 Node operations，
并复用 Resident AST / 编码缓存，从而消除兼容 Adapter 的全状态 Diff；在此之前，不宣称
ContextDB Runtime 路径具有整体性能优势。

## 6. 本轮结论与迁移门禁

SQLite 单机实验与 Runtime Integration Preview 已经证明：Context AST authority、Node 级
局部修改、细粒度 OCC 和物理持久化可以同时成立；Morphz 可以保留完整 Agent Trajectory
与现有恢复能力，而不依赖历史重放来读取当前 Mind。

该结果已经足以在显式特性门下替换 SQLite Runtime 的当前 Mind authority，但还不足以
成为默认路径或替换所有 Runtime Control 存储。进入默认路径前至少还需要：

1. 完成默认与 ContextDB 路径的全量语义 conformance / A-B suite；
2. 完成工具 continuation、调度恢复、长时间 Agent 和多 Session 故障注入；
3. 建立明确的 SQL/字节预算和 Runtime Adapter 性能基线；
4. 决定 Thread/Session Control AST 化的协议，而不是机械迁移现有表；
5. 补齐 Reference Edge、Selector、Watch 与 Ready Index；
6. 把后端无关的事务语义从 SQLite 适配器中抽出，再实现 PostgreSQL 后端；
7. 只有完整回归、性能和回滚门禁通过后，才考虑默认启用。

因此当前决定是：保留默认关闭的完整 SQLite Runtime 路径，以它作为 ContextDB 语义、
兼容性和性能基线；继续保留一键回到旧实现的能力，在门禁完成前不改变默认生产路径。
