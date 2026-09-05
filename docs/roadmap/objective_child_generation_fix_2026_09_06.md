# Objective 子线程等待故障修复审计（2026-09-06）

## 根因与回归边界

`schedule_tx` 创建现有 Objective 的 durable 子线程时，把内容/状态变更的
`Objective.revision` 用作了 `Thread.supervision.generation` 和 ThreadGroup generation。
目标被编辑、claim 或绑定等待组后，revision 可以增加，但执行生命周期 generation 不变。

`e31fbd83339bf43abc7955e3b8e09ca23754d124` 加入 Objective dispatch generation
校验后，原有写入错误表现为调度卡住：Timer 已触发，claim 因代次不匹配被拒绝，
没有 Signal/Activation，Schedule 留在 queued。不是把秒解释成毫秒，也不是模型不愿执行。

## 修复边界

- 创建、转交子线程统一使用实际 Objective generation；revision 仅作变更 CAS。
- SQLite/PostgreSQL 在同一事务中验证子线程的 Objective 身份、路由、状态和代次，
  任一成员不匹配则整个创建事务回滚。PostgreSQL 按稳定 ID 顺序提前取得 owner 写锁。
- 新 Objective 执行线程不得借用旧事件的 revision 或新 owner 代次绕过过期输入检查。
  被拒绝的旧输入留下稳定审计，并关闭对应投递记录，不物化 Thread/Signal/Activation。
- 保留暂停、取消、代次切换后的 dispatch fence；不放开旧工作重新执行。
- 旧的子线程 owner/generation 不一致会出现在 Scheduler 不变量诊断中；诊断本身不
  自动暂停、重绑定或改写这些记录。

## 已存在错误记录的升级边界

**普通升级只能阻止继续写错，不能自动恢复已卡住的 queued 工作。** 已 fired 的同代次
Timer 也不会因为重启重新变成 pending。不能声称只换二进制即可恢复四条原任务。

生产处理必须另获授权，先备份实际运行数据库，再按明确 ID 逐项审计。特别核对是否已有
Signal、Activation、ExecutionJob、终态或外部副作用；存在任一执行证据就不能当作
“尚未启动”无条件重建。

无需更改数据库 generation 的保守处理方式是使用现有控制接口取消并重建：

1. 通过 Objective 的取消操作关闭原目标，阻止继续派生新工作；保存原目标说明和关联 ID。
2. 显式逐条取消错误子 Thread（`Runtime::control_thread`，`Cancel`，最新 revision CAS）。
   **不能只依赖取消 Objective 的同代次级联**：错误记录的监督代次本来就不匹配。
   Thread 的取消事务闭合其 Schedule、Activation、终态及组成员；读回核实状态。
3. 确认原来的子线程、Schedule 均已闭合，再通过普通 Objective/`schedule_tx` 创建替代工作。
   新工作使用新 ID，保留旧历史和已有文件；不能把重建说成原任务继续执行。
4. 对于必须保留原任务 ID 的修复，需要单独审计、验证的一次性数据修复；本提交不提供
   启动时自动改代次的兼容代码，也没有修改任何生产记录。

隔离回归验证了过期 queued 子线程经普通取消后，Thread/Schedule 均为 cancelled，
重建 Scheduler 并 recover 不会重新派发。四子线程回归验证了新建替代工作的调度基础：
revision 与 generation 不同、创建后先重建 Scheduler、recover 后四条各派发一次。
这两项不是针对任意旧生产数据的无条件恢复保证。

## 门禁

- `schedule_tx` existing/current Objective：四个独立 durable 子线程实际派发，重启恢复不重复。
- promotion：转交到新建/编辑过的 Objective 后实际派发，不混用源 owner 和目标 owner 代次。
- stale generation：不产生 Signal，不执行；普通取消后重启仍保持闭合。
- stale Objective continuation：持久 rejection、outbox discarded、无新执行、无额外模型调用。
- rejection 审计提交前后重试：一条审计事实，投递记录始终正确闭合。
- SQLite 与真实 PostgreSQL Store conformance：混入错误 generation 的批次全量回滚。
- 完整 morphz lib、attempt_loop、objective_group_handoff、fmt、Clippy、diff-check。

最终实测：morphz lib 1265 passed / 0 failed / 7 ignored；attempt_loop 76 passed；
objective_group_handoff 1 passed；runtime_store_conformance 6 passed（包含实际启动的
隔离 PostgreSQL，未跳过）；`cargo clippy --offline -j 2 -p morphz --lib --tests --
-D warnings`、`cargo fmt --all -- --check` 和 `git diff --check` 通过。

保留一次中间门禁失败：`same_session_dialogue_turns_are_serialized` 等待回复超时，
单独精确复跑及默认并发的完整 attempt_loop 重跑均通过；未更改该测试、延长超时或
降低测试并发。此次波动原因没有独立确证，不能据此声称已修复另一个调度问题。
