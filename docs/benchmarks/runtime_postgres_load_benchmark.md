# Runtime + PostgreSQL 并发容量基准

## 目的

这个基准测量 Morphz 服务本身，而不是模型推理速度。它保留真实的：

- Session 消息接入与幂等声明；
- Thread / Activation 调度；
- 结构化 Context 编译；
- PostgreSQL 持久化与回复提交；
- exactly-once 完成检查。

模型 Provider 被替换为确定性 Mock，默认立即返回 `benchmark-ok`。可以设置一个很小的固定延迟，用来观察 Provider 调度窗口是否真正并发，而不产生真实模型成本。

它与现有测试的分工不同：

- `postgres_storage_statement_budget` 锁定单个存储操作的物理 SQL / round-trip 预算；
- `postgres_multi_process_probe` 验证多 Runtime single-flight、租约和故障恢复正确性；
- 本基准验证多用户并发下的延迟、吞吐、长尾和完成完整性。

## 安全边界

基准只接受显式命名的 `MORPHZ_BENCH_POSTGRES_URL`。每次运行都会：

1. 创建唯一的 `morphz_runtime_load_*` schema；
2. 在该 schema 中执行 Morphz migration 和负载；
3. 成功完成后删除该 schema。

设置 `MORPHZ_BENCH_KEEP_SCHEMA=1` 可以保留失败现场用于诊断。不要把没有创建、删除 schema 权限的生产连接直接交给该工具。

## 运行

```bash
MORPHZ_BENCH_POSTGRES_URL='postgresql://...' \
MORPHZ_BENCH_CONTEXT_STORE=legacy \
MORPHZ_BENCH_TOPOLOGY=shared_context \
MORPHZ_BENCH_CONCURRENCY=16 \
MORPHZ_BENCH_MESSAGES=64 \
MORPHZ_BENCH_POSTGRES_POOL_SIZE=16 \
MORPHZ_BENCH_MODEL_DELAY_MS=5 \
cargo run -q -p morphz-evals --bin runtime_postgres_load_benchmark
```

ContextDB 对照臂必须显式编译并选择，不能把默认旧存储结果误记为 ContextDB：

```bash
MORPHZ_BENCH_POSTGRES_URL='postgresql://...' \
MORPHZ_BENCH_CONTEXT_STORE=contextdb \
MORPHZ_BENCH_TOPOLOGY=shared_context \
MORPHZ_BENCH_CONCURRENCY=16 \
MORPHZ_BENCH_MESSAGES=64 \
MORPHZ_BENCH_POSTGRES_POOL_SIZE=16 \
MORPHZ_BENCH_MODEL_DELAY_MS=0 \
cargo run -q -p morphz-evals --features context-db \
  --bin runtime_postgres_load_benchmark
```

完整参数：

```bash
cargo run -q -p morphz-evals --bin runtime_postgres_load_benchmark -- --help
```

### Topology

- `shared_context`：多个外部用户通过独立 Session 与同一个 Agent / Context 并发交互。这是当前面向用户的 Agent 产品最重要的拓扑。
- `isolated_contexts`：每个外部用户使用独立 Context，但仍由同一 Runtime 进程和 PostgreSQL 连接池承载。它用于提前暴露未来多 Agent / 多租户形态的调度问题，但不等价于完整租户隔离。

## 输出指标

- `database_select_one`：连接池内并发 `SELECT 1` 的 p50 / p95 / p99，近似观察数据库 RTT 与连接池等待；
- `ingress`：从客户端提交到消息持久接受的延迟；
- `end_to_end`：从提交到持久 `chat/reply` 完成的延迟；
- `turn_stages`：按稳定阶段名聚合的 p50 / p95 / p99，用于把 Context、调度、Provider
  和持久化长尾分开诊断；
- `throughput_messages_per_second`：完整逻辑 turn 的吞吐；
- `model_calls` 与 `peak_model_concurrency`：Mock 调用次数及物理 Provider 并发峰值；
- `accepted_messages` 与 `replies`：用于发现丢回复、重复执行和非终态泄漏。

