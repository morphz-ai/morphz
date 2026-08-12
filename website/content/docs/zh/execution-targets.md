---
title: 工作区与执行目标
description: 控制 Agent 在哪里执行，以及可使用哪些能力。
section: guides
order: 230
status: current
---

模型提出行动，Runtime 决定行动能否在某个 Execution Target 上发生。目标、权限和工作区共同构成现实副作用边界。

## 本地工作区

默认工作区是启动 Morphz 时的当前目录。`--cwd` 可以在加载项目配置前切换目录。Runtime 会保护自身配置、数据库、可执行文件、`.git`、`.ssh` 等关键路径，避免 Agent 通过文件工具或 Shell 绕过控制面。

## Sandbox 与审批

Sandbox 决定物理访问范围；审批策略决定需要何种授权。两者不是同一个概念：允许访问某个目录不代表所有命令都自动获批，批准某次能力也不会扩大 Sandbox。

## Managed SSH

Morphz 可以使用宿主已有 OpenSSH 配置解析远程目标。Agent 只提交主机别名与能力需求；Runtime 使用宿主 SSH 客户端、严格主机密钥校验和批处理模式执行连接，不把私钥内容交给模型。

```json
{
  "kind": "managed_ssh",
  "host": "production",
  "capabilities": ["exec"]
}
```

直接使用 IP 或 DNS 名称时可以显式提供用户和端口。已有 `IdentityFile`、`ProxyJump` 和 SSH Agent 设置继续由宿主 OpenSSH 处理。

## Edge Execution Node

Edge Node 通过主动出站连接与 Morphz Gateway 配对，适用于 Runtime 无法直接访问的网络。配对码是短期凭证；长期设备凭证和能力租约由节点本地保存并可撤销。

## 能力租约

一次审批可以产生限定于 Principal、Agent、Thread、Target 和能力集合的租约。后续调用只有仍在完全相同的边界内才能复用，Runtime 不会从相似命令推断更宽权限。
