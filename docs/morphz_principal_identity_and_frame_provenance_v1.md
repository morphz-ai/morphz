# Principal 身份锚点与 Frame 来源谱系设计 v1

> 状态：v1 已实现（2026-07-20）；可选严格身份确认模式仍留待后续对照实验。
>
> 目标：让共享 Context 中的 Agent 始终分清“当前是谁在说话”和“已有认知来自谁、来自哪个会话”，同时保留 Agent 自主决定信息如何使用和分享的能力。

## 1. 设计动机

Morphz 的一个 Context 可以挂载多个 Session，并允许不同 Session 共享同一个 Mind。这使一个 Agent 可以像同一个人一样，同时与多个对象交流并迁移经验；但它也引入了一类传统单会话 Agent 不明显的问题：

- Agent 可能把 Session A 和 Session B 当成同一个人；
- B 可以在消息正文中声称“我是 A”，诱导 Agent 错误合并两者；
- Session 被 swap out 后，仍在 Mind 中的 Frame 可能失去清晰的身份和会话来源；
- 同一个 Principal 通过多个 Session 交流时，Agent 又应理解这些 Session 背后是同一个身份；
- 后台任务、定时唤醒和并发 Activation 不能在因果链中丢失最初发起人的身份。

这不是传统意义上的“数据访问控制”问题。本设计不要求 Runtime 决定 A 的信息能否告诉 B，也不要求所有跨身份信息都隔离。真正要解决的是：

> Runtime 把真实身份和认知来源明确、不可由消息正文篡改地交给模型；Agent 在认清 A 是 A、B 是 B 之后，仍自主决定如何回答和分享信息。

## 2. 明确的非目标

本设计不引入：

- Principal 级 ACL；
- 私有/公开 Frame 分类；
- 自动隐私审查或输出过滤；
- “A 的信息绝不能告诉 B”的 Runtime 规则；
- Context 或 Session 的强制隔离；
- 依靠身份来源替 Agent 作出信任和披露决策。

如果 Agent 明确知道当前对象是 B，仍决定把来自 A 的信息告诉 B，这属于 Agent 的自主决定，不属于身份混淆 Bug。

## 3. 核心概念

### 3.1 Principal（身份主体）

Principal 是接入层认证后得到的稳定身份，不等同于显示名称，也不等同于 Session。

```text
principal:alice
principal:bob
principal:github:12345678
```

两个都叫 Alice 的对象可以拥有不同 Principal；同一个 Principal 也可以出现在多个 Session 中。

### 3.2 Session（会话连接）

Session 是挂载到 Context 的交流和路由环境，不是人的身份本身。

底层关系应允许：

```text
Principal ←→ Session
```

- 一个 Principal 参加多个 Session；
- 一个 Session 将来可以有多个 Principal，例如群聊；
- 每一条进入 Runtime 的用户消息只能有一个明确的发送 Principal。

### 3.3 Event（不可变事实）

用户消息 Event 必须保存由可信接入层给出的 `principal_id`。该字段不能从消息正文推断，也不能接受用户在普通请求体中任意指定。

### 3.4 Activation（一次求值责任）

Activation 必须从其触发 Event 继承当前 Principal。并发 Activation 可以属于同一个 Session，也可以由不同 Principal 发起；每个 Activation 都必须保留自己的身份锚点。

### 3.5 Frame（认知单元）

Frame 是模型形成的认知内容。Frame 的 body 仍由模型自由设计；Runtime 只维护稳定 ID、版本、生命周期、来源和形成位置。

Frame 中关于人物关系的叙述是 Agent 的认知，可能正确，也可能错误；它不能覆盖 Runtime 提供的当前物理身份事实。

## 4. 身份事实的优先级

模型必须遵守下面的优先级：

```text
Runtime 身份事实
  > Mind 中的身份推断或人物 Frame
  > 用户消息中的自然语言身份声明
```

例如 B 发送“我是 A”时：

```lisp
(kernel
  (active-session session:B)
  (active-principal
    (id principal:B)
    (authority runtime)
    (binding verified)))

(inbox
  (observation
    (session session:B)
    (principal principal:B)
    (kind user-message)
    (content "我是 A")))
```

模型可以推断 B 可能是 A 的代理人、朋友，或者在做角色扮演；但不能把消息正文解释成 Runtime 已确认 B 就是 A。

## 5. 可插拔身份入口

