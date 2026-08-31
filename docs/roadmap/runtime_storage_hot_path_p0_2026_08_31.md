# Runtime 存储热路径整改 P0

> 状态：P0 实现与发布门禁已通过
>
> 范围：SQLite、PostgreSQL、Runtime/Orchestrator 共享语义
>
> 原则：性能整改不得弱化幂等、授权、因果、并发调度、恢复和多进程一致性。

## 1. 问题定义

Runtime 的规范化持久化模型承载了 Event、Recall、Session Projection、Thread、Signal、
Activation、Execution Job 和授权等不同权威。此前 Orchestrator 按表和细粒度 Store API
串行组装一次消息接收与 Context 构建，造成重复授权检查、Event sequence 回读、N+1
读取和过多数据库往返。

这不是单纯缺少索引的问题。SQLite 虽没有网络 RTT，重复读取仍增加解析、锁持有和
调用放大；PostgreSQL 的每个客户端 `await` 还会形成一次远程往返。整改目标是将物理
访问数量变成明确、有界、可回归的契约，同时保留规范化数据模型和完整调度语义。

## 2. 不可破坏的语义

P0 保持以下约束，并通过 SQLite/PostgreSQL 共用 conformance suite 验证：

1. **消息幂等**：相同 `(session_id, client_message_id)` 与相同内容返回同一 Event；
   内容不同必须冲突。
2. **提交时授权**：Session 状态、Principal 绑定、引用 Session 归属与状态在原子提交
   边界内复核，不能依赖事务外预检。
3. **因果冻结**：Activation 只消费其 root、trigger 和 input signal 对应的因果前沿。
4. **并发调度唯一性**：一个 Thread generation 同时最多存在一个 queued/running
   Activation；独立 Parallel 消息拥有独立 Thread 和 Signal。
5. **Interrupt/Follow-up**：Interrupt 的取消、接替与输入重放保持原语义；Follow-up
   稳定连接正确 predecessor。
6. **崩溃恢复**：已接受消息、已领取 Signal、running Activation、Model Attempt 和
   Tool continuation 仍可恢复或确定地结算。
7. **多进程 fencing**：lease、revision、generation 和行锁边界继续防止旧 owner 写入。
8. **跨后端等价**：SQLite 与 PostgreSQL 对同一命令序列产生等价权威状态和错误优先级。

## 3. 已实现的存储契约

### 3.1 原子 Ingress Command

`DeliveryIngressStore::claim_message` 是消息接收的权威提交边界：

- 删除 Runtime 事务外、非权威的 Principal 预检；Runtime 仍读取一次 source Session 以解析
  模型、Context 与消息路由，但 `claim_message` 在提交边界内重新验证其可变状态和绑定；
- Event insert 直接返回 sequence，不再追加读取；
- 同一提交边界完成幂等声明、授权复核、首次 Principal encounter、Event、Recall、
  Session Projection、Thread、Signal 与 Session activity；
- PostgreSQL 对最常见的 canonical `user_message + Parallel + 无引用 Session` 路径使用
  一条 data-modifying CTE；
- PostgreSQL 对 `Interrupt` 与 `Follow-up` 使用一次连接、一个短事务、一次 Session 行锁
  和一条 data-modifying CTE，完整物理预算为三条语句；真实运行中断、Provider wait、
  pending/queued 批量与 predecessor 链均在同一原子命令内完成；
- SQLite 使用一次 pool acquire 和一个 `BEGIN IMMEDIATE` 事务，按九项规范化权威执行
  九条确定语句；
- 引用 Session、retired mount、历史幂等修复和兼容事件类型保留通用事务路径；三种正常
  调度模式不再因模式不同落入无界的细粒度访问。

### 3.2 版本化 Context 快照

`ContextRuntimeSnapshotStore` 提供四类有界、带内容 revision 的快照：

1. **Directory**：Context、Cognitive Clock、Mind、Sessions、Objectives、Assignments、
   Capabilities、active Activations、Principal bindings；
2. **Scheduler**：active Threads、待交付 Threads、有界终态历史、Thread Groups、queued
   Schedules 与 pending Signals；
3. **Activation Causality**：Activation input Signals、Thread、trigger/root Event 和
   root sequence；
4. **Execution Resources**：有界 background Jobs、可见 Execution Targets 和授权。

每类快照由数据库内的一条语句构建，彻底消除按 Session、Thread、Group 或 Target 的
N+1。快照间仍是独立的权威读取，不宣称它们构成一个跨语句的全局 MVCC Snapshot；
其 revision 用于审计、比较和后续缓存 fencing。

Context 的 steady-state 读取分为三段关键路径：

1. Directory；
2. 根据 working set 读取 Session Projection；
3. Scheduler、可选 Activation Causality 和 Execution Resources 并行读取。

三项独立快照 Future 在堆上装箱，整个 Context 构建 Future 也在 API 边界装箱，既保留
并行 RTT，又防止大型 SQL Future 被层层内嵌后耗尽默认线程栈。

### 3.3 观测契约

- `morphz_storage_command_duration_seconds{backend,command,outcome}` 记录 pool admission
  加数据库执行的 Store command 耗时；
- SQLx query 与 pool acquire 在 TRACE 级别可追踪，slow acquire 在 WARN 级别报告；
- statement/acquire 数量由隔离的回归测试直接统计 SQLx 物理事件，不用逻辑调用数猜测。

## 4. P0 固定预算

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

steady Context 的四条语句是 Directory、Session Projection、Scheduler 和 Execution
Resources；Activation Context 额外读取一条精确因果快照。后半段独立读取并发执行，
因此两者均只有三段串行数据库阶段。所有预算与历史 Event 数、Session 数和 Thread 数
解耦；各快照内部另有明确的 working-set 或历史上限。

## 5. 发布门禁

P0 完成需要同时满足：

- SQLite/PostgreSQL 共用 Store conformance 全通过；
- 并发幂等、独立 Parallel、并发 Follow-up predecessor、并发 Interrupt batch、真实
  Interrupt、首次 encounter、Session Projection、伪造 route 回滚和授权错误优先级均由
  双后端测试覆盖；
- Context 各快照结果与原细粒度 Store API 逐字段等价；
- Mind retirement、stale CAS、双进程 fencing、Interrupt/Follow-up 和 Runtime 重启
  恢复测试通过；
- SQLite/PostgreSQL statement、pool acquire、连续 20 次 steady Context 预算通过；
- 全量 `morphz` 测试、Clippy、格式和 diff 检查通过；
- 开源前审计报告记录实际预算、已知边界和下一阶段工作，不以目标架构冒充现状。

## 6. P1，而非 P0 已完成项

以下方向有价值，但本次不冒充已经实现：

1. 将 Activation admission/claim 进一步收敛为单一原子 Command；
2. 在 revision fencing 完整后加入进程内 Context 快照缓存；
3. 对可重建 Recall/运营 Projection 做更彻底的异步化；
4. 注入可控 WAN RTT、连接池饱和和数据库故障，建立延迟曲线；
5. 建立不同历史规模、并发 Session 和 Execution Target 数量下的长期基准。
