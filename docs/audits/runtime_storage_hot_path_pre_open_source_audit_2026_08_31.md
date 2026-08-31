# Runtime 存储热路径开源前审计

> 审计日期：2026-08-31
>
> 审计范围：消息接收、并发调度、Context 构建、模型请求前持久化、SQLite/PostgreSQL 等价性
>
> 当前结论：P0 实现、双后端专项门禁和单线程全量测试门禁均已通过。

## 1. 审计结论

本次整改将 Runtime 最常见的消息接收和 Context 构建路径从“由上层按细粒度 Store API
逐项拼装”收敛为有界的存储命令与版本化组件快照。数据库访问数量现在是可测量、可回归
且与历史 Event、Session、Thread 数量解耦的契约。

性能收敛没有通过删除规范化权威或弱化调度语义换取。Event、Recall、Session Projection、
Thread、Signal、Activation、授权、lease 与 revision 仍保留各自的领域职责。SQLite 与
PostgreSQL 共用相同的语义 conformance suite；PostgreSQL 仅对最常见、语义边界清晰的
canonical Parallel ingress 使用单语句快速路径，复杂命令仍走通用事务路径。

当前实现已通过本次开源前 P0 发布验证，但不能据此宣称：

- 所有 Runtime 命令都已经变成一条 SQL；
- 四类 Context 快照构成一个跨语句的全局 MVCC Snapshot；
- 已经完成跨地域 WAN、连接池饱和和大规模多租户压力验证；
- Execution Target 授权已经并入 ingress 的原子提交。Target 仍按既有 Runtime 边界预检，
  并在真正执行副作用时由执行授权再次约束。

## 2. 原问题与根因

原实现把一次 Runtime 周期拆成大量细粒度读取：重复 Session/Principal 检查、Event
sequence 回读、按 Session/Thread/Group/Target 循环加载以及可串行执行的独立快照读取。
这造成三类问题：

1. **访问放大**：物理查询数量随 working set 增长，缺少固定预算；
2. **远程往返放大**：PostgreSQL 中每个独立 `await` 都可能形成网络 RTT；
3. **语义难审计**：同一命令的检查与提交分散，难以判断竞态窗口和错误优先级。

根因不是单一索引缺失，而是 Store API 粒度与 Runtime 命令边界不匹配。因此整改同时处理
命令原子性、读取模型、可观测性和测试预算，而不是只调整索引。

## 3. 实际实现

### 3.1 消息接收

`DeliveryIngressStore::claim_message` 继续作为消息接收的权威提交边界。

PostgreSQL 对 canonical `user_message + Parallel + 无引用 Session` 使用一个
data-modifying CTE，在一条语句中完成：

- Session 状态与 Principal 绑定复核；
- 幂等声明与内容冲突判定；
- Principal first encounter；
- Event 与 sequence；
- Recall 与 Session Projection；
- Thread、Signal 和 Session activity。

该语句对 Session 行加稳定顺序的锁，对 Principal binding 使用共享锁；route 不匹配时
不会留下 Event 或任何部分写入。

`Interrupt` 与 `Follow-up` 需要观察同一 Session 上一条已提交消息，不能直接复用 Parallel
的一条语句：在 PostgreSQL `READ COMMITTED` 下，等待行锁的语句不会为其他表自动取得
锁后新快照。两种有序模式因此使用一次 pool acquire、一个短事务、一次 Session authority
锁和一条 data-modifying CTE。完整入口固定为三条物理语句；CTE 同时完成 predecessor
选择、真实运行中断、Provider wait 取消、queued/pending 批量合并、Event/Projection、
Thread/Signal 与 Session activity，不再执行十余条细粒度查询。

SQLite 使用一次连接获取和一个 `BEGIN IMMEDIATE` 事务。它仍执行九条规范化语句，原因
是本地嵌入式数据库没有 WAN RTT，而保持清晰的领域写入比构造庞大 SQLite CTE 更容易
验证。九条语句是固定预算，不随历史规模增长。

只有引用 Session、retired mount、非 canonical 兼容事件与缺失 fingerprint 的历史幂等
记录继续使用通用修复路径。正常的三种调度模式均有固定操作预算。