普通消息负载不会自动产生 `context_tx`。当前 Mind 权威存储的局部修改性能必须另用
`context_db_postgres_runtime_benchmark` 测量；该工具在两个隔离 schema 中交替执行旧
Projection 与 ContextDB 的等价 Mind commit/read，避免把第二个运行的缓存优势误当成架构
优势：

```bash
MORPHZ_BENCH_POSTGRES_URL='postgresql://...' \
MORPHZ_CONTEXTDB_RUNTIME_BENCH_FRAMES=256 \
MORPHZ_CONTEXTDB_RUNTIME_BENCH_BODY_BYTES=4096 \
cargo run -q -p morphz-evals --release \
  --features context-db \
  --bin context_db_postgres_runtime_benchmark
```

多租户云端最重要的不是单个 Context 能否违反顺序语义，而是互不相干的 Context 能否一直
并行到 PostgreSQL 本身饱和。`context_db_postgres_concurrency_benchmark` 为每个 worker
创建一个独占 Context，Context 内串行提交、Context 间通过 barrier 同时启动；它把 typed
state commitment 的 CPU 时间和 Store commit 分开统计，同时采样连接池、`pg_stat_activity`
资源等待、负载中的低频 `SELECT 1`，并强制刷新后读取当前测试 schema 独占的表/索引 IO
统计：

```bash
MORPHZ_BENCH_POSTGRES_URL='postgresql://...' \
MORPHZ_CONTEXTDB_CONCURRENCY_LEVELS=1,2,4,8,16,32,64 \
MORPHZ_CONTEXTDB_CONCURRENCY_COMMITS_PER_CONTEXT=64 \
MORPHZ_CONTEXTDB_CONCURRENCY_FRAMES=64 \
MORPHZ_CONTEXTDB_CONCURRENCY_BODY_BYTES=512 \
MORPHZ_CONTEXTDB_CONCURRENCY_POOL_SIZE=64 \
cargo run -q -p morphz-evals --release \
  --features context-db \
  --bin context_db_postgres_concurrency_benchmark
```

### 指标口径

- `completed turns/s`：一条用户消息从 Runtime ingress 开始，经过调度、Context build、一次
  Mock 模型调用，直到收到对应 `chat/reply`；必须同时满足 accepted、reply、model call
  exactly once。
- `Context commits/s`：直接执行一次 `commit_context_mutation_transaction`，包含一个持久 Event、
  一个 fenced Context mutation 和同事务控制状态；不包含用户消息调度、模型调用与 reply。
- 两者没有固定换算关系。普通对话可能为 0 次 Context commit；一次包含多个 `derive/revise`
  工具循环的 Turn 也可能产生多次 commit。因此 Runtime 基准同时报告
  `context_commits_per_completed_turn`，禁止用存储 commit 吞吐冒充用户 Turn 吞吐。

## 2026-09-01 本机 PostgreSQL 15.14 首轮基线

这些数字只验证工具和当前实现，不是线上容量承诺。测试数据库与 Runtime 位于同一台 Apple Silicon 主机。

| Topology | 并发 / 消息 | Mock | DB `SELECT 1` p50 / p95 | Ingress p50 / p95 | E2E p50 / p95 | 吞吐 | 完成 |
|---|---:|---:|---:|---:|---:|---:|---:|
| shared context | 1 / 32 | 0ms | 0.093 / 0.142ms | 1.271 / 2.212ms | 49.655 / 55.971ms | 20.0 msg/s | 32/32 |
| shared context | 16 / 64 | 0ms | 0.250 / 5.271ms | 2.651 / 12.816ms | 94.545 / 118.960ms | 54.8 msg/s | 64/64 |
| shared context | 16 / 64 | 5ms | 0.211 / 5.696ms | 2.114 / 11.666ms | 93.079 / 867.995ms | 51.3 msg/s | 64/64 |
| isolated contexts | 4 / 16 | 5ms | 0.067 / 1.817ms | 1.845 / 4.328ms | 53.913 / 836.111ms | 18.0 msg/s | 16/16 |

