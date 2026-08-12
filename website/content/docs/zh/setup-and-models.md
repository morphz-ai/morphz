---
title: Setup 与模型选择
description: 理解向导保存的对象，以及模型何时会出现在选择器中。
section: start
order: 20
status: current
---

Setup 负责建立一条完整的模型请求路径，而不是只保存一个 API Key。一次可用配置至少包含模型服务实例、认证账号和模型路由。

## 两种 Setup 界面

| 命令 | 适用场景 |
|---|---|
| `morphz setup` | 本机或可访问 Dashboard 的环境，默认选择 |
| `morphz setup --tui` | SSH、无图形桌面或纯终端环境 |
| `morphz setup --no-open` | 启动 Dashboard Setup，但不自动打开浏览器 |

Dashboard 和 TUI 写入同一套配置，不存在两套产品模型。

## Setup 保存什么

1. **模型服务实例**：端点、协议与服务方言；
2. **认证账号**：OAuth 身份或 API Key 的引用；
3. **模型路由**：用户可选择的名称如何解析到物理模型和账号；
4. **模型容量**：只有服务目录明确返回，或用户明确覆盖时才保存。

OAuth Token 和 API Key 不写入普通 TOML 配置。配置文件只保存对 Secret Store 的引用。

## 为什么登录后还可能没有模型

登录成功只证明 Morphz 获得了认证材料。模型选择器还要求存在已启用的模型路由。如果服务提供模型目录，Dashboard 会显示服务真实返回的模型；如果服务不提供目录，用户必须填写服务真实接受的物理模型名。

Morphz 不应凭空生成模型名，也不会把系统生成的路由 ID 当作用户设置的别名显示。

## 默认模型

当前默认模型由 `[llm].model` 指向的模型路由决定。选择器显示路由的 `display_alias`；没有显示别名时，显示服务返回或用户填写的真实物理模型名。

修改后可以用以下命令解释最终配置来源：

```bash
morphz config explain --format=json
```

这比只查看某一层 TOML 更可靠，因为 Morphz 会合并用户配置、项目偏好和命令行覆盖。
