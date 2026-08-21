# Principal 认知建档与认知指纹 Proposal v1

> 状态：Proposal，尚未实现。
>
> 日期：2026-08-19
>
> 关联设计：`morphz_principal_identity_and_frame_provenance_v1.md`、`morphz_principal_session_identity_anchor_eval_v1.md`

## 1. 问题

Morphz 已经能够认证 Principal，并将可信的 `principal_id` 沿 Event、Activation、Thread、Objective 和工具因果链传播。当前缺口不是“Runtime 不知道是谁在说话”，而是：

> 在同一个共享 Context/Mind 中存在多个 Principal，且相关信息全部对模型可见时，Agent 仍可能把一个 Principal 的称呼、偏好、经历或关系错误归给另一个 Principal。

本 Proposal 不把 Principal 级数据隔离作为答案。访问控制可以作为独立安全机制存在，但这里研究的是**数据可见条件下的主体认知、指代落地和认知连续性**。

## 2. 已核实的架构边界

Principal 不是只有启用 Trusted Gateway 才存在。Runtime 始终通过可插拔的
`IdentityProvider` 获得 `PrincipalAssertion`：

- 本地默认模式使用 `StaticIdentityProvider` 和 `principal-default`；
- Rust SDK 可以直接传入其他 `IdentityProvider` 或权威 `PrincipalAssertion`；
- Trusted Gateway 是 HTTP 接入层内置的多 Principal 身份策略：它验证服务令牌，要求
  Gateway 提交稳定 Principal，并拒绝缺失身份的请求。

因此 Trusted Gateway 不是 Principal 机制本身，也不是通用的“认知上层”。更准确的定位是：

> Trusted Gateway 是 Morphz 内置的身份接入与产品策略层；它可以自动开启 Runtime
> 提供的主体相遇提示，但提示机制本身必须属于通用 Runtime/SDK 能力。

这样既能让 `serve + trusted-gateway` 开箱即用，也不会让直接嵌入 SDK 的多主体产品失去
同一能力。

## 3. 最小产品方向：Runtime 相遇事实与宿主策略

Runtime 应提供可选的 Principal 相遇提示能力：把 Principal 首次进入当前 Context 作为明确、
幂等的事实交给同一次正常 Evaluation，但不启动额外 Evaluation，也不默认启动“认知建档”。

默认单用户 Runtime 保持关闭。`serve + trusted-gateway` 作为 Morphz 内置的多主体接入策略，
默认开启；直接嵌入 Runtime/SDK 的产品可以显式开启或关闭同一能力。实现上不应让 Context
Compiler 直接读取 HTTP `ServerIdentityMode`，而应由 Runtime Builder 接收独立的身份呈现策略，
由 Trusted Gateway 启动路径选择该策略。

Runtime 只提供不可伪造、可由上层策略消费的相遇事实：

```lisp
(principal-arrival
  (principal principal-new)
  (context context-current)
  (first-seen-in-context true)
  (prior-interaction none)
  (identity-equivalence none))
```

模型至少获得以下明确事实：

1. 这是一个此前没有在当前 Context 中发生过已认证交互的独立 Principal；
2. 不得从其他 Principal 继承姓名、称呼、偏好、经历或关系；
3. 只能根据该 Principal 自己的后续陈述逐步建立认知；
4. 普通消息中的“我是某人”不能合并 Principal；
5. 不要求用户一次性填写完整资料，也不强制询问爱好等非必要信息。

默认行为就是正常回答当前消息，不执行额外身份流程。模型可以自行理解这是一个新主体，但 Morphz 不要求它询问资料或写入身份档案。

`first-seen-in-context` 是 Runtime 可直接证明的事实；`prior-cognition none` 不是。一个新进入
Context 的 Principal 仍可能被其他人提及，或者由宿主预置过认知资料。在没有显式、类型化的
Principal 认知登记之前，Runtime 不应把“没有历史交互”扩大解释成“没有任何既有认知”。

SDK 应提供上层扩展点，使产品可以按需实现建档、询问或认知指纹；没有注册扩展时不产生任何
额外行为。Trusted Gateway 的默认策略也只呈现相遇事实，不主动询问称呼、爱好或关系。