5ms Mock 下 `shared_context` 的 Provider 并发峰值达到 13，证明并发调度实际发生；零延迟 Mock 太快，不能用其 `peak_model_concurrency=1` 推断 Runtime 串行。

一次 `isolated_contexts`、并发 16、64 消息的探索运行只产生 63 条回复。持久状态中出现一个 `failed` Activation 对应 `open` Thread，另外三个失败 Thread 正确产生了终端错误回复。该运行不计入通过结果；它证明在扩大独立 Context 容量前还需要修复或解释这一非终态泄漏。

## 2026-09-02 ContextDB PostgreSQL A/B

换用 ContextDB 后必须重新测量，不能沿用旧 Projection 的基线。以下结果来自同一台主机、同一 PostgreSQL 15.14、同一 release binary；两个实现使用隔离 schema，并在每个样本中交替先后顺序。每组包含 10 次预热、200 次单 Frame 局部修改和 200 次权威 Mind 读取。

约 1.11 MB Mind（256 Frames，每个 body 4096 bytes）重复三次后的首轮中位结果：

| 实现 | Commit p50 / p95 | 权威读取 p50 / p95 | 最终状态 |
|---|---:|---:|---:|
| Legacy Projection | 8.620 / 9.643ms | 2.654 / 2.977ms | 精确一致 |
| ContextDB adapter | 31.655 / 33.608ms | 16.100 / 16.808ms | 精确一致 |

这不是通过结果。当前 ContextDB adapter 的 commit p95 约为旧实现的 3.5 倍，权威读取 p95 约为 5.6 倍。它已经避免覆盖未修改叶子的 payload，但局部修改仍会读取 touched collection 的全部 sibling Node、重算全局 Merkle commitment；权威读取还会取回并重组全部 Node。兼容 API 同时继续接收完整 `NewMindProjection`，因此局部存储尚未形成端到端局部计算。

普通消息路径另以 200 messages、并发 16、5ms Mock 重复三次。空/小 Mind 下两者用户可见延迟基本持平，但 ContextDB 吞吐中位数为 127.4 msg/s，Legacy 为 145.3 msg/s；这个基准不触发 `context_tx`，只能证明普通消息路径没有数量级回归，不能证明 ContextDB 的局部修改优势。

首轮失败后定位到两个独立问题：

1. bounded mutation 已经只持久化变化 Node，但每次提交仍把完整 `NewMindProjection`
   物化、验证并重新解码为第二棵 AST，只为计算完整状态的独立 Merkle commitment；
2. 完整读取先逐 Node 解析、规范化并验证内容，再立即为构造 Mind 解析同一批
   S-expression，做了重复解析。

保留完整 Mind 哈希/版本门禁、mutation 结果根哈希门禁、逐 Node 内容哈希和全树
Merkle 校验，只将完整状态 commitment 改为直接计算、将读取改为精确字节哈希加单次
类型解析后，同一口径再重复三次，中位结果为：

| 实现 | Commit p50 / p95 | 权威读取 p50 / p95 | 最终状态 |
|---|---:|---:|---:|
| Legacy Projection | 9.095 / 9.682ms | 2.587 / 3.051ms | 精确一致 |
| ContextDB adapter | 8.373 / 8.711ms | 13.398 / 13.894ms | 精确一致 |

局部 commit 已经通过“不回归”门禁：ContextDB p95 比 Legacy 低约 10%。完整兼容读取
由首轮 p95 16.808ms 降到 13.894ms，但仍是 Legacy 的约 4.6 倍，尚未通过。这里测量的
是旧 `MindProjectionStore::get_mind_projection` 契约要求的“加载全部 Node、验证全树、
重组完整 Mind JSON”，不是最终原生 ContextStore 的增量/驻留读取接口。

因此，写路径的核心假设已经由数据验证；在完成原生 Context 读取/编码路径、证明 Runtime
不再依赖旧 Projection 兼容读取并通过相应性能门禁以前，ContextDB 仍不能切为默认实现。

