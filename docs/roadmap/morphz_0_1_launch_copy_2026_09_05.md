# Morphz 0.1 首发文案（2026-09-05）

> 发布身份：Morphz 0.1 Developer Preview  
> 主链接：<https://morphz.ai>  
> 源码：<https://github.com/morphz-ai/morphz>  
> 封面：`website/public/video/morphz-concept-demo-poster.jpg`

## 核心主张

自主维护上下文。并发推进目标。安全执行行动。

## 中文标题

Morphz 0.1：会自主维护上下文的开源 Agent Runtime

## 中文短文案

Morphz 0.1 现已开源。它让智能体自主维护结构化上下文，在同一身份下并发推进多个目标，并由确定性内核约束权限、执行与恢复。

官网与演示：<https://morphz.ai>  
源码：<https://github.com/morphz-ai/morphz>

## 中文完整文案

今天公开 Morphz 0.1。

Morphz 是一台面向持久 Agent 的 S 表达式认知机。它以可版本化、可修订、可退役的结构化 Context 承载长期认知；智能体可以自主整理自己的上下文，在同一身份下并发推进多个目标。模型负责语义判断，确定性事务内核负责事实、权限、状态、执行与恢复。

0.1 是源码优先的 Developer Preview，提供 macOS、Linux 和 Windows 原生版本。代码、论文、规范、文档与概念演示现已公开：

- 官网：<https://morphz.ai>
- 源码：<https://github.com/morphz-ai/morphz>
- 论文：<https://morphz.ai/paper>
- 规范：<https://morphz.ai/standards>
- 文档：<https://morphz.ai/docs>

macOS 与 Linux：

```bash
curl -fsSL https://morphz.ai/install.sh | sh -s -- setup
```

Windows PowerShell：

```powershell
irm https://morphz.ai/install.ps1 | iex
```

欢迎阅读源码、复现实验并提交 Issue。

## English title

Morphz 0.1: An open-source Agent Runtime with self-maintaining context

## English short copy

Morphz 0.1 is now open source. It gives an Agent a self-maintaining structured Context, concurrent objectives under one identity, and a deterministic kernel for authority, execution, and recovery.

Website and demo: <https://morphz.ai/en>  
Source: <https://github.com/morphz-ai/morphz>

## English full copy

Today we are releasing Morphz 0.1.

Morphz is an S-Expression Cognitive Machine for durable Agents. Long-term cognition lives in a structured Context whose Frames can be versioned, revised, and retired. An Agent can maintain that Context and advance concurrent objectives under one identity. The model handles semantic judgment; a deterministic transaction kernel owns facts, authority, state, execution, and recovery.

Version 0.1 is a source-first Developer Preview with native builds for macOS, Linux, and Windows. The source, paper, specifications, documentation, and concept demo are now public:

- Website: <https://morphz.ai/en>
- Source: <https://github.com/morphz-ai/morphz>
- Paper: <https://morphz.ai/en/paper>
- Specifications: <https://morphz.ai/en/standards>
- Documentation: <https://morphz.ai/en/docs>

macOS and Linux:

```bash
curl -fsSL https://morphz.ai/install.sh | sh -s -- setup
```

Windows PowerShell:

```powershell
irm https://morphz.ai/install.ps1 | iex
```

Read the source, reproduce the experiments, and open an Issue.

## 发布边界

- 不引用未经独立核实的 GPT-6 产品传闻或竞品内部实现。
- 不使用“生产就绪”“行业领先”或其他超出当前证据的比较性表述。
- StateBench 与论文实验只引用仓库和预印本已经公开的结果与限定条件。
- 0.1 明确标为 Developer Preview；Windows 与 macOS 二进制尚未配置商业代码签名。
