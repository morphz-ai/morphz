# Morphz 产品化架构收口 v1

> 状态：v1 已实现
> 更新时间：2026-07-13
>
> 历史边界说明：本文记录 2026-07-13 完成的 Core/Extension/Eval/Application API 收口，相关依赖方向仍然有效；其中把 Dashboard 称为“可选 Inspector”的产品定位已被后续规划取代。当前产品界面与交付边界以[产品界面与交付架构 v1](./morphz_product_surfaces_and_delivery_architecture_v1.md)为准，Dashboard 详细定位以[Dashboard / Runtime Console 设计 v1](./morphz_dashboard_runtime_console_design_v1.md)为准。

## 1. 目标

Morphz 已经具备 Agent 主循环、Agent-owned Context、多 Session 挂载与共享、长期任务、工具执行、原生沙箱和审批闭环。下一阶段不再继续把所有实验能力堆进同一个二进制，而是建立稳定的产品边界，让核心 Runtime、CLI、Server、扩展、Inspector 和评测可以独立演进。

本阶段只收口以下四项：

1. 明确 Core、Extension、CLI、Server、Inspector、Eval 的所有权；
2. 将 Vector、Graph、Embedding 从默认核心迁为可选扩展；
3. 将评测代码和评测二进制迁入独立 `morphz-evals` crate；
4. 提取统一 Runtime Application API，并让 CLI 与 Server 通过该 API 组装运行。

## 2. 产品边界

### 2.1 Core

`morphz` 核心库只拥有任何 Agent 都必须具备的机制：

- Agent、Cognitive Context、Session、Delegation 生命周期；
- Event Ledger 与 Context Encoding；
- S-Expression VM、工具循环与标准回复协议；
- Permission Profile、审批和 Sandbox Backend；
- 文件、Shell、Skill discovery 等基础工具；
- Provider-neutral LLM completion 接口；
- 可选能力的稳定 Extension SPI。

Core 不依赖任何具体向量数据库、Embedding 模型、Dashboard 图谱视图或评测夹具。

### 2.2 Extension

扩展实现非必需能力。Core 只定义最小、语义中立的接口，例如 `RecallProvider`；具体扩展自行拥有数据模型、依赖、配置和迁移。

首个扩展 `morphz-memory-vector` 承接历史 Graph/Vector/Embedding 能力。默认 `cargo build -p morphz` 不编译或初始化该扩展。扩展复用原有 SQLite `graph_nodes/graph_edges/model_metadata` 表，因此停用扩展不会删除历史数据，重新启用后仍可读取。

### 2.3 CLI

CLI 是第一等产品，但不拥有 Runtime 规则。它只负责：

- 参数和交互输入；
- Runtime Application API 调用；
- 事件、工具调用、审批和最终回复的终端呈现；
- Ctrl+C、中断和退出语义。

### 2.4 Server

Server 是同一 Application API 的远程传输适配器，负责 HTTP/WebSocket、认证、序列化和事件流，不直接实现 Context、Session 或审批业务规则。

### 2.5 Inspector

当前 Dashboard 降级为可选 Inspector。它不是 Core，也不决定 API。默认 Inspector 聚焦 Session、执行轨迹、审批、Context/Mind 和 Ledger；Graph 页面只能由 Graph 扩展提供。

### 2.6 Eval

所有基准夹具、评分器、模型矩阵和评测二进制属于 `morphz-evals`。它可以依赖 Core，但 Core 不能反向依赖 Eval。

## 3. Runtime Application API

Application API 是人类界面和机器界面共同依赖的产品契约。v1 提供：

- `MorphzRuntimeBuilder`：显式注入配置、LLM Client、数据库位置和默认身份；
- `MorphzRuntime`：封装并启动 Event Bus、Store、Context Engine、Orchestrator、Permission Broker 和 Approval Hub；
- `AgentHandle`、`ContextHandle`、`SessionHandle`：用稳定身份操作生命周期；
- 消息提交、取消、事件查询、Context inspect 和审批接口；
- Runtime event subscription，供 CLI、Server 和未来 SDK 使用。

底层 Store、Orchestrator 和工具注册表不再暴露给 CLI/Server，也不成为外部 SDK 的长期承诺。

CLI 与 Server 使用同一套 `MorphzRuntime` Application API 和持久化语义：消息提交统一走
`SessionHandle::send`，事件统一走 Runtime subscription，Context inspect、取消和审批也都
通过 Application API 完成。交互 CLI 与 `serve` 是不同的进程入口，不要求为了使用终端而
隐式启动 HTTP Server。

## 4. 数据兼容与删除纪律

- 核心数据库升级不得删除 `graph_*` 或 `model_metadata` 历史表；Core 只停止创建、读写和迁移这些扩展表。
- Vector 扩展负责幂等创建旧表，并兼容读取既有 Embedding BLOB。
- 历史 LanceDB sidecar 不由 Core 删除。v1 扩展以 SQLite BLOB 为事实来源，后续如果重新引入 ANN Backend，应由扩展自身执行显式迁移。
- 旧配置中的向量字段不再影响 Core；扩展配置进入独立配置域。
- 迁移期间每一步都必须保持默认 Core 可编译、可测试，并保持 Ledger/Session 数据兼容。

## 5. 依赖方向

```text
morphz-cli ───────┐
morphz-server ────┼──> Morphz Runtime Application API ──> Core
future SDK ───────┘                          ^
                                              │ RecallProvider
morphz-memory-vector ─────────────────────────┘

morphz-evals ────────────────────────────────> Core
Inspector ───────────────────────────────> Server API
```

禁止的反向依赖：Core 不能依赖 Eval、Inspector 或具体 Extension。

## 6. 本阶段验收

- `cargo tree -p morphz` 不再包含 LanceDB、Arrow、Candle、Tokenizer 或历史 `executor`；
- Morphz 默认启动不加载 Embedding 模型、不创建 LanceDB 目录、不暴露 Graph API；
- `morphz-memory-vector` 能打开旧数据库并完成文本/向量召回；
- 生产 crate 不再导出 `*_eval` 模块或构建评测二进制；
- CLI 和 Server 由同一套 `MorphzRuntime` Application API 提供能力；
- Core、Extension、Eval 和 Dashboard 均通过各自验证。

## 7. 实现结果（2026-07-13）

- 默认 `morphz` 已移除 LanceDB、Arrow 与本地 Embedding 执行器依赖；
- 历史 Graph/Vector 数据由 `extensions/morphz-memory-vector` 兼容读取；
- 八个评测入口、评测实现和 coding fixtures 已迁入 `morphz-evals`；
- CLI 与 HTTP/WebSocket Server 已改为 `MorphzRuntime` 的两个独立适配器；
- Inspector 已停止请求 Core 中不存在的 `/api/graph`，默认展示 Context、Session、Mind、Inbox 与 Runtime event；
- Core 122 个库测试、6 个 CLI 测试与 41 个 Attempt Loop 集成测试通过；独立 Eval 与 Extension 验证由 Workspace 测试覆盖。
