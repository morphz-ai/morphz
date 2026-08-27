# ME-07 Morphz 正式训练回复等待失败与修复记录

> 状态：`failed-attempt-preserved / fix-verified / clean-restart-required`

## 结论

第一次 Morphz travel 正式训练在第 23 条 canonical episode 后超时。模型求值、Context
transaction 和回复生成均已完成；失败发生在 adapter 的完成观察协议，而不是 Event Store、
Structured Context 或训练输入本身。

冻结 SQLite 证据显示：

- 共接收 23 条训练请求，并形成 23 次 `chat/context_tx_committed`；
- Context revision 已由 22 推进到 23；
- root turn `msg_1787740526919384000_51891_22` 的 Context transaction 已于
  `2026-08-26T10:36:50.088929Z` 持久化；
- 同一 root turn 的 `chat/reply` 已于 `2026-08-26T10:36:55.993959Z` 作为 event row 438
  持久化，随后线程进入 terminal；
- adapter 仍等待进程内 exact-topic `runtime.subscribe("chat/reply")`，最终报告
  `ME-07 Morphz Runtime reply timed out`。

失败快照 SHA-256 为
`1acfd38a52dfeb427406e10fb07d322a1db7bd5c7f039abf252a1a2a70144ed1`；stderr SHA-256 为
`47995a2a56a0e0dca9878ade22c308d318c07def0966d5a2eabb7aba0919375a`。原目录
`/private/tmp/me07-formal-training-20260826/morphz` 保持不变，不进入正式效果统计。

## 根因与修复

`runtime.subscribe` 是进程内异步业务通知面，不是持久化请求—回复完成协议。持久化完成并不
保证受 business-handler semaphore 调度的订阅者已经观察到事件；旧 adapter 还只按
`session_id` 过滤，存在串 turn 风险。

修复 commit `2e502056f52fc355e29f01df69d3b434607c257e` 新增 Runtime
`wait_for_turn_reply(session_id, root_turn_id, timeout)`：先安装同步观察边界，再查询 durable
Event Store，最后只接受同一 Session、同一 root turn 的新回复。STATE-Bench adapter 改用每轮
发送 receipt 的 `event_id` 等待，不再使用长驻 exact-topic stream。

验证结果：Morphz lib `1002 passed / 0 failed / 6 ignored`；morphz-evals `87` 个单元测试与
`3` 个集成测试通过；fmt、diff-check 及两个包的 Clippy `-D warnings` 均通过。新训练二进制
SHA-256 为 `0666fd3c0e49b2365d923d9589229ed6e37d6d47bbabc6bfcf0e0a45d53fa31a`。

该修复可靠覆盖本实验使用的同进程 embedded adapter。它不被扩张解释为跨 Runtime 进程的
持久通知保证；未来若需要跨进程等待查询后由 peer 新提交的回复，仍需 DB tailing 或持久通知。

## 处理规则

旧训练不是正式 held-out trial，不能补分，也不会与新结果拼接。修复后的 commit、二进制和
machine-readable lock revision 2 全部重新冻结，然后从空数据库完整重跑 100 条 travel
训练轨迹；只有 clean restart 与 reload Gate 全部通过后，快照才可进入正式 held-out 评测。
