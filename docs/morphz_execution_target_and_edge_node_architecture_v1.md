# Morphz Execution Target 与用户边缘执行节点架构 v1

> 状态：v1 核心闭环、Artifact 物理传输与 Node Relay 已实现；对象存储 Transport 与商业计费留待后续
> 日期：2026-07-21  
> 适用范围：云端 Agent、本地执行代理、多节点工具调度、远程沙箱、审批、Execution Job、商业化产品交付  
> 相关文档：[`morphz_scheduler_kernel_and_domain_model_v1.md`](morphz_scheduler_kernel_and_domain_model_v1.md)、[`morphz_sandbox_execution_and_approval_architecture.md`](morphz_sandbox_execution_and_approval_architecture.md)、[`morphz_sdk_and_trusted_gateway_identity_v1.md`](morphz_sdk_and_trusted_gateway_identity_v1.md)、[`morphz_single_identity_distributed_cognition_architecture.md`](morphz_single_identity_distributed_cognition_architecture.md)

## 1. 结论

Morphz 应当把 **Execution Target（执行目标）**提升为 Runtime 的一等领域对象。

Agent、Session、Evaluation 和 Execution 不需要与同一台物理机器绑定：

- Agent 可以运行在云端并保持统一的 Context、Mind 和多 Session 认知；
- 用户可以只进行聊天，而不提供任何本地执行环境；
- 当用户需要 Agent 真正工作时，可以安装 Morphz Edge Node，由本地节点向云端建立受认证连接；
- Agent 发出的文件、Shell、浏览器或其他物理工具动作，经 Runtime 调度到用户授权的 Execution Target；
- 沙箱、秘密凭证和最终物理权限仍由目标节点本地执行和裁决；
- 一个 Agent 可以同时在用户的笔记本、台式机、服务器以及其他受管节点上并发工作。

这不是传统 Agent 的“远程控制插件”，而是将认知平面与执行平面解耦：

```text
Cloud Cognitive Plane
Agent / Context / Mind / Session / Evaluation / Scheduler
                         │
                         │ durable Execution Job
                         ▼
Execution Target Plane
Local Target / User Edge Node / SSH Target / Managed Worker
                         │
                         ▼
Native Sandbox / Approval / Physical Tools / OS Processes
```

## 2. 产品形态

### 2.1 纯聊天用户

用户通过 Web App 与云端 Agent 对话，不挂载任何执行目标。Agent 仍然可以使用云端明确提供的公共能力，但不能访问用户设备。

### 2.2 挂载本地执行环境的用户

用户安装 Morphz Edge Node，并将一个或多个本地 Workspace 授权给云端 Agent：

```text
Browser / Web App
       │
       ▼
Cloud Morphz Agent
       │
       │ authenticated outbound channel
       ▼
Morphz Edge Node on user's computer
       │
       ├── native sandbox
       ├── local approval
       ├── workspace-scoped filesystem tools
       └── managed processes and background jobs
```

模型产生的是目标明确的工具动作。云端 Runtime 负责形成、调度和追踪 Execution Job；用户节点负责在本地安全边界内执行并返回事实结果。

### 2.3 多执行节点

同一个 Agent 可以被授权使用多个节点：

```text
Agent
├── target: shafreeck-macbook / workspace:morphz
├── target: home-linux / workspace:research
├── target: gpu-server / capability:cuda
└── target: phone / capability:camera,notification
```

不同 Execution Thread 可以绑定不同 Target，并行执行。共享 Mind 可以感知各线程的进度和结果，但物理工具的路由、权限与输出仍有明确目标，不能因为共享认知而混淆机器。

## 3. 四个不能混淆的概念

### 3.1 Agent：认知主体

Agent 拥有身份、Context、Mind、Session 和长期连续性。它不等于模型进程，也不等于执行机器。

### 3.2 Execution Target：逻辑执行目的地

Execution Target 是 Agent 可寻址的一个稳定执行环境和安全边界，例如：