随后将持久 `MindState` 类型从 Orchestrator 拆到独立 Context state domain，并为
`MindProjectionStore` 增加原生 typed read，排除了 JSON 往返是不是主要瓶颈。实测表明，
ContextDB typed read 与兼容读取几乎相同，主要成本确实来自完整 Node 集合的传输、Merkle
完整性校验和 AST 重组，而不是最后一次 JSON 序列化。

在此基础上加入了有界的进程内 Context working set。它只在
`WorkerCoordinationMode::ExclusiveProcess` 下命中；事务、Seed、Snapshot 恢复和 Event
迁移成功后同步发布精确提交状态，CAS 冲突会淘汰失败方缓存，旧冷读也不能覆盖更高 revision。
共享 Runtime 暂不命中，直到数据库 snapshot 能用 revision/hash 对缓存做强一致 fence。

同一 1.11 MB workload、三次完整重复后的中位结果：

| 实现 | Commit p50 / p95 | 原生冷读 p50 / p95 | Runtime 热读 p50 / p95 | 兼容冷读 p50 / p95 | 最终状态 |
|---|---:|---:|---:|---:|---:|
| Legacy Projection | 9.042 / 9.596ms | 2.517 / 2.956ms | 0.034 / 0.040ms | 2.462 / 2.827ms | 精确一致 |
| ContextDB adapter | 8.308 / 8.680ms | 13.198 / 13.570ms | 0.034 / 0.038ms | 13.326 / 13.711ms | 精确一致 |

这证明驻留工作集可以把 1.11 MB Context 的 Runtime state lookup 降到约 34µs，并让两种
后端在热读上等价；ContextDB 局部提交 p95 同时比旧实现低约 9.5%。但这仍不是完整读取门禁
通过：当前真实 `build_context_encoding` 的原子 Projection snapshot 还会独立装载完整 Mind，
PostgreSQL shared-worker 模式也会绕过进程缓存。下一阶段必须把 cached revision/hash 带入
同一数据库 snapshot，在事件可见性边界内只在 head 变化时返回完整 Node payload；不能把
`mind_version` 微基准的提升冒充成 Agent 端到端收益。

随后把 resident revision 带入 directory snapshot 和 encoding snapshot，并将 ContextDB
物理 AST revision 与 Agent Mind logical revision 明确拆分。数据库始终返回同一原子快照中的
Mind head；只有调用方没有该 revision，或 head 已变化时才返回完整 Node payload。共享 Worker
只把进程内状态作为候选，必须经过数据库 head fence 后才能使用。Runtime 冷启动的同 Context
并发首读还增加了 single-flight：一个读者装载并校验完整 AST，等待者随后各自读取与 Session
相关的 directory，但只接收 Mind head。16 个并发冷读的回归测试确认完整 payload 恰好传输一次。

同一 1.11 MB Mind 的真实 Runtime 顺序路径（并发 1、32 条消息、0ms Mock）各重复三次，
中位结果为：

| 实现 | Ingress p50 / p95 | E2E p50 / p95 | 吞吐 | 完成 |
|---|---:|---:|---:|---:|
| Legacy Projection | 1.300 / 2.982ms | 96.568 / 105.765ms | 10.17 msg/s | 32/32 |
| ContextDB adapter | 1.365 / 2.816ms | 95.656 / 108.204ms | 10.29 msg/s | 32/32 |

这说明真实热路径已不再每轮传输、重组两次完整 AST；两臂在顺序用户体验上等价。

共享 Agent 拓扑再用并发 16、256 条消息、0ms Mock 各重复五次。每条消息当前会执行两次
Context build，因此每臂实际包含 2,560 个 Context build 样本。五次运行的“各次统计值中位数”
如下：

| 实现 | DB p50 / p95 | Ingress p50 / p95 | Context build p50 / p95 | Directory p50 / p95 | Projection p50 / p95 | E2E p50 / p95 | 吞吐 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Legacy Projection | 0.400 / 4.612ms | 2.089 / 9.239ms | 46.114 / 69.868ms | 3.891 / 8.918ms | 1.577 / 3.243ms | 172.504 / 258.645ms | 79.18 msg/s |
| ContextDB adapter | 0.342 / 4.669ms | 1.831 / 9.986ms | 45.809 / 66.224ms | 3.922 / 9.569ms | 1.568 / 3.299ms | 168.105 / 301.616ms | 76.13 msg/s |

