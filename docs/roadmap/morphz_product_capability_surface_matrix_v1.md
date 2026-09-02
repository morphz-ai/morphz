# Morphz 通用能力与产品表达矩阵 v1

> 状态：当前实现审计基线与跨产品实现边界
>
> 日期：2026-09-02
>
> 适用仓库：`Morphz`（Runtime、SDK、Dashboard、TUI、CLI）与
> `morphz-ai-site`（官方 C 端 Gateway/Web，未来演进为 Desktop App）
>
> 相关文档：[产品界面与交付架构 v1](../morphz_product_surfaces_and_delivery_architecture_v1.md)、
> [Execution Target 与 Edge Node 架构](../morphz_execution_target_and_edge_node_architecture_v1.md)、
> [Artifact Transfer 数据平面](../morphz_artifact_transfer_data_plane_v1.md)

## 1. 用户与产品面不能混用

Morphz 有两类明确不同的用户：

1. **底层用户**：工程师、运维者、高级用户和对 Runtime 感兴趣的人。他们使用
   Dashboard、TUI、CLI，应该看见真实的 Context、Session、Thread、Target、Approval、
   Job、Event 和错误边界。
2. **C 端用户**：使用官方主站、未来 Web App 与 Desktop App 的普通用户。他们看到的是
   “对话”“任务”“连接你的电脑”“需要你确认”和可行动的恢复入口，不承担 Runtime
   运维概念。

两类产品不共享信息架构，但必须共享同一套底层事实、权限、幂等、生命周期和恢复协议。
Dashboard 不是 C 端产品的原型，C 端 Gateway 也不能重新发明 Runtime 状态机。

## 2. 四层职责

| 层 | 权威职责 | 不应承担 |
| --- | --- | --- |
| Runtime / Store | 身份、持久状态、因果、幂等、权限、任务生命周期、恢复 | 产品文案、页面流程、视觉状态 |
| SDK / Product API | 稳定类型、作用域授权、错误分类、跨客户端能力契约 | 猜测 UI 行为、泄露 Admin 权限 |
| Dashboard / TUI / CLI | 完整、可审计的底层控制与诊断 | 为 C 端重新定义领域语义 |
| Gateway / Web / Desktop | 身份接入、消费级流程、文案、渐进披露、平台集成 | 私建另一套任务、附件或恢复真相 |

判断规则：

- 会造成数据丢失、安全绕过、重复执行或跨端不一致的问题，必须在 Runtime/Store 关闭；
- 两个以上客户端需要且具有身份、权限或生命周期的能力，必须先成为 SDK/API；
- 术语、布局、引导和动画属于产品表达层；
- 未发送文本草稿不是 Agent 经历，不得进入 Event Ledger；
- 已发送消息、附件绑定、工具动作和恢复决定必须由 Runtime 保持权威。

## 3. 能力矩阵

状态：`已具备`、`部分具备`、`缺失`。这里描述代码事实，不把规划当实现。

| 通用能力 | Runtime / SDK 当前状态 | Dashboard / 底层产品 | 官方主站 / C 端产品 | 目标边界 |
| --- | --- | --- | --- | --- |
| Principal、Context、Session 连续性 | 已具备；可信 Gateway 可锚定 Principal 与持久 Session | 展示完整身份与作用域 | 已用站内账户映射稳定 Principal/Session | 保持单一身份真相，C 端不暴露管理令牌 |
| 消息幂等与权威终态 | 已具备 `client_message_id`、Event Ledger 与终态 Projection | 展示 Event、Thread、Attempt 与原始错误 | 已按 root/attempt 归并流式状态 | 所有客户端只消费同一终态，不以 HTTP 返回猜完成 |
| 模型与推理策略 | 已具备 Session 持久默认与 one-shot override | 可直接切换并查看实际路由 | 默认由服务管理，按产品需要渐进开放 | C 端配置必须走 Principal-scoped API，不复制 Provider 管理面 |
| Sandbox / Permission | 已具备 scoped policy、人工审批、自动审批、完全访问 | 展示精确路径、网络、规则与审计 | 尚未形成消费级权限流程 | C 端只包装当前用户相关请求，规则权威仍在 Runtime |
| 消息附件持久化 | 已具备 Principal+Session+草稿消息隔离的持久 staging、断点续传、过期回收、SDK/API、内容校验、不可变 Event 绑定与 Workspace 物化；保留内联 Base64 兼容 | 已迁移到 staging ID，刷新后从 Runtime 对账 staged attachment | 已通过 Gateway 二进制流式上传并迁移到 staging ID | Runtime 不内置文档语义解析，Agent 通过 Workspace 路径自行选择工具 |
| 未发送草稿 | 不进入 Ledger；附件草稿由 Runtime staging 保持权威 | 已按 Session 在本机持久文本和 staging 引用，接受后清除 | 已按稳定 Session 在浏览器持久文本和 staging 引用，接受后清除 | 文本草稿属于客户端私有状态；已上传字节及归属由 Runtime 保持权威 |
| 发送失败恢复 | 已具备稳定 `client_message_id`、staging offset/状态与已接收 Runtime failure retry | 已区分未接收草稿、丢失 HTTP receipt 和已接收失败轮次 | 已区分未接收草稿、丢失 HTTP receipt 和已接收失败轮次 | 同一幂等 ID 不重复创建 turn；只有权威接受后才清空草稿 |
| Execution Target 目录与 Session 默认 | 已具备本机默认、Session 持久选择、Principal 可见性/在线校验与结构化可用性 | 已有 Target 选择器和接入入口 | Gateway 已提供脱敏设备目录，主站可选择 Session 默认电脑 | C 端只显示设备名称、平台与在线状态，隐藏 Principal、Workspace、租约和内部元数据 |
| Edge 配对与设备接入 | 已具备 `morphz-edge`、一次性配对、租约、撤销和执行协议 | 展示 Node/Target/状态/诊断 | 已表达为“连接你的电脑”，生成短期配对码、展示安装/运行步骤并轮询在线状态 | 配对权限和 Target 归属始终由 Runtime 管理；Gateway 不持有设备私钥 |
| 缺少 Target 后续接原任务 | 已在物理副作用前形成 `execution_target_required` 失败，标记 `physical_action_started=false`；retry 与 Target 改绑在 Store 同一事务提交 | 可审计 failure、Thread generation、Target route | 主站识别失败、连接/选择电脑后用原 root/failure token 继续 | 已开始物理副作用的失败不可走该改绑路径；重复 retry 保持幂等 |
| 后台任务与产物 | 已具备 Thread/Job、受管后台、Artifact Transfer 与终态 | 展示完整 Job、Target、进度和产物引用 | 主要仍是对话流 | C 端映射为任务卡和结果，不暴露 lease/fencing 等内核细节 |
| 主动联系与通知 | Runtime 有 outbound 事件；渠道由外层授权 | 展示原始事件与配置 | 已有站内授权和渠道绑定基础，系统通知缺失 | 通知偏好在产品层，发送事实和因果来源可审计 |
| 数据导出与删除 | Ledger 与身份生命周期已有边界；通用用户导出缺失 | 管理查询较完整 | 账号删除已明确，用户导出缺失 | Runtime 提供 Principal-scoped 导出；产品层提供可理解包与隐私说明 |
| 订阅额度/能量 | Provider usage API 已具备 | 可查看 Provider/Account 细节 | 已有脱敏公开状态和运营明细 | 保持 secret-free 投影，C 端不泄露内部账号身份 |
| 浏览器可靠性门禁 | Runtime/纯函数测试较强 | Dashboard 缺真实浏览器 E2E | 主站缺关键浏览器 E2E | 两个产品分别覆盖刷新、断线、失败恢复、附件和 Target 接入 |

