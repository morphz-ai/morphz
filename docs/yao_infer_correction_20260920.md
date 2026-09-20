# Yao infer 修正与验收（2026-09-20）

状态：代码修正、自动化验证、原 Runtime 加载及原桌面交互验收完成。
未发布；本记录只声明下列已执行的验证范围。

## 范围

- `infer (returns T)` 的 T 约束模型求值结果，不与任务 BODY 的静态类型比较。
- 直接删除错误的 `produces`，不保留别名、历史模式开关、解码兼容字段或错误包副本。
- 模型数据结果按 T 获得严格 JSON 契约；Program 候选仍独立准入。
  Pending Effect 固定本次解码契约是正常恢复机制，不是错误语法兼容。
- Map 按 Map 取键；名义记录按已知类型取字段。点路径编译为逐层带类型的 Get，
  删除按 `$yao` 字段猜接收者类型的路径。普通数据中的 `$yao` 只是一项数据。
- `json-object` 降为 Dict + ToJson 语法糖，移除独立 HIR/执行节点。
- 离线工具检查复用现有有界 Schema 校验器：验证可静态求值的参数，拒绝已知非法值；
  包内全部声明函数各检查一次，包括入口未调用的导出／内部函数，不只遍历入口的内联树。
  动态参数、缺失 Schema、不支持的约束逐项报告，不冒充完整验证。
- 同步官方编剧 1.3.0、语言卡、中英文规范及测试；不新增一个包版本掩盖错误。

保留独立的捕获值传递、权限校验、幂等与恢复修复。用户剧本、正式稿、候选和输入
不是错误代码，不因本次修正清空。开发环境旧安装的处理与验证记录在下方单列。

## 当前验证

本轮重新执行，旧文档中的数量及桌面截图不计作本次验收：

- `cargo test --workspace --all-targets --features experimental-session-io --quiet -- --test-threads=4`
  最终版本通过。包括 Runtime 库 1391 通过、10 项环境依赖测试跳过；CLI 31 通过。
- `cargo test -p yao-lang --quiet`：56 单测、13 编写回归通过。覆盖不同 BODY/结果类型、
  错误关键字和序列化模式字段拒绝、Map 的 `$yao` 键、点路径、构造语法糖等。
- 离线编写 7 项测试已包含在 Runtime 库测试中；原审计的非法枚举值、缺少嵌套字段，
  以及未被入口调用的函数中的非法参数，探针均明确失败、退出码为 1。
  官方包检查及格式检查通过；带随包 Schema 的检查覆盖 7 个函数、1 个静态调用，
  动态提交参数明确列为需运行时验证，`tool_contracts_verified: false`，不再误报完整覆盖。
- `npm --prefix application test`：336 通过；应用生产构建通过。
- `npm --prefix application run test:script-runtime`：12 个分支、55 次合成模型调用通过。
  覆盖讨论不写入、延后生成、0/1/2 轮检查与修订、各阶段阻塞、非法结果拒绝、候选提交、
  人工采纳／审阅／锁定／导出和应用重开无重放。
- `npm --prefix application run test:script-recovery`：16/16 中断点恢复通过，包含模型各阶段、
  Host 读取以及提交前／后崩溃；只终止隔离的测试进程。
- Yao 全目标严格 Clippy、Runtime 非测试库及 binary 严格 Clippy、修改文件 rustfmt、
  `git diff --check` 通过。

完整 `--all-targets` 严格 Clippy 仍被未修改文件中的现有 6 处告警阻止：
`morphz/tests/session_io.rs` 持锁跨 await；`orchestrator/context.rs` 不必要借用；
`session_io/output.rs` 测试模块顺序；`output_tests.rs` 和 `session_io/tests.rs` 的
3 处 Default 后赋值。日志策略检查也仍报告 `memory/remote/timing.rs:178,216` 缺少
event_code。这些文件均无本轮 diff；不把这些门禁宣称为全绿，也不借本次修正扩改它们。

本机详细证据（临时测试目录，不作为产品迁移代码）：

