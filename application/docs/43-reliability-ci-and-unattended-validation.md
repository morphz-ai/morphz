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
| CI `37372641618` Check/Lint | Format check 指出 12 个 Rust 文件；Clippy 尚未执行 | 机械格式修正及原检查复验 |
| 同 run Test/Release | `postgres_multi_process_probe.rs` 的 `NewThread` 漏新增字段，E0063；尚未运行测试 | 显式保持该无模型探针的 Off 协议，并验证真实 PostgreSQL 探针 |
| 同 run Native macOS/Linux | `runner_id=0`、无 steps；GitHub 原注释为 hosted Runner 多次未接单 | 托管容量失败，不计 native 通过，不猜为本地环境缺失 |
| Application storage PostgreSQL | 服务准备和 build 成功，测试步骤被取消 | 取消不计成功，也不推测所有测试失败；保留原记录 |
| 真实 message smoke 第二条输入 | typed IO 默认 interrupt 的新 Thread 重复插入，准入回滚 503 | 正在最小修复，SQLite/PostgreSQL 同契约回归，不改成 parallel 绕过 |
| 真实 trusted-gateway identity smoke | 来源读取错误使用 operator Context 端点及 service Principal，401 | 正在修正为原发起 Human 的只读 Session 证据，权限不升级 |

用户暂缓的无已发布补丁 `braces` 告警仍独立披露；不删除安全门来宣称全 CI 绿。
此前原 11 项依赖告警已关闭，不代表当前所有 npm 审计没有新告警。

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

目标活跃，尚未完成。CI 独立认知六契约与门禁负控已验证；真实 IPC 首个失败
已复现、定位并修正。其他真链新暴露的错误正在逐项修复；长跑 harness 正进行
独立评审和短时预检，8 小时正式结果仍待实际取得。