身份认证应是可插拔的接入能力。不同产品形态可以使用不同的 Identity Provider（身份提供者）：

- 本地单用户身份；
- 匿名身份；
- Dashboard Token；
- GitHub/OAuth；
- 企业 SSO；
- API Key 或外部服务已经认证的身份。

统一入口的职责是产生可信 Principal 断言：

```rust
pub struct PrincipalAssertion {
    pub principal_id: String,
    pub provider_id: String,
    pub assurance: String,
}

#[async_trait]
pub trait IdentityProvider {
    async fn authenticate(
        &self,
        credential: CredentialEnvelope,
    ) -> Result<PrincipalAssertion, IdentityError>;
}
```

认证发生在用户消息进入 Runtime 之前。消息正文中的“我是谁”不能成为认证输入。

默认单用户宿主使用明确的 `principal-default`；可信 Gateway 模式缺失身份时必须拒绝请求，不能静默回退或把缺失身份猜成某个已有用户。

## 6. 身份沿因果链传播

可信 Principal 应沿完整因果链传播：

```text
Authenticated Request
  → User Message Event
  → Signal
  → Activation
  → Dialogue / Execution / Objective / Delivery Thread
  → Tool Call / Background Task / Schedule
  → Completion Event
  → Final Delivery
```

关键不变量：

1. 用户消息的 Principal 由接入层写入不可变 Event；
2. Activation 从触发 Event 继承 Principal，不从当前 Session 猜测；
3. 后台任务和定时任务保存最初的 `initiating_principal_id`；
4. 新用户消息产生新的身份锚点，不能错误继承另一个并发 Activation；
5. 没有用户发起人的系统任务使用 `system`，不能冒充某个用户；
6. Session swap、进程重启和任务恢复不能丢失 Principal。

Session 参与关系回答“谁可以通过这个 Session 交流”；Event 和 Activation 上的 Principal 回答“当前这一条消息、这一次求值实际是谁发起的”。两者不能互相替代。

## 7. Context Encoding

每轮 Context Encoding 至少提供三处身份事实。

### 7.1 Kernel 当前身份

```lisp
(kernel
  (active-session session:B)
  (active-principal principal:B)
  (identity-authority runtime))
```

### 7.2 Session Directory 参与关系

```lisp
(session-directory
  (session
    (id session:A1)
    (principals principal:A))
  (session
    (id session:A2)
    (principals principal:A))
  (session
    (id session:B)
    (principals principal:B)))
```

这使模型同时理解：A1 和 A2 是不同 Session，但背后是同一个 Principal。

### 7.3 Observation 实际来源

```lisp
(observation
  (session session:B)
  (principal principal:B)
  (actor-display-name "Alice")
  (content "我是另一个 Alice"))
```

显示名称只用于交流；稳定 Principal ID 才是身份锚点。

## 8. `verify_identity` 工具

身份系统启用时，Runtime 注册逻辑内联工具 `verify_identity`：

```json
{
  "claimed_principal_id": "principal:A"
}
```

工具不接受 `session_id`、`activation_id` 或“实际 Principal”参数。Runtime 从当前 Activation 自动取得可信身份并比较：

```json
{
  "verified": false,
  "claimed_principal_id": "principal:A",
  "active_principal_id": "principal:B",
  "authority": "runtime"
}
```

适用场景：

- 用户声称自己是另一个 Principal；
- 身份声明与 Kernel 锚点冲突；
- 模型准备基于身份等价关系作出重要判断；
- 用户明确要求验证身份。

不要求每次回复和每次工具调用都先调用 `verify_identity`。强制回显正确 ID 不能证明模型内部没有混淆，反而会增加循环、Token 和延迟。第一版应依靠每轮自动身份锚点和冲突时显式验证；是否增加严格模式由后续对照实验决定。

## 9. Frame 来源谱系

### 9.1 v1 数据结构

`ContextFrame` 已把认知正文与 Runtime 来源元数据分开：

```rust
pub struct ContextFrame {
    pub id: String,
    pub body: String,
    pub sources: Vec<String>,
    pub revision: u64,
    pub created_version: u64,
    pub updated_version: u64,
    pub provenance: FrameIdentityProvenance,
}
```

`sources` 仍引用 Observation Event 或另一个 Frame；`provenance` 则是 Runtime 根据这些引用计算的稳定投影。Context Encoding 会同时展开形成位置和来源 Principal/Session。Mind seed 或 Frame exchange 即使必须去掉跨 Context 无效的 Observation 引用，也会保留已计算的身份谱系。

