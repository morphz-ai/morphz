---
title: Thread、Activation 与 Objective
description: 理解任务为何运行、等待、恢复或完成。
section: concepts
order: 120
status: current
---

Morphz 不把一次模型调用等同于一个任务。持续工作由 Thread 表达，具体运行机会由 Activation 表达，需要长期收敛的意图由 Objective 表达。

## Thread 是工作线

Thread 持有执行的连续性。它可以处于可运行、运行中、等待、暂停或终态。Thread 等待时必须能够说明等待的事件，例如模型服务恢复、工具结果、审批或用户输入。

## Activation 是一次执行机会

Activation 是调度器授予 Thread 的一次有租约执行。它可以包含多个 Model Attempt 与工具调用，直到到达一个持久边界。Activation 结束不应让仍然有效的子线程失去所有者。

## Objective 是持久收敛条件

Objective 适合需要跨多轮、跨重启或后台持续推进的工作。它不是普通 Thread 的父目录，也不会自动接管此前无关的工作线。

当 Agent 把 Objective 标为完成时，Runtime 仍需确保最终报告完成交付。目标的公共状态在最后交付边界确认前保持活动，避免“目标已经完成，但交付 Activation 因目标非活动而被取消”。

## attached 与 durable

- `attached` 工作依附于父 Thread，适合父工作线内的并行分解；
- `durable` 工作拥有独立持久生命周期，适合跨多轮继续；
- 子线程应附着到父 Thread，而不是附着到某次短暂 Activation。

选择错误的生命周期可能产生没有活动所有者的悬空工作。Runtime 应通过不变量校验阻止或明确终结这种状态，而不是永久保留“可运行但永远不会被调度”的记录。

## 等待不是失败

等待必须对应已登记的恢复条件。Provider 临时网络失败可以进入退避并等待资源恢复；用户暂停则必须等待显式恢复；缺少审批必须等待审批决定。如果页面只显示“等待”却没有原因，应当作为可观测性缺陷处理。
