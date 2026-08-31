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
MORPHZ_BENCH_TOPOLOGY=shared_context \
MORPHZ_BENCH_CONCURRENCY=16 \
MORPHZ_BENCH_MESSAGES=64 \
MORPHZ_BENCH_POSTGRES_POOL_SIZE=16 \
MORPHZ_BENCH_MODEL_DELAY_MS=5 \
cargo run -q -p morphz-evals --bin runtime_postgres_load_benchmark
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
- `throughput_messages_per_second`：完整逻辑 turn 的吞吐；
- `model_calls` 与 `peak_model_concurrency`：Mock 调用次数及物理 Provider 并发峰值；
- `accepted_messages` 与 `replies`：用于发现丢回复、重复执行和非终态泄漏。

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