- 本机默认 Workspace；
- 用户笔记本上的某个授权 Workspace；
- 一台通过 SSH 访问的服务器；
- 一个受管的云端 Worker；
- 未来的手机、浏览器或专用设备能力。

Target 应包含稳定 `target_id`、所有者、类型、能力、平台、授权范围、在线状态和策略摘要。Target 不是连接本身；断线重连后仍然是同一个逻辑目标。

Target 也不要求与云端直接连接的 Node 一一对应。一个最终 Target 可以由另一个 Execution Node 代理提供，例如用户笔记本通过 SSH 托管对内网服务器的访问。

### 3.3 Execution Node：提供 Target 的物理节点

Execution Node 是安装在设备上的 Morphz 客户端或服务进程。一个 Node 可以暴露多个 Target，例如同一台机器上的两个相互隔离 Workspace。

Node 还可以暴露 **Proxy Target（代理目标）**：目标不在 Node 本机，但只能由该 Node 使用其网络位置、设备能力或本地凭证访问。此时 Node 同时承担 Target Provider / Relay 的角色。

Node 负责：

- 主动向云端建立连接，适应 NAT 和家庭网络；
- 证明自己的设备身份；
- 发布有限能力清单，而不是暴露整台机器；
- 接收被授权的 Job；
- 在本地执行沙箱、审批和进程监管；
- 流式返回进度、输出和最终物理事实。

### 3.4 Worker：一次 Job 的临时执行者

Worker 是领取 Execution Job lease 的具体进程实例。它是可替换的临时算力，不是 Target，也不是 Agent。

```text
Agent decides intent
  → Execution Target selects destination
  → Execution Node provides the destination
  → Worker claims and executes one Job
```

### 3.5 Target Provider、Proxy Target 与 Execution Route

Execution Target 表示最终动作应当发生在哪里；Target Provider 表示哪个已连接 Node 能够把动作送到那里。两者必须分开。

典型场景：

```text
Cloud Morphz Agent
        │
        │ Job(target = target-office-server)
        ▼
Edge Node: user's laptop
        │
        │ Managed SSH Backend
        ▼
Office intranet server
```

这里：

- 用户笔记本是 `Execution Node`；
- 办公室服务器是最终 `Execution Target`；
- SSH 是该 Target 的 Backend / Route；
- 用户笔记本是该 Target 当前的 Provider Node；
- Agent 选择的是 `target-office-server`，而不是自己编排“先到笔记本、再执行 ssh”。

建议的权威关系是：

```text
ExecutionTarget
  target_id: target-office-server
  provider_node_id: node-user-laptop
  backend: managed_ssh
  capabilities: filesystem, shell
  policy_digest: ...
```

如果同一 Target 存在多条合法 Route，可以把 Provider 和 Backend 进一步抽成独立 `ExecutionRoute`。Agent 仍然选择最终 Target，Runtime 只在已授权、在线且满足策略的 Route 中做确定性选择，并在 Job 执行前冻结实际 Route。

```text
ExecutionRoute
  route_id
  target_id
  provider_node_id
  backend_kind
  endpoint_ref
  capabilities
  policy_digest
  online_state
```

`endpoint_ref` 只能引用 Provider Node 本地保存的连接配置，不能包含私钥、密码或 Token 值。凭证不进入云端 Prompt、Event History 或 Execution Job。

Tool Output 和审计事件需要同时记录：

- `target_id`：动作最终发生在哪里；
- `provider_node_id`：哪个节点实际承接了动作；
- `route_id` / `backend_kind`：通过什么受管路径完成；
- `worker_id`：哪个临时执行者领取了 Job。

这可以防止把“用户笔记本成功领取任务”误记为“命令在用户笔记本执行”，也能在多跳、重试和故障恢复时保持物理因果清晰。

需要区分两类代理：

1. **Node 代理普通 Target**：下游只提供 SSH、SFTP、浏览器或设备协议，本身不运行 Morphz；当前 Node 是唯一 Morphz Provider。
2. **Node 中继另一个 Node**：下游也运行 Morphz，但因为内网或网络策略不能直连云端；上游 Node 转发 Morphz Job 协议，下游 Node 仍保留自己的身份、沙箱、审批和 Worker lease。

