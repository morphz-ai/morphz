# 持续验收与无人值守可靠性

2026-10-06，最初范围是修复 CI 与失败诊断，以及取得当前版本 8–24 小时
连续、受控、无人值守整链证据。本文保留原始检查点，执行以最新用户范围为准。

**2026-10-06 08:37 用户范围变更：** 取消仅重复验证已有功能的无人值守长跑。
不再要求或启动新的 8–24 小时运行，也不继续扩大旧功能验收矩阵；自动跟进
`morphz-8` 已删除。已发现的真实缺陷仍修复，只做与改动相称的定向回归和
阶段本地提交。以下长跑启动记录是历史证据，不是当前继续执行指令。
用户随后明确要求：已发现问题修复完成后结束目标，不再增加长跑或旧功能验收。

## 边界

不调整现有 UI、图标、布局与动效；不读取或改写真实业务资料、草稿、授权及
Session，不停止原 Runtime。自动回归使用独立的临时 SQLite/PostgreSQL、合成
身份、loopback Provider；外部付费模型调用为零。阶段验证后聚焦本地提交，
本目标没有新的 GitHub 推送、发布或新凭据授权。

数据权威仍是 Runtime 的 Event/Thread/Signal/Activation/Plan/Job/Outcome、
Platform 的输入和命令回执、认知应用的确切原件版本。测试仅生成可重放证据，
不新增生产数据库、双写、迁移或渲染器状态权威。Fixture 退出/重启只作用于
它本次创建并记录的进程与目录，不影响用户 App。

## 第一阶段：明确必跑与失败来源

新增 `cognitive-runtime-contract` 独立 CI job，调用正式 `npm test` 入口：

- PostgreSQL、真实 Rust Runtime 为必需能力；四组认知集成开关固定启用。
- 四个确切文件中的六项原契约逐项完成一次；零 skip/cancel/todo/缺项/重复。
- 总量报告和逐项 Node 完成账本必须同时存在；缺最终报告不是成功。
- 异常退出、显式取消、超时、托管 Runner 消失分别呈现。Runner 消失只能
  留下未完成状态，不推测测试结果。
- 上传有界脱敏文本与摘要，不上传原始数据库、Profile、账户、原请求正文。
  原 IPC smoke 单独导出有限因果字段、终态和日志；原 fixture 仅在本机保留。

本地六项真实 Rust/独立 packed 作者链已通过（Node 25.8.1、合成 Provider）。
CI 固定 Node 24.13.0；未推送前不声称托管 CI 已通过。

### 已核实的原失败，逐项处理

| 来源 | 证据与结论 | 处理状态 |
| --- | --- | --- |
| Application `37370373780` IPC | 持久 `runtime/response_protocol_error`：测试最终回复漏必填标题和结果标注；物理对象已成功写入 | 修测试 Provider，不关闭 Runtime 协议检查；当前源 IPC 已通过 |
| CI `37372641618` Check/Lint | Format check 指出 12 个 Rust 文件；Clippy 尚未执行 | 格式、语言及 379 项日志检查已通过；后续又发现核心错误诊断语言违规，原异常协议回归保持通过；完整 Clippy 另核 |
| 同 run Test/Release | `postgres_multi_process_probe.rs` 的 `NewThread` 漏新增字段，E0063；尚未运行测试 | 保持无模型探针的 Off 协议，修正精确准入事件断言；真实临时 PostgreSQL 多进程、single-flight、崩溃恢复及 schema 清理通过 |
| 同 run Native macOS/Linux | `runner_id=0`、无 steps；GitHub 原注释为 hosted Runner 多次未接单 | 托管容量失败，不计 native 通过，不猜为本地环境缺失 |
| Application storage PostgreSQL | 服务准备和 build 成功，测试步骤被取消 | 取消不计成功，也不推测所有测试失败；保留原记录 |
| 同 run Dashboard/Website | `npm audit --audit-level=low` 失败；后续 lint/test/build 未执行 | 两边分别 5/7 条传递链都指向暂缓的同一 braces 公告；不把破坏性升级或降版当补丁 |
| 同 run Native Windows | 原生边界 3 项、非 PG Session IO lib 22 项及 integration 13 项成功，构建产物上传成功 | 3 项明确需 PostgreSQL 的 ignored 不冒充已执行；真实 PG 用独立必跑 job 验证 |
| 真实 message smoke 第二条输入 | typed IO 默认 interrupt 的新 Thread 重复插入，准入回滚 503；PG 快速路径还错误合并 typed pending 输入 | 精确复用本事务已建的替代 Thread；SQLite/PG 同一合约 2 项实际通过，PG 原 legacy 合约通过；两种数据库的 HTTP 附件/引用/权限/重启原断言通过，不改 parallel 绕过 |
| 真实 trusted-gateway identity smoke | 来源读取错误使用 operator Context 端点及 service Principal，401 | 原 Human 只读 Session 证据已修复；真实双身份/共享/撤权/重启 smoke 与 Rust gateway 拒绝边界通过，不升级权限或 claim membership |

