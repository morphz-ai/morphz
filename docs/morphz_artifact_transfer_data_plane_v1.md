# Morphz Artifact Transfer 数据平面设计 v1

**状态：v1 核心数据平面已实现并通过回归验证。**  本文定义 Morphz 在不同 Execution Target、Workspace 与信任域之间传输数据的一等语义。它补全执行平面中的数据移动能力，但不把 `scp`、`sftp` 或某个对象存储协议暴露为领域模型。

## 1. 为什么 Transfer 是 Runtime 核心能力

Morphz 的 Agent 不属于某一台机器。一个 Agent 可以在云端求值，同时把物理动作调度到用户电脑、受管 SSH 主机、Edge Node 或未来的 Cloud Worker。只要 Execution Target 可以分离，数据就不能再被假定为天然共享：

- 相同路径在不同 Target 上不是同一个文件；
- 一个 Target 的工具结果必须显式交付给另一个 Target；
- 模型不应直接接触 SSH 私钥、SFTP 凭证或对象存储密钥；
- 传输需要与命令执行相同的审批、取消、恢复、fencing 和审计能力。

因此，Artifact Transfer 是 Execution 数据平面，不是 Shell 的便利封装。

## 2. 术语

### 2.1 Artifact

Artifact 是 **Runtime 可以寻址、传输并验证的数据对象**。它不暗示数据由 Agent 生成，也不暗示内容必须写入 Event Ledger、Mind 或 Context Encoding。

Artifact 的来源可以是：

- 用户已有的文件、目录或数据集；
- Agent 或工具生成的构建产物；
- 外部系统下载或导出的内容；
- 另一个 Execution Target 交付的结果；
- Runtime 生成的诊断包或快照。

`origin` 只是可选的审计元数据，不参与所有权和授权判断。真正的访问权由 Principal、Target authorization 与 Target 本地 Permission Profile 决定。

### 2.2 Artifact Location

```text
ArtifactLocation
  target_id
  path
  workspace_identity?   # 可选的稳定 Workspace 身份，不是路径根限制
```

`path` 是 Target 本地路径表达。它既可以是相对路径，也可以是绝对路径。Runtime 只做语法与空值校验，不额外发明“禁止绝对路径/禁止 ..”的权限模型。

路径是否允许由现有权限体系裁决：

- `use-default`：遵守 Workspace、read/write roots、protected paths 与原生沙箱；
- `require-escalated`：按现有审批链申请本次最小能力；
- `full-access`：允许访问 Target 上的完整文件系统，不再由 Transfer 另行限制；
- `custom`：完全遵循自定义 Permission Profile。

在真正访问前，负责物理执行的节点必须规范化路径并执行自己的 Permission Profile。云端不能用自己的文件系统去伪 canonicalize 远端路径。

### 2.3 Descriptor

```text
ArtifactDescriptor
  artifact_id
  location
  content_digest        # 文件字节摘要；目录为稳定 tree-manifest 摘要
  size_bytes            # 文件字节数；目录为所有普通文件的逻辑字节数
  media_type?
  origin?
```

模型只提交位置和意图。摘要、大小和最终媒体类型由读取源数据的受信执行端计算；模型提供的预期摘要只能作为前置条件，不能作为事实。

目录的逻辑身份与传输载荷严格分离：目录可以通过确定性 tar、对象存储 multipart
或未来的点对点协议传输，但 Receipt 中的 `content_digest/size_bytes` 始终描述同一棵
逻辑目录树；Backend 另行校验实际载荷的 payload digest/size。更换 Transport 不能改变
Artifact 身份。

### 2.4 Transfer 与 Receipt

```text
ArtifactTransferRequest
  transfer_id
  source: ArtifactLocation
  destination: ArtifactLocation
  overwrite
  expected_source_digest?

ArtifactTransferReceipt
  transfer_id
  source: ArtifactDescriptor
  destination: ArtifactDescriptor
  transport
  bytes_transferred
```

成功条件不是“复制命令退出码为 0”，而是源端和目的端的摘要一致，并且最终 Receipt 已作为 Execution Job 的终态结果持久化。冻结 Route、开始/完成时间与 side-effect boundary 属于 Execution Job，而不是在 Receipt 中复制一份可能漂移的权威状态。

## 3. 单一权威生命周期：Execution Job

