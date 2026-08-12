---
title: 核心概念
description: 用一套稳定心智模型理解 Agent、Context、Session、认知帧与执行。
section: concepts
order: 100
status: current
---

Morphz 把模型求值与 Runtime 状态分开：模型负责提出认知与行动，Runtime 负责验证结构、权限、因果和持久化。

## Agent

Agent 是一组身份、认知策略、工具边界和默认行为。它不是某个模型账号，也不是一次模型请求。

## Context

Context 是 Agent 持有的长期认知范围。它包含当前认知结构、认知帧、观察、关系和可召回账本。多个 Session 可以共享一个 Context，因此新会话不等于失忆。

## Session

Session 是用户、Agent 或外部通道之间的沟通流。它负责消息顺序和交付目的地，但不独占 Context。归档 Session 不会删除 Context 中已经形成的认知。

## 认知帧

认知帧是 Context 中可寻址、可版本化的认知单元。它可以承载事实、约束、计划或形成中的理解，并带有来源和生命周期。认知帧退役后不会从账本中消失；需要时可以通过 Recall 查回。

## Thread 与 Activation

Thread 表示一条持续的工作线；Activation 是 Runtime 对这条工作线的一次具体执行机会。Activation 可以结束，Thread 仍可等待下一次事件继续。子线程的生命周期归属于父线程或独立持久目标，而不是偶然触发它的某次 Activation。

## Objective

Objective 表示需要跨多轮持续推进的目标。它持有目标状态和收敛条件，Runtime 可以在进程重启或临时模型失败后继续调度。Objective 完成前，最终交付仍属于目标生命周期的一部分。

## Provider 与模型路由

Provider 描述请求发往哪里、采用什么协议；认证账号描述使用哪个身份；物理模型是服务真正接受的模型名；模型路由给用户提供稳定选择并决定候选路径。这些对象必须保持分离。

## 一次请求的边界

```text
用户消息
  → Session 接收
  → Context 编码
  → Thread 获得 Activation
  → Model Attempt
  → Runtime 校验工具或文本结果
  → 提交事件与认知变化
  → 向目标 Session 交付
```

这条边界解释了为什么模型响应成功、工具执行成功和最终交付成功是三个不同状态。
