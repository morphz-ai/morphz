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
| 用户配置 | `~/.morphz/morphz.toml` | 模型服务、账号引用、模型路由、存储与服务设置 |
| 项目偏好 | `<workspace>/.morphz/morphz.toml` | 受信任范围内的项目行为偏好 |
| 显式文件 | `--config-file <FILE>` | 运维者明确指定的可信配置 |

`MORPHZ_HOME` 可以改变 Morphz 用户目录。旧版本平台配置目录只用于一次性迁移，不再是公开路径契约。

## 默认模型

```toml
[llm]
model = "my-route"
```

这里填写模型路由的可解析名称。模型路由再指定模型服务、物理模型和账号。不要把物理模型名、账号 ID 和路由 ID 当成同一个字段。

## 配置合并

最终配置可能来自用户层、项目层、环境变量和命令行参数。查看最终结果及来源：

```bash
morphz config explain --format=json
```

当控制台显示的默认模型与 TOML 不一致时，应先用这个命令确认是哪一层覆盖了它。

## 凭证

API 密钥和 OAuth 令牌不应直接写在 `morphz.toml`。配置只保存凭证或密钥存储引用。工作目录中的 `.env` 不会被自动加载；Morphz 只会使用用户控制的环境文件或进程环境。

## HTTP 代理路由

模型服务、OAuth 和认知协调流量默认遵循系统代理。标准 `NO_PROXY` 排除规则始终生效；如果一台机器通过代理访问互联网、但需要直连本地认知协调网格，可以这样启动：

```bash
NO_PROXY=.local,localhost,127.0.0.1,::1 morphz serve ...
```

`MORPHZ_HTTP_PROXY_MODE=system|direct` 设置全局策略。`MORPHZ_PROVIDER_PROXY_MODE`、`MORPHZ_OAUTH_PROXY_MODE` 和 `MORPHZ_COORDINATION_PROXY_MODE` 可以分别覆盖对应流量；OAuth 未单独设置时继承模型服务策略。Morphz 不会因为一次网格探测失败，就静默改变模型服务的路由。

## 默认执行设备

本地、自托管和命令行部署默认把运行 Morphz 的机器作为执行设备，用户无需额外选择。云端 C 端服务不应让用户任务落到服务主机，可在可信宿主配置中关闭这个默认值：

```toml
[execution_targets]
local_enabled = false
```

也可设置 `MORPHZ_EXECUTION_TARGETS_LOCAL_ENABLED=false`。此时会话未选择设备时仍可正常对话；第一次需要物理工具时，运行时会返回 `EXECUTION_TARGET_REQUIRED`。客户端可调用 `GET /api/sessions/:session_id/execution-targets`，据其 `reason` 区分“安装并配对 `morphz-edge`”与“从已有设备中选择”。会话的选择只影响随后创建的新任务，已运行任务不会迁移。

## 存储权威

SQLite 是默认物理存储，适合本机与单实例部署：

默认数据库位于 `~/.morphz/morphz.db`，因此从不同工作目录启动 Morphz 时仍会使用同一份本机状态。需要改用其他位置时，请配置绝对路径：

```toml
[storage]
backend = "sqlite"
cognitive_store = "context_db"

[storage.sqlite]
path = "/absolute/path/to/morphz.db"
max_connections = 8
```

多实例服务可以显式选择 PostgreSQL。连接地址通过一个由配置指定名称的环境变量提供，避免数据库凭证进入普通配置与诊断输出：

```toml
[storage]
backend = "postgres"
cognitive_store = "context_db"

[storage.postgres]
url_env = "MORPHZ_POSTGRES_URL"
max_connections = 16
```

仅设置 `MORPHZ_POSTGRES_URL` 不会自动切换物理存储。认知存储默认使用上下文数据库；`legacy` 仅用于显式迁移兼容回退。启动不会隐式迁移认知权威，迁移必须由运维者明确执行。

后台命令的完整输出默认归档在 `~/.morphz/artifacts`，不会随 Morphz 的启动目录改变。可信的用户配置可以选择其他绝对位置：

```toml
[background_task]
artifact_dir = "/absolute/path/to/morphz-artifacts"
```

项目配置不能改变这项由宿主管理的存储位置。

## 会话工作集与认知整理

```toml
[orchestrator.session_working_set]
active_window = "24h"
max_sessions = 50

[orchestrator.frame_retirement]
cooling_ticks = 8
```

活动窗口和数量上限决定哪些非当前会话可以进入本轮有界工作集；实际投影仍要服从上下文容量。`cooling_ticks` 表示普通认知帧从请求退役到整理窗口生效之间经过的认知时钟步数，不应把它改成物理时间或立即删除开关。

高并发服务还可以调整激活准入容量。默认同时运行 16 个激活、最多持久排队 256 个，并为对话与最终交付保留容量。除非已经监测模型、数据库和执行节点的真实承载能力，否则不要仅为了提高吞吐而放大这些上限。

## 容量覆盖

模型服务的容量字段都是可选的：

```toml
[services.example.models."physical-model"]
context_window_tokens = 262144
max_input_tokens = 229376
max_output_tokens = 32768
```

仅在服务目录明确返回或运维者确认限制时设置。缺少字段意味着未知，不意味着零，也不应触发猜测值。

模型输入附件同样区分“宿主安全策略”和“物理模型能力”。宿主策略位于用户级配置，不能由项目配置放宽：

```toml
[model_input]
max_artifacts_per_import = 128
max_artifact_bytes = 134217728
max_import_bytes = 268435456
max_artifacts_per_request = 128
max_request_bytes = 268435456
```

前 3 项限制一次用户上传或工具结果导入；后 2 项限制最终组装出的单次物理模型请求。控制台从运行时读取同一份策略，不维护另一组固定数字。这些限制是可配置的主机内存、磁盘与传输保护上限，不代表任何模型的真实能力。

只有服务目录明确返回或运维者确认时，才在物理模型档案中声明更严格的能力：

```toml
[services.example.models."physical-model"]
max_input_attachments = 64
max_input_attachment_bytes = 67108864
max_input_attachment_total_bytes = 201326592
```

最终请求逐项采用宿主策略与物理模型声明中更严格的值。物理模型未声明这些字段时保持“未知”，Morphz 不会根据模型名称猜测。每次模型尝试都会记录实际附件数量、总字节数、有效上限和限制来源。
