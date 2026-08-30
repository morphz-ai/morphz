# ME-08 Prefix Cache A/B 缓存与 Token 审计

## 计数口径

只统计 `orchestrator.model_usage.persisted` 与 `provider.prompt_cache.wire_outcome` 的精确数字字段。
字段解析使用边界匹配，绝不把 `uncached_input_tokens` 中的子串误算成
`cached_input_tokens`。每条记录必须同时满足：

```text
input_tokens = uncached_input_tokens + cached_input_tokens
total_tokens = input_tokens + output_tokens
```

Control 1,381 条、Treatment 1,307 条 usage 记录全部通过；共 2,688 条，没有恒等式失败。
`cache_write_input_tokens` 在所有记录中均由 Provider 报告为 0；本报告不据此推测 Provider
内部写缓存成本。

## 整批累计

| 指标 | Control | Treatment | 差异 |
| --- | ---: | ---: | ---: |
| 请求 outcome | 1,381 | 1,307 | −74 |
| 输入 Token | 66,006,703 | 63,147,898 | −4.33% |
| 缓存输入 | 19,721,216 | 54,478,336 | +176.24% |
| 未缓存输入 | 46,285,487 | 8,669,562 | **−81.27%** |
| 缓存命中率 | 29.88% | 86.27% | **+56.39pp** |
| 输出 Token | 1,380,558 | 1,831,532 | +32.67% |
| 推理 Token（输出子集） | 925,946 | 1,334,214 | +44.09% |
| 输入 + 输出 | 67,387,261 | 64,979,430 | −3.57% |

Treatment 的主要收益是把输入从未缓存路径迁移到缓存路径，而不是简单减少模型看到的逻辑输入。
Treatment 的随机轨迹产生了更多输出与推理 Token，因此总 Provider Token 只下降 3.57%。

## 按请求序号

| 请求位置 | Control | Treatment | 解释 |
| --- | ---: | ---: | --- |
| sequence 1 | 55.23% | 55.23% | 两臂相同的静态前缀冷启动基线 |
| sequence 2 | 49.82% | 79.05% | Treatment 从第二次请求开始保留稳定前缀 |
| sequence 3+ | 28.37% | 87.55% | 稳定热路径差异 |
| sequence 4+ | 27.66% | 88.08% | Treatment 热路径继续提高；Control 随轨迹增长而下降 |

第一轮完全一致而后续轮次迅速分叉，符合本实验的机制预期：稳定 schema 本身已经能缓存一部分
静态前缀，Structured Delta 的增益主要来自避免后续轮次重写既有结构化上下文。

## 按任务长度

这里以每题实际 Provider usage 请求数作固定分桶，而不按结果好坏事后切分：短任务 0–10 次，
中任务 11–20 次，长任务 21 次以上。

| 请求数分桶 | Control 任务 / 命中率 | Treatment 任务 / 命中率 | 差异 |
| --- | ---: | ---: | ---: |
| 0–10 | 40 / 42.06% | 44 / 83.31% | +41.25pp |
| 11–20 | 31 / 30.59% | 30 / 82.37% | +51.78pp |
| 21+ | 18 / 26.93% | 15 / 89.56% | +62.63pp |

两臂都各有两道 0 请求任务：`break-filter-js-from-html` 与 `vulnerable-secret`，它们在
Provider usage outcome 前进入终止性安全拒绝路径。Treatment 在 89/89 trial 都产生
Structured Delta start 审计事件；87 个真正进入 Provider usage 的 trial 都产生 reuse。

长任务中 Control 的缓存命中率最低，而 Treatment 最高；这说明优化没有只在短 smoke 中成立，
反而随着轮次增加更明显。逐题请求数、Token 和命中率保存在 `CACHE_AUDIT.json`。

## 墙钟边界

Control 完成于 6,349.93 秒，Treatment 完成于 6,765.76 秒，Treatment 慢 415.83 秒
（+6.55%）。本轮不能主张缓存优化降低墙钟。最直接的同时发生因素是 Treatment 输出与推理
Token 更多，并有一例 900 秒 AgentTimeout；Provider cache 命中改善与端到端墙钟不是同一个指标。

## Gate 判定

- 缓存率改善：通过；
- 未缓存输入显著下降：通过；
- 精确字段恒等式：通过；
- 长任务热路径改善：通过；
- 端到端墙钟改善：未通过，但这不是预注册发布 Gate 的必要条件；
- 与正确率/完整性联合判定：可作为新候选基线送论文任务复核。
