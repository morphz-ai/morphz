# Morphz 多 Session 并发对话验证 v1

> 历史基线说明（2026-07-12）：本文件记录的是旧实现中“一个 Session 一个 Context”的隔离实验。它的原始结果仍有诊断价值，但不再代表当前对象层级，也不能作为共享 Context 的验证证据。当前实现与共享回归结果请以 [Context-Owned Session Service v1](morphz_session_service_v1.md) 为准。

> 时间：2026-07-12
> 模型：`gemini-3-flash-agent`
> Runtime：Session Service v1 未提交工作树
> 模式：一个 Agent、三个 Session、三个独立 Context Event Stream

## 1. 验证目标

验证当前 Runtime 在同时推进多个 Session 时，是否能够：

1. 把用户消息、工具结果、进度和最终回复路由到正确 Session；
2. 让模型只看到当前 Session 的 Ledger、Mind 和 Inbox；
3. 在互相冲突的身份、项目、口令和端口下保持认知隔离；
4. 并发修订各自 Mind，不发生版本、来源或内容串线；
5. Runtime 重启后分别恢复三个 Session，并继续正确回答。

本测试不验证 Shared Context。当前 `context_id=session_id`。

## 2. 测试夹具

| Session | 用户 | 项目 | 初始口令 | 初始端口 | 偏好 |
| --- | --- | --- | --- | --- | --- |
| `session-aurora` | 林舟 | `AURORA-17` | `AMBER-731` | `7101` | 简洁回答 |
| `session-boreal` | 苏岚 | `BOREAL-29` | `COBALT-842` | `8202` | 详细回答 |
| `session-cirrus` | 顾川 | `CIRRUS-43` | `SILVER-953` | `9303` | 先给结论再解释 |

三个 Session 共用逻辑 `agent_id=multisession-agent`，但分别挂载同名独立 `context_id`。

## 3. 执行阶段

### 3.1 并发建立状态

同时向三个 Session 注入互相冲突的用户、项目、口令、端口与回复偏好，并要求写入 Mind。

三个 Session 均创建了自己的受保护 Frame：

- Aurora：`session-config`
- Boreal：`user_profile`
- Cirrus：`session-c-info`

三条首轮回复均只报告本 Session 信息。

### 3.2 同条件隔离追问

同时要求三个 Session 仅依据当前 Mind，以一行 JSON 返回 `user/project/token/port/style`，并报告是否可见其他 Session。

结果：

```json
{"user":"林舟","project":"AURORA-17","token":"AMBER-731","port":7101,"style":"简洁","foreign_visible":false}
{"user":"苏岚","project":"BOREAL-29","token":"COBALT-842","port":8202,"style":"detailed","foreign_visible":false}
{"user":"顾川","project":"CIRRUS-43","token":"SILVER-953","port":9303,"style":"先给结论再解释","foreign_visible":false}
```

### 3.3 真正同时的独立修订

三个 HTTP 请求在同一物理时刻写入：

```text
Aurora  2026-07-12T13:54:12.414043000Z  port 7101 → 7117
Boreal  2026-07-12T13:54:12.414043000Z  token COBALT-842 → COBALT-843
Cirrus  2026-07-12T13:54:12.414045000Z  user 顾川 → 顾澜
```

三条回复分别确认自己的变化。三个 Frame 均从 revision 1 变为 revision 2，只改变指定字段，其他字段完整保留，来源指向各自新用户 Event。

### 3.4 重启恢复

关闭 Runtime，使用同一 SQLite/LanceDB 路径重新启动，再次同时追问三个 Session。

结果：

```json
{"user":"林舟","project":"AURORA-17","token":"AMBER-731","port":7117}
{"user":"苏岚","project":"BOREAL-29","token":"COBALT-843","port":8202}
{"user":"顾澜","project":"CIRRUS-43","token":"SILVER-953","port":9303}
```

## 4. 定量结果

| 指标 | 结果 |
| --- | --- |
| Session 数 | 3 |
| 最终回复 | 12/12 路由正确 |
| 最终隔离问答 | 3/3 全字段正确 |
| 并发修订 | 3/3 正确 |
| Mind revision | 3/3 从 1 正确升级到 2 |
| 重启恢复 | 3/3 正确 |
| 被扫描 Session Event | 124 |
| 外来项目/口令标记 | 0 |
| Context 版本或来源串线 | 0 |

因此，在当前隔离模式下，可以确认：

> Runtime 的 Session 路由、Ledger 查询、Context 构造、Mind transaction 和重启恢复均保持了 Session 边界；模型能够依据各自 Context 分辨并持续推进多个对话。

## 5. 独立发现：Context 隔离不等于物理环境隔离

首轮中，Boreal 只执行一次 `context_tx`；Aurora 和 Cirrus 在已经成功维护 Mind 后，仍违反用户“不调用物理工具”的要求，分别扫描了共享工作区：

| Session | 额外调用 |
| --- | --- |
| Aurora | `list_files` 1、`read` 3、`recall` 1 |
| Cirrus | `list_files` 1、`read` 3、`search` 2、`recall` 2 |

两者读取了相同的 `docs/task.md`、`notes.txt` 和 `docs/walkthrough.md`。没有发现对方 Session 的项目、口令或用户信息，也没有把共享文件内容错误写入最终 Mind。

这说明：

1. **不是 Session Context 串线**：三个 Ledger 的外来标记均为 0，Mind 和回复也正确；
2. **是模型工具纪律问题**：Gemini 在 maintain 后把普通“项目配置”误当成需要检查 workspace 的任务；
3. **物理 workspace 当前确实共享**：不同 Session 使用同一 Tool Registry 和 `workspace_root`，一个 Session 写入的文件原则上可被另一个 Session 读取；
4. 后续若需要项目级物理隔离，应把 `workspace_id/workspace_root` 作为 Runtime 路由资源，而不能依赖模型自行区分。

## 6. 结论边界

本测试证明的是：

- 单进程、单 Agent、三个独立 Context 的并发 Session 隔离与恢复正确；
- 模型能根据 Runtime 提供的当前 Context 正确区分三个持续对话。

本测试尚未证明：

- 多 Session 共享同一个 Context Head；
- 多 Sub Agent 并发写同一 Mind；
- 不同项目 workspace 的物理隔离；
- 多进程或多节点下的 Session Directory 一致性；
- 大规模 Session 数量下的调度和容量表现。

下一阶段不需要因为本次结果修改 Context 语义；更直接的功能问题是补充 Session/Project 到 Workspace 的确定性挂载关系，以及继续完善持久化后台任务和无人值守调度。
