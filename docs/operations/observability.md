# Morphz Runtime 可观测性

本文描述 Morphz Runtime 的第一版服务级可观测性契约。目标不是收集尽可能多的数据，而是能够回答三个具体问题：

1. 一条消息从进入 Runtime 到模型首次输出，时间花在了哪里？
2. 延迟来自调度、Context 构建、数据库、Provider 排队，还是模型本身？
3. 服务是否正在接近连接池、Event Writer 或 Provider 并发上限？

## 观测面

Morphz 同时提供三个互补的观测面：

- **Turn 时间线**：保留最近 512 个 Turn 的阶段记录，使用 `root_turn_id` 关联；它是进程内、容量有界的诊断投影，Runtime 重启后清空。
- **Prometheus Metrics**：面向趋势、告警和容量判断，只使用低基数标签。任何 Agent、Context、Session、Turn 或 Principal ID 都不会成为指标标签。
- **结构化日志**：阶段完成日志包含 `trace_id`、`root_turn_id`、`context_id`、`session_id`、`stage`、`outcome` 和 `duration_micros`，适合按单次请求检索。设置 `MORPHZ_LOG_FORMAT=json` 可输出 JSON 日志；默认仍保留便于本地阅读的文本格式。

HTTP 消息提交成功后，响应头 `x-morphz-trace-id` 等于该消息的 Event ID，也就是对应的 `root_turn_id`。其他 HTTP 请求也会获得进程生成的请求 Trace ID。

## 受保护的端点

以下端点沿用 Dashboard Operator Token，不公开匿名访问：

```text
GET /metrics
GET /api/observability/turns?limit=50
GET /api/observability/turns/{root_turn_id}
```

示例：

```bash
curl -H "Authorization: Bearer $MORPHZ_OPERATOR_TOKEN" \
  "$MORPHZ_BASE_URL/metrics"

curl -H "Authorization: Bearer $MORPHZ_OPERATOR_TOKEN" \
  "$MORPHZ_BASE_URL/api/observability/turns?limit=20"
```

不要把 Token 放进 Prometheus 配置仓库。生产抓取应通过 Secret 注入 `Authorization` Header。

## Turn 阶段

阶段分成两类：

- 普通阶段的 `duration_micros` 表示该阶段自身耗时；
- `scheduler.to_activation_running`、`provider.request_ready`、`provider.stream_started` 和 `provider.first_output` 是累计检查点，表示从消息进入 Runtime 到该检查点的总耗时。

关键阶段如下：

| 阶段 | 含义 |
| --- | --- |
| `ingress.claim_message` | 原子持久化用户 Event、Thread Signal 与幂等声明 |
| `ingress.dispatch` | 将已经持久化的 Event 交给进程内调度总线 |
| `scheduler.activation_admission` | 等待本地 Activation 并发窗口 |
| `scheduler.to_activation_running` | 消息进入后，Activation 已持久化为 Running 的累计时间；Dashboard 的“等待模型读取”最迟应在这一带结束 |
| `context.directory_load` | 生命周期维护、认知时钟、Session、Objective、Assignment、Binding 与活动 Activation |
| `context.session_working_set` | Principal 绑定与本轮需要完整加载的 Session 工作集选择 |
| `context.projection_load` | 原子读取 Mind 与 Session/Event Projection |
| `context.scheduler_graph_load` | Thread、Group、Schedule、Signal 与近期终态图 |
| `context.activation_causality_load` | 当前 Activation 的精确根事件、触发事件和因果输入 |
| `context.background_tasks_load` | 非终态后台 Execution Job |
| `context.materialize_view` | 因果前沿过滤、Observation 选择、预算计算与 View 投影 |
| `context.execution_targets_load` | Execution Target 与授权投影 |
| `context.render` | 将结构化 Context 投影渲染为模型输入 |
| `context.build` | 完整 Context 构建总耗时 |
| `provider.admission` | 等待本地 Provider Semaphore |
| `provider.bind_model_attempt` | 解析实际 Provider、Account、Endpoint 与物理模型 |
| `provider.request_ready` | 模型 Attempt 已持久化为 Streaming、即将打开物理请求的累计时间 |
| `provider.stream_started` | 收到 Provider `Started` 事件的累计时间 |
| `provider.first_output` | 收到第一段文本、推理摘要或 Tool Call 的累计时间 |
| `provider.request` | 单次物理 Provider 请求的完整耗时 |
| `provider.stream_completed` | 单次物理响应流持续时间 |
| `scheduler.activation_terminal` | Activation 到达 Succeeded、Failed 或 Cancelled 的累计时间 |

一个逻辑 Turn 可能包含多个 Activation 和多个物理模型 Attempt，因此同一阶段可出现多次。这是工具调用、Context 维护或 Provider continuation 的正常表现，不应简单相加为唯一总耗时。

