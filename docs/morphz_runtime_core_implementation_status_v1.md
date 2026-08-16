# Morphz Runtime 核心实现状态总览 v1
> 状态：当前权威状态索引
>
> 日期：2026-08-15
>
> 代码事实基线：`aefa17b`

## 1. 文档定位

Morphz 的设计文档记录了多个阶段的探索、取舍和实现过程。部分 v1 文档中的“未实现”或旧调度术语在当时是准确的，但已经被后续实现取代。本文只回答一个问题：

> 以当前 `main` 分支为准，哪些核心能力已经落地，哪些仍处于验证、产品化或远期研究阶段？

若历史文档与本文冲突，应依次以当前源码、数据库契约测试、本文和最新专项设计文档为准。历史文档仍保留，用于解释设计为何演进，不再承担全局实施状态索引的职责。

统一术语基线：Morphz 是运行在大语言模型上的 **S-Expression Cognitive Machine（S 表达式认知机）**；LLM 是可替换的非确定性语义处理器，Runtime 是确定性事务内核。Agent 指加载身份、Context、能力与策略后的认知机实例。历史 Profile ID、实验名称和原始 Prompt 可以保留 `SExpr VM` 或旧词序，但不再作为当前产品身份。

## 2. 当前状态

| 领域 | 当前状态 | 已落地的核心边界 | 仍需推进 |
| --- | --- | --- | --- |
| Scheduler Kernel v2 | 核心完成，运行期观察 | 统一 Kernel Command、权威 Store、结构化 Dependency、内部 Direct Signal、Thread/Activation/Group/Delivery 原子终态、Controller 与 Reconciler 分层、SQLite/PostgreSQL 契约测试 | 长期 soak、更多进程崩溃与外部故障注入、生产负载下的稳定性数据 |
| Session / Thread 并发 | v1 完成 | 多 Session 并发、同 Session 对话串行门、工具执行与对话并发、持久 Thread/Activation、批量排队消息、因果路由 | 极端并发时的公平性、长时间运行下的恢复验证与交互细节 |
| Objective Supervisor | v1 完成 | First-Class Objective、持久 Evaluation、Dependency 派生 readiness、暂停/继续/删除、持久收口审计、受监督并发 | 不同模型的自主收口质量、复杂目标下的长期行为评测 |
| Mind / Context Projection | 核心完成 | Event History、Mind Projection、Snapshot 增量恢复、Session Projection、有界 Context Encoding、SQLite/PostgreSQL revision CAS | 大规模生产容量、Projection 重建运维、跨主机故障注入 |
| Frame 级 MVCC | 已实现 | Runtime 从 SExpr 提取受影响对象；不同 Frame 的并发修改可安全 rebase；同一 Frame、来源已变化或全局生命周期操作保持冲突 fence | 生产冲突率与收益数据、更复杂 Relation/Checkpoint 场景验证 |
| Frame 生命周期与召回 | 基础能力完成 | create/derive/revise/retire/restore/protect、来源与身份、Recall Projection、活动/退役视图 | 自动语义激活、分层 Frame Working Set、长期认知质量与 Frame Exchange |
| Provider 与流式协议 | 可用，持续补齐 | OpenAI Responses/Chat Completions、Anthropic Messages、Gemini generateContent、流式正文/推理/工具、真实 usage 持久化与本地压力估算 | 多模态与 Provider 特有状态的完整 Conformance、长首字节/中断恢复的持续兼容验证 |
| Identity / SDK / Gateway | v1 可用 | Principal、Session 参与关系、Trusted Gateway、Dashboard Operator 视角、Rust SDK 与 HTTP API 共用应用层接口 | 公网多租户策略、审计/限流/配额、正式稳定 SDK 版本纪律 |
| Secret Store | v2 核心完成 | Catalog 与值分离、runtime/context/session/objective/target scope、系统凭证库与 Morphz `.env` 后端、CLI/Dashboard 管理入口 | Headless Keychain/Secret Service 部署体验、企业 Secret Manager 后端 |
| Execution Target / Edge / Artifact | v1 可用 | 本地与 Managed SSH Target、Target capability、远程 exec/read/write/search/transfer、Artifact Store、权限模型复用 | Edge Node 成品客户端、多跳代理、对象存储、断点续传、商业化配额 |
| Domain Harness / `.hns` | 基础设施 v1 完成 | Loader、Manifest/Contract/Mind、显式 `eval/infer`、Typed Plan IR、持久 PlanExecution、Registry、Evaluation Scope Binding | `process` 与模块组合、签名/远端目录、内置领域包、可重复的领域增益证据 |
| PostgreSQL / 多 Runtime | 首个可部署版本 | 完整 RuntimeStore 能力、SharedLeases、双 Store/双 Runtime/双 OS 进程 single-flight 与 lease 恢复、迁移锁和版本表 | 跨主机长期运行、数据库故障切换、生产编排与容量规划 |
| Dashboard | 持续产品化 | Runtime 全局视角、对话/调度/认知/事件历史/运行时、模型与推理控制、附件、Principal 查询、目标与线程控制 | 信息架构和移动端持续优化、更多诊断与运维工作流 |
| TUI / 配置 | 可用，持续产品化 | Setup、国际化、主题、CLI 子命令、统一用户级配置、Dashboard/Runtime 共享模型配置 | 与 Dashboard 的能力对齐、跨平台交互与配置迁移体验 |
| Web App / Desktop App | 尚未进入主实现阶段 | 产品边界与启动形态已有规划 | 面向终端用户的独立体验、远程 Edge 配对与正式发布 |