用户暂缓的无已发布补丁 `braces` 告警仍独立披露；不删除安全门来宣称全 CI 绿。
此前原 11 项依赖告警已关闭，不代表当前所有 npm 审计没有新告警。

查看者与作者仍分离：团队查看者使用自己的既有 Session 权限读取原作者来源，
不改写作者，也不借来源读取获得成员权限；Agent 签名来源仍须原作者当前有效。
新增 16 项正式 Node 回归含受控 HTTP 边界，明确不冒称真实 Rust；另有真实 Rust
gateway 回归。其他管理界面的 operator 读取不在本次来源修复的完成声明中。

本地阶段提交：`b3c4915d` 必跑 CI；`87da7c3a` 最终回复 fixture/脱敏证据；
`cff2d230` 探针与格式；`142d017b` 长跑 harness；`f639141c` 只读身份来源；
`ed2cb57f` 核心诊断；`7c91f248` typed interrupt 两端修复及 PG CI 必跑门。
这些提交未推送，新托管 run 尚未产生。

## 第二阶段：连续长跑

先完成短时预检，再冻结提交号、实际二进制版本/哈希和 harness 哈希，真实运行
至少 8 小时。短测、已写代码、启动成功、计时器到点都不能替代长跑完成。

每轮包含多 Session 的真实输入、定向 steer、持久 Context 事务、infer 父子链、
定时事项和生产 Host 物理对象写入；周期注入 Provider TCP 断开、Host 在途关开、
隔离 Runtime 崩溃恢复。故障不每轮重启 Runtime，以保留长驻资源增长区段。
每个根必须独立核唯一 Thread 与相应唯一终态、未遗留活动/信号/计划；原命令
重试必须回原回执，不增模型调用、物理 Job 或对象版本。记录 RSS/FD/SQLite
字节及权威表计数，区分正常持久历史增长与不可解释资源增长；缺观察或机器
休眠超过连续性预算使本轮失败，不用墙钟空跑冒充 8 小时工作。

独立目录保留 manifest、逐事件 trace、每轮资源、原合成请求样本、失败数据库
和最终 result；失败不删除断言、回执或原始证据。清理失败也必须输出失败报告，
不能因为先写了成功字段就跳过后续清理检查。

### 证据不可替代的边界

- Embedded Host 关开不等于实际 Electron 窗口关闭/退出；另需真实 Electron
  自动隔离回归，实际 main 退出、同 Profile 冷启动、原 Runtime 持续、草稿和
  回执保全。它仍不冒称用户原窗口手工验收。
- 合成 Provider 可以证明调度、传输、恢复和控制协议，不证明模型自主认知
  质量；脚本 Context 退休/保留事实不能冒称真实模型总结能力。
- SQLite 长跑不代表 PostgreSQL 长跑或跨宿主 failover；PG 用独立真实集成
  合约验证并单独记录。未经执行的范围始终保留为待验收。

## 当前检查点

目标活跃，尚未完成。CI 独立认知六契约与门禁负控、上述实际失败修复已验证；
`7c91f248` 二进制的 IPC、双身份与四文件六项正式门再次通过，零失败/跳过/取消；
正式门证据 `application/test-results/cognitive-runtime-ci-MYbbOb/summary.json`。