- 全工作区：`/tmp/morphz-infer-correction.6PuIpI/workspace-tests-final.log`，退出码 0。
- 流程：`/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-script-runtime-cnVm8a/result.json`
- 恢复：`/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-script-recovery-oYC21X/summary.json`

流程和恢复证据均已使用最终 binary 重跑，不沿用修正前的结果。

## 原开发环境修正

2026-09-20 04:11（Asia/Shanghai）正常重启原空闲 Runtime，未新开应用、profile 或中心。
先确认无活动任务并备份两个数据库，再将唯一的未发布 1.3.0 包目录记录更正为已通过
隔离安装、加载及流程验证的源码／hash。没有新增版本，没有给安装 API 添加覆盖开关，
没有添加持久兼容逻辑。

- 包逻辑 hash：`sha256:fde4089183f26e5a28403c479b01dbe66a31ac9f82b23aa5149d9607f04f21d0`
- Program hash：`sha256:89af9e95433d2e22bd493802d5d46e63d4c2a0828d51da9ac2076cff981fd33b`
- 原桌面进程保留；首次修正后的 Runtime PID 为 71845，原端点 `127.0.0.1:18089` 恢复就绪。
- 重启后逐项核对：59 条输入、5 个剧本项目、候选／正式版本、会话和投递、执行历史、
  凭据配置及权限范围不变；只有指定包目录事件的 payload 被更正。
- 备份及比对结果：`/tmp/morphz-infer-correction.6PuIpI/verified.json`。

04:25 在完成下列桌面验证后，补齐离线检查的全部函数覆盖，并再次正常重启空闲 Runtime。
这次仅更新 binary，包目录、可执行 Program hash、配置和验证后的用户数据均未改变。

- 最终 Runtime PID：74464；端点仍为 `127.0.0.1:18089`。
- binary：原 profile 的 `bin/morphz-infer-corrected-final-20260920`。
- SHA-256：`4c6b4cf00d1714504f9c5f53265544d818a3601bbeaf8376dfa8700125496ee6`。
- 加载、hash、数据保留证据：`/tmp/morphz-infer-correction.6PuIpI/final-runtime.json`。

## 原桌面真实模型验收

解锁后在原 Morphz 窗口操作，未另开应用或 profile；使用已有测试剧本
“TEST 专业编剧 Harness 验收 0919”的“场1：两个人的操作台”。

1. 点击“构思新剧”，在输入框发送“TEST infer 修正讨论验收 0920”。
   要求仅讨论两个人修收音机的结尾小动作，不生成或修改稿件。
   实际 Plan 仅执行 `discussion`，界面返回两句话；此时新增候选为 0，所有原数据不变。
   输入 ID：`4c17e704-3b16-4943-b3b3-21221ce35591`。
2. 点击“生成候选”，保留 1 个候选／1 轮自审，通过“准备到输入框”后点击发送。
   实际阶段为 `intent → create → review → delivery`，一轮自审无明确问题，没有强制修订。
   只增加 1 个待决定候选；正式稿仍为 v1，引用的所属集仍为 v2，没有采纳、批准或锁稿。
   输入 ID：`8809c080-8f1d-4c64-a6ff-3478aa564062`；
   候选 ID：`edfd2a76-c11c-5c0a-99b8-81643771ab3e`。
   桌面已打开该候选的正文对比，候选数由 4 变为 5，供用户直接查看。

两条真实 Plan 均成功，绑定上述修正后的 1.3.0 hash；模型子执行的 Tool 列表为空，
数据结果均采用统一 JSON 契约。逐项比对原 59 条输入、5 个剧本项目、正式稿、旧候选、
会话路由／事件、执行历史和其他项目内容均未改变；仅新增上述 2 条测试输入和 1 个候选。

手动验收发生在 PID 71845；之后的离线覆盖补全未改变可执行 Program hash。
PID 74464 已确认恢复同一包和验收后的数据。证据：

- 讨论后单独核对：`/tmp/morphz-infer-correction.6PuIpI/discussion-acceptance.json`。
- 两条完整流程及最终数据比对：`/tmp/morphz-infer-correction.6PuIpI/manual-acceptance.json`。

这些证据确认语言修正、流程分支和数据边界，不代表专业创作质量、行业认可或所有模型兼容性。