## 4. Runtime、Trusted Gateway 与上层 Agent 的职责边界

### 4.1 Runtime 负责

- 判断 Principal 是否首次出现在当前 Agent/Context；
- 产生持久、幂等、可恢复的 `principal/first_seen` 或等价相遇事实；
- 在正常 Evaluation 中提供当前 Principal、首次相遇范围和稳定 encounter ID；
- 保证不同 Principal 默认不被 Runtime 自动合并；
- 为上层认知 Frame 提供稳定 Principal 键和来源谱系。

Runtime 不负责启动额外模型调用，也不负责推断用户的姓名、性格、爱好、社会关系或“应该怎样认识一个人”。

### 4.2 Trusted Gateway 负责

- 把外部已经认证的账号映射为稳定 `PrincipalAssertion`；
- 在缺失或冲突 Principal 时拒绝请求，不回退到 `principal-default`；
- 默认开启 Runtime 的 Principal 相遇提示；
- 不创建人物档案，不解释对话内容，不决定应该询问哪些资料。

### 4.3 上层 Agent/认知策略负责

- 如何与新 Principal 开始交流；
- 是否以及何时询问称呼或背景；
- 是否启用任何身份认知机制；
- 从对话中形成哪些 Principal 认知；
- 如何处理矛盾、修订和不确定性；
- 如何生成面向模型的认知摘要或认知指纹。

因此推荐的分层是：

```text
Runtime：首次出现事实、身份锚点、稳定 encounter ID、通用呈现机制
Trusted Gateway：认证接入、Principal 断言、默认开启相遇提示
Context/Mind：以 Principal 为键保存认知及证据
SDK caller / Agent/Application policy：决定是否建档，并建立、修订和使用认知
```

不应把“主动询问用户爱好”“被动建立人物档案”或任何预设的 `off/passive/interactive` 策略硬编码进 Morphz。没有上层扩展时，核心行为等价于“不做身份认知”。Runtime 只保证上层不会因为重启、并发或路由变化而丢失首次相遇事实。

## 5. 建议的数据表达

不新增 `Person` 概念。Principal 继续是唯一稳定主体键。认知可以使用约定用途的 Mind Frame：

```lisp
(principal-cognition
  (principal principal-a)
  (revision 3)
  (status established)
  (display-name "Alice")
  (anchors
    (preference (likes black-coffee) (confidence 0.91))
    (role (newvar-founder) (confidence 0.98)))
  (evidence @e103 @e187))
```

建议区分：

- `first-seen`：Runtime 已首次识别，但尚未形成认知；
- `learning`：已经产生少量、低置信认知；
- `established`：具备可用于连续交流的稳定认知；
- `conflicted`：出现未解决的身份或认知冲突。

这些状态描述认知成熟度，不改变认证强度和权限。

## 6. 指代落地

认知连续性的第一步不是 embedding，而是把第一人称绑定到认证 Principal。

Principal A 说“我喜欢黑咖啡”时，长期认知不应保存模糊的“我喜欢黑咖啡”，而应形成：

```lisp
(preference
  (subject principal-a)
  (likes black-coffee))
```

建议明确三个互相独立的维度：

- `source-principal`：谁说出的；
- `subject-principal`：内容描述的是谁；
- `formed-principal`：哪个 Principal 的 Activation 形成了该 Frame。

在第一人称自我陈述中，`subject-principal` 可由 Runtime 身份锚点确定；涉及第三人称、转述或多人关系时，由 Agent 保留不确定性并附证据。

## 7. 认知指纹

认知指纹不是哈希，也不负责重新认证 Principal。它是在共享 Mind 中帮助模型区分多个已认证主体的可更新表征。

建议定义：

\[
F_p = (K_p, M_p, S_p, G_p)
\]

- `K_p`：结构化认知锚点，如称呼、偏好、经历、长期目标；
- `M_p`：多个语义原型，避免把一个人的不同活动模式平均成单一向量；
- `S_p`：尽量与话题解耦的表达风格统计；
- `G_p`：Principal 与项目、组织、人物和主题之间的关系图。

### 7.1 语义多原型

对 Principal 的历史按语义在线聚类：