存储相关的核心门禁已经通过：Context build p95 改善约 5.2%，Projection p95 相差约
1.7%，吞吐相差约 3.9%，所有运行均为 256/256 exactly-once 完成。整条 E2E p95 的五次
中位数仍有约 16.6% 差异，但该指标受两臂都出现的约 1 秒 Runtime 调度长尾显著影响；新增的
逐阶段报告显示，配对运行中该差异可以反向，且 Context build 并未同步恶化。因此它记录为
通用调度长尾的后续性能事项，不能据此把 ContextDB 存储路径判为回归，也不能声称 E2E p95
已经改善。

基准同时暴露并修复了一个既有 PostgreSQL Thread 幂等竞态：两个首次写入者使用相同
`id` 和 `root_turn_id` 时，唯一冲突可能落在主键而非 UPSERT 指定的业务唯一键。现在正常路径
仍为单 SQL，罕见主键竞态会在胜者提交后读取 canonical root；带同步 barrier 的 SQLite 与
PostgreSQL conformance 均通过。

## 2026-09-02 原生承诺复用与多 Context 饱和结果

Runtime 在生成 mutation fence 时本来就必须遍历完整 typed Mind，并为七个稳定认知集合
计算原生 AST 子树承诺。Store 的完整状态独立校验此前又编码相同叶子一次。现在由一个不可从
外部反序列化或伪造的 `ContextStateCommitment` 同时携带 state hash 和七个集合根：

- Runtime 的完整 typed state 仍独立于数据库 bounded patch 计算；
- 数据库仍从持久 sibling hash 加本次局部 Mutation 推导增量根；
- 两者必须完全相等，缺失 Mutation 仍会失败关闭；
- 普通提交没有第二次完整 AST 编码，snapshot 边界仍保存并校验完整 typed state。

约 195KB Mind（256 Frames、每个 body 512 bytes），10 次预热、100 次局部写、release
构建的同库隔离 schema A/B：

| 实现 | Commit p50 / p95 | 原生冷读 p50 / p95 | Runtime 驻留读 p50 | 最终状态 |
|---|---:|---:|---:|---:|
| Legacy Projection | 2.937 / 3.193ms | 0.866 / 0.931ms | 0.015ms | 精确一致 |
| ContextDB | 1.585 / 1.830ms | 4.901 / 5.164ms | 0.015ms | 精确一致 |

普通局部写已不只是“允许一两毫秒尾差”，而是 ContextDB p95 比旧 Projection 低约 43%。
完整冷读仍较慢，因为它需要传输、验证并重组全部物理 Node；稳定 Runtime 热路径通过 revision
fence 命中驻留 typed state，两者均约 15µs，因此不能用运维/冷启动完整读取替代用户热路径
作容量推断。

随后在同一台 M4 Pro、PostgreSQL 15.14、64 连接池上运行多 Context 饱和矩阵。每个 Context
初始 Mind 约 48.9KB（64 Frames × 512-byte body），每个 worker 连续提交 64 次，每次包含
真实 ContextDB bounded patch、Event 和事务门禁，不包含模型延迟：

| 并发 Context | 完成提交 | 吞吐（Context commits/s） | Store commit p50 / p95 / p99 | 负载探针 p50 / p95 | Pool 峰值 |
|---:|---:|---:|---:|---:|---:|
| 1 | 64 | 599 ops/s | 0.883 / 1.749 / 2.541ms | 0.088 / 0.269ms | 3/64 |
| 2 | 128 | 894 ops/s | 1.425 / 2.375 / 3.053ms | 0.095 / 0.967ms | 5/64 |
| 4 | 256 | 1,297 ops/s | 1.973 / 3.220 / 5.892ms | 0.113 / 0.913ms | 8/64 |
| 8 | 512 | 2,075 ops/s | 2.537 / 4.923 / 6.031ms | 0.115 / 0.313ms | 15/64 |
| 16 | 1,024 | 3,450 ops/s | 3.150 / 5.308 / 5.836ms | 0.235 / 1.331ms | 23/64 |
| 32 | 2,048 | 4,558 ops/s | 5.314 / 8.547 / 12.889ms | 0.451 / 2.764ms | 52/64 |
| 64 | 4,096 | 5,152 ops/s | 10.410 / 15.332 / 17.541ms | 2.332 / 6.663ms | 64/64 |