## 4. 当前完整目标的四项交付

### 4.1 矩阵与契约

- 本文成为两仓库共同的边界依据；
- 主站产品文档不再把 Execution Target 永久排除，而是区分“底层配置”与“连接你的电脑”；
- 新 API 都从稳定错误码和 Principal/Session 作用域开始设计。

### 4.2 持久 Artifact Staging

必须满足：

- 上传在发送消息之前完成，支持状态查询、取消、过期回收和幂等；
- staging 归属 Principal+Session，其他身份和 Session 不可引用；
- 大文件不再通过 JSON Base64 整体驻留浏览器、Gateway 和 Runtime 内存；
- 消息提交只携带 staging ID；Runtime 校验完整性后将其绑定到唯一 Event；
- Event 绑定与失败恢复不会产生重复附件引用，也不会删除仍被 Event 使用的内容；
- Agent 仍只得到安全的 Workspace 路径和元数据，由 Agent 自己选择 PDF/DOCX 等解析方法，
  Runtime 不内置文档语义解析。

### 4.3 Session 草稿与发送失败恢复

必须满足：

- 文本草稿按 Principal+Session 隔离，刷新、重连和切页后可恢复；
- 附件草稿引用持久 staging，不依赖浏览器内存中的 `File`；
- 点击发送后，在 Runtime 明确接收前不清除草稿；
- 已接收后用同一 `client_message_id` 恢复，不能另造重复消息；
- Dashboard 展示 raw 状态/ID/错误；C 端展示“已保存”“重新发送”“继续任务”等用户语言；
- 用户主动清空、发送成功或 staging 过期时，状态转换可解释且可审计。

### 4.4 Execution Target / Edge 与原任务续接

必须满足：

- 自托管/CLI 默认本机不增加额外选择；云端可显式关闭本机默认；
- 用户有多台电脑时可选择 Session 默认 Target；选择持久化并可撤销；
- 云端没有 Target 时，C 端展示下载 `morphz-edge`、安全配对和在线确认流程；
- 缺少 Target 必须在真实物理副作用前形成 typed recoverable failure/wait；
- Target 接入后继续原 `root_turn_id`，使用稳定恢复 token 和原幂等边界；
- 如果失败前已有不可安全重放的副作用，不得自动重试，只能明确请求用户确认；
- Dashboard 保留 Target/Node/route/fencing 细节，C 端只呈现设备与任务结果。

## 5. 验收与变更纪律

每项能力完成时同时提供：

1. Runtime/Store 的确定性测试；
2. Principal-scoped HTTP/SDK 契约测试；
3. Dashboard 与主站各自的状态恢复测试；
4. 至少一条刷新/断线/重启后的端到端恢复证据；
5. 中文和英文用户文案；
6. stable error code 与日志事件码；
7. 两个仓库独立、干净、可审计的提交。

任何页面若需要猜测 Runtime 状态，或 Gateway 需要直接读写 Runtime 数据库，说明能力层级
仍然放错，不能用 UI workaround 宣称完成。
