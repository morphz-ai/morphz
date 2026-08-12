---
title: 配置文件
description: 理解用户配置、项目偏好、环境覆盖与最终生效值。
section: guides
order: 220
status: current
---

Morphz 将宿主控制面配置与项目偏好分开。项目仓库不能重定向宿主凭证或修改管理面安全设置。

## 配置位置

| 层级 | 默认路径 | 用途 |
|---|---|---|
| 用户配置 | `~/.morphz/morphz.toml` | Provider、账号引用、模型路由、存储与服务设置 |
| 项目偏好 | `<workspace>/.morphz/morphz.toml` | 受信任范围内的项目行为偏好 |
| 显式文件 | `--config-file <FILE>` | Operator 明确指定的可信配置 |

`MORPHZ_HOME` 可以改变 Morphz 用户目录。旧版本平台配置目录只用于一次性迁移，不再是公开路径契约。

## 默认模型

```toml
[llm]
model = "my-route"
```

这里填写模型路由的可解析名称。模型路由再指定 Provider、物理模型和账号。不要把物理模型名、账号 ID 和路由 ID 当成同一个字段。

## 配置合并

最终配置可能来自用户层、项目层、环境变量和命令行参数。查看最终结果及来源：

```bash
morphz config explain --format=json
```

当 Dashboard 显示的默认模型与 TOML 不一致时，应先用这个命令确认是哪一层覆盖了它。

## 凭证

API Key 和 OAuth Token 不应直接写在 `morphz.toml`。配置只保存 Credential 或 Secret Store 引用。工作目录中的 `.env` 不会被自动加载；Morphz 只会使用用户控制的环境文件或进程环境。

## 容量覆盖

Provider 模型容量字段都是可选的：

```toml
[services.example.models."physical-model"]
context_window_tokens = 262144
max_input_tokens = 229376
max_output_tokens = 32768
```

仅在服务目录明确返回或 Operator 确认限制时设置。缺少字段意味着未知，不意味着零，也不应触发猜测值。
