# Morphz 认知协调协议 v0.1（实验性）

状态：实验性，不提供兼容性承诺。

## 1. 范围

本协议用于在多个独立运行的 Morphz 参与节点之间完成一次有界认知求值，定义 Coordination Mesh 成员候选解析、能力握手、投影绑定、不可变求值 Assignment、取消、部分失败记录与结果聚合。

它不定义开放网络发现、经济激励、拜占庭共识，也不会自动修改 Union Mind。

## 2. 身份与信任

`authority_id` 是协议层全局唯一身份。在 Mesh 模式中，每个节点拥有一组由 Morphz Secret Store 保管的 Ed25519 密钥，并由公钥派生 Authority。Agent、Context 与 Session 标识由各自 Authority 管辖，因此不同 Runtime 可以使用相同的本地默认标识。

Mesh 来源只产生由运营者授权的候选端点，不直接证明节点身份。每个声明端点首次返回有效自签名握手时，本地固定其公钥与 Authority；只有发送方端点也存在于接收方 Mesh 来源中，并且反向身份探测证明签名调用者在该端点控制同一公有身份时，接收方才会完成相互固定。端点或公钥发生变化时拒绝连接。未配置 Mesh 时，旧版显式 peer 模式仍使用每对 Authority 的 HMAC-SHA256 密钥。

认证信封绑定认证版本、发送方 Authority、Mesh 模式下的公钥、签发时间、唯一 nonce 与完整类型化载荷。除握手外，接收方拒绝未建立信任的 Authority，同时拒绝错误签名、超出时钟偏差的请求和 nonce 重放。

签名不提供内容加密；明文 HTTP 的首次接触也可能受到中间人攻击。非可信网络部署必须另加 TLS 或使用私有认证网络。

## 3. Mesh 解析与健康状态

一个 Mesh 来源可以是静态 URL 列表或版本化文件。同一份来源可以原样用于每个成员；节点通过匹配本地公钥身份的签名握手，自动识别自己的可达端点，不需要配置自身 Authority。

成员解析与心跳均为尽力而为。远端离线、尚未启动或恢复中，均不得阻止本地 Runtime 和普通 Agent 启动。后台心跳持续记录节点健康、失效、加入和恢复；文件来源会在每次心跳时重新解析。未来服务发现实现可以接入同一个内部 provider 接口，无需增加新的模型概念或 CLI 参数。

## 4. 握手能力声明

握手结果是一份短时有效的能力租约，包括：

- 协议版本与支持的操作；
- 参与者的 Authority、Agent、Context 与锚点 Session；
- 语义能力与 token 容量；
- 逻辑模型路由、用于说明的物理模型标签；
- 支持的 reasoning effort、输出限制；
- 本地 Session 当前默认模型路由与 reasoning effort；
- 签发时间与失效时间。

只有运营者明确允许的模型路由可以对外声明；凭据和 Provider 账户身份不会进入声明。

无需认证的身份探测接口只返回一份新鲜的自签名公有身份与协议版本。只有发送方签名握手同时声明了接收方 Mesh 来源中存在的端点后，接收方才返回能力声明。

## 5. 求值生命周期

1. 发起 `coordinate.evaluate` 的 Agent 成为该请求的协调者。
2. 协调者进行实时握手，只在租约有效且满足约束的节点中路由。
3. 协调者向每个入选节点请求 Context 投影摘要。
4. 协调者生成不可变 Assignment，绑定共同任务、token 预算、投影、同级身份以及已解析的模型路由与 reasoning effort。
5. 每个节点从自己的 Context 出发，在隔离的临时 Session 内独立求值。
6. Runtime 校验草案并生成带来源证明的 proposal。
7. 有效 proposal 组成 Contribution Graph 与 Semantic Settlement 记录。
8. 节点错误单独进入 `failures`；只有有效 proposal 数仍满足 `min_participants` 时整体才成功。
9. 终态结果明确返回 `committed=false`。

普通对话不会自动进入这一流程。只有对应 Context 已启用能力且模型明确调用 `coordinate` 工具时才会发起协调。

协调 Agent 不会自动再作为一个独立参与节点运行；工具返回后，它会在自己的后续求值中整合各节点 proposal。若部署确实需要额外生成一份相互隔离的本地 proposal，可以显式配置本机回环 peer；对于“一台协调、两台远程求值”的三节点拓扑，这不是必要条件。

## 6. 模型协商

调用方可以不提出模型要求，也可以为所有节点指定共同的逻辑路由与 reasoning effort，或按 Authority 单独覆盖。路由器会在远程执行前拒绝未声明的组合。只指定 reasoning effort 时，优先使用兼容的默认路由，否则确定性选择另一个兼容的已声明路由。

最终选择会被冻结到 Assignment；节点不得因为请求执行期间本地默认设置发生变化而静默替换。

## 7. 超时与取消

每次远程调用都有运营者配置的超时。远程求值失败或超时时，协调者发送尽力而为的取消请求。参与节点把活动 Assignment 映射到临时 Session，并持久化取消该 Session，不影响普通本地会话。

取消是幂等的：未知或已经完成的 Assignment 返回 `cancelled=false`。

## 8. 接口

- `GET /api/experimental/cognitive-coordination/identity`
- `POST /api/experimental/cognitive-coordination/handshake`
- `POST /api/experimental/cognitive-coordination/projection`
- `POST /api/experimental/cognitive-coordination/evaluate`
- `POST /api/experimental/cognitive-coordination/cancel`
- `GET /api/experimental/cognitive-coordination/status`（使用运营者认证的 Dashboard 接口）

身份探测返回自签名公有信封；其余四个有状态协议接口使用认证信封。状态接口使用 Morphz 既有运营者认证，并且永不返回密钥。

## 9. Union commit 边界

协调求值与 Union commit 是两个独立操作。求值允许保留分歧，不产生写入权限。后续提交机制必须显式声明 Union Authority、基础 Context 版本、裁决策略、证书或 quorum 证明以及幂等事务身份。

参与节点、远程响应和模型输出均不得隐式写入 Active Mind 或 Union Mind。