默认应优先让每个 Node 主动直连云端。只有无法直连时才使用 Node Relay。多跳 Route 必须：

- 持久化并冻结有序 hop 列表；
- 在每一跳验证 Node 身份和 Target 授权；
- 设置可配置的最大 hop 数并检测环路；
- 保留端到端 `job_id`、claim/fencing 和取消语义；
- 让最终结果携带完整但可脱敏的 Route 审计信息；
- 任意一跳策略拒绝时终止，不能由上游授权覆盖。

第一版只需要支持一跳 Provider：`Cloud → Edge Node → Managed SSH Target`。这已经覆盖绝大多数用户本机代理内网服务器的场景；Node Relay 可以在 Target 与 Route 模型稳定后继续扩展。

## 4. 当前实现边界

截至 2026-07-21，v1 已经具备可运行的核心闭环：

- 一等 `ExecutionTarget` Registry，单机启动时显式注册 `target-default`；
- Execution Job 持久化权威 `target_id`，并冻结 Target revision、Provider Node、Backend、endpoint reference 与策略摘要组成的 Route Snapshot；
- `exec/read/write/edit/search/list_files` 等所有物理工具统一经过 target-aware Dispatcher；纯认知工具不进入执行平面；
- 本地 `InProcessLocal`、用户 `EdgeNode` 与一跳 `ManagedSsh` Backend；
- Edge Node 的 Ed25519 设备身份、短期配对码、challenge、短期连接凭证、心跳和设备密钥轮换；
- Node 主动出站轮询领取命令；持久化 claim、lease、heartbeat、fencing、输出分片、取消、终态提交、断线恢复和 side-effect uncertainty；
- Node 发布 Target 能力与平台，Runtime 执行 Target 在线状态、能力、Principal 所有权和并发上限校验；
- Thread Target affinity、显式 Target 选择、离线排队和确定性能力选择器；
- Principal 所有权之下的 Agent／Context／Thread scoped Target authorization；一旦进入 scoped 模式，撤销最后一个授权不会退回 owner-wide；
- 云端 Thread + Target Capability Lease，以及 Provider Node 独立保存、独立撤销的本地 Capability Lease；
- 云端只批准逻辑 Target 权限，远端路径不会在云端主机上做伪 canonicalization；Provider Node 必须用自己的 Permission Profile、审批器和 Native Sandbox 再次裁决；
- Context Encoding 中的紧凑 Target Index，包含在线状态、能力、Backend、Provider 与当前 Activation 的权威授权模式；
- SDK、HTTP、CLI 与 Dashboard 的 Target、Node、授权、Lease、Job、输出和取消控制面；
- 具备 Target/Workspace/Digest 约束的 Artifact Transfer 类型与 Backend Registry，以及最小 Harness 描述和绑定接口。

Target access 进入 Context protocol v23：`authorization=global|owner_wide|scoped_authorized` 是 Runtime 事实；进入 scoped 模式但当前 Activation 无匹配授权的 Target 不会出现在模型可用索引中，Dispatcher 仍在执行边界再次校验，不能只信任 Prompt。

当前有意保留的边界：

- Edge 传输 v1 使用经过认证的主动 HTTP 轮询；WebSocket／HTTP2／QUIC 多路复用是可替换传输，不属于领域语义；
- `Cloud → Provider Edge Node → Managed SSH Target` 只支持一跳；下游 Morphz Node Relay、多跳路由、环路检测和逐跳协议尚未实现；
- Artifact Transfer 的完整数据平面语义已在 [morphz_artifact_transfer_data_plane_v1.md](morphz_artifact_transfer_data_plane_v1.md) 中冻结并实现；对象存储 multipart 等 Transport 扩展不改变领域边界；
- Harness 只有稳定的描述、发现和绑定接口，尚未冻结 Coding／Research 等上层 DSL；
- Managed Cloud Worker、对象存储 Artifact Backend、计费与商业配额属于产品部署层，不伪装成已完成的 Runtime 能力。