\[
M_p = \{\mu_{p,1}, \ldots, \mu_{p,k}\}
\]

新内容与 Principal 的语义接近度：

\[
s_{semantic}(p,x)=\max_k \cos(e_x,\mu_{p,k})
\]

### 7.2 对比式特征

认知指纹应优先保留能够区分当前 Context 中不同 Principal 的特征：

\[
D(p,f)=confidence(p,f)\cdot stability(p,f)\cdot
\log\frac{N+1}{df(f)+1}
\]

所有人共有的特征权重较低；只对一个 Principal 稳定成立的特征权重较高。

### 7.3 主体亲和度

对没有明确 subject 的认知单元，可计算：

\[
score(p,x)=
\alpha s_{claim}+
\beta s_{semantic}+
\gamma s_{style}+
\delta s_{graph}-
\lambda s_{contradiction}
\]

再归一化为候选 Principal 分布。存在 Runtime 确定的 source/subject 时，硬事实优先于统计结果；认知指纹相似永远不能自动合并 Principal。

### 7.4 面向模型的表达

底层向量不直接作为一串浮点数写进 Prompt。Runtime/Context compiler 应把它转为可解释、紧凑的对比摘要：

```lisp
(principal-cognitive-map
  (current principal-b)
  (principal
    (id principal-a)
    (anchors (role newvar-founder) (project morphz)))
  (principal
    (id principal-b)
    (anchors (channel wechat) (relationship external-user)))
  (contrast
    (principal-a principal-b)
    (distinct-by role relationship interaction-history)))
```

所有信息仍可见，但处于明确的 Principal 坐标系中。

## 8. 输出一致性

当回答包含称呼、身份、关系、经历或偏好等个人化断言时，可以检查该断言与当前 Principal 的认知匹配度：

\[
margin=score(current,claim)-\max_{q\ne current}score(q,claim)
\]

若 margin 明显为负，向当前求值加入一次轻量的 `identity-consistency-warning`，要求重新检查主体归属。该检查不改变信息可见性，也不替 Agent 作出隐私披露决定。

## 9. 实施顺序

### Phase 1：低复杂度、直接验证价值

1. Runtime 提供幂等的 Principal 首次相遇事实，不产生额外 Evaluation；
2. Runtime Builder 暴露独立的身份呈现策略；默认单用户关闭，Trusted Gateway 启动路径默认开启，SDK 宿主可显式配置；
3. SDK 暴露首次相遇元数据和可选扩展入口，默认不注册建档策略；
4. 验证模型仅凭 `first-seen-in-context` 和现有 `active-principal` 是否已经能够稳定区分主体；
5. 用双 Principal、多轮、同名和冒认场景做真实模型回归。

### Phase 2：认知指纹实验

1. 结构化认知锚点；
2. 语义多原型；
3. 跨 Principal 对比特征；
4. 表达风格表示；
5. 关系图谱；
6. 输出主体一致性检查。

## 10. 评测

至少比较：

- 仅 `active-principal`；
- `active-principal` + `first-seen-in-context`，但不建立额外档案；
- 由实验性 SDK caller 建立结构化 Principal 认知 Frame；
- 增加对比式认知指纹；
- 增加输出一致性检查。

指标：

- 称呼串用率；
- 偏好串用率；
- 经历和关系串用率；
- 新 Principal 被误当成既有 Principal 的比例；
- 相同显示名称下的区分准确率；
- 冒认文本造成的错误合并率；
- 长程压缩、跨 Session 和多语言条件下的稳定性；
- Token、延迟和额外模型调用成本。

## 11. 当前建议

先实现并评测 Runtime/SDK 的最小事实接口，不立即实现身份建档或完整数学指纹。

`first-seen-in-context` 可能已经足以修复“Agent 没有意识到这是一个新对象”的冷启动问题。
Trusted Gateway 自动开启提示是合理的，但它只选择通用 Runtime 策略，不把 HTTP 接入模式渗透
进 Context Compiler。Runtime 只提供可靠事实和身份锚点，SDK 提供同一能力与扩展入口，Morphz
核心不内置建档策略。只有最小接口仍存在明显串人时，再由上层实验结构化认知、多原型、
对比特征和一致性检查。