隔离生产 Electron 的 `7c91f248` 严格验收通过：
`/private/tmp/morphz-embedded-electron-DqKIo4/result.json`。真实关窗/activate
保持同 main，app.quit 正常 main exit 0 后同 Profile 冷启动；Runtime 全程同 PID。
两个原根、唯一物理 Job、实际 DOM 回复、未发送草稿的原始字节/owner/key、原件、
来源、权限及回执均保全。旧二进制和超短 deadline 两种负控确实失败且保留取证。
它不冒称用户原窗口验收，原 App 未触碰。

初次 `7c91f248` 长跑 `/private/tmp/morphz-reliability-soak-I1NLGr` 实际运行
279090 ms、5 轮、41 个完成根，八种故障/事务场景均执行，清理失败为零。
此时完整 Clippy 又发现 13 项历史警告（此前 CI 被格式门挡住），需最终源码收尾。
为重新冻结最终版本，主执行者只对 owned harness 发 SIGTERM；原 result 如实记录
failed/interrupted，目录与原证据保留。这不是产品故障，也不是 8 小时通过；
不会拼接前后时长。机械 lint 修正及独立复验完成后，正式连续 8 小时另行冻结、
启动并记录结果。

最终机械收尾已验证：完整严格 Clippy（原命令及新增 `--keep-going` 的同强度
命令）均 exit 0；`--keep-going` 仅让独立编译目标的错误一次完整呈现，不降低
`-D warnings`。私有终轮证据参数合组、等价迭代及测试锁的词法作用域修正保留
原断言、事件投影、最终协议和权限检查。协议/Custom/投影/steer 64 项回归、
Custom/ingress/steer 13 项、Runtime/Store 28 项、generation 查询 SQLite/PG
2 项，以及 typed interrupt SQLite/PG 2 项分别通过；重跑组有重叠，不相加
冒充独立测试总数。专用 PostgreSQL 实际执行并清理，未以缺环境变量提前返回。

严格日志：`/tmp/morphz-clippy-strict-final-oct06.rATR2Q/clippy-original.log`；
全面诊断日志：`/tmp/morphz-clippy-keep-going-final-oct06.C5YyqB/clippy-original.log`；
typed 当前源结果：`/tmp/morphz-typed-final-current-oct06.d4DRKx/result.json`。
格式、英文协议、379 项诊断及工作流语法检查通过。这些是本地证据，不是远程
CI 成功声明。全量 Rust 将从干净的隔离提交副本运行，保留原始 ignored 清单；
真实外部登录测试不在无付费/无新凭据范围，不全局启用 `--include-ignored`。
原生测试还须隔离默认 SSH 配置读取，不能只用新 HOME 推断已隔离 macOS 用户。
机械收尾聚焦提交为 `c12d52f37f220b20a43438ffe247f26dc057741a`，这是本目标
第九个本地提交，未推送。最终二进制 version 为 `git c12d52f37f22`，SHA256
`67fca34452456780f7b7ecdb4b54d449ea5938133e6fdfd0151fec163da47441`。
IPC 与双身份两条正式链实际复验成功，前后源/二进制哈希一致：
`/tmp/morphz-final-runtime-c12-oct06.0Wl9Xk/verification.json`。
认知正式六项门再次完成 6/6，零 skip/cancel/todo：
`application/test-results/cognitive-runtime-ci-vHcTNE/summary.json`。
真实隔离 Electron 两场景同 Runtime PID、真实 quit exit 0、草稿/原件/回执
保全及实际 DOM 验证通过：`/private/tmp/morphz-embedded-electron-21x92S/result.json`。

### 最终冻结并行运行（历史记录，未通过）

