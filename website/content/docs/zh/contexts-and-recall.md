---
title: Context、认知帧与 Recall
description: 理解当前上下文、退役内容和完整历史之间的关系。
section: concepts
order: 110
status: current
---

Context 不会把所有历史原文永久塞进每次 Prompt。Runtime 维护当前工作集，同时把完整事件保存在账本中；Agent 可以在需要证据时主动 Recall。

## 当前可见内容

模型每次收到的是当时编译出的 Context Encoding，其中可能包含：

- 当前 Session 的消息；
- 仍然活跃的认知帧；
- 当前观察和工具结果预览；
- Objective、Thread 和权限等运行时元数据；
- 可召回原文的稳定引用。

内容离开当前工作集不等于被删除。它仍可存在于不可变事件账本或已退役认知帧中。

## Recall 支持的读取方式

Recall 当前支持四种主要入口：

1. 使用事件短引用或完整 Event ID 分页读取原文；
2. 使用 Frame ID 查看认知帧及关系；
3. 使用 Unicode 关键词搜索当前 Context 的账本；
4. 使用带时区的时间范围检索事件，可单独使用，也可与关键词组合。

CLI 时间范围示例：

```bash
morphz context recall search \
  --since=2026-08-04T09:00:00+08:00 \
  --until=2026-08-04T18:00:00+08:00 \
  --format=json
```

`since` 包含起始时刻，`until` 不包含结束时刻。时间必须携带明确 offset，避免把当地时间误解为 UTC。

## 大型事件分页

工具输出或文件内容可能只在 Context 中保留预览。Recall 返回 `next_offset` 或 `next_cursor` 时，应原样用于下一次请求，而不是重新猜测关键词。分页是读取同一份权威证据，不是重新执行原工具。

## Recall 不会自动改写认知

Recall 结果进入 Agent 的当前收件箱。是否把其中内容写入或更新认知帧，仍需要显式的 Context Transaction。这样可以区分“读到历史证据”和“把它声明为当前认知”。