时间线状态随最新 Activation 演进：`in_flight` 表示尚未产生首次输出，`first_output` 表示已经开始响应，`completed` 与 `failed` 表示最新 Activation 的终态；同一逻辑 Turn 启动后续 Activation 时会重新进入 `in_flight`。

## Prometheus 指标

核心 Histogram：

- `morphz_turn_stage_duration_seconds{stage,outcome}`
- `morphz_runtime_operation_duration_seconds{component,operation,outcome}`
- `morphz_http_request_duration_seconds{method,route,status_class}`

容量与健康 Gauge/Counter：

- `morphz_storage_pool_connections{backend,state}`，其中 `state` 为 `size`、`idle`、`in_use` 或 `max`；
- `morphz_event_writer_queue_depth`；
- `morphz_event_writer_failed_batches_total`；
- `morphz_event_writer_contention_retries_total`；
- `morphz_model_provider_queue_depth`；
- `morphz_model_provider_in_flight`；
- `morphz_model_provider_max_in_flight`；
- `morphz_context_encodings_total` 与 `morphz_context_events_scanned_total`。

初期建议先观察分位数，不急着设置过严告警。具备稳定基线后再建立：

- HTTP 5xx 比例；
- `provider.first_output` 的 p50/p95/p99；
- `context.build` 的 p95；
- PostgreSQL `in_use / max` 长时间接近 1；
- Event Writer queue、失败批次或 contention retry 持续增长；
- Provider queue 持续非零。

## 判断数据库是不是瓶颈

Runtime 的 `storage` 和 `context.*_load` 计时包含连接池等待、网络往返、数据库执行和结果解码，是用户实际承受的端到端时间。PostgreSQL 的 `pg_stat_statements` 只统计数据库服务器看到的 SQL 执行，因此两者必须结合：

- Runtime 很慢、SQL 服务端很快、连接池 `in_use` 接近 `max`：优先怀疑连接池等待或跨区网络；
- Runtime 与 `pg_stat_statements` 都慢：优先检查 SQL、索引、锁和数据规模；
- Context 加载阶段快，但 `context.render` 慢：瓶颈在进程内编码而非数据库；
- `provider.request_ready` 快而 `provider.first_output` 慢：瓶颈在 Provider 网络或模型服务。

Supabase 默认提供 `pg_stat_statements`。可在 SQL Editor 使用下列只读查询查看累计最重的规范化 SQL：

```sql
select
  queryid,
  calls,
  round(total_exec_time::numeric, 2) as total_exec_ms,
  round(mean_exec_time::numeric, 2) as mean_exec_ms,
  round(max_exec_time::numeric, 2) as max_exec_ms,
  rows,
  left(query, 240) as normalized_query
from pg_stat_statements
order by total_exec_time desc
limit 30;
```

观察当前连接与等待：

```sql
select
  state,
  wait_event_type,
  wait_event,
  count(*) as connections
from pg_stat_activity
where datname = current_database()
group by state, wait_event_type, wait_event
order by connections desc;
```

`pg_stat_statements` 是累计统计，比较优化前后时应记录时间窗口或在受控环境重置统计。不要为了获得普通成功 SQL 日志而在生产全局打开详细 statement logging；它成本高，也可能扩大敏感数据暴露面。

Supabase 参考资料：

- [pg_stat_statements](https://supabase.com/docs/guides/database/extensions/pg_stat_statements)
- [Database inspection](https://supabase.com/docs/guides/database/inspect)
- [Logs Explorer](https://supabase.com/docs/guides/monitoring-and-debugging/logs)
- [Metrics](https://supabase.com/docs/guides/monitoring-and-debugging/metrics)

## 数据与安全边界

- Prometheus 标签禁止放入任何业务 ID、Prompt、消息文本、URL 查询值、Token、数据库连接串或 SQL 参数。
- Turn 时间线只记录固定阶段、耗时、结果与固定错误分类，不复制底层错误文本，也不记录 Prompt、模型输出或 Event Payload。
- `/metrics` 与 Turn API 必须保留 Operator 鉴权；`/health` 可以继续作为无敏感信息的公开存活检查。
- 进程内时间线用于即时诊断，不承担审计职责。需要跨重启长期保存时，应将结构化日志或后续 OTLP Trace 发送到外部后端，而不是把观测数据混入 Agent 的认知 Event。

## 下一层演进

当前实现已经建立稳定的阶段命名、Trace 关联和 Prometheus 契约。后续接入 Grafana、Prometheus 或 OpenTelemetry 时应复用这些阶段语义，而不是重新定义另一套链路。优先顺序是：

1. 预览环境抓取 Metrics，并建立 24 小时基线；
2. 将 JSON 日志送入可按 `root_turn_id` 检索的日志后端；
3. 当一个请求跨 Worker、Runtime Container 和 Edge Node 后，再增加 W3C `traceparent`/OTLP 跨进程传播；
4. 数据库连接池出现实际饱和证据后，再把 SQLx acquire 封装为独立 Span，区分 acquire、execute 和 decode。
