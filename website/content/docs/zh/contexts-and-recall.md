---
title: 认知上下文、认知帧与召回
description: 理解 Morphz 如何以权威事件、当前认知、显式事务和有界上下文投影承载长期记忆。
section: concepts
order: 110
status: current
---

认知上下文是智能体拥有的持久状态。运行时针对每次求值编译一份有界的上下文编码，其中只包含本轮所需的历史、认知和运行状态。

## 三层状态

Morphz 把长期状态分成三个层次：

1. **事件历史**保存实际发生过的输入、工具结果、审批和状态提交，是权威事实来源；
2. **认知状态**保存智能体通过显式事务维护的认知帧、关系、顺序和检查点；
3. **上下文编码**把本轮需要的事件、认知、会话和运行状态投影给模型。

当前默认认知存储是上下文数据库。它把不可变事件与认知、调度等权威投影放在同一事务边界内。事件历史和认知状态保持权威，词法召回索引作为派生数据可随时重建。

## 上下文编码

当前编码按以下物理顺序组成：

```text
protocol
→ evaluation-profile
→ inbox
→ observation-state
→ mind
→ session-directory
→ kernel
→ optional cognitive-capabilities
→ evaluation-environment
→ evaluate
```

这些区域共同组成一棵可求值结构，并拥有明确的权责：

- `inbox` 保存按事件序列投影的不可变观察内容；
- `observation-state` 保存保护、驻留、新旧关系和使用情况等可变投影属性；
- `mind` 保存认知帧、关系和检查点；
- `session-directory` 表达多个会话及其投影层级；
- `kernel` 表达调度、目标、权限、上下文压力和当前激活等运行时事实；
- `evaluation-profile` 在绑定领域程序时保存稳定定义，否则为 `none`；
- `evaluation-environment` 保存本轮模型、时间与动态绑定；
- 最后的 `evaluate` 是唯一执行入口。

大型观察可以只进入预览。稳定短引用（例如 `@e42`）仍指向同一份权威事件，供召回或认知事务使用。

## 认知帧事务

认知帧只能通过带基础版本的原子事务修改：

```lisp
(context-tx
  (base-version 42)
  (reason "replace an outdated assumption with verified evidence")
  (derive deployment/current
    (from @e42)
    (fact (region cn-hangzhou)))
  (relate deployment/current supersedes deployment/old)
  (retire deployment/old))
```

当前事务操作包括：

- `create`、`derive` 与 `revise`：创建、从证据派生或完整替换认知帧正文；
- `retire` 与 `restore`：让观察或认知帧退出当前活动编码，或恢复它；
- `protect` 与 `unprotect`：保护仍必须保留在活动认知中的内容；
- `relate` 与 `unrelate`：维护认知帧之间的显式关系；
- `place`：调整认知帧的投影顺序；
- `checkpoint`、`rollback` 与 `drop-checkpoint`：保存、回滚或移除高风险重组前的认知快照；
- `retire-session` 与 `restore-session`：调整会话注意状态，并可与认知修改原子提交。

`revise` 会替换完整正文。需要保留的内容必须在新正文中重新陈述。

## 并发修改与版本冲突

认知版本是全局物理提交序列，但冲突按更细的语义边界判断，包括认知帧正文、生命周期目标、关系边、顺序和检查点身份。

当两个并发事务修改互不相干的边界时，运行时可以把较旧事务安全重放到最新版本。若它读取或修改的精确边界已经变化，运行时会拒绝提交；智能体必须重新读取并做语义合并。检查点回滚和会话注意状态修改始终要求精确版本，并跳过自动重放。

## 退役不是失效或删除

退役只表示内容退出当前活动编码，不代表事实错误、认知失效或物理删除。

- 观察退役会立即从活动编码释放；
- 普通认知帧退役后先进入整理窗口，在窗口内保持可见并继续占用容量。窗口使用认知时钟计量：每当新的用户消息、外部事件或真实工具结果进入上下文时，时钟推进一步；
- 后继认知帧同时把旧帧列为来源并声明 `supersedes` 替代关系时，旧帧可以在同一事务中立即退出；
- 受保护内容必须先显式解除保护；
- 当前激活尚未交付的根请求受到因果保护，不能提前退役。

整理窗口为智能体留下了修订、恢复或补充关系的机会。窗口生效后，内容仍保留在历史和召回系统中。

## 召回

召回支持三类读取：

1. 按关键词和时间范围搜索事件与认知帧；
2. 按事件短引用或完整标识分页读取原文；
3. 从一个认知帧沿来源和关系向上游、下游或双向遍历。

```bash
morphz context recall search "沙箱 权限" --limit=20 --format=json

morphz context recall search \
  --since=2026-08-04T09:00:00+08:00 \
  --until=2026-08-04T18:00:00+08:00 \
  --format=json

morphz context recall frame memory/sandbox \
  --depth=2 --direction=ancestors --include-events --format=json
```

`since` 包含起始时刻，`until` 不包含结束时刻。时间必须带明确偏移量。返回续页游标时应原样用于下一次读取；分页沿同一组权威证据继续读取。

召回结果先作为新观察进入收件箱。把它升级为当前认知仍需要显式事务，因此“读到历史证据”和“声明当前认知”始终是两个动作。

## 审计与重建

```bash
morphz context status context-default
morphz context audit context-default
morphz context recall-index inspect context-default --format=json
morphz context recall-index rebuild context-default --format=json
```

`context audit` 通过事件回放核对当前认知投影。重建召回索引只重建派生搜索数据，不修改权威事件或认知帧。
