# Morphz Memory Scope：长期经验的作用域设计

> 状态：实现前设计冻结；Checkpoint/rollback 已进入 protocol v7，跨 session scope 尚未写入 Runtime

## 1. 问题

当前 Mind 由 `session_id` 定位。只要使用同一个 session，进程重启后可以确定性恢复；Operations Continuity v1 已验证这一点。但“Agent 运行越久越聪明”不能依赖所有任务永久共用一个无限 session，也不能把一个项目的经验无条件暴露给另一个项目。

作用域是访问与生命周期机制，不是 Runtime 预定义的认知 Schema。Runtime 不判断某条经验是否值得晋升，只提供隔离、版本、权限和审计；是否从 session 提炼到 project/agent，由 LLM 通过显式事务决定。

## 2. 三个作用域

| Scope | 所有者 | 典型内容 | 默认可见范围 |
| --- | --- | --- | --- |
| `session` | 单次连续会话 | 当前目标、开放问题、临时计划、未完成工作 | 当前 session |
| `project` | 稳定 `project_id` | 项目架构、验证命令、长期约束、已确认决策 | 同 project 的 session |
| `agent` | 稳定 `agent_id` | 跨项目可复用的方法、用户长期偏好、经过反例验证的策略 | 同 Agent 的 session |

默认写入 `session`。Runtime 绝不能根据重复次数、相似度或时间自动把内容晋升到更宽作用域。

## 3. 所有权与版本流

三个 scope 使用三个独立的 Event Stream 和版本号：

```lisp
(mind-scopes
  (session (id SESSION_ID) (version 12) (writable true))
  (project (id PROJECT_ID) (version 7) (writable true))
  (agent (id AGENT_ID) (version 3) (writable true)))
```

一个 `context_tx` 只能修改一个 scope，避免一次事务跨越三个 single-writer 锁：

```lisp
(context-tx
  (scope project)
  (base-version 7)
  (reason "相同部署约束已在三个任务中验证")
  ...)
```

跨 scope 原子事务暂不支持。Agent 需要先在窄 scope 提炼稳定 frame，再以显式来源晋升到宽 scope；失败时各 stream 独立回滚。

## 4. 晋升、修订与撤销

建议新增通用原语，而不是给 frame 增加固定业务字段：

- `(promote NEW_ID (from SCOPE:FRAME_ID) BODY...)`：在更宽 scope 创建带血缘的新 frame；
- `revise`：只修改目标 scope 内的 frame，仍是完整 body 替换；
- `relate`：可以声明宽 scope 经验取代旧经验；
- `checkpoint/rollback`：只作用于当前目标 scope；
- `retire`：只改变目标 scope 的当前可见性，不删除来源 Ledger。

晋升不是复制原文。Agent 必须形成对新作用域仍然成立的表达，并保留来源。project 事实不能直接晋升为 agent 规律，除非有跨项目证据或用户明确授权。

## 5. Context 合并规则

每次模型调用按 `agent → project → session → inbox` 展示，窄 scope 不自动覆盖宽 scope。若存在冲突：

1. Runtime 只显示 scope、版本、来源和显式 `supersedes`；
2. Runtime 不根据“session 更近”自动决定谁正确；
3. Agent 必须在 Mind 中显式声明当前采用的结论；
4. 需要长期修正时，Agent 对对应宽 scope 提交新的 transaction。

ID 在 scope 内唯一，模型视口使用 `agent:ID`、`project:ID`、`session:ID` 消除歧义。

## 6. 安全与产品边界

- `agent_id` 和 `project_id` 由 Kernel/产品层注入，模型不能伪造；
- 工具输出默认只能进入当前 session inbox；
- 未经显式晋升，不得进入 project/agent Mind；
- project/agent transaction 需要独立审批策略和审计时间线；
- 删除 Agent 身份或项目时，可以确定性枚举并删除对应 stream；
- 不同用户或租户绝不能共享 `agent_id`；
- 宽 scope frame 必须支持 checkpoint、来源检查和撤销，防止错误经验长期污染。

## 7. 实现顺序

1. 配置与 Kernel 增加只读 `agent_id/project_id`；
2. Context Store 建立三个独立 scope stream 和锁；
3. Context View 合并三层只读状态；
4. `context_tx` 增加必填/默认 scope，并维持单 scope 原子性；
5. 实现显式 `promote` 与跨 scope 来源引用；
6. Dashboard 增加 scope 筛选、Diff、Checkpoint 和血缘；
7. 运行正迁移、负迁移和跨项目污染测试后，才允许默认启用 agent scope。

## 8. 验收

- 同 project 新 session 能恢复 project frame，但看不到其他 project；
- 同 agent 跨 project 只能看到 agent frame；
- session 临时计划不会自动泄漏到 project/agent；
- 宽 scope 的错误经验可以 rollback 或被新经验 supersede；
- 并发 session 不会覆盖同一 project/agent 版本；
- 在相同任务与预算下，开启 scope 后后续任务质量提升，且负迁移不增加。