所有档位都是 0 conflict、0 error，且每个 Context 最终 revision 精确等于 64。32–64 档的
服务端采样开始出现 `WALWrite`、`WALInsert`、`BufferContent`、`ProcArray` 和数据文件扩展
等待；64 档峰值观察到 63 个 PostgreSQL backend 同时 active。吞吐在 32 后明显趋缓，证明：

- 不同 Context 没有被 Morphz 全局串行化，能够一直并行到整机 CPU 与 PostgreSQL 事务资源饱和；
- PostgreSQL 已出现 WAL、共享缓冲/事务状态和连接资源竞争，但仅凭数据库等待不能判断整机
  CPU 与内存是否饱和，因此不能把这个拐点只归因于数据库；
- 若线上需要越过该平台，必须同时测量 Runtime CPU、PostgreSQL CPU/IO 与 SQL/tuple 写放大，
  而不是破坏单 Context 的严格顺序语义。

为补齐整机证据，又把每个 Context 的提交数提高到 1,024，并对 `1 / 64` 两档连续采样。
64 Context 共完成 65,536 次提交，吞吐 5,299 Context commits/s，Store commit p95 12.495ms，负载中的
`SELECT 1` p95 4.228ms；仍为 0 conflict、0 error、最终 revision 精确一致。64 个 PostgreSQL
backend 峰值同时 active/waiting，峰值 9 个处于 Lock wait。

14 逻辑核 M4 Pro 的进程级采样结果如下。macOS `%CPU=100` 表示一个逻辑核：

| 进程组 | 平均 CPU | 峰值 CPU | 峰值 RSS |
|---|---:|---:|---:|
| benchmark / Runtime | 827.3%（8.27 核） | 1,105.1%（11.05 核） | 43.3 MiB |
| PostgreSQL postmaster + backends | 180.2%（1.80 核） | 256.0%（2.56 核） | 7.8 GiB（RSS 求和） |

饱和段整机 `top` 连续三次只剩 `0% / 0.69% / 0.91%` idle，说明 CPU 被真实压满。
Runtime 进程本身内存很小；PostgreSQL 的 RSS 求和会把 73 个进程共同映射的 shared pages
重复计算，不能解释为独占 7.8 GiB。该实例配置为 `shared_buffers=128MB`、`work_mem=4MB`、
`max_connections=100`；饱和段整机仍有约 5 GiB unused，compressor 没有增长，因此没有
内存压力证据。

这组采样修正了“平台只受 PostgreSQL 限制”的初步判断：当前是混合瓶颈，但 CPU 主耗在
benchmark / Runtime 进程。48.9KB Mind 的每次提交仍会准备完整 typed-state commitment，
它与 SQL 客户端编码、事务驱动共同占用了大部分 CPU；PostgreSQL 侧则同时存在 WAL、buffer
和锁等待。下一轮优化应分别量化并减少 commitment 的全状态重复计算与数据库 tuple/WAL 写
放大，再复跑同一饱和矩阵；单纯扩大连接池不会解决当前瓶颈。

在原生 commitment 复用完成后，基准又加入 `pg_stat_wal` 与 schema tuple 计数。使用相同
48.9KB Mind、64 个互不争用 Context、每个 128 次局部提交，共 8,192 次提交：

- 吞吐为 5,626 Context commits/s，Store commit p95 为 12.780ms；
- 0 conflict、0 error，所有最终 revision 精确一致；
- 共更新 49,152 个 tuple，即稳定为 6 updates/commit；
- 共插入 16,512 个 tuple，扣除极少量统计边界噪声后约为 2 inserts/commit；
- WAL 为 48,907,852 bytes，即 5,970 bytes/commit；仅 2 个 full-page image。