## 5. Target 必须进入 Execution Job

物理动作一旦生成，目标必须成为不可变 Job 输入的一部分：

```text
ExecutionJob
  job_id
  activation_id
  thread_id
  principal_id
  target_id
  tool_name
  request
  approval_requirement
  retry_safety
  policy_digest
```

不能在 Job 创建后根据“当前连接”或“最近使用的机器”补推目标，否则重试、恢复和并发执行可能落到另一台机器，破坏因果和安全边界。

`target_id` 必须参与：

- Job 幂等身份和请求摘要；
- 审批与能力租约范围；
- Worker claim 校验；
- Event、Tool Output 和 Delivery 的来源标记；
- Dashboard、SDK 和审计日志展示；
- 取消、恢复和 side-effect uncertainty 判断。

## 6. 工具协议：明确目标，不使用隐式远程 Shell

### 6.1 推荐形式

```json
{
  "target": "target-macbook-morphz",
  "command": "cargo test --workspace",
  "cwd": ".",
  "sandbox_permissions": "use_default"
}
```

对应的 Context Encoding 可以表达为：

```lisp
(execution-thread thread-42
  (target target-macbook-morphz)
  (platform macos-arm64)
  (workspace "Morphz")
  (cwd ".")
  (status running))
```

### 6.2 禁止隐藏的“当前远程机器”

不应模拟传统交互式 Shell：

```text
ssh host
# 此后所有命令隐式在 host 执行
```

在并发 Agent 中，这种进程级隐式状态很容易导致机器混淆。内部可以复用 SSH 或 Edge 长连接，但模型可见语义必须始终是目标明确的动作。

第一版建议：

- 本地单机模式允许省略 Target，并解析为 `target-default`；
- 任何非本地 Target 必须显式指定；
- Execution Thread 可以绑定一个 Target；
- Thread 内后续动作即使允许继承，也必须在 Context Encoding 和工具回执中重复显示实际 Target；
- 跨 Target 动作必须显式创建新绑定或显式指定，不能悄悄切换。

### 6.3 不只 `exec` 需要 Target

文件工具、浏览器、设备能力和外部进程同样属于物理工具：

```text
read(target, path)
write(target, path, content)
search(target, query, path)
exec(target, command, cwd)
browser(target, action)
```

Runtime 可以保留统一的模型工具名，由 Target Backend 决定本地执行、网络代理还是远程 Worker 执行。纯认知工具如 `context_tx` 不属于 Execution Target。

## 7. Target 发现与调度决策

模型不应每轮接收所有节点的完整信息。Context Encoding 只提供紧凑的相关 Target Index：

```lisp
(execution-targets
  (default target-macbook-morphz)
  (target target-macbook-morphz
    (online true)
    (platform macos-arm64)
    (capabilities filesystem shell browser))
  (target target-gpu-server
    (online true)
    (capabilities shell cuda)))
```

更多信息通过 `list_targets` / `inspect_target` 按需发现。

调度权分成两层：

1. Agent 选择语义目标或能力约束，例如“在用户 Morphz Workspace 执行”或“选择具有 CUDA 的节点”；
2. Runtime 只在 Principal、Agent、Context 和 Thread 被授权使用的在线 Target 中进行确定性匹配，并记录实际选择。

如果 Agent 指定 `target_id`，Runtime 不能擅自改投另一台机器。若使用能力选择器并由 Runtime 选择，则实际 Target 必须在执行前形成权威事实并反馈给模型。

## 8. Edge Node 配对与信任边界

### 8.1 配对

建议采用设备密钥而不是长期共享 Token：

1. Edge Node 本地生成不可导出的设备密钥；
2. 用户通过 Web 或 CLI 获得短期配对码；
3. 云端将 `node_id` 绑定到权威 Principal；
4. Node 用设备私钥证明身份并取得短期连接凭证；
5. 每次重连验证设备、Principal、撤销状态和协议版本。