Runtime 在调用该提交边界前仍读取一次 source Session，用于解析模型、Context、sandbox
与消息路由等构造期配置。这不是授权依据；Session 状态和 Principal 绑定必须在
`claim_message` 内再次验证。没有引用和指定 Target 的普通消息已删除重复 Principal 查询；
引用消息与可选 Target 的构造期解析仍属于显式、有上限的非普通路径。

### 3.2 Context 构建

`ContextRuntimeSnapshotStore` 提供四类内容寻址、带 revision 的组件快照：

1. Runtime Directory；
2. Scheduler Snapshot；
3. Activation Causality；
4. Execution Resources。

各组件快照在数据库中各由一条语句构建；Session Projection 另由一条有界语句读取。完整
steady Context 因而固定为四条语句，Activation Context 为五条。Directory 与 Projection
构成前两段依赖阶段；Scheduler、可选 Causality 和 Resources 随后并行读取，所以关键路径
只有三段串行数据库阶段。

Directory 的“有界”同时约束语句数和返回基数：Session 的时间窗口、当前 Session 优先级、
Full Projection 数量上限和有界 metadata-only 例外均在 SQLite/PostgreSQL 查询内执行，
不会把 Context 下全部 Session 拉入 Runtime 再过滤。默认查询不按 Principal 隔离；可选
Principal 范围只是调用方显式请求的存储谓词，因此不会破坏一个 Shared Mind 同时服务
多个 Principal 的语义。

每个组件快照内部是单语句一致的。组件之间可能观察到不同提交时刻，因此本次只以 revision
支持比较、审计和未来缓存 fencing，不宣称跨组件全局事务一致性。

### 3.3 Mind retirement

Context Directory 已提供 Cognitive Clock 与 Mind head。retirement finalizer 复用这份状态，
只在 CAS 冲突时重新读取，并通过 revision/head/hash 约束避免旧状态覆盖新状态。Mind 与
Session retirement 的原子提交、stale CAS 重试和恢复恰好一次仍由专项测试保护。

### 3.4 可观测性

新增：

- `morphz_storage_command_duration_seconds{backend,command,outcome}`；
- SQLx statement TRACE；
- pool acquire TRACE；
- 超过 100 ms 的 pool acquire WARN。

Store command 延迟从开始等待连接池时计时，覆盖 pool admission 与数据库执行。物理
statement/acquire 数量不通过业务层计数猜测，而由隔离测试直接统计 SQLx tracing 事件。

## 4. 固定操作预算

| 热路径 | SQLite | PostgreSQL |
| --- | ---: | ---: |
| canonical Parallel ingress | 9 statements / 1 acquire / 1 transaction | 1 statement / 1 acquire |
| canonical idempotent replay / conflict | 3 statements / 1 acquire / 1 transaction | 1 / 1 |
| canonical Interrupt ingress / pending batch | bounded local transaction | 3 statements / 1 acquire / 1 transaction |
| canonical Follow-up ingress / replay | bounded local transaction | 3 statements / 1 acquire / 1 transaction |
| Runtime Directory | 1 / 1 | 1 / 1 |
| Scheduler Snapshot | 1 / 1 | 1 / 1 |
| Activation Causality | 1 / 1 | 1 / 1 |
| Execution Resources | 1 / 1 | 1 / 1 |
| steady Context | 4 statements / 4 acquires | 4 statements / 4 acquires |
| Activation Context | 5 statements / 5 acquires | 5 statements / 5 acquires |

连续二十次 steady Context 也受同一精确操作预算约束。测试环境默认延迟门槛为 SQLite
p95 不超过 250 ms、PostgreSQL p95 不超过 500 ms；它们是防止本地/CI 出现数量级退化的
宽松门禁，不代表生产 SLO。

## 5. 语义验证矩阵

双后端 conformance suite 覆盖：

- 同一幂等键并发竞争，只产生一个 Accepted、一个 Existing 和一个 Signal；
- 同一幂等键、不同 payload 在 Barrier 同步的真实竞争中只产生一个 Accepted 和一个
  Conflict，失败方指向胜出 Event，且不留下第二份 Event/Projection；
