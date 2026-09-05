# 调度取消与目标干预的闭合边界

## 控制的是工作，还是唤醒来源

- `schedule_tx` 的 `cancel` 只取消指定 Schedule；它不会把所属 Thread 宣告为取消，也不会把未完成的组成员计为成功。
- 放弃整条工作应调用 `thread_control`，参数为 `thread_id`、`expected_revision`、`action`（`pause`、`resume`、`cancel`）、`reason`。最新 Thread revision 可从 `recall` 或 `schedule_tx inspect` 返回的 `thread` 获取。
- 模型工具与 Dashboard/API 使用同一个 Scheduler Kernel 控制入口。取消必须原子提交 Thread 终态、待处理 Signal/Schedule 的取消、唯一 ThreadOutcome 及 Group/依赖结算。正在执行的物理任务接收取消，不保证回滚已经发生的副作用。
- 旧 revision 返回冲突，不得盲重试。重复取消不能重复累计组计数或生成第二个终态。模型不得用这个工具控制自己正在执行的 Thread。
- 事务提交后的实时唤醒可以异步交付；不能在父 Thread 执行取消工具、仍持有自身执行锁时同步等待父线程处理 Group 屏障。持久事实始终先于实时交付，并可由恢复器重新投递。

独立 Schedule 与 Objective 仍不建立隐含生命周期级联。修复不通过忽略合法 open Thread、自动取消旧数据或跳过依赖来消除等待。

## 等待中的 Objective 接收定向干预

干预获得的不是“忽略所有等待”的权限，而是针对一个确切依赖的 Evaluation 绑定。工具输出及并行工具组的后续 Activation 必须保留：

- Objective ID、Evaluation ID、revision；
- Evaluation 开始时间；
- 本次干预获准跨越的 `objective_pending_dependency_id`。

每次后续 Activation 准入及续租都检查持久状态。该依赖必须属于当前 Objective generation；不存在、被取消、被其他等待替代或 Evaluation 已失去所有权时拒绝继续。

干预本身可能取消最后一个子线程，使原依赖满足并清除 Objective wait。此时允许同一 Evaluation 继续创建替代工作，但仅限原依赖已满足、wait 已清空且不存在其他必需的 pending 依赖。不能仅凭“目前没有 pending 依赖”恢复缺失绑定的执行。

异步工具、物理工具拒绝结果及 Action Group 屏障共用完整路由编码。并行组恢复从原始持久 tool-selection Event 取回绑定，并校验其 Objective/Evaluation 与 Group 一致。

Yao `infer` 是新的受管子执行，而不是父输出的复制。其权限通过持久 Plan、父子 Thread/Activation、原始 infer Event 与 Signal 的完整关系校验，再从确切父 Activation 的持久 tool-selection 事件继承中断依赖；不修改不可变 infer Event，也不新增数据库字段。新目标采用可能发生在工具选择之后，此时有效 Plan 图只证明普通 Evaluation 权限，不能授予跨越 pending wait 的例外。冲突绑定不可降级成普通权限。

`derive_objective_readiness` 的 `Leased` 是状态投影，不是跳过依赖的授权。缺失中断绑定的子执行，即使租约尚新，也不能越过未满足的等待。

### 提交替代等待后的收尾

`schedule_tx` 为本次 Evaluation 创建新 Group 并安装等待后，允许一次 `schedule-receipt` 收尾，只能说明安排或 `no_reply(mode=silent)`。权限必须由持久工具回执、同一工具求值/线程的 `objective/thread_group_bound` 事件、当前 generation/Group 与唯一 pending 依赖共同证明，不能仅凭工具名称放行。

新依赖仅用于这次只回复阶段的精确续租，不改写原干预的工作权限。此阶段不进入 Runtime Harness；Provider 上下文溢出恢复也不能重新开放工具。正常终态释放同一 Evaluation，保留新 Group/wait，重复或陈旧回执不能重新激活已结束的求值。

## Dashboard

`lifecycle=open` 表示工作未终结；`phase=idle` 表示目前没有可执行唤醒，两者并不矛盾。未结束线程必须保留在控制列表，允许检查与取消，不应被近期历史数量限制隐藏。运行计数仍由真实调度 phase 计算，不把 idle 宣称为正在执行。

## 回归覆盖

- 实际模型工具目录包含 `thread_control`，并通过普通工具调用完成取消。
- 实际定向 Objective 输入经过多轮工具输出，取消四个未启动子线程后创建四个替代线程；不额外创建普通对话 Thread。
- 同一干预先经 durable Yao infer，校验真实子线程完成、Plan 成功及 typed result=42 后，再取消与替换；同时覆盖同响应 `objective_create` 前置采用加 `eval` 的普通无等待路径。
- 四成员组取消仅生成一次终态/屏障；重建 Store、TimerEngine 与 ThreadScheduler 后，只有替代工作被实际投递。
- 虚拟时钟驱动多次 heartbeat，并覆盖丢失、取消、竞争依赖和旧 Evaluation；不使用随机 sleep 制造竞态。
- 替代回执后的实际模型请求跨三个心跳周期仍存活；正常回复后释放 Evaluation，旧回执不能重入；Provider 溢出后的工具越权也在执行前拒绝。
- SQLite/PostgreSQL 共用等待完成前后和 stale route 的 Store 一致性断言。
- Dashboard 验证 open+idle 可见、可取消，但不计入运行线程。