### 8.2 主动出站连接

Edge Node 主动连接云端 Gateway，不要求用户开放本地端口。连接需要支持：

- 心跳和在线状态；
- 断线指数退避，避免重连风暴；
- 多 Job 多路复用；
- 进度和输出流；
- 取消信号；
- lease 续约和 fencing token；
- 协议版本协商。

WebSocket、HTTP/2 或 QUIC 是传输选择，不应泄漏成领域语义。

### 8.3 云端不能覆盖本地物理策略

一次直接远程执行同时受两层约束；若 Provider Node 再代理下游 Target，则还要满足下游目标自己的物理约束：

```text
Cloud authorization
  Principal / Agent / Thread 是否有权使用 Target

Local authorization
  Node 是否允许该命令、路径、网络、秘密和副作用

Downstream authorization (when proxied)
  下游 Target 的账户、操作系统和可选 Morphz Worker 是否允许该动作
```

云端审批通过不意味着能覆盖本地 `protected_paths`。本地 Node 是设备物理权限的最终裁决者，可以要求用户确认或拒绝操作。

## 9. 凭证与 SSH 的位置

SSH 是一种 Target Backend，而不是 Agent 直接读取用户 `.ssh` 的理由。

```text
Execution Target
├── InProcessLocalBackend
├── EdgeNodeBackend
├── ManagedSshBackend
└── ManagedCloudWorkerBackend
```

Managed SSH Backend 可以由 Runtime 使用 ssh-agent、系统钥匙串或受管凭证建立连接，Agent 仍只提交目标明确的命令。凭证值不进入 Prompt、Event History 或普通 Shell 环境。

在 Edge 模式下，这个 Backend 应当运行在持有凭证并能访问目标网络的 Provider Node 上，而不是默认运行在云端 Runtime：

```text
Agent action
  → Job(target = private-server)
  → provider = user's-edge-node
  → edge node opens managed SSH connection
  → command runs on private-server
```

这正好覆盖“用户电脑已经接入 Agent，而另一台电脑只能从用户电脑通过 SSH 到达”的情况。用户电脑不只是一个可执行 Target，也可以成为其他 Target 的安全代理节点。

需要区分两种下游：

1. **普通 SSH Target**：下游没有 Morphz Node。Provider 可以保护凭证并管理传输，但不能凭空获得与 Morphz 原生沙箱完全相同的远程隔离；远端安全主要依赖受限 SSH 账户、远程操作系统策略和命令权限。
2. **Morphz-managed downstream Target**：下游也运行 Edge Node / Worker。它可以执行完整的本地沙箱、审批、进程监管和 durable Job 协议。长期运行、后台进程、可靠取消和副作用恢复应优先采用这种方式。

普通 SSH 可以作为兼容 Backend 和部署引导路径；可靠的分布式执行应逐步升级为 Morphz-managed Target。

对于面向用户本机的商业产品，Edge Node Backend 比 SSH 更合适：它能在远端执行与本机相同的 Morphz 沙箱、审批、任务监管和审计协议，而普通 SSH 只能提供传输，不能天然保证远端沙箱同构。

## 10. 审批频率：Target 级 Thread Capability Lease

远程执行不能为每条命令调用一次审批模型。建议把审批从一次性命令许可扩展为受限能力租约：

```text
CapabilityLease
  principal_id
  agent_id
  thread_id
  target_id
  capabilities
  path_roots / network_scope / secret_names
  policy_digest
  issued_at / expires_at
  status
```

规则是：

- 沙箱基础能力内无需审批；
- 同一 Thread 在某个 Target 上第一次扩张能力时审批；
- 后续请求是已批准能力的子集时直接执行；
- 切换 Target、增加路径、网络目的地、秘密或副作用等级时重新审批；
- Thread 完成、用户撤销、Target 策略改变或租约过期时失效；
- 高风险能力可以被本地策略固定为每次人工确认；
- 云端租约和本地租约都必须满足，任何一侧拒绝都不能执行。