- 同一 Session 的两个并发 Follow-up 被行锁串行化，第二条稳定指向第一条提交后的 Thread；
- 同一 Session 的两个并发 Interrupt 在无运行 Activation 时稳定批入同一 pending Thread；
- 两条独立 Parallel 消息并发进入同一 Session，产生不同 Thread 且均被接受；
- 同一 Principal 并发首次进入多个 Session，只产生一个 first-seen；
- Parallel 消息恰好一次进入 Session Projection；
- forged route 被拒绝且事务不留下 Event；
- 未绑定 source 与不支持 reference 同时出现时，授权错误优先级保持一致；
- Directory、Scheduler、Causality、Resources 快照满足既有模型语义；Directory 另外验证
  高基数 Session Registry 只返回配置上限、默认跨 Principal、显式 Principal 谓词可选；
- Interrupt、Follow-up、Activation 唯一所有权、lease/revision fencing 与两进程竞争；
- Model Attempt、background wake、execution job、approval grant 与 Runtime 重启恢复；
- Mind retirement、successor、stale CAS 和恢复恰好一次。

专项操作预算测试覆盖 SQLite 与 PostgreSQL 的 ingress、四类组件快照、完整 steady Context、
Activation Context 和二十次连续构建。观测性单元测试验证 metric 的 backend、command、
outcome 标签及真实样本数。

## 6. 验证记录

已通过：

- `cargo check -p morphz --tests`；
- `cargo clippy -p morphz --tests -- -D warnings`；
- `cargo fmt --all -- --check`；
- `git diff --check`；
- SQLite 全部 Store conformance；
- PostgreSQL 全部 Store conformance；
- SQLite/PostgreSQL 精确 statement/acquire 与连续构建预算；
- Observability 专项测试；
- 默认线程栈下的 Runtime Context/LLM 回归测试。

一次默认并行的 `cargo test -p morphz` 执行了 1099 个 lib 测试，其中 1090 通过、6 忽略、
3 个在高并发资源竞争下失败：两个 Artifact Transfer 超时/未及时结束，一个长期 Objective
测试比预期多观察到一次调用。三个测试分别隔离运行均通过，说明它们不是本次存储整改形成的
确定性语义失败，但暴露了现有全量测试在高并行负载下的稳定性边界。

最终单线程全量门禁使用独立 PostgreSQL 测试库执行：

```text
MORPHZ_TEST_POSTGRES_URL=postgresql://.../morphz_final3 \
  cargo test -p morphz -- --test-threads=1
```

退出码为 0。1099 个 lib 测试中 1093 通过、6 忽略；随后 CLI、Edge、Attempt Loop、
Runtime stability、双后端 Store conformance、SQLite/PostgreSQL operation budget、两进程
fencing 与其余 integration tests 全部通过。

在该全量套件之后新增的 Barrier 同步冲突竞争测试和 replay/conflict 精确预算，又分别通过：

```text
cargo test -p morphz --test runtime_store_conformance -- --test-threads=1
cargo test -p morphz --test storage_statement_budget
cargo test -p morphz --test postgres_storage_statement_budget
```

## 7. 已知边界与后续工作

P1 应继续完成：

1. 收敛 Activation admission/claim 的数据库命令边界；
2. 在 revision fencing 完整后加入进程内 Context 缓存；
3. 注入可控 WAN RTT、连接池饱和、连接中断和数据库故障；
4. 建立不同 Event 历史、并发 Session、Thread 和 Execution Target 规模曲线；
5. 把并行全量测试中的三个时序脆弱用例改为确定性同步，而不是单纯放宽 sleep/timeout；
6. 为生产 SLO 单独建立真实区域、真实网络和真实连接池配置下的持续基准。

## 8. 发布判断

本次实现已经消除已知的无界 N+1 和重复热路径读取，并用双后端语义测试和精确物理操作
预算锁定结果。单线程全量门禁以及新增并发/预算专项均已通过，因此本整改可以判定为开源前
P0 存储门禁通过。默认并行全量测试暴露的三个时序脆弱用例仍应作为测试基础设施债务处理，
不能因为单线程全绿而从后续工作中删除。
