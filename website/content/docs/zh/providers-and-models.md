---
title: 模型服务、账号与路由
description: 配置模型请求路径，并理解选择器显示的模型究竟来自哪里。
section: guides
order: 200
status: current
---

Morphz 的模型层由线协议、服务适配器、服务实例、认证账号和模型路由组成。它们分开存在，目的是让 Runtime 不依赖任何一家厂商。

## 五个对象

| 对象 | 回答的问题 |
|---|---|
| Protocol | HTTP 与流事件采用什么物理语义 |
| Provider Adapter | 服务有哪些端点、Header 和方言 |
| Provider Instance | 当前部署具体连接到哪里 |
| Auth Account | 请求使用哪个登录身份或 API Key |
| Model Route | 用户选择如何解析到物理模型与账号 |

## 支持的协议

当前线协议包括 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和 Gemini generateContent。兼容网关、自建服务和 API Key 服务通过这些协议接入，不需要为每个品牌创建一套领域模型。

## 真实模型名与别名

物理模型名必须来自服务目录或用户明确输入。Morphz 不根据品牌猜模型，也不生成看似合理的默认模型名。

模型路由可以设置 `display_alias`。设置后选择器显示这个别名；未设置时显示可解释的真实模型名。内部生成的路由 ID 只用于稳定引用，不能自动冒充用户别名。

## 一个路由的直接目标

```toml
[models.my-coding-model]
display_alias = "Coding"
service = "codex-subscription"
physical_model = "gpt-example-coding"
account = "account-example"
```

这里的物理模型名只是结构示例，必须替换成服务当前真实接受的名称。

## 多候选路由

当同一个用户选择可以由多个服务提供时，使用候选列表和优先级。路由选择只会在已配置、已启用且健康的候选中进行。账号冷却、配额或网络失败可以让 Runtime 选择其他候选，但不会把两个账号同时用于一次请求。

## 模型容量

- **上下文窗口**：输入和输出合计上限；
- **最大输入**：仅输入 Prompt 的上限；
- **最大输出**：允许生成的输出上限。

服务目录返回哪个字段，Morphz 就保存哪个字段；没有返回时保持未知。用户可以显式覆盖已确认的限制，但 Runtime 不应猜容量。
