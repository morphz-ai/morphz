# Context Token Budget v1

## 1. 目标

Morphz 的 Context 是可维护、可换入换出的认知工作集，不应被 Provider 的最大
Context Window 被动决定其大小。Token Budget 因此分成两个层次：

- **Provider + Model 物理容量**：Operator 在配置文件中声明，表示当前端点对该精确
  模型名所允许的输入上限。
- **Context 请求预算**：用户可以为某个 Cognitive Context 单独设置；不设置时使用
  当前模型的物理容量。

核心请求路径不调用远端 token 计数或探测接口。未声明模型容量时，沿用 Runtime
全局 `orchestrator.context_hard_token_limit` 作为固定保底值。

## 2. 配置

模型能力按照 **Provider ID + 精确 Model Name** 配置：

```toml
[llm]
provider = "proxy"
model = "model-large"
models = ["model-large", "model-fast"]

[providers.proxy]
protocol = "openai-responses"
base_url = "http://localhost:8317/v1"

[providers.proxy.models."model-large"]
context_window_tokens = 1000000
max_output_tokens = 32000

[providers.proxy.models."model-fast"]
max_input_tokens = 240000
max_output_tokens = 16000
```

物理输入上限按以下优先级求值：

1. `max_input_tokens`
2. `context_window_tokens - max_output_tokens`
3. `orchestrator.context_hard_token_limit`

三个模型能力字段都必须大于零。若 Context Window 无法扣除 Output Allowance，配置
不会产生有效模型输入容量，Runtime 使用固定保底值。

## 3. Context 预算语义

每个 Cognitive Context 持久化：

```text
requested_hard_token_limit  用户请求值；NULL 表示自动
token_budget_revision       独立的 CAS revision
```

Runtime 在每次求值前，结合当前模型重新计算：

```text
effective_hard = min(requested_hard 或 physical_prompt, physical_prompt)
soft           = effective_hard × 75%
reserve        = effective_hard × 12.5%
critical       = effective_hard - reserve
```

`requested` 与 `effective` 必须分开保留。用户可以在大模型下请求 500k，临时切换到
240k 模型时 effective 会被钳制为 240k；切回更大模型后仍恢复为请求的 500k，而不是
丢失偏好。

模型切换和预算修改只影响随后开始构造 Context Encoding 的 Evaluation，不中断已经
发给 Provider 的请求。

## 4. 并发与一致性

预算拥有独立 revision，不复用 Context/Mind revision。更新使用比较并交换：

```text
PATCH(requested, expected_revision)
  ├─ revision 相同：写入并 revision + 1
  ├─ revision 不同：409，并返回当前预算
  └─ Context 不存在：404
```

SQLite 和 PostgreSQL 使用相同语义。数据库升级会为已有
`cognitive_contexts` 表补齐字段；旧 Context 默认进入自动模式。

## 5. 统一接口

Rust Runtime 与 SDK：

```text
context_token_budget(context_id)
update_context_token_budget(context_id, requested, expected_revision)
```

Operator HTTP API：

```text
GET   /api/contexts/{context_id}/token-budget
PATCH /api/contexts/{context_id}/token-budget
```

PATCH Body：

```json
{
  "requested_hard_token_limit": 128000,
  "expected_revision": 3
}
```

将 `requested_hard_token_limit` 设为 `null` 可恢复自动模式。读取与修改均属于
Runtime Operator 能力，不开放为普通 Principal-scoped 写接口。

## 6. Dashboard

Dashboard 在模型选择器旁提供 Context Budget 控件：

- 自动、常用预设、滑块和精确数值输入；
- 同时显示 requested、effective、physical、soft、maintenance reserve；
- 请求值超过当前模型容量时明确显示钳制，而不覆盖请求值；
- 使用 revision-CAS 保存，冲突时刷新为服务端最新状态；
- 切换模型后自动刷新 effective 值；
- 明确提示修改从下一次 Evaluation 生效。

## 7. 与 Token Usage 的边界

Context Token Budget 是求值前的本地压力控制，不替代 Provider 返回的真实 Usage：

- Provider Usage 持久化后用于成本、统计和校准；
- 本地估算用于尚未发送的 Context 分区与压力判断；
- Provider 最终仍有权以 `context_length_exceeded` 拒绝请求，Runtime 应据此触发
  Context Maintenance，而不是把本地估算伪装成精确计数。
