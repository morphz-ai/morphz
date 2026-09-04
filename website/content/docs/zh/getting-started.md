---
title: 快速开始
description: 安装 Morphz、完成模型配置，并获得第一次真实响应。
section: start
order: 10
status: current
---

Morphz 以预编译的原生二进制交付，控制台嵌入在主程序中。第一次使用将依次完成安装、模型配置和真实响应验证。

## 前置条件

- macOS（Apple Silicon 或 Intel）、x86_64 Linux，或 x86_64 Windows；
- 可访问至少一个模型服务；
- 对当前工作目录具有读写权限。

## 一条命令安装

macOS 与 Linux：

```bash
curl -fsSL https://morphz.ai/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://morphz.ai/install.ps1 | iex
```

安装器识别当前平台，从 GitHub Releases 下载对应归档并校验 SHA-256，然后安装到用户目录，不要求 root 或管理员权限。打开一个新终端后继续设置。

更新由用户显式触发，并复用同一组经过校验的 GitHub Release 资产：

```bash
morphz update status
morphz update
```

更新成功后会保留上一个主程序二进制；需要时可运行 `morphz update rollback` 回滚。独立的执行节点客户端 `morphz-edge` 使用单独的安装与更新流程。

## 完成设置

默认使用控制台设置向导：

```bash
morphz setup
```

它会启动本机控制台并尝试打开浏览器。在 SSH 或没有浏览器的机器上，可使用终端向导：

```bash
morphz setup --tui
```

如果只希望输出控制台地址而不自动打开浏览器：

```bash
morphz setup --no-open
```

设置完成后，Morphz 会保存一个完整可用的模型服务、认证账号和模型路由。OAuth 登录完整成功后，相应账号才会进入可选列表。

## 验证模型路径

先运行整体诊断：

```bash
morphz doctor
```

然后在控制台的“模型服务”页面对已添加账号执行实测。登录状态确认凭证已经保存；账号实测会进一步确认所用账号、物理模型和真实请求路径，并显示耗时或错误。

## 开始第一次对话

直接启动交互界面：

```bash
morphz
```

也可以直接携带提示词：

```bash
morphz 请检查当前项目并说明你能访问哪些内容
```

控制台显示模型正文后，模型链路验证完成，Morphz 已准备好开始工作。若页面只有用户消息，请保留当前会话并按照[运维与故障排查](/docs/operations)定位模型请求路径。

## 从源码构建

在仓库根目录使用 `rust-toolchain.toml` 固定的 Rust 工具链运行：

```bash
cargo build --release
```

生成的二进制位于 `target/release/morphz`。源码构建面向开发、审查和独立复现；普通用户可以直接使用前面的一条命令安装。

## 下一步

- 阅读[核心概念](/docs/core-concepts)，理解认知上下文与会话的区别；
- 阅读[会话与并发工作](/docs/sessions-and-concurrency)，理解共享认知上的多条工作线；
- 阅读[认知应用、领域程序与 Yao](/docs/cognitive-applications)，为目标绑定领域工作方法；
- 阅读[模型服务、账号与路由](/docs/providers-and-models)，理解模型选择器实际提交的内容；
- 在远程机器上部署时阅读[远程 OAuth 登录](/docs/remote-oauth)。