这组数值把“写放大很大”的泛化怀疑收敛成了可门禁指标。一次局部 Context Mutation 必须
更新被修改叶子、对应集合根、全局根和 Context metadata，同时提交 Event 与两个 Context
head fence；因此 6 个 update 并非完整 Context 重写。约 6KB WAL/commit 在当前 5.6K commits/s
下已经把本机推到 WAL/buffer/CPU 混合饱和，但不存在随 48.9KB Context 尺寸线性增长的写入。
后续若合并物理 head 或压缩 Merkle 路径，必须在同一基准下同时降低
`updates_per_commit` / `wal_bytes_per_commit`，且不能增加 SQL round trip、削弱 CAS fence 或
改变恢复语义；未满足这些条件的“优化”不进入开源基线。

### 完整 Message / Turn 吞吐复测

存储 commit 上限不能替代用户可见吞吐。使用原有 `runtime_postgres_load_benchmark`，配置为
一个共享 Context、每条消息独立 Session、48.9KB 初始 Mind、ContextDB、PostgreSQL pool 64、
零延迟纯文本 Mock 模型。每个输入都必须 exactly once accepted、恰好一次 Model call，并收到
恰好一个 `chat/reply`。该 Mock 不调用 `derive/revise`，因此所有运行均明确报告
`context_commits_per_completed_turn=0`。

并发 16/32/64 各重复三次；表中为各次统计值的中位数。并发 1 是单次基线：

| 并发 | 完成 Turns | completed turns/s | E2E p50 / p95 | Context commits / Turn | 正确性 |
|---:|---:|---:|---:|---:|---:|
| 1 | 64 | 26.6 | 37.243 / 41.817ms | 0 | 64/64 |
| 16 | 512/次 | 206.8 | 42.884 / 57.132ms | 0 | 3 × 512/512 |
| 32 | 1,024/次 | 307.9 | 69.737 / 101.305ms | 0 | 3 × 1,024/1,024 |
| 64 | 2,048/次 | 281.4 | 195.192 / 241.448ms | 0 | 3 × 2,048/2,048 |

完整 Turn 吞吐在并发 32 达到当前平台峰值；提高到 64 后吞吐下降约 8.6%，同时 E2E p95
增加约 2.4 倍，因此不能用更多并发掩盖过载。该结果回答 Runtime 完整 message→reply 容量；
前述约 5,299 Context commits/s 只回答独立认知事务的存储/计算容量，两种单位并列报告但不
做固定换算。

重复运行一度在 teardown 暴露 `DROP SCHEMA` 与仍持有 RowExclusiveLock 的后台投影任务死锁。
基准现在先关闭共享 SQLx Pool、排空所有 backend，再由独立 administration connection 删除
测试 schema；产品热路径和测量窗口均不受这个清理步骤影响。

这仍是本机单实例基准，不是线上容量承诺。正式云部署必须在候选数据库规格、网络拓扑和真实
Mind 分布上复跑同一矩阵，并以 0 丢失、0 重复、0 非终态泄漏作为先决条件。

## 部署候选的比较方法

对每一种拓扑使用相同镜像、配置、数据库数据量和基准矩阵：

1. Runtime 与 PostgreSQL 同机；
2. 现有轻量服务器 Runtime + 同地域托管 PostgreSQL；
3. CloudBase Run + 上海 CloudBase PostgreSQL；
4. 当前 Cloudflare Runtime + Supabase PostgreSQL，作为跨区域对照。

建议容量阶梯为并发 `1 / 4 / 8 / 16 / 32 / 64`，每档至少 200 条消息、重复 3 次。正式候选必须先满足：

- accepted、reply、model call 数完全一致；
- 没有 open / running Thread 或 Activation 泄漏；
- 错误率为 0；
- 再比较数据库 RTT、E2E p95 / p99、吞吐、连接池占用和单位消息成本。

现有阿里云、腾讯云轻量服务器可以承载 Runtime，但不应跨云随机组成一个共享数据库集群。优先选择与数据库同云、同地域的节点；其他服务器更适合作为开发节点、灾备节点或 Execution Target / Edge Node。