Transfer 不建立平行的 `TransferJob` 状态机。每一次物理传输就是一个 `tool_name=transfer` 的持久化 `ExecutionJob`：

```text
model / SDK / HTTP transfer intent
             ↓
ExecutionJob (唯一状态权威)
  queued → waiting_approval → running → succeeded|failed|cancelled|lost
             ↓
ArtifactTransferReceipt + result Event
```

这直接复用现有能力：

- 确定性 Job ID 与幂等 ensure；
- claim、lease、heartbeat 和 fencing token；
- 一次性审批与 Capability Lease；
- 取消、重启恢复和 side-effect uncertainty；
- Edge 输出流、Dashboard 与 SDK 的统一可观测性。

如需更快的 Transfer 列表或进度查询，可以建立可重建 Projection，但 Projection 不是第二个生命周期权威。

## 4. 双 Target Route

普通物理工具只有一个 Target；Transfer 同时涉及 source 与 destination。因此 Job 必须冻结两个 Route Snapshot：

```text
request._morphz_transfer_routes
  source: ExecutionRouteSnapshot
  destination: ExecutionRouteSnapshot
```

`ExecutionJob.target_id` 保留为 **协调执行 Target**，v1 默认取 destination Target；真正的双端事实来自冻结的 Transfer Routes。协调 Target 不等于数据来源，也不能覆盖 source authorization。

Transfer 不绑定或改写当前 Execution Thread 的单 Target affinity。跨 Target 是该工具的显式语义，而不是让普通工具偷偷切换 Thread Target。

创建 Job 前必须同时验证：

1. 当前 Principal/Agent/Context/Thread 对 source Target 有效授权；
2. 对 destination Target 有效授权；
3. source 发布 `artifact_read` 或等价能力；
4. destination 发布 `artifact_write` 或等价能力；
5. 两个 Route Snapshot 均已冻结，后续心跳不能偷换 Provider。

## 5. 双端权限裁决

一份 Transfer 有两个独立的文件系统动作：

- source path：Read；
- destination path：Write。

两端都必须通过权限检查。任何一端拒绝，Transfer 都不能开始。

### 5.1 本地与 Runtime Managed SSH

- 本地路径由 Runtime 的 `PermissionBroker` 预检和审批；
- Runtime Managed SSH 的远端路径由冻结 Target policy 与云端审批约束；
- OpenSSH 配置、agent socket 和密钥仍由 Runtime 托管，不进入模型参数；
- `full-access` 模式下 Transfer 不额外禁止绝对路径或 Workspace 外路径。

### 5.2 Edge Node

- 云端只验证 Target 使用权并冻结逻辑 Route；
- Edge Node 再用自己的 Permission Profile 和原生沙箱检查本地 source/destination；
- 云端 `full-access` 不能覆盖 Edge 本地限制；只有 Edge 本地也配置为 full access 才具备完整访问；
- Edge 代理 Managed SSH 时，SSH/SFTP 凭证留在 Edge 信任域。

## 6. Backend 与传输选择

模型不选择 `scp`、`sftp` 或对象存储 Backend。Runtime 根据冻结的 source/destination Route 和部署策略选择 Transport：

| Source | Destination | v1 Transport |
|---|---|---|
| Local | Local | 原子临时文件 + rename 的本地复制 |
| Local | Runtime Managed SSH | Runtime 托管 SSH 数据 Transport |
| Runtime Managed SSH | Local | Runtime 托管 SSH 数据 Transport |
| Managed SSH | Managed SSH | Runtime 分块中继或受管三方传输 |
| Edge local | Edge local | Edge 本地复制 |
| Cloud/Runtime | Edge | Edge command + 分块数据通道 |
| Edge | Cloud/Runtime | Edge command + 分块数据通道 |
| Edge A | Edge B | Runtime/Object Store 中继；未来可协商直连 |

Backend 选择是 Runtime policy，不能由 Harness 或模型显式指定名称后绕过安全边界。`ArtifactTransferBackend` Registry 可以保留为实现注册表，但选择器必须接收冻结 Route，而不是接收模型提供的 backend 字符串。

## 7. 数据完整性、覆盖与恢复

### 7.1 写入协议

默认流程：

