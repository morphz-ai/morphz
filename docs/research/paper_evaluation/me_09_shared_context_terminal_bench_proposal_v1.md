# ME-09：单 Agent、八 Session、共享 Context 的 Terminal-Bench 迁移实验 Proposal v1

> 状态：`proposal-only / not-authorized-for-model-run`  
> 日期：2026-08-26  
> 性质：外部完整 Agent 能力与跨 Session 经验迁移的组合实验  
> 启动约束：必须先向用户展示并确认正式协议；当前文件不授权运行

## 1. 研究问题

在模型、Runtime、权限、任务集合、单题尝试次数和最大并发均保持一致时，把 89 道
Terminal-Bench 2.1 任务交给同一个长期 Morphz Agent，并由挂载到同一 Context 的 8 个固定
Session 分担，最终任务通过率是否相对“每题独立 Agent/Context”的 ME-08 发生变化；运行轨迹中
是否出现可审计的跨 Session 经验形成和复用。

该问题不是“有记忆与无记忆”的弱对照。ME-08 已提供具有完整 Morphz 能力、但各 trial 状态隔离
的控制条件；ME-09 只引入长期共享 Agent/Context 和固定 Session 工作流。

## 2. 对照

### 控制：ME-08 post-fix all-89 Morphz

- 89 个独立 trial；
- 每题独立容器、Agent、Context、Session、SQLite 和工作区；
- `gpt-5.6-sol` / max / full-access / Harness none；
- 每题一次、重试 0、最大并发 8；
- 官方 verifier `raw_reward` 为主分数。

### 处理：ME-09 shared-agent eight-session

- 一个 Agent、一个权威 Context、一个持久数据库；
- 精确 8 个固定 Session，全部挂载同一 Context；
- 89 个任务按冻结清单轮转分配，每个 Session 顺序负责 11 或 12 题；
- 任一时刻最多 8 个任务执行，每个 Session 同时最多一个任务；
- 每题仍使用全新的隔离容器、工作区和 Execution Target；完成评分后销毁该任务环境；
- Agent 可以按生产机制自主形成、修订和复用 Mind Frame，不增加任务特化 Harness，也不直接要求
  “总结这道题”或“提交经验”。

## 3. 冻结队列

正式协议应直接使用 ME-08 的同一 89 题 manifest 顺序，按列表位置 `index mod 8` 分配 Session。
执行采用 barrier rounds：每轮每个 Session 最多领取一题，等待本轮全部终态后进入下一轮。最后一轮
只有一个任务。这样保持最大并发 8，并使任务分配在看见 ME-09 结果前完全确定。

每个 task 只能出现一次。Provider、安全策略拒绝、Agent 错误、超时和 verifier 失败均为该题正式
终态，不补跑、不换 Session、不从分母剔除。

## 4. 变量边界

必须固定：

- Runtime commit 和 Linux 二进制 SHA-256 与 post-fix ME-08 相同；
- Terminal-Bench registry digest、Harbor 版本、模型物理标识、reasoning effort、fallback、权限和
  Provider route 相同；
- 最大并发 8、每题一次、无 Harness、官方评分器和任务容器镜像相同；
- 不根据 ME-08 的逐题成败调整 ME-09 顺序、Prompt、工具或预算。

如果“一 Runtime 对八任务容器”的 adapter 必须修改 Runtime 二进制，本实验不能直接冒充 ME-08
的单变量复现。应优先只新增外部 adapter；若确实需要 Runtime 修改，则先以同一新二进制重建隔离
Context 控制，或把结果降格为系统级探索实验。

## 5. 完整性 Gate

模型调用前必须通过：

1. 无模型 dry-run 证明全程只有一个 `agent_id`、一个 `context_id` 和精确 8 个稳定 `session_id`；
2. 89 个 task ID 与 ME-08 manifest 完全相同且各出现一次；
3. 每个 Session 同时最多绑定一个 Execution Target，Target 权限只能访问本题容器；
4. 一个任务结束后，后续 Session 无法访问其文件系统、环境变量和容器，只能读取 Runtime 正常投影的
   持久认知状态；
5. Context transaction 保留 base version、来源、提交 Session、冲突和重读记录；
6. 每个 verifier reward、Session、task、Execution Target 和根因果 turn 可以一一关联；
7. 断开任一 Session 或任务容器不会终止其他 Session；失败状态可以原样落盘并继续队列；
8. 资源采样、模型绑定和凭据不落盘 Gate 通过。

## 6. 指标

主指标：89 题官方 verifier 平均 `raw_reward`。

次指标：

- 相对 ME-08 隔离 Context 的逐题胜、负、同过和同败；
- 任务级配对差、cluster/bootstrap 区间和 discordant-pair 精确检验；
- 每题模型调用、Provider token、墙钟和失败类别；
- Context transaction 数、版本冲突数、跨 Session 来源引用数；
- 后续任务实际投影或引用此前任务所形成 Frame 的次数；
- 负迁移审计：过期、错误或不适用于当前任务的跨任务 Frame 是否进入行动依据。

“跨 Session Frame 被投影或引用”是机制证据，不自动等于它提高了得分。对具体 Frame 的贡献需要结合
trajectory 和因果来源单独审查。

## 7. 预先冻结的解释

- **ME-09 明显低于 ME-08：** 说明该共享 Agent/Context 与八 Session 协议在当前实现中产生负面
  系统效应；进一步区分 Context 污染、锁竞争、Prompt 增长、负迁移和 Provider/环境差异。
- **ME-09 与 ME-08 接近：** 不能证明没有迁移能力，也不能证明共享 Context 有益；任务可能缺少可
  迁移结构，或正负效应相互抵消。最多说明没有观察到明显总体退化。
- **ME-09 高于 ME-08：** 构成与跨 Session 正迁移一致的正式系统证据；只有在 trajectory 确认
  先前 Frame 被后续任务读取并改变方法时，才可把具体改善与经验迁移联系起来。一次运行仍不足以证明
  普遍因果优势。

无论结果如何，不能把 Terminal-Bench 分数直接解释为 Structured Context 单一机制的因果效应；
固定 Session 历史、共享 Context、调度和长期 Agent 行为共同构成处理条件。

## 8. 成本和停止条件

- 新增 89 个 Morphz trial；不再运行 Codex；
- 正式运行前先用 fake Provider 和最小无模型任务容器完成 adapter Gate；
- 不以真实模型 smoke 的成绩调 Prompt；真实 smoke 只验证接线和 artifact 完整性，产物不可并入正式分数；
- 若需要改变 Runtime 二进制、任务集合、并发、权限或评分器，停止并重新形成协议，不在运行中修补。
