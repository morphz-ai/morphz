# 按任务指定模型与思考深度

目标、线程调度和委托使用相同的两个可选参数：

- `model`：已配置的模型路由或别名，不是任意 Provider 模型名。SDK 的 `SessionScheduleRequest` 兼容原有 `model_alias`。
- `reasoning_effort`：`provider_default`、`none`、`low`、`medium`、`high`、`max`。`provider_default` 明确使用 Provider 默认设置，`none` 明确关闭思考；两者不等价。

省略字段表示继承，不会修改 Session 或 Runtime 默认值。不同线程、目标和委托可以并发使用不同设置。显式设置持久化到任务记录，等待、工具续接与 Runtime 重启后仍然有效。

## 入口

| 入口 | 用法 |
| --- | --- |
| `objective_create` | 顶层传 `model`、`reasoning_effort` |
| `schedule_tx` | 每个 `spawn`、`enqueue`、`reschedule` 操作单独传两个字段 |
| `schedule_tx` 的 `objective.mode=create` | 在 `objective` 内传目标默认设置；操作自身可以覆盖它 |
| `delegate` | 顶层传两个字段，适用于 attached 和 detached |
| SDK / HTTP 目标创建 | 创建命令中传两个字段 |
| SDK / HTTP Session 调度 | 创建请求中传两个字段；`action=reschedule` 可修改后续调度设置 |
| CLI 目标创建 | 使用已有的 `--model`、`--reasoning-effort` 参数，设置同时写入目标 |
| 应用层事项编辑 | Agent 事项的“执行模型”“事项思考深度”；改派给人会清除两项设置 |

Agent 自行选择的模型必须在 `llm.allowed_evaluation_models` 中；操作者 SDK/HTTP 入口使用启用的模型目录。未知模型、非法深度或已知不兼容组合会报错，不静默切换模型。未配置能力信息的模型仍由 Provider 的既有请求适配规则处理。

## 示例

创建目标：

```json
{
  "stated_objective": "排查并修复结果归属问题",
  "reason": "修复需要跨多轮验证并等待测试结果",
  "source_refs": [],
  "model": "deep-review",
  "reasoning_effort": "high"
}
```

创建附属线程：

```json
{
  "operations": [{
    "op": "spawn",
    "lifetime": "attached",
    "intent": "检查错误路径并补充回归测试",
    "model": "coding",
    "reasoning_effort": "medium"
  }]
}
```

委托：

```json
{
  "task": "独立审查这次修复是否遗漏恢复路径",
  "model": "deep-review",
  "reasoning_effort": "high"
}
```

模型名均为示例，必须替换为本机已配置且有权限使用的路由。

## 继承与后续修改

每个字段分别解析：显式操作设置优先，其次为线程/目标任务设置，最后使用 Session / Runtime 默认值。新建受目标监督的线程继承目标设置；新委托继承父任务设置，再由显式委托参数覆盖。

`reschedule` 以 `expected_revision` 防止并发覆盖。省略模型或深度保留已有值；修改对后续调度生效，不切换已发出的模型请求。重新调度仍遵循原有时间参数语义；仅修改模型时也应带上需要保留的时间/周期字段。`pause`、`resume`、`cancel` 不接受模型设置。普通未指定任务设置的对话仍在后续模型请求边界读取 Session 默认值。

### Session IO 与普通输入的相同边界

Session IO 的 `activation.model_alias`／`reasoning_effort` 同样只表达调用方
明确指定的设置。省略必须在原请求、准入 Event 和根 Thread 中继续表示继承，
Host 和 Runtime 不能把准入时的默认值补成任务固定值。实际采用的模型与强度
由每次物理模型请求记录，不用当前输入框或准入快照冒充执行事实。

更改默认值不打断已经发送的 Provider 请求；未固定的后续请求再解析当前默认，
明确指定的任务仍保持原设置。已准入信封和指纹在重试、并发准入及重启后不变；
修正新准入的继承规则不等于重写历史请求或重放已执行工作。历史已被错误复制
成固定值的后续任务及输入框默认设置的接线须另行验证，不由新准入测试代替。
