# Morphz Runtime 接入评估

检查日期：2026-09-07  
源码基线：`8e04cf09807d25e198b0134d9418e44939aed7ca`  
范围：HTTP 路由及相关处理器、Rust SDK、身份与持久记录、事件订阅、Edge 执行通道。只读源码评估，未执行端到端接入测试，也未修改 Runtime。

## 结论

Session、Principal 绑定、Objective、线程控制、历史事件和 Edge 作业通道已有可复用基础。MorphzWork 不需要再建立一个执行调度器。

但通用 Inbox、指派给人的工作、事项级模型策略和浏览器交接，不能直接当成现有 Dashboard 接口的另一种展示。需要补齐产品契约，并区分管理员操作与普通参与者操作。这些是目标产品的接入缺口，不等同于本轮发现了 Runtime 故障。

## 已有能力与产品缺口

| 需求 | 源码证据 | 可复用范围与待补部分 |
| --- | --- | --- |
| 人的稳定身份 | `PrincipalRecord`、`SessionPrincipalBinding`；SDK `authorize_session` 检查参与关系 [1], [2] | 可以复用身份和 Session 绑定。用户登录、邀请、退出、团队角色与撤销流程仍需应用契约。 |
| 连接中心并同步对话 | `/api/sessions`、Session 消息与事件路由；`SendMessageCommand` [3], [4] | 复用 Session 和消息入口；各端不建立独立 Agent。应用需要自己的已读、导航和当前事项关联。 |
| 请求重复提交 | 消息入口使用 `client_message_id`，`claim_message` 区分既有请求与冲突 [5] | 聊天重试已有基础。新事项变更、交接及浏览器动作仍各自需要幂等契约，不能认为聊天去重涵盖所有操作。 |
| 多目标与线程控制 | Objective 创建、修改、暂停、恢复路由；修改带 `expected_revision`；线程控制返回修订冲突 [6], [7] | 复用 Runtime 的执行与控制权威，不在客户端重新调度。现有线程 HTTP 控制为 Operator 接口，团队参与者入口需另作授权设计。 |
| 通用 Inbox | 已有注意事项确认记录与接口；`ObjectiveRecord` 保存执行状态和协调／交付 Session [8], [9] | 可作为部分来源。在所查路由与记录中未发现同时表达 Human／Agent 负责人、分派、截止时间及交付的通用工作事项接口。注意确认不是完成业务事项。 |
| Agent 等待人参与 | `ObjectiveWaitCondition` 包含 `UserInput`、`Permission`、`ExternalEvent` 等；注释说明实际就绪状态由依赖机制推导 [10] | 有等待表达基础，但不等于已经有通用人工事项。需要定义请求、授权响应、拒绝、超时及有效修订，接入现有依赖机制，不能只改一个等待字段。 |
| 为工作选模型 | Session 默认 `model_alias`／`reasoning_effort`；消息可一次性覆盖本次 Evaluation 的模型，不改 Session 默认 [4], [11] | 不是“只能全局换模型”。仍需定义一个工作事项对应哪些调用、后续 Objective 调用如何继承，以及运行中调整的生效点。 |
| 多端补历史与实时更新 | Session 事件支持 `after_sequence`／`before_sequence`；WebSocket 有实时订阅、模型尝试快照与慢消费者断开处理 [12], [13] | 可复用历史与流式通道。WebSocket 不是带任意游标的完整事项重放协议；需要组合补历史、去重和快照边界，并补事项更新流。 |
| 普通成员订阅 | 非 Operator 的 WebSocket 必须指定 Session，并验证 Principal 参与关系 [14] | 可以复用受限 Session 订阅。不可让客户端用全局 Operator 订阅再在界面过滤成“我的 Inbox”。 |
| 共享认知与私密内容 | `context_sharing` 注释明确：隔离控制其他 Session 历史的自动进入，共享 Mind 与显式 Recall 仍是 Context 范围 [11] | `Isolated` 不能充当团队隐私 ACL。需要端到端确认共享认知、Recall、产物和模型输入的可见范围，而非只隐藏聊天列表。 |
| 远端执行与设备 | Edge 配对、连接、作业领取、输出、完成等路由；节点公布 capabilities 和 targets [15], [16] | 可以复用设备与作业基础。所查模块未见产品级浏览器配置、标签页、人机控制权和页面动作契约；需要浏览器适配能力。 |

源码中的 S 表达式 `inbox` 是上下文里的观察入口，不能据名称将其认作用户产品 Inbox。`initiating_principal_id` 是发起身份，也不能替代事项当前负责人。

## 接入前应先确定的五份契约

### 1. 应用身份与可见性

Runtime 将 Operator 与 trusted gateway 分开处理；trusted gateway 请求携带的 Principal 是已受信的身份声明，不是终端用户任意填写一个 Header 就能获得的身份。[17]

建议由中心侧应用服务完成用户认证和权限检查，再经受信入口接入 Runtime。网关凭据与管理员令牌均不下发给普通客户端。是否独立进程、如何部署及使用哪种身份提供方，尚未决定。

