---
title: 安全与权限边界
description: 了解凭证、管理面身份、工作区保护与能力审批。
section: operations
order: 310
status: current
---

Morphz 把模型输出视为不可信候选。任何现实副作用都必须经过 Runtime 的结构、权限、因果和目标边界校验。

## Secret Store

OAuth Token、API Key 和刷新凭证只进入 Secret Store。普通配置保存引用，不保存 Token 原文。凭证不得进入 Prompt、Context、Session、Ledger 或普通日志。

## Dashboard 管理凭证

`MORPHZ_DASHBOARD_TOKEN` 是 Operator 管理面凭证。它证明调用方可以管理当前 Runtime，但不应被解释为最终用户 Principal。可信 Gateway 的服务身份必须使用独立凭证，两者不能复用。

## 非环回监听

绑定 `0.0.0.0` 或其他非本机地址会暴露管理面，必须设置足够强的 Dashboard Token，并由部署环境提供 TLS、访问控制和网络边界。

## 项目配置不是宿主控制面

项目目录可能不可信，因此 `.morphz/morphz.toml` 不能重定向 Provider 凭证、Secret Store、管理监听地址或宿主安全策略。工作目录 `.env` 也不会隐式加载。

## 工具与目标

工具权限由 Sandbox、审批、Principal、Thread 与 Execution Target 共同决定。Runtime 必须验证每一次调用的实际路径和能力，不能只相信模型声明。

## 审计

拒绝、批准、工具调用、模型路径和状态迁移应保留可追溯事件。删除界面记录不等于抹除已经发生的外部副作用，也不应破坏审计历史。
