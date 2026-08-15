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

前 3 项限制一次用户上传或工具结果导入；后 2 项限制最终组装出的单次物理模型请求。Dashboard 从 Runtime 读取同一份策略，不维护另一组固定数字。默认值支持 43 张常见截图的批量视觉审查；它们仍是可配置的主机内存、磁盘与传输保护上限，不代表任何模型的真实能力。

只有服务目录明确返回或运维者确认时，才在物理模型档案中声明更严格的能力：

```toml
[services.example.models."physical-model"]
max_input_attachments = 64
max_input_attachment_bytes = 67108864
max_input_attachment_total_bytes = 201326592
```

最终请求逐项采用宿主策略与物理模型声明中更严格的值。物理模型未声明这些字段时保持“未知”，Morphz 不会根据模型名称猜测。每个 Model Attempt 会记录实际附件数量、总字节数、有效上限和限制来源。