完整 Rust 原命令 `cargo test --locked --all -- --test-threads=1` 曾实际启动。
证据目录 `/tmp/morphz-full-rust-final-c12-snapshot-oct06.DqkLDj`，直接运行
其 `harness/run.mjs`，原工具会话 `30957`、owned Cargo 进程组 `85162`。
该运行现已失败结束，以下是当时的隔离条件。使用干净的同提交副本
`/Users/shafreeck/.codex/worktrees/reliability-ci-isolated/Morphz`，只共享绝对 Cargo
target 缓存，不共享默认资料目录。真实专用 PG、owned HOME/MORPHZ_HOME、净
凭据环境、2 build jobs、CI 同样的 test debug=0、测试串行、双卷 8 GiB 下限。

SSH wrapper 只准真实 `/usr/bin/ssh -F /dev/null` 的版本/配置展开，不准连接
或额外/组合配置选项；只准版本单参或固定 localhost 的确切安全 user/port
参数语法。Fish wrapper 真进程加 `--no-config`，只准单个版本参数或一个
`-c` 脚本，不准覆盖启动参数。独立正负控 33/33 实际通过，证据
`/tmp/morphz-native-wrapper-review-oct06.PAwmhn/result.json`；新运行自己的
预检全部通过后才启动 Cargo。结束还须检查测试期间至少 3 次
SSH 展开与 2 次 Fish 命令的脱敏调用账本，不能把可选命令缺失后的 early return
算作实际原生验收。不验证用户 Alias/Match/认证或启动配置，也不冒称 Linux
原生沙箱已经在 Mac 执行。完整 ignored 清单保留，专门 PG 已执行另列。

此前 `/tmp/morphz-full-rust-final-c12-oct06.uKUe6F` 已防御性中断：独立复核
发现最初 SSH 黑名单检查漏组合 `-vF`/`-qF`；当时尚在编译、实际测试为 0，
未见危险调用。只发 SIGTERM 给 owned Cargo `81077`；171.163 秒、PG 清理
成功、源码哈希不变，原 result/log 保留，`harness-review.json` 更正原元数据中
过强的配置拒绝声明。这不是产品测试失败或环境缺失。旧辅助文件未在修正前
保存完整快照，只记录原哈希，不拿新文件冒称旧文件可精确重放。以后每轮先
保存 runner/SSH/Fish/PG helper 只读快照、实际从副本执行，结束核全部哈希；
PG helper 与原提交字节相同，只有已安装 `pg` 依赖复用外部 node_modules。
`mWtyES` 是未启动候选，不当成实际全量。此时没有变更生产源码，未因此重启长跑。

正式连续 8 小时于 `2026-10-05T22:15:55.432Z`（北京时间 10 月 6 日
06:15:55）启动，原定最早 14:15:55 达到时长；实际已提前失败，未达到时长。
证据 `/private/tmp/morphz-reliability-soak-L0PYAH`，日志
`/private/tmp/morphz-reliability-final-c12-oct06.log`，tmux
`morphz-reliability-final-c12-oct06`，owned harness PID `82804`。
冻结副本与 manifest 对应上面的确切 c12 提交，8 种真实场景首轮全部执行、
18 次合成 Provider 请求；这仅证明已开始并完成首轮，不是 8 小时通过。

### 停止状态及后续修复

`L0PYAH` 实际于 `2026-10-05T22:55:03.567Z`（北京时间 06:55:03）失败退出，
运行 2348114 ms，第 40 轮 Context 事务未提交；原 `result.json`、失败请求、
数据库和日志全部保留，cleanupFailures 为零。它不是 8 小时通过，40 轮也
不与新运行拼接。当前核查 owned harness `82804` 和 Runtime `83556` 已退出，
不是仍在运行或已验收。按用户最新范围不会重新冻结或启动替代长跑。

`DqkLDj` 全量 Rust 实际 exit 101，主 lib 栈溢出中止，没有完整最终报告；
其余未执行 targets 不计通过。另一个 SSH 配置展开用例被 fixture 围栏误拒绝，
已精确允许固定 `mini-m4.local` 的 `-G` 展开并定向通过，未允许远程连接或个人配置。
原失败报告与三套临时 PG 的清理证据保留。

