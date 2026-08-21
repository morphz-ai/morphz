# Morphz 论文与路演 Runtime 基线 v2

> 基线 ID：`paper-eval-runtime-v2`
>
> 冻结日期：2026-08-17（Asia/Shanghai）
>
> 状态：历史 Runtime 源码基线；当前新实验默认使用 [v3](./runtime_baseline_v3.md)

## 1. 权威代码身份

| 字段 | 值 |
| --- | --- |
| Git tag | `paper-eval-runtime-v2` |
| Morphz commit | `03a32f864a3c38026672b4076855137e0bbb5627` |
| Commit subject | `feat: add durable session coordination` |
| Commit time | `2026-08-17T17:39:23+08:00` |
| Author / committer | `fearless <shafreeck@gmail.com>` |

该 commit 是 2026-08-17 至 v3 冻结前的论文实验与路演 DEMO-001 Runtime 源码
起点。每个历史 Run 仍须记录实际 commit；只有实际 Runtime commit 等于本基线时，
才能简写为 `paper-eval-runtime-v2`。2026-08-20 之后尚未启动的新 Run 不再默认使用
本基线。

路演的 runner、collector、scorer、frozen protocol 和 fixture 尚需形成独立的
Demo 冻结提交与 tag。Demo 冻结提交应以本基线为代码祖先，但不得把当前工作树中
尚未提交的实验文件误写成 `03a32f8` 已经包含的内容。

## 2. 相对 v1 的主要变化

v2 在 v1 的 Runtime 语义基础上纳入：

- Managed SSH 私钥 Secret 支持；
- 不可恢复历史 Objective 的启动隔离；
- 多行 Credential 值保持；
- 每条消息的 `interrupt`、`parallel`、`follow_up` 调度模式；
- 持久化 Session 协调闭环。

这些变化与论文的跨 Session、并发、恢复研究以及路演的 Session/Thread 协调展示
直接相关，因此当时的新批次不再默认使用 v1；当前默认选择见 v3。

## 3. 使用规则

1. 只有实际基于该 commit 的历史论文实验和路演运行声明 v2；
2. v1 既有结果如存在，继续保留原基线身份，不追写成 v2；
3. 第一次真实模型 Run 前，从明确 checkout 重新记录 fmt、Clippy、测试与构建状态；
4. Runner/scorer 或 frozen fixture 变化时提升 Demo/实验包版本，不移动本 Runtime tag；
5. Run manifest 同时保存 Runtime commit、实验包 commit/tag、dirty 状态和 dirty diff hash；
6. 不同 Runtime commit 的结果不得在未分析差异的情况下直接合并。

## 4. Git 历史说明

2026-08-17 仓库将历史 author/committer 邮箱统一为
`fearless <shafreeck@gmail.com>`，所有受影响提交 SHA 随之变化。v1 的当前 tag
已经指向重写后的等价提交 `cbfc540c...`；v2 则指向历史重写及最新开发提交完成后的
`03a32f8...`。
