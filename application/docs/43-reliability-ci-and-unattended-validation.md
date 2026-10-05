# 持续验收与无人值守可靠性

2026-10-06，用户确认的两个活动目标：修复 CI 与失败诊断；取得当前版本
8–24 小时连续、受控、无人值守整链证据。本文记录范围与检查点，不是完成声明。

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
最终版重建、严格桌面复验及正式 8 小时冻结尚待执行。