1. source 打开并计算 SHA-256、大小；
2. destination 写入同目录临时文件；
3. 边传输边计算 destination digest；
4. 校验摘要和大小；
5. 按 `overwrite` 规则原子 rename；
6. fsync（Backend 能力允许时）；
7. 持久化 Receipt，再完成 Execution Job。

若 destination 的父目录尚不存在，Backend 会在同一份写权限裁决内创建它；
这只是传输语义的一部分，不引入独立于现有 Permission Profile 的路径权限模型。

目录 Artifact 在 v1 中通过确定性归档流传输；归档清单包含相对路径、类型、大小与摘要，并拒绝解包逃逸。符号链接默认作为链接元数据处理，不能在目的端无提示解引用到目录外。

### 7.2 Retry Safety

Artifact Transfer Job 使用确定性身份和内容校验，因此在目的端尚未可见以前属于
`Idempotent`：暂存、分块传输、断点续传以及重复领取都可以安全重试。`overwrite=deny`
遇到已存在且摘要相同的目的对象时视为已收敛；摘要不同则报冲突。`replace` 也必须先把
新内容完整写入临时对象，再通过同文件系统原子发布，不能边写边破坏旧对象。

真正的边界位于“目的对象即将变得可见”之前：

1. Backend 向当前 Execution Job 请求 side-effect ACK；
2. Runtime 或 Edge Node 先持久化 `side_effect_started_at`；
3. 持久化成功后才允许 Backend 执行 link/rename/远端 publish；
4. 边界之前崩溃可自动重新入队；边界之后没有持久 Receipt 的结果必须标记 `lost`，等待内容对账，不能盲目重复覆盖。

Runtime↔Edge 数据通道按持久 stage offset 续传。Managed SSH v1 会复用 Runtime 已完成的
source stage；连接中断时可重新建立连接并重传尚未发布的临时载荷，最终发布仍受上述边界
保护。后续可把 SSH 临时载荷也升级为分块 offset 续传，但这不是改变 Artifact 语义的前提。

取消会 Drop 当前物理 Future。未跨边界时临时文件/目录和 SSH 子进程被清理，Job、
Activation 与 Thread 一起进入 `cancelled`；已跨边界但尚无 Receipt 时不伪装成安全取消，
而按结果未知语义进入 `lost`/人工对账。Runtime 重启时只恢复仍可证明幂等的 Job。

### 7.3 进度

进度是 Execution Job 的输出流：

```text
bytes_transferred / total_bytes
throughput
current_entry?       # 目录传输
source_target_id
destination_target_id
```

进度可以丢失或降采样，终态 Receipt 必须持久化。

## 8. 模型工具、SDK 与 HTTP API

### 8.1 模型工具

```json
{
  "source": {"target_id": "target-default", "path": "dist/app.tar"},
  "destination": {"target_id": "target-prod", "path": "/opt/app/app.tar"},
  "overwrite": false,
  "expected_source_digest": null
}
```

模型可见的工具与 Execution Target capability 统一使用 `transfer`，与 `read`、`write`、`exec` 保持同一层次的紧凑操作原语；Artifact 仍是 Runtime 内部带摘要、来源和可追溯性的领域对象。模型不传 backend、私钥、Token、源大小或最终摘要。

### 8.2 Rust SDK

SDK 提供：

```text
submit_artifact_transfer(intent, authority) -> ExecutionJob
get_execution_job(job_id)
subscribe_execution_output(job_id)
cancel_execution_job(job_id)
```

SDK 与模型工具都进入同一个 Job planner 和权限边界，不提供直接调用 Store/Backend 的旁路。

### 8.3 HTTP

```text
POST /api/artifact-transfers
GET  /api/artifact-transfers/:job_id
GET  /api/artifact-transfers/:job_id/output
POST /api/artifact-transfers/:job_id/cancel
```

HTTP 身份来自 Trusted Gateway Principal Assertion；请求不能自报 Principal。响应返回 Execution Job 与 Receipt 投影。

## 9. Event 与 Context 语义

建议事件：

- `runtime/artifact_transfer_requested`
- `runtime/artifact_transfer_progress`
- `runtime/artifact_transfer_completed`
- `runtime/artifact_transfer_failed`
- `runtime/artifact_transfer_cancelled`

事件包含 `job_id`、双 Target、双 Workspace identity、摘要、大小和因果 route。不得包含凭证或未经裁剪的文件内容。