租约以 Thread 生命周期为主要边界，以 TTL 为安全兜底，避免长程任务因固定短时限频繁重新审批。

## 11. 远程 Job 生命周期

```text
1. 模型产生带 target_id 的物理 Tool Action
2. Runtime 验证 Principal / Agent / Thread 对 Target 的使用权
3. Runtime 创建持久化 Execution Job
4. 对应 Node 上的 Worker 使用 fencing token claim Job
5. Node 执行本地审批与 Native Sandbox 预检
6. Node 在副作用前持久化 side_effect boundary
7. Node 流式回传 progress / stdout / stderr
8. Node 提交终态和带 target_id 的 Tool Output Event
9. Runtime 原子提交结果、Action Group 状态和 Thread wakeup
10. 下一次 Evaluation 看见目标、进度和最终物理事实
```

Node 断线时：

- 尚未跨过副作用边界的幂等 Job 可以安全 requeue；
- 已跨过边界但结果未知的 Job 必须标记 `lost`，不能自动假装失败或成功；
- 同一 Job 的旧 Worker 在 lease 失效后不能提交结果；
- 恢复连接不能把 Job 偷换到另一 Target；
- 用户可以取消排队或运行中的 Job，Node 在重连后仍要收到持久化取消状态。

## 12. 多节点工作空间与数据一致性

多个 Target 不共享文件系统。`cwd="."` 只对该 Target 的 Workspace 有意义。

跨节点协作必须显式选择一种数据策略：

- 每个 Target 各自拥有 Workspace；
- 通过 Git、对象存储或 Artifact Transfer 显式交换结果；
- 通过共享文件系统挂载同一数据源；
- 由 Harness 定义模块所有权和合并协议。

Runtime 不应因为目录字符串相同就假设两台机器上的文件相同。Tool Output 和证据引用必须包含 `target_id`、Workspace identity 和必要的内容摘要。

## 13. UI 与模型自描述

Dashboard 和 Web App 至少展示：

- 当前默认 Target；
- 每个 Execution Thread 的实际 Target；
- Node 在线／离线、平台和能力；
- 当前审批由云端还是本地节点等待；
- Tool Call 在哪台机器、哪个 Workspace、哪个 cwd 执行；
- 后台进程和 Sub Agent 使用的 Target；
- Target 切换和权限扩张历史。

模型的 Context Encoding 也必须提供同一组权威事实，避免 UI 知道目标而模型不知道。

## 14. 对 SDK 与 HTTP API 的影响

SDK 应提供稳定的 Target 控制面，而不是让产品直接操作内部 Worker：

```text
register / pair node
list targets
inspect target
authorize target for agent/context/thread
revoke target
submit target-aware action
subscribe target/job progress
cancel job
```

公网浏览器只连接可信 Gateway。设备凭证、服务凭证和 Principal Assertion 分属不同信任域，不能复用同一个 Token。

v1 已将同一组控制面语义暴露给 Rust SDK、HTTP 和 CLI。CLI 使用：

```text
morphz target list|show|enable|disable|authorize|authorizations|revoke-authorization
morphz edge pairing-code|pair|run|status|nodes|revoke|local-leases|revoke-local-lease
morphz-edge pair|run|status|rotate-key|local-leases|revoke-local-lease
morphz execution list|show|output|cancel
morphz lease list|revoke
```

独立的 `morphz-edge` 只承载用户侧 Execution Node 能力；完整 `morphz edge ...`
入口继续保留并与之共用实现。发放配对码、列出全部节点和远程撤销节点属于服务端
控制面，因此只在完整 `morphz` 中提供。安装、配对和配置边界见
[morphz-edge CLI](./morphz_edge_cli.md)。

HTTP 使用 `/api/execution-targets`、`/api/execution-target-authorizations`、`/api/edge/*`、`/api/execution-jobs` 和 `/api/capability-leases`。SDK 是这些产品入口共享的权威校验层；HTTP Handler 不直接操作 Store 或 Worker 内部状态。