栈溢出已用同一二进制默认栈与诊断 16 MiB 栈对照复现；增大测试栈不是修复。
修复只在 `SchedulerKernel::execute` 堆固定大型 interpreter Future，仍在
同一 task 中 await，保留取消、事务 fence 和调用顺序。默认栈 exact 与相关
67 项回归、严格 Clippy 已有实际成功证据，独立审查后聚焦提交 `a7bca84e`。
默认栈 exact：`/tmp/morphz-stack-final-default-c12-oct06.TsDQbd/result.json`；
相关回归：`/tmp/morphz-scheduler-box-regressions-oct06.mL7spE/stage-results.json`。

长跑第 40 轮另观察到真实 Context SQLite `SQLITE_BUSY_SNAPSHOT`（517），
事务失败后 fixture 仍产生最终回复；“Thread completed”不能替代 Context 提交。
已用 `77850512` 修复：两条 Runtime Context 写入口在读取 mutation basis 前
共用 `BEGIN IMMEDIATE`，避免 deferred snapshot 被并发提交失效。不新增语义
重试、不改 CAS／输入保护／来源归属，状态、Event、Session projection、Recall
和提交回执仍在同一事务内。原 trace 未记录具体竞争 SQL，不能指认某个并发
writer；确定性回归用独立连接复现同一机制。

四个 exact 定向回归实际通过，零 ignored，未设置 `RUST_MIN_STACK`：

- `memory::sqlite::tests::context_db_writer_reservation_prevents_busy_snapshot_and_preserves_cas`
- `memory::sqlite::tests::context_db_is_authoritative_while_trajectory_and_control_commit_atomically`
- `context_tools::tests::context_tx_tool_rejects_retiring_the_active_root_request`
- `context_tools::tests::context_tx_tool_persists_direct_model_and_causal_attribution`

第一个回归直接验证生产 writer reservation helper，公共入口的调用由源码
复核确认，不冒称在每条入口内部注入并发。原始工具输出保存在本轮 Context
子任务 rollout `01a10ea5-20d0-7623-8a65-942b8b6cd8c5` 的 L383／L403；没有另存
shell logfile。最终 sqlite.rs SHA256
`d8d7e30bfcf52e26514be9ea84aea87028527e6902e3efc9de915ed931a521d8`。

### 已完成证据工具的保存与审计修复

`7d420986` 保存本轮此前已完成的隔离维护／故障证据工具及对应测试，不会
自动启动验证。维护证据 `movkeW`／`cT8mFl` 已只读复核：34 roots、38 次受控
请求、1 个实际写入 Job；压力下降、原输入与确切来源保留、重试未增加调用。
此证据是协议证明，不是自主摘要质量或长跑证明。

故障证据 `/private/tmp/morphz-reliability-fault-boundaries-66HMGu/result.json`
保留原写入 `lost`，仅执行一次；随后两次实际 list/read 完成并公开说明不确定
状态，不用缓存成功回包冒称原写入恢复。旧 `actualOutageMs` 31527 ms 包括
恢复验证，实际注入配置为 20000 ms；不可把这两个时长混称。提交前仅增加
只读结果的结构断言以通过严格类型检查，未声称重新跑过该脚本。

独立审计发现并修复：只要求终态记录一致可能把一致的 `failed` 也判 PASS。
现在 ledger 与 trace 都明确要求工作 root 为 `completed`；新增一致失败负控，
focused audit tests 6/6 通过。维护 oracle 原有 20 项通过；五个文件的 focused
严格类型、格式检查通过。没有扩展或重新运行既有功能矩阵。

### 按最新用户范围收尾

已发现的栈溢出、Context SQLite snapshot 失效及审计假通过缺口均已修复，
阶段提交保留原失败和定向回归。按用户要求结束原目标，无人值守长跑取消，
不是验收成功。未重启或部署原 Runtime，未推送 GitHub；本地 CI 门已实现，
不将本机定向回归表述为全量或远端 CI 全绿。

用户原 Runtime `68670` 仍存活，未发停止/重启信号；UI、资料、权限与 Session
保持不变。自动跟进已删除。本次用户新反馈的页面“应用连接中断”独立排查，
当前 App 进程与 Runtime 服务正常不等于页面已恢复，未以服务健康代替 UI 验收。