## 3. 当前调度权威语义

当前调度实现以 [Scheduler Kernel v2](./morphz_scheduler_kernel_stabilization_v2.md) 为准：

```text
Controller
  → KernelCommand
  → SchedulerKernel
  → RuntimeStore transaction
  → authoritative state + durable direct Signal
```

三条已经冻结的纪律：

1. Runtime 内部调度不再依赖 Event → Signal Outbox → Signal 的二次翻译；内部 Signal 在 Kernel 事务中直接、持久、原子提交。
2. Objective readiness 来自结构化 `scheduler_dependencies`；`wait_condition` 只保留为展示或迁移投影，不能成为业务权威。
3. Reconciler 只处理 lease、外部 outbox 和物理资格恢复；不能创造、猜测或修补新的业务语义。

旧文档中关于内部 Signal Outbox、正常路径 barrier repair、由单一 `wait_condition` 决定 Objective readiness 的描述，均属于历史实现。

## 4. 当前 Context 与并发写语义

在线请求从 Projection 读取当前 Mind 和 Session 状态，完整 Event History 重放只用于首次迁移、显式审计、损坏恢复和 Seed 导出。Context transaction 仍携带全局 `base-version`，但不再意味着所有陈旧版本都必然失败：

- 修改不同 Frame 的事务可以在 Runtime 验证 read/write set 后安全自动 rebase；
- 同一 Frame 被并发 revise/retire、来源 Frame 已变化、相同 ID 创建冲突时拒绝；
- checkpoint/rollback 等大范围操作继续使用 Context 级 fence；
- 全局 Context revision 继续承担 Event History 物理顺序和审计职责。

因此，当前实现已经从“纯 Context 级 CAS”演进为“Context revision + Frame revision 的分层 OCC/MVCC”，而不是把 Mind 拆成 Runtime 固定业务表。

## 5. 能力完整与效果成熟必须分开

以下能力在工程接口上已经存在，但不能据此宣称效果问题已经解决：

- Frame 可以形成、召回和迁移，不等于大规模 Frame 已能稳定产生高阶认知；
- `.hns` 可以执行，不等于 Coding、写作或视频 Harness 已经证明稳定增益；
- 多 Runtime 可以正确仲裁，不等于已经完成生产级跨地域容灾；
- Provider 协议可用，不等于所有厂商、模型和多模态边界都已进入 Conformance Suite；
- Dashboard 能控制调度对象，不等于面向最终用户的 Web App 已经完成。

今后的实施状态应分别标记“机制已实现”“契约已验证”“真实负载已验证”和“效果已证明”，避免把其中任意一层替代其他层。

## 6. 权威专项文档

- 调度内核：[Scheduler Kernel v2 稳定化重构](./morphz_scheduler_kernel_stabilization_v2.md)
- Context / Projection / MVCC：[Context 事务、Mind Projection 与分布式扩展](./morphz_context_transaction_scalability_and_mind_projection_v1.md)
- Session 并发：[并发 Session 事件循环与认知工作集](./morphz_concurrent_session_working_set_v1.md)
- Objective 与受监督并发：[First-Class Objective](./morphz_first_class_objective_supervisor_v1.md)、[受监督并发模型](./morphz_supervised_concurrency_model_v1.md)
- Harness：[Domain Harness](./morphz_domain_harness_architecture_v1.md)、[Yao Harness `.hns`](./morphz_yao_harness_file.md)
- Identity / SDK：[SDK v1 与可信 Gateway 身份接入](./morphz_sdk_and_trusted_gateway_identity_v1.md)
- Secret：[托管凭证与 Secret Store v2](./morphz_secret_store_architecture_v2.md)
- Execution Target：[Execution Target 与 Edge Node](./morphz_execution_target_and_edge_node_architecture_v1.md)