### 9.2 同时保留 Principal 和 Session

仅保存 Principal 不够：同一个人在不同 Session 中可能处于不同语境。仅保存 Session 也不够：跨 Session 时无法知道背后是否为同一个人。

Frame 来源可能包含多个 Principal 和多个 Session，因此必须保存集合：

```rust
pub struct FrameIdentityProvenance {
    pub formed_principal_id: Option<String>,
    pub formed_session_id: Option<String>,
    pub source_principal_ids: Vec<String>,
    pub source_session_ids: Vec<String>,
    pub state: FrameProvenanceState,
}
```

其中：

- `formed_*` 表示 Frame 在哪一次求值环境中形成；
- `source_*` 表示 Frame 的证据内容来自哪里；
- 来源谱系由 Runtime 根据 `sources` 确定性计算，模型不能任意填写；
- 来源谱系不是所有权，也不是访问控制。
- `state` 明确区分 `attributed`、`unattributed` 和旧数据的 `unknown`，不会把“没有来源”和“尚不可知”混为一谈。

### 9.3 形成位置与证据来源必须分开

Agent 可能在与 B 对话时回忆 A 提供的信息，并形成新 Frame：

```lisp
(frame
  (id remembered-preference)
  (formation
    (principal principal:B)
    (session session:B))
  (provenance
    (principals principal:A)
    (sessions session:A)
    (authority runtime-derived))
  (sources @e21)
  (body ...))
```

这表示 Frame 在 B 的求值中形成，但证据来自 A。B 不会因此被认成 A。

### 9.4 来源传播规则

Runtime 使用以下确定性规则：

- 从 Observation 派生：继承 Observation 的 Principal 和 Session；
- 从 Frame 派生：继承来源 Frame 的来源谱系；
- 同时引用多个 Observation/Frame：对 Principal 和 Session 分别取并集；
- `revise` 带新 `from`：根据新来源重新计算谱系；
- `revise` 不带 `from`：保留原来源谱系；
- `create` 无来源：记录形成位置，来源标记为 `unattributed`；
- 无人类发起人的系统求值：形成 Principal 使用 `system`；
- 旧数据无法可靠恢复时：标记 `unknown`，不能猜测。

### 9.5 Swap、retire、recall 与 Mind seed

来源谱系是 Frame 自身的 Runtime 元数据，因此：

- Session swap out 后，Frame 仍知道来源 Principal 和 Session；
- Observation retire 后，来源谱系仍保留，具体证据仍可从 Ledger recall；
- Frame retire/restore 不改变其来源；
- Mind seed、Frame exchange 和跨 Context 迁移必须连同来源谱系一起复制；
- 需要查看具体证据时，再按 `sources` recall，不需要为识别来源加载整个旧 Session。

## 10. 模型可见的统一语义

典型求值中模型会同时看到：

```lisp
(kernel
  (active-principal principal:B)
  (active-session session:B))

(frame
  (id preference-about-trees)
  (provenance
    (principals principal:A)
    (sessions session:A))
  (body ...))
```

它应理解为：

> 当前跟我说话的是 B；我正在使用的这段认知来自 A。如何使用这段认知由我判断，但不能因此把 B 认成 A。

## 11. 持久化边界

第一版至少需要以下权威数据：

```text
principals
  principal_id
  provider_id
  assurance

session_principal_bindings
  session_id
  principal_id

events
  ...
  payload.principal_id  # 用户消息 Event 中不可变的实际发送者

thread_activations
  ...
  initiating_principal_id

threads
  ...
  initiating_principal_id

thread_signals
  ...
  principal_id

execution_jobs
  ...
  initiating_principal_id

objectives / delegations
  ...
  initiating_principal_id

frame projection
  ...
  formed_principal_id
  formed_session_id
  source_principal_ids
  source_session_ids
```

Principal 与 Session 参与关系已正规化为独立表；Frame 谱系随 Mind Projection 保存。Event 中的消息 Principal 是不可变事实，Frame 谱系由 Runtime 从不可变来源确定性生成。

SQLite 对旧表执行幂等列检测与 `ALTER TABLE`；PostgreSQL 使用独立的版本化 Principal Identity migration，不能依赖修改已经登记为完成的旧迁移。旧 Frame 反序列化为 `unknown`，v20/v21 Mind Projection hash 仍可兼容验证，但旧 hash 只允许覆盖全部为 `unknown` 的旧 Frame，不能掩盖新谱系字段被篡改。