至少明确团队／共享 Context 范围、Session 参与关系、事项可见性、产物范围、浏览器配置所属人，以及撤销对在途订阅和操作的影响。私密内容进入共享认知前就需要有边界；事后从界面隐藏无法弥补模型已经读到它的问题。

这不改变“同一个中心 Agent”的产品方向：需要设计它能够在哪个授权范围下读取和行动，而不是为每个人复制一个互不相干的 Agent。

### 2. 中心工作事项与 Inbox 投影

延续[生命周期草案](./03-work-item-lifecycle.md)：工作事项表达责任、要求、时间、模型策略与交付，引用相关 Objective／Thread／Session，不取代它们。

建议把工作事项持久化和合法变更放在中心侧，对 UI 与 Agent 都提供受授权、可审计的操作。Inbox 是按参与者生成的视图。工作对象最终位于 Runtime 的扩展模块还是应用服务，需要在接口设计时决定；不能让每个端自行保存业务真相。

第一版契约至少包含：稳定事项标识、发起人与执行者、负责人及分派修订、预期结果、优先级、时间约束、依赖引用、执行／交付状态、结果引用。Agent 自主安排与人手动调整必须走同一套权限和修订规则。

人工完成要验证响应人、事项修订、关联等待和完成标准，再通知现有 Runtime 依赖机制。不通过修改聊天文本或直接写数据库状态来“唤醒”。

### 3. 事项级模型策略

现有一次性消息覆盖可以验证一次调用的选模型体验，但不能据此宣称整个工作事项已经支持热切换。

需要补一份映射：工作事项涉及哪些线程和后续调用，实际模型何时绑定，策略调整何时生效，模型不可用是否允许回退，数据是否允许发送给新模型。

建议先采用“新调用使用新策略、在途请求按既有绑定完成”的验证方案，明确向用户显示生效点。若现有绑定机制不支持，应增加正式控制入口，而非改 Session 默认冒充事项级设置。需要立即中断时走现有取消／交接语义，并保护已经发生的外部操作。

### 4. 同步、修订与重复请求

复用 Session 的历史序列和实时流，同时为工作事项定义快照水位、变更序列和客户端操作标识。客户端重连要能分辨已经接受、尚未接受和结果不确定的操作。

现有 `client_message_id`、Objective／Thread 的修订控制是可沿用的模式，不是所有新对象已经具备的能力。新接口需要明确旧修订冲突、重复提交、取消后迟到结果和权限撤销的响应。

需要验证快照与订阅交接时的缺口和重复，不能只测试持续在线时的页面更新。多个客户端最终应看到相同的有效事项状态及获准读取的聊天历史。

### 5. 浏览器目标与人机交接

建议每次操作明确关联 Principal、工作事项、Morphz Session、Edge、浏览器配置、标签页、页面状态和控制权版本。这是待设计的概念集合，不是现有 API 参数表。

用户接管使旧控制权失效；Agent 恢复前重新获取页面。动作标识用于核对执行与回执，不保证第三方网站也支持幂等。发布结果未知时先核对外部状态，不自动重试。

账号凭据默认留在浏览器所属 Edge；共享 Agent、转交事项或切换模型均不隐含共享账号。应用 UI、第三方网页和特权执行之间的隔离与登录验证要求见[技术选型](./07-technology-selection.md)。

产品意义上的 Edge 是入口和执行端；并非每一个只显示会话的 Web 客户端都必须注册成现有协议里的执行节点。浏览器需要执行能力时，再明确对应节点、目标和授权。

## 建议的技术验证顺序

| 顺序 | 最小验证 | 通过条件 |
| --- | --- | --- |
| 1 | 两个真实 Principal，经中心认证接入 Session、历史与订阅 | 未绑定 Session 不可读取；私密输入不能从共享认知或 Recall 绕过边界；撤销有效 |
| 2 | 创建一个人工事项并关联 Agent 工作 | 分派、拒绝／转交、有效响应与等待解除成立；无关工作继续 |
| 3 | 调整其中一个事项的模型和优先级 | 保存与生效可区分；不影响并发事项；不重复外部操作 |
| 4 | 桌面浏览器填写—人接管—Agent 接续—核对结果 | 目标账号不串线，旧操作失效；断线和未知提交结果可恢复 |
| 5 | Web／Desktop 刷新、重复提交和两端冲突 | 历史和事项恢复一致；没有丢任务、误完成或重复提交 |

这些是拟开展的验证，当前没有通过结果。源代码存在相关类型或测试，也不能代替这里的跨组件验收。

## 源码索引

以下链接固定到本次检查的提交，避免后续主分支改动导致判断依据漂移。

[1]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/memory/mod.rs#L1441
[2]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/sdk.rs#L4253
[3]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L1320
[4]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/sdk.rs#L358
[5]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/runtime.rs#L10325
[6]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L8006
[7]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L5624
[8]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L5545
[9]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/memory/mod.rs#L5236
[10]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/memory/mod.rs#L5189
[11]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/memory/mod.rs#L1364
[12]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L7674
[13]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L8674
[14]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L8353
[15]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L1161
[16]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/edge_node.rs#L299
[17]: https://github.com/morphz-ai/morphz/blob/8e04cf09807d25e198b0134d9418e44939aed7ca/morphz/src/web.rs#L3611
