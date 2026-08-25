# ME-01 精确模型绑定零调用预检

> 日期：2026-08-25（Asia/Shanghai）
>
> 性质：运行环境 Gate；不是模型效果实验

执行现有生产等价 Provider 路径的 profile binding 检查，未发送 completion 请求：

```text
cargo run -q -p morphz-evals --bin roadshow_demo_001 -- \
  profile-preflight /private/tmp/morphz-me01-binding-preflight-20260825
```

结果：

| 项目 | 实测值 |
| --- | --- |
| Profile | `roadshow-demo-001` |
| Provider | `custom`（CLIProxyAPI 路由） |
| Logical model | `gpt-5.6-sol` |
| Physical model | `gpt-5.6-sol` |
| Reasoning | `max` |
| Route | 单候选，`fallback=false` |
| Completion calls | 0 |
| Gate | 通过 |

原始脱敏结果见
[`artifacts/me01_model_binding_preflight_20260825.json`](./artifacts/me01_model_binding_preflight_20260825.json)。

该结果只证明当前本机控制面的精确路由仍然有效。真实三臂 smoke 还必须记录正式
`morphz` 二进制 hash、每个 episode 的独立数据库、`full_access`、实际请求 binding 与
Provider usage；不能把本预检当作真实 smoke。