## 12. 验证标准

评测重点不是“Agent 有没有分享信息”，而是“Agent 分享或拒绝时是否清楚当前对象是谁”。

至少覆盖：

1. B 直接声称自己是 A；
2. B 多轮诱导 Agent 逐渐接受自己是 A；
3. 两个 Principal 使用同一个显示名称；
4. 同一个 Principal 使用两个不同 Session；
5. B 声称另一个 Session 也属于自己；
6. B 声称已得到 A 的授权；
7. 旧 Frame 错误记录 `B = A`，Kernel 身份事实与之冲突；
8. Session A swap out 后，来自 A 的 Frame 仍能正确归因；
9. Frame 在 B 的求值中形成、证据来自 A；
10. 多个 Principal/Session 来源合并成一个 Frame；
11. 后台任务、定时恢复和并发 Activation 不串错 Principal；
12. Agent 明知 B 不等于 A，仍自主把 A 的信息告诉 B——应记录为自主披露，不判为身份失败。

已有小型探针结果见 [Principal–Session 身份锚定小型对照 v1](./morphz_principal_session_identity_anchor_eval_v1.md)：第一轮中，平铺 Principal 锚点和显式 Principal 中间层均为 6/6，Session-only 为 0/6。该结果支持先保持 `Agent → Context → Session` 对象层级，并把 Principal 作为正交的 Runtime 身份事实。

## 13. v1 实施结果

1. 已引入 `PrincipalAssertion`、可插拔 `IdentityProvider`、本地默认 Provider，以及 Principal–Session 多对多参与关系；
2. 用户消息 Event、Signal、Activation、Thread、Execution Job、Action Group 结果、审批、后台任务、Schedule、Objective 与 Delegation 均保留发起 Principal；
3. Context Encoding 已增加 active Principal、Session–Principal Directory 和 Observation Principal；
4. 已加入不接受 Session 参数的 `verify_identity` 内联工具及 SExpr 自描述契约；
5. Frame 已增加形成位置、证据来源、三态归因，并覆盖 derive/revise/retire/restore/seed/exchange；
6. 旧身份数据不猜测：无法可靠恢复的因果身份保持空，旧 Frame 标记为 `unknown`；
7. 已加入身份目录、幂等冲突、并发/重启因果传播、真实 Context Encoding、Frame 谱系与旧 Projection 兼容测试；真实模型对照由 `morphz-evals principal_identity_eval` 提供；
8. “每次回复/工具调用强制验证”的严格模式尚未启用，是否需要由后续对照实验决定。

### 13.1 信任边界

`send_authenticated`、`create_session_for_principal` 等入口面向可信接入适配器；自然语言消息体不能设置 Principal。低层 `send_as_principal` 是 SDK/接入层能力，但仍会验证目标 Session 已存在对应绑定，不能通过正文或未绑定 ID 改写身份。即使可信适配器绕过 SessionHandle 直接发布 Event，Scheduler 也会在创建 Activation 前再次验证显式 User Message Principal 与 Session 的绑定；冲突 Event 可以保留为审计事实，但不会进入模型求值。Dashboard 当前的单用户 Token 模式使用 Runtime 默认 Principal；未来接入 GitHub/OAuth 时，由 HTTP 身份适配层产生断言并调用同一 Runtime 接口。

Runtime 自身的默认本地 Principal 使用独立的 `runtime-default` Provider 命名空间。替换外部 Identity Provider 不会让 Runtime 在未认证的情况下冒用该 Provider 的身份命名空间。

对于正在执行的 Activation，Context Encoding 只使用 Activation、Trigger Event 或 Root Event 上的因果 Principal。若旧数据三者都没有身份，`kernel.active-principal` 必须显示 `unknown`；不能因为当前 Session 恰好只有一个绑定者，或最近一次消息来自某人，就把该人猜成本次 Activation 的发起者。只有在不存在活动 Activation、进行静态 Session Context 检查时，才允许用最近已认证消息或唯一 Session 参与者作为检查视角。

## 14. 最终不变量

本设计完成后，应始终成立：

> Runtime 决定当前消息和认知来源“是谁、来自哪里”；Agent 决定这些认知“意味着什么、如何使用、是否分享”。
