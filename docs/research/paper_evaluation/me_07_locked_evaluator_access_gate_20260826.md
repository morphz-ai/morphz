# ME-07 锁定评测器访问 Gate（2026-08-26）

> 状态：`failed-closed / no-model-call / no-formal-trial`

## 结论

STATE-Bench v0.8.1 的官方 GPT-5.4 user simulator/judge client 当前不能在本实验环境中构造。
使用上游锁定虚拟环境执行以下只读预检：

```shell
.venv/bin/python -c \
  'from state_bench.client import build_user_sim_client; build_user_sim_client()'
```

上游 client 在任何网络请求前按预期失败，错误为：

```text
ValueError: Azure OpenAI endpoint required. Set STATE_BENCH_EVAL_ENDPOINT
environment variable or pass endpoint parameter.
```

当前进程也没有 `STATE_BENCH_EVAL_ENDPOINT`、`STATE_BENCH_EVAL_DEPLOYMENTS`、
`STATE_BENCH_EVAL_API_KEY` 或可确认的等价 Azure 登录配置。该预检没有调用模型、没有生成
trial，也没有读取或输出任何凭据。

## 解锁条件

1. 提供可访问 Azure OpenAI GPT-5.4 的 `STATE_BENCH_EVAL_ENDPOINT` 与
   `STATE_BENCH_EVAL_DEPLOYMENTS`；
2. 通过 `STATE_BENCH_EVAL_API_KEY`、Azure token 或已登录的 Azure CLI 提供认证；
3. 运行零 completion/最小 completion 绑定检查，确认 simulator 与两个 judge 的实际部署均为
  协议锁定的 GPT-5.4；
4. Gate 通过后才允许同一 held-out task 的三臂 scored smoke。

CLIProxyAPI、GPT-5.6、Qwen 或其他可用线路不得替代这个评测器。访问条件满足前，ME-07 只保留
三强记忆方法、真实学习产物与重载 Gate，不报告效果分数。
