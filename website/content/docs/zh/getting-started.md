---
title: 快速开始
description: 构建 Morphz、完成模型配置，并获得第一次真实响应。
section: start
order: 10
status: current
---

Morphz 当前以 Rust 单二进制交付，控制台会嵌入二进制。第一次使用的目标不是“把服务启动起来”，而是完成一次经过真实模型服务的响应。

## 前置条件

- Rust 工具链，以仓库中的 `rust-toolchain.toml` 为准；
- 可访问至少一个模型服务；
- 对当前工作目录具有读写权限。

## 构建

在仓库根目录运行：

```bash
cargo build --release
```

生成的二进制位于 `target/release/morphz`。你可以直接从这里运行，也可以把它复制到自己的可执行目录。

## 完成设置

默认使用控制台设置向导：

```bash
./target/release/morphz setup
```

它会启动本机控制台并尝试打开浏览器。在 SSH 或没有浏览器的机器上，可使用终端向导：

```bash
./target/release/morphz setup --tui
```

如果只希望输出控制台地址而不自动打开浏览器：

```bash
./target/release/morphz setup --no-open
```

设置完成后，Morphz 会保存一个完整可用的模型服务、认证账号和模型路由。未完成的 OAuth 登录不会留下可选择的账号。

## 验证模型路径

先运行整体诊断：

```bash
./target/release/morphz doctor
```

然后在控制台的“模型服务”页面对已添加账号执行实测。实测必须明确显示所用账号、物理模型、耗时和错误；“已经登录”只说明凭证存在，不等于模型请求一定成功。

## 开始第一次对话

直接启动交互界面：

```bash
./target/release/morphz
```

也可以直接携带提示词：

```bash
./target/release/morphz 请检查当前项目并说明你能访问哪些内容
```

收到模型正文后，第一次运行才算完成。如果只有用户消息、没有模型回复，请先查看[运维与故障排查](/docs/operations)，不要重复创建新会话掩盖问题。

## 下一步

- 阅读[核心概念](/docs/core-concepts)，理解认知上下文与会话的区别；
- 阅读[模型服务、账号与路由](/docs/providers-and-models)，理解模型选择器实际提交的内容；
- 在远程机器上部署时阅读[远程 OAuth 登录](/docs/remote-oauth)。
