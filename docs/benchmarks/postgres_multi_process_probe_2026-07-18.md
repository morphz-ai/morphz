# PostgreSQL Multi-Process Probe — 2026-07-18

这是一份多 Runtime 正确性与故障恢复探针，不是 PostgreSQL 吞吐基准，也不是公网容量承诺。它验证 Morphz 的跨 Worker 权威状态确实位于数据库，而不是依赖单个进程内的 Mutex、EventBus 或任务表。

## 环境与命令

- PostgreSQL：15.14，本机临时实例；
- Runtime：两个独立 OS 子进程；
- Store：同一 PostgreSQL 实例、同一隔离 schema、每进程独立连接池；
- Model：确定性本地夹具，不访问外部 Provider；
- 故障注入：第三个子进程 claim 一项短租约 Execution Job 后被父进程强制终止；租约到期后由第四个新进程执行启动恢复。

```bash
MORPHZ_TEST_POSTGRES_URL='postgresql://127.0.0.1:5432/postgres' \
  cargo run -p morphz-evals --bin postgres_multi_process_probe
```

连接 URL 只通过显式命名环境变量传给父/子进程，不进入普通配置、命令行参数或报告。

## 首次结果

```json
{
  "workers": 2,
  "ready_workers": 2,
  "model_calls": 1,
  "replies": 1,
  "crash_recovery_requeued": true,
  "elapsed_millis": 2342,
  "success": true
}
```

该结果同时证明：

1. 两个 Runtime 可以并发首次连接同一新 schema；migration advisory lock 避免并发 DDL 冲突。
2. 一条用户消息在两个进程之间只产生一个 Activation 所有者、一次模型调用和一条持久回复。
3. 第二个 Runtime 启动时不会抢占另一进程尚未到期的 Execution lease。
4. 持有 lease 的进程消失后，Job 在 lease 到期前不会被重放；到期后可由新进程 revision-fenced 地恢复为 queued。

## 尚未证明

- 不同主机之间的网络分区、时钟偏差和进程编排行为；
- PostgreSQL 主从切换或托管服务故障转移；
- 高并发下的 p50/p95/p99、连接池容量和数据库成本；
- 外部工具已经跨越副作用边界后的自动 reconciliation。此类 Job 会进入 `lost`，不会被盲目重放；具体外部事实仍需工具适配器确认。

因此，这份报告支持“Phase 4 首个可部署版本成立”，但不支持“生产级分布式部署已经完成”的结论。