Artifact 内容默认不进入 Context Encoding。模型只看到紧凑 Receipt 和必要的证据引用；需要读取内容时再在目的 Target 上调用 `read`/领域工具。

## 10. 可观测性

Dashboard/TUI 至少展示：

- source → destination Target 与路径；
- 当前 transport/route；
- 等待哪一端审批；
- 传输进度、吞吐与预计剩余；
- 摘要验证结果；
- cancelled、failed 与 lost 的不同语义；
- Receipt 及其因果 Thread/Objective。

## 11. 实现阶段与验收

### Phase A：领域与权限语义

- 修正 `ArtifactLocation`，移除硬编码相对路径限制；
- 区分模型 Intent 与 Runtime Descriptor；
- 冻结双 Target Route；
- 用现有 Permission Profile 裁决双端路径。**已完成并覆盖 workspace、审批扩张、自动审批、拒绝、protected paths 与 full-access 测试。**

### Phase B：本机完整闭环

- 注册 `transfer` Physical Tool；
- 复用 Execution Job 生命周期；
- Local→Local 文件/目录传输、摘要、覆盖、取消和回执；
- SDK 与 HTTP API。**已完成。**

### Phase C：Managed SSH

- Runtime 托管 SSH 数据 Transport；
- Local↔SSH 与 SSH↔SSH；
- 审批、凭证隔离和断线恢复。**已实现持久 stage、重新连接与安全发布；真实 SSH 的不同服务端/网络故障组合属于部署现场兼容性矩阵，不改变 v1 领域完成状态。**

### Phase D：Edge

- Edge 本地 Transfer executor；
- Edge 双层权限裁决；
- Runtime↔Edge 数据通道与断点恢复；**已完成。**
- Edge 代理 Managed SSH。**已完成。**

### Phase E：产品闭环与后续扩展 Backend

- Dashboard 进度/Receipt；**v1 已完成。**
- 对象存储中继与大文件 multipart；**属于 v2 可替换 Transport，不是 v1 完成前提。**
- 部署级配额、速率限制和对象清理策略；**属于产品/Gateway policy，不进入 Artifact 领域权威。**

### 11.1 已执行验证矩阵

| 范围 | 验证结果 |
|---|---|
| Local 文件与目录 | 字节摘要、稳定 tree-manifest 摘要、原子发布、不同内容 no-clobber、相同内容幂等 reconcile 均通过 |
| Runtime 生命周期 | Event → Thread → Activation → Execution Job 原子建立、进度、Receipt、重复提交与取消收口通过 |
| 权限模型 | `use-default`、自动/人工审批入口、拒绝、不可覆盖 protected paths、`full-access` 均通过 |
| Edge 数据通道 | 文件与目录、逻辑摘要/载荷摘要分离、Runtime↔Edge、Edge↔Edge 中继通过 |
| 网络中断 | 模拟服务端仅持久化前缀后返回故障；客户端从服务端权威 offset 续传并得到完整摘要，测试通过 |
| 存储后端 | SQLite 多进程 fencing 与 Runtime Store 契约通过；真实 PostgreSQL 15 连接下同一契约通过 |
| Dashboard | 进度与吞吐呈现、59 项前端契约测试及 production build 通过 |
| 全量 Runtime 回归 | 598 项 Rust 单测中 595 通过、3 项人工 PTY/视觉测试按约定忽略、0 失败 |

完成标准：同一套模型工具、SDK 和 HTTP 入口能在 `use-default`、审批扩张、`full-access` 与 Edge 本地拒绝四类权限场景下得到一致结果；重启、取消、重复提交和网络中断不会产生未审计的重复覆盖。

## 12. 冻结的设计纪律

1. Artifact 来源不限，用户文件与 Agent 产物使用同一模型。
2. Transfer 是一等物理能力，不暴露原始 `scp/sftp` 给模型。
3. Transfer 不发明独立路径权限；统一复用现有 Permission Profile。
4. `full-access` 对 Transfer 也是真正的完整访问。
5. 两端权限都必须满足，任何一端拒绝即停止。
6. Execution Job 是唯一持久生命周期权威。
7. 模型声明位置和意图，Runtime 计算物理事实与摘要。
8. Backend 由 Runtime 路由策略选择，模型不能指定传输机制。
9. 凭证永远留在所属信任域。
10. 同一路径字符串不代表跨 Target 的同一数据。