## 15. 分阶段实现

### 阶段一：本地 Target 领域化

**状态：已完成。**

- 新增 `ExecutionTarget` 与 Registry；
- 为现有单机 Runtime 创建 `target-default`；
- Execution Job 持久化 `target_id`；
- 工具结果、事件和 Dashboard 显示 Target；
- 现有本地执行行为保持不变，但不再硬编码为唯一目的地。

这一阶段只重构领域模型，不引入网络，最容易验证。

### 阶段二：执行后端抽象

**状态：已完成。**

- 将本地物理工具执行从 Orchestrator 中抽象为 Target Backend；
- `exec/read/write/search` 统一走 target-aware dispatcher；
- 保持 Context 工具和纯认知工具在 Runtime 内部执行；
- 建立 Target capability discovery 与 compact index。

### 阶段三：Edge Node 最小闭环

**状态：已完成 v1。** 当前采用主动认证轮询而非固定某一种长连接传输；协议语义已经与传输分离。

- Node 配对与设备身份；
- 主动长连接、心跳和能力发布；
- 远程 claim/lease/fencing；
- 本地 Native Sandbox 与审批；
- 输出流、取消、断线和恢复。

### 阶段四：多 Target 调度

**状态：核心调度与 Artifact Transfer v1 数据平面已完成。** 早期类型和 Backend Registry 不再代表最终权限、路由或生命周期语义；以 [Artifact Transfer 数据平面设计](morphz_artifact_transfer_data_plane_v1.md) 为准。

- Agent 显式选择 Target；
- Runtime 处理能力选择器、在线状态和并发上限；
- Thread affinity、离线排队和可观测性；
- Artifact Transfer 与 Harness 接口。

### 阶段五：能力租约与产品化

**状态：安全控制面已完成；商业策略待产品部署。** 云端与 Provider-local 双层租约、撤销、设备密钥轮换和审计数据已经落地；用量计费与套餐配额不属于单机 Runtime 的默认策略。

- Target + Thread scoped Capability Lease；
- Web 与本地双审批通道；
- 用户可撤销、设备丢失、密钥轮换；
- 用量、配额、审计和商业化策略。

## 16. 必须守住的设计原则

1. **Agent 不属于机器**：机器只是它可使用的物理执行节点。
2. **Target 不属于模型隐式状态**：每个物理动作都有权威目标。
3. **Node 主动连接云端**：用户不需要开放本地端口。
4. **凭证留在所属信任域**：模型、Prompt 和 Event History 不保存私钥或 Token 值。
5. **本地是最终物理权限裁决者**：云端不能覆盖本地保护规则。
6. **Job 状态必须持久化**：断线、重启和重试不能制造重复副作用。
7. **一个 Target 可以离线，一个 Agent 仍然存在**：认知连续性不依赖设备在线。
8. **多个 Target 可以并行，但不能混淆证据来源**。
9. **同一抽象覆盖单机与云端**：单机模式只是 `target-default` 的 in-process Backend。
10. **先领域化，再网络化**：先证明 Target-aware 本地执行正确，再引入 Edge 协议。
11. **最终 Target 与 Provider Node 分离**：Agent 选择动作目的地，Runtime 冻结合法 Route，Provider 只负责安全抵达该目标。
12. **代理不能削弱下游边界**：每一跳都必须保留自己的身份、策略、审批和因果证据。

## 17. 最终产品意义

这套结构让 Morphz 可以同时提供两种产品：

- 免费或低成本的云端认知与对话服务；
- 用户自带设备和算力的安全执行服务。

用户不是把整台电脑和私钥交给云端 Agent，而是把经过本地策略约束的 Execution Target 挂载给同一个持续存在的 Agent。Agent 可以在世界任何位置保持认知连续性，同时在获得授权的多台机器上行动。

因此，Execution Target 不是外围功能。它是 Morphz 从“单机 Agent Runtime”走向“认知与物理执行解耦的分布式 Agent 操作系统”的关键领域抽象。
