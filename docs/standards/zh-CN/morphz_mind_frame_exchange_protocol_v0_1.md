# Morphz Mind Frame Exchange 协议 v0.1

> 状态：规范草案
>
> 维护方：新变元（Newvar）
>
> 参考实现：Morphz Runtime（计划中）
>
> 规范文本语言：英文
>
> 日期：2026-08-25
>
> 英文规范文本：[English](../morphz_mind_frame_exchange_protocol_v0_1.md)

## 1. 范围

Morphz Mind Frame Exchange 协议（**MFX**）定义一个 Agent 如何导出经过选择的认知
子图，以及另一个 Agent 如何验证、隔离、求值并选择性吸收这些认知，同时不转移 Agent
身份，也不赋予发布方修改接收方 Mind 的权力。

协议的主要可移植对象是 **Mind Frame Bundle（心智帧包）**。一个 Bundle 可以包含一个
Frame 或多个 Frame，以及 Relation、证据血缘、修订信息、披露与权利声明、完整性元数据
和可选的 Remote Resolver 能力。

MFX v0.1 定义：

- 统一承载单个 Frame、Frame Bundle 与 Mind Projection 交换的逻辑 Bundle 模型；
- 跨权威域的源身份、修订、血缘与引用语义；
- 离线解释与可选远程求证；
- 披露、数据权利、完整性和扩展要求；
- 隔离、求值、吸收、派生与拒绝语义；
- 导入认知、本地 Mind 成员资格、驻留与单次 Evaluation 激活之间的边界；
- Core Producer、Consumer、Verifier、Resolver 与 Importer 角色。

MFX v0.1 不定义通用知识本体、真理评分、自动语义合并、实时共享 Context、联邦查询
网络、信誉市场、支付系统，也不转移完整 Agent、Kernel、Session 历史、私有 Inbox、
凭据或模型隐藏推理。

[《Morphz 结构化上下文规范》](morphz_structured_context_specification_v1.md)定义 Frame 与
Context 语义。[《Morphz Agent Trajectory 规范》](morphz_agent_trajectory_specification_v0_1.md)
定义可移植的因果经验模型，MFX 复用其中的证据与权利概念。非规范性的
[《Morphz Union Mind Federation：联合大脑与认知联邦愿景》](../../morphz_union_mind_federation_vision_v1.md)
描述 MFX 之上的一种联邦层设想。

## 2. 规范性用语

本文中的“必须”“不得”“应当”“不应当”“推荐”“不推荐”“可以”和“可选”，在表达
规范性要求时，对应 BCP 14、[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) 与
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html) 中的大写关键词。

除非另有明确说明，示例与设计理由均为非规范性内容。中英文含义冲突时，以英文规范文本
为准。

## 3. 基础原则

### 3.1 交换经过选择的认知，而非转移 Agent

MFX 交换经过明确选择的认知子图。Bundle 不得暗示源 Agent 的身份、所有权、权威、权限、
完整人格、私有 Session 或整个 Mind 被转移。

Exporter 必须应用明确的选择边界。边界之外的材料即使存在于源 Context，也不自动属于
Bundle。

### 3.2 导入不等于相信

接收、解析、验证、保留或求值 Bundle，本身不得使其中的 Frame 成为接收方 Active Mind
的成员。吸收必须是一次明确且经过授权的状态转换。

密码学完整性只能证明字节一致性或某个密钥的控制关系，不能证明 Frame 真实、有用、安全、
最新或适用于接收方。

### 3.3 认知主权

接收方拥有吸收、修订、建立 Relation、退役、激活或拒绝外部认知的决定权。默认情况下，
吸收会创建一个接收方所有的本地 Frame，并保留指向源 Frame 的不可变血缘。发布方不得
因此获得对本地 Frame 的写权限。

远程身份镜像或订阅需要未来 Profile 明确定义，不得从 MFX-Core 导入中静默推导出来。

### 3.4 证据与解释保持分离

Frame body 是 Agent 编写的认知；Evidence Descriptor 记录或引用可能支持、反驳、限定或
解释该认知的材料。存在证据并不会把 Frame 变成 Runtime Fact，MFX 必须保留二者的区别。

### 3.5 Core 离线可用，在线求证可选

符合 MFX-Core 的 Bundle 必须能够在无网络条件下完成解析、结构验证和语义分类。可选的
Remote Resolver 可以补充证据、修订或替代关系信息，但 Resolver 不可用不得导致 Bundle
无法解析。

Importer 不得因为 Bundle 中存在 URL 或 endpoint 就自动访问。任何远程访问都必须是一次
由显式策略控制的操作。

### 3.6 Body 开放，Envelope 封闭

MFX 标准化交换 Envelope、身份、血缘、权利与生命周期边界，不规定 Frame body 的通用业务
本体。Body format 可以定义语法与解码方式，但不能宣称具有通用语义。

## 4. 术语

### 4.1 Mind Frame

**Mind Frame** 是 Morphz Structured Context 定义的、具有稳定身份的 Agent 认知单元。
它具有源身份、修订、body、生命周期状态，以及可选的 Source Reference 与 Relation。

### 4.2 Mind Frame Bundle

**Mind Frame Bundle** 是统一的 MFX 交换物。它可以选择：

- 一个独立 Frame；
- 多个 Frame 及其依赖图；
- 从源 Context 中选择得到的 Mind Projection。

它们是同一逻辑对象的不同选择模式，而不是三种独立 wire format。

### 4.3 Source Frame Reference

**Source Frame Reference** 标识某个权威域中的一个 Frame 修订。其可移植身份元组为：

```text
authority_domain + agent_id + context_id + frame_id + revision
```

不得静默用一个分量替代另一个分量。本地实现可以使用不透明编码，但规范分量必须可恢复，
或者受到密码学绑定。

### 4.4 Local adopted Frame

**Local adopted Frame** 是接收方在求值外部认知之后创建并拥有的 Frame。它具有自己的
本地身份，并通过 `derived_from`、`forked_from` 或等价关系保留对一个或多个 Source
Frame Reference 的不可变血缘。

### 4.5 Evidence Descriptor

**Evidence Descriptor** 是对源 Event、Observation、Outcome、Artifact、Agent Trajectory
节点、外部记录，或已脱敏/不可获得来源的可移植描述。它不一定包含证据内容本身。

### 4.6 Remote Resolver

**Remote Resolver** 是支持已声明 MFX 求证能力的可选权威端点。Resolver 响应是该权威
所作的陈述，不是通用真理。

### 4.7 Quarantine

**Quarantine（隔离区）**是由接收方控制的存储与求值状态。导入内容仍位于 Active Mind
之外，不能获得权威，也不能执行其中嵌入的内容。

### 4.8 Adoption、Residency 与 Activation

- **Adoption（吸收）**使本地 Frame 成为接收方语义 Mind 的一部分；
- **Residency（驻留）**决定 Frame 是否属于默认 Frame Working Set；
- **Activation（激活）**决定 Frame 是否进入某一次 Evaluation 的 Context Encoding。

三者相互独立。吸收不得隐含永久驻留或在所有 Evaluation 中激活。

## 5. Bundle 逻辑模型

### 5.1 顶层字段

Mind Frame Bundle 包含以下逻辑字段：

| 字段 | 要求 | 含义 |
| --- | --- | --- |
| `spec_version` | 必须 | MFX 规范版本 |
| `profiles` | 必须 | 声明符合的 Profile |
| `bundle_id` | 必须 | 本次导出 Bundle 的稳定身份 |
| `source` | 必须 | Producer、Exporter、权威域和源修订 |
| `selection` | 必须 | Frame 选择方式与闭包策略 |
| `completeness` | 必须 | `complete`、`partial` 或 `open` 及限定条件 |
| `frames` | 必须 | 被导出的 Frame 修订；仅诊断场景可以显式为空 |
| `relations` | 必须 | 被导出的类型化 Relation |
| `evidence` | 必须 | Evidence Descriptor 或明确缺失状态 |
| `transform` | 必须 | 选择、过滤、脱敏与派生历史 |
| `disclosure` | 必须 | 被省略的内容类别与保密状态 |
| `rights` | 必须 | 允许的接收方操作与受众约束 |
| `integrity` | 必须 | Digest/签名声明或明确缺失状态 |
| `resolvers` | 可选 | 受策略门禁控制的 Remote Resolver 声明 |
| `extensions` | 可选 | 带命名空间的扩展数据 |

必需集合为空，并不能证明源系统中不存在相应类别的信息。

### 5.2 Source

`source` 必须标识：

- Producer 实现与 Exporter 版本；
- 权威域；
- 源 Agent 与 Context；
- 源 Mind revision 或等价导出边界；
- 在允许披露时的导出时间；
- 可选的 Issuer 身份与签名密钥引用。

Exporter 不得对无法认证或无法绑定到导出过程的 Context 声称权威。

### 5.3 Selection 与 Completeness

`selection` 必须说明根 Frame 如何选择、依赖闭包如何计算，例如显式 Frame 列表、Relation
遍历或具名 Projection rule。

`complete` 表示声明的 Profile 和选择边界所要求的实质内容均已内联，或由允许的外部引用
明确表示；`partial` 表示边界封闭，但有实质信息被省略、脱敏、无法获得或未被捕获；
`open` 表示声明的导出边界内，所选择的源状态仍可能变化。

Exporter 不得仅因为“所有选中的行都已输出”就宣称 Bundle 完整。

### 5.4 Frame record

每条 Frame record 必须包含：

- Source Frame Reference；
- body 可用性以及 Body Value 或允许的省略标记；
- 导出时的源生命周期状态；
- 在允许且重要时的源保护状态；
- 已声明的 Source Reference；
- Provenance 状态；
- body 存在时的内容 digest；
- 可选的 applicability、counterexample、uncertainty 与 revision-history 声明。

Agent 编写的主张必须与 Runtime 派生的身份和 Event Fact 保持可区分。

### 5.5 Relation record

Relation record 必须标识 subject、relation name、object、创建权威和源修订。除非某个 Profile
另有定义，Relation name 是开放的。Consumer 不得根据未知 Relation 的名称猜测标准业务语义。

`supersedes` 表示源 Agent 作出的替代声明，不要求接收方退役自己的本地 Frame。

### 5.6 Body Value 与 Body Format

Body Value 必须声明：

- `format`；
- 当 format 未定义编码时的 `encoding`；
- 内联内容、Artifact reference 或明确的省略状态；
- 内容存在时使用的 digest 算法和值。

MFX v0.1 定义两个基础 format identifier：

- `morphz.sexpr`：UTF-8 Morphz S-expression body；
- `text.utf8`：不带通用本体声明的不透明 UTF-8 文本。

其他 body format 需要带命名空间的 extension 或 Profile。Format 只描述如何解码内容，不得
被当作内容安全或语义正确的证明。

## 6. 身份、修订与血缘

### 6.1 源身份不可变

再次导出同一个源 Frame 修订时，必须保留 Source Frame Reference。Producer 不得为语义
不同的内容复用同一个 Source Frame Reference。

当源系统检测到身份损坏或历史迁移存在不确定性时，必须声明不确定性，而不是伪造连续性。

### 6.2 Bundle 身份

`bundle_id` 必须对确定的选择、源边界、转换和内容保持稳定。凡源修订、选择、脱敏、权利
声明或转换发生会影响解释的变化，都必须创建新的 Bundle 身份或显式 Bundle revision。

### 6.3 本地吸收血缘

MFX-Core 吸收应当创建接收方本地 Frame 身份。吸收事务必须记录：

- 源 Bundle 身份；
- Source Frame Reference；
- `derived_from`、`forked_from` 等吸收模式；
- Admission 使用的 Verifier result 与 policy identity；
- 对吸收负责的本地 Principal 或 Agent authority；
- 本地创建 revision。

接收方可以按照本地 Structured Context 语义修订该 Frame，但不得把本地修订发布成原始
源权威编写的修订。

### 6.4 不存在隐式远程写权限

Resolver 可用、签名有效、存在 subscription metadata 或共享 relation name，均不得赋予
发布方修改、退役、恢复、保护、激活或披露接收方本地 Frame 的权限。

## 7. 证据闭包与远程求证

### 7.1 证据可用状态

每个重要 Evidence Descriptor 必须声明以下状态之一：

- `inline`：允许披露的内容包含在 Bundle 中；
- `artifact`：内容位于受到 digest 绑定的 Artifact；
- `remote`：Resolver 可以在策略允许时提供内容；
- `redacted`：内容存在但被有意隐去；
- `unavailable`：Exporter 无法取得内容；
- `unknown`：源系统无法确定内容是否存在。

`redacted`、`unavailable` 与 `unknown` 不等价于空或 false。

### 7.2 可移植证据引用

只在本地权威域有意义的 Event 或 Observation ID，必须同时携带 authority domain 与 source
type。Exporter 不得把不可访问的本地 ID 包装成虚假的可移植主张。

当 Frame 实质依赖被省略证据时，Bundle 必须包含 external-parent、redacted-parent、
unavailable-parent 或等价闭包标记。过滤不得静默把认知重新挂到一个方便但不真实的可见来源。

### 7.3 Remote Resolver 声明

Resolver 声明必须包含：

- 协议标识和版本；
- authority domain；
- endpoint 或 endpoint discovery identifier；
- 支持的 capability；
- authentication 与 authorization method identifier；
- 可选 expiry 与 signing-key reference。

MFX v0.1 保留以下 capability name：

- `resolve_frame`；
- `resolve_evidence`；
- `check_revision`；
- `list_superseding_frames`；
- `get_withdrawal_statement`。

Capability name 只声明能力存在，不代表请求已获授权。每次请求仍受接收方策略与 Resolver
授权决定约束。

### 7.4 Resolver 调用策略

Importer 不得因为 Bundle 内含 endpoint 就自动访问 Resolver。网络访问前，接收方必须应用
显式策略，至少覆盖：

- 允许的 authority domain 与 endpoint scheme；
- DNS、redirect、loopback、link-local、private-network 与 metadata-service 限制；
- credential scope 与披露范围；
- 请求目的和所请求 identifier；
- response size、timeout 与 content limit；
- 审计以及用户/Principal 审批要求。

Importer 必须把 redirect 与 endpoint change 当作新的网络决策。除非策略明确授权，不得发送
接收方 secret、本地 Frame body、query context 或 private identity。

### 7.5 Resolver response binding

Resolver response 应当签名，并必须绑定 authority domain、capability、request reference、
returned revision、content digest、issuance time，以及存在时的 expiry。Consumer 不得把一个
响应的内容与另一个响应的身份或签名混用。

Resolver 失败、拒绝或消失不会使 Bundle 内已有字节失效；它只会改变当前可验证的范围，
并必须如实表示。

## 8. 披露与权利

### 8.1 权利必须显式声明

开放实现或公开规范不得被解释为允许收集、保留、吸收、派生、托管处理、再分发或训练
Bundle。

Rights declaration 至少必须分别说明：

- inspect 与 verify；
- retain；
- local evaluation；
- hosted evaluation；
- adopt into local Mind；
- derive cognition；
- Remote Resolver access；
- redistribute original 与 transformed content；
- training use。

未知或缺失的许可必须视为拒绝。Derived Frame 与 derived Bundle 不得扩大源授予的权利。

### 8.2 受众与时间约束

Rights declaration 可以限制 Principal、组织、Agent identity、authority domain、purpose、
jurisdiction、validity period 或 downstream recipient。机器可读标记不能替代适用法律、合同
或人类可读许可文本。

### 8.3 Disclosure

Disclosure declaration 必须说明 Bundle 是否包含或省略：

- 用户或 Principal 内容；
- 私有 Session 材料；
- 原始 Evidence payload；
- 推断得到的敏感属性；
- 模型私有推理；
- 机密 Frame body 或 Relation；
- 源身份与时间元数据。

脱敏应同时减少内容泄露与元数据推断。低熵秘密的 digest 本身可能泄密，不能仅为证明脱敏
而发布。

## 9. 完整性

Integrity declaration 必须标识状态、digest algorithm、canonicalization、covered fields，
以及存在时的 signature scheme。`unsigned` 或 `unavailable` 是明确状态，不代表验证成功。

在 canonical-signature Profile 定稿之前，Producer 必须标识 digest 或签名实际使用的精确
canonicalization。除非所声明 canonicalization 另有规定，不得假设 object-key order 具有语义。

验证至少必须区分：

- structurally valid；
- digest-valid；
- signature-valid for a declared key；
- authority binding validated；
- evidence resolved 或 unresolved；
- policy-admissible 或 denied；
- semantically evaluated 或 unevaluated。

使用单一布尔 `trusted` 字段不能满足这些区别。

## 10. 导入、隔离与吸收

### 10.1 状态必须分离

MFX Importer 必须保留以下概念状态，即使内部命名不同：

```text
received -> verified -> quarantined -> evaluated -> adopted | rejected
```

任一阶段失败不得静默进入下一状态。基于新策略或新证据的再次求值必须产生新的可审计决定。

### 10.2 Quarantine 要求

被隔离的内容必须：

- 保持在 Active Mind 之外；
- 保持在默认 Context Encoding 之外；
- 不拥有 Tool、capability、credential 或 Runtime authority；
- 不执行嵌入的 Yao、Harness、script、link 或 instruction；
- 受到资源与解压限制；
- 保留源身份、权利、披露和完整性元数据；
- 能够在不修改本地权威认知的前提下被删除。

Agent 可以在权威与披露边界明确的隔离 Evaluation 中检查这些认知。

### 10.3 Evaluation

Evaluation 可以把导入认知与本地 Frame、Evidence、Outcome、Policy 或领域 Verifier 比较。
结果应当记录：

- 被求值的 Bundle 与 Frame identity；
- 本地 State View 或声明的比较边界；
- 使用的 Evidence 与 Resolver response；
- compatibility、applicability、uncertainty 与 conflict finding；
- 重要时的 evaluator、model、Cognitive Application 与 policy identity；
- 推荐动作，同时不得把推荐与 commit 混为一谈。

### 10.4 Adoption

Adoption 必须是经过授权的本地 Context transaction，只能创建或修订接收方所有的状态，
并保留源血缘。吸收决定可以：

- 基于导入 body 创建本地 Frame；
- 组合导入认知与本地认知，派生新 Frame；
- 保留多个竞争假设；
- 与已有本地 Frame 建立 Relation；
- 继续隔离以等待证据；
- 拒绝 Bundle。

Adoption 不得自动退役冲突的本地 Frame，也不得把源 protection state 复制成接收方 authority。

### 10.5 吸收后的认知使用

被吸收的 Frame 可以参与本地 recall 与 activation。它是否默认驻留、是否进入某次 Evaluation，
仍是两个独立的本地决定。实现不得把“物理上已经保存但尚未吸收”的 Bundle 表示成 Active
Cognition。

## 11. 更新、替代与撤回

源权威可以发布新的 Frame revision、superseding Frame、correction 或 withdrawal statement。
它们都是新信息，不得修改早先的不可变 Bundle。

接收方可以通过 Remote Resolver 或未来 Subscription Profile 发现更新，但发现更新不得自动
修订或删除本地 Frame。接收方必须自行求值更新并提交本地状态转换。

Withdrawal 表示源权威在声明条件下不再认可或分发某项源主张。它不能抹除另一 Agent 已经
学到的认知，不能重写本地 Event History，也不能证明旧主张必然为假。法律或合同上的删除
义务是另一类约束，必须由相应产品与权威策略执行。

## 12. 序列化与扩展

v0.1 交换表示为 UTF-8 JSON。每个 Bundle 必须声明 `spec_version`。Object-key order 不具有
语义；只有字段明确声明时，array order 才具有语义。Timestamp 使用 RFC 3339。

Consumer 必须拒绝不支持的 REQUIRED Profile，不得根据字段形状猜测其语义。Extension
必须使用抗冲突命名空间，且不得重定义 Core field。未知的 optional extension 可以保留并
忽略；正确解释所必需的 extension 必须声明为 required。

JSON 是 v0.1 的传输表示，不是 Frame ontology。未来编码只要保留相同逻辑模型与协商语义，
即可另行定义。

## 13. 安全考虑

所有导入的 Frame body、Relation、Evidence、metadata、Resolver declaration 与 signature
均是不可信输入。实现至少必须防御：

- 认知或证据中的 prompt injection 与 instruction smuggling；
- 恶意 Yao、Harness、script、URI 或 Artifact 执行；
- identifier collision 与 authority-domain substitution；
- digest/signature confusion 与 canonicalization ambiguity；
- decompression bomb、超大图、深层嵌套和循环依赖攻击；
- SSRF、DNS rebinding、redirect abuse、metadata-service access 与 credential leakage；
- 恶意或已失陷的 Remote Resolver；
- 通过本地派生或转换再分发进行权利洗白；
- 通过内容或元数据重新识别私有 Session 或 Principal；
- 过时、已撤回、投毒或选择性脱敏的认知；
- attention pollution、personality drift 与 Context capacity denial；
- 把多数意见或 reputation signal 误认为真理。

在显式策略分别授权每一步之前，Importer 应默认不联网、不执行、不吸收、不再分发。

## 14. 一致性角色与 Profile

### 14.1 角色

实现可以声明一个或多个角色：

- **MFX Producer**：创建逻辑 Bundle；
- **MFX Exporter**：从权威源确定性地投影 Bundle；
- **MFX Consumer**：解析和解释 Bundle；
- **MFX Verifier**：验证结构、身份、完整性与 Profile 声明；
- **MFX Importer**：执行隔离与吸收边界；
- **MFX Resolver**：提供受策略控制的远程求证能力。

### 14.2 Profile

MFX v0.1 定义或保留：

- **MFX-Core**：离线 Bundle 模型、身份、Frame、Relation、证据状态、披露、权利、完整性
  声明与 extension 行为；
- **MFX-Importer**：隔离、Evaluation record 与本地吸收边界；
- **MFX-Remote-Resolver**：capability discovery、策略门禁求证与 response binding；
- **MFX-Signed**：为 canonical signature 保留；
- **MFX-Subscription**：为远程 revision feed 与 cursor 保留；
- **MFX-Federation**：为 Union Mind federation 语义保留。

本 Draft 仅描述 MFX-Core、MFX-Importer 与 MFX-Remote-Resolver。保留 Profile 在规范性扩展
发布前不得被声明。

### 14.3 最低一致性证据

未来公开一致性套件至少应验证：

- 相同源边界的确定性导出；
- Source Frame Reference 与 Bundle identity 稳定；
- complete/partial/open 及 evidence availability 状态可区分；
- 拒绝 malformed、cyclic、oversized 与 authority-substituted Bundle；
- 无 Resolver 时仍可离线解析；
- 不自动访问 URL 或调用 Resolver；
- Quarantine 隔离且不执行嵌入内容；
- 吸收必须显式事务化并保留本地血缘；
- 发布方对 adopted Frame 不具有写权限；
- 权利默认拒绝且派生不得扩权；
- Resolver endpoint policy、request binding、redirect handling 与 response verification；
- update 与 withdrawal statement 只作为本地非变异输入。

自测结果不是公开认证。官方兼容性标识需要独立治理、商标政策与合格证据。

## 15. 与其他 Morphz 标准的关系

### 15.1 Structured Context

Structured Context 定义 Frame 及本地 Context transaction 如何维持身份、修订、生命周期、
Provenance 与冲突语义。MFX 定义两个 Context authority 之间的可移植边界，不重定义本地事务。

### 15.2 Agent Trajectory

Agent Trajectory 记录因果结构化经验与状态转换；MFX 传递从经验中形成的选定认知。Bundle
可以引用 Agent Trajectory node 或 Bundle 作为证据，但两种 Artifact 不可互换。

### 15.3 Cognitive Application、Harness 与 Yao

Cognitive Application 或 Harness 可以在 Runtime authority 约束下导出、求值或吸收认知。
Frame body 可以描述程序性知识，但导入 Frame 不得挂载 Harness 或执行 Yao。可执行包需要
独立 Admission Artifact 与 capability boundary。

### 15.4 Union Mind Federation

Union Mind Federation 可以在 MFX 之上建设 discovery、query、subscription、attribution 与
协作认知，但必须保留本文定义的源权威与接收方主权。本 Draft 不把 Federation 设为 Core
依赖。

## 16. 进入 Candidate 状态前的开放决定

以下内容需要显式评审、MEP 或后续 Profile：

1. 规范 JSON Schema 与字节级 canonicalization；
2. 全局 authority-domain discovery 与 key rotation；
3. 精确 rights vocabulary 及其与人类可读 license 的关系；
4. Artifact packaging 与最大可移植 Bundle 限制；
5. 标准 applicability、uncertainty 与 counterexample vocabulary（如有）；
6. Resolver authentication、隐私保护查询与 response caching；
7. subscription cursor、update feed 与 mirror identity；
8. 跨权威 reputation 与 verification-result portability；
9. Union Mind discovery、Federated Recall 与协作治理；
10. 最终的规范文本、专利、贡献与兼容性标识政策。

## 附录 A：非规范性 JSON 骨架

```json
{
  "spec_version": "0.1",
  "profiles": ["MFX-Core", "MFX-Importer"],
  "bundle_id": "mfxb:sha256:...",
  "source": {
    "implementation": "morphz",
    "exporter_version": "0.1.0",
    "authority_domain": "agent.example",
    "agent_id": "agent-a",
    "context_id": "context-main",
    "mind_revision": 42
  },
  "selection": {
    "roots": ["frame-experience-7"],
    "closure": "declared-sources-and-relations"
  },
  "completeness": {
    "status": "partial",
    "reason": "one private evidence body was redacted",
    "material_omissions": ["evidence:event-private-2"]
  },
  "frames": [
    {
      "source_ref": {
        "authority_domain": "agent.example",
        "agent_id": "agent-a",
        "context_id": "context-main",
        "frame_id": "frame-experience-7",
        "revision": 3
      },
      "body": {
        "format": "morphz.sexpr",
        "encoding": "utf-8",
        "content": "(experience (claim \"...\") (scope \"...\"))",
        "digest": "sha256:..."
      },
      "lifecycle": "active",
      "sources": ["evidence:event-1", "evidence:event-private-2"]
    }
  ],
  "relations": [],
  "evidence": [
    {
      "evidence_id": "evidence:event-1",
      "kind": "event",
      "availability": "remote",
      "source_ref": "event-1",
      "digest": "sha256:..."
    },
    {
      "evidence_id": "evidence:event-private-2",
      "kind": "event",
      "availability": "redacted",
      "reason": "private-session-content"
    }
  ],
  "transform": {"operations": ["select", "redact"]},
  "disclosure": {
    "user_content": "redacted",
    "private_reasoning": "omitted"
  },
  "rights": {
    "inspect": true,
    "retain": true,
    "local_evaluation": true,
    "hosted_evaluation": false,
    "adopt": true,
    "derive": true,
    "remote_resolve": true,
    "redistribute_original": false,
    "redistribute_transformed": false,
    "training": false
  },
  "integrity": {
    "status": "digest",
    "algorithm": "sha256",
    "canonicalization": "mfx-json-draft-0.1",
    "digest": "sha256:..."
  },
  "resolvers": [
    {
      "protocol": "mfx-resolver/0.1",
      "authority_domain": "agent.example",
      "endpoint": "https://agent.example/mfx",
      "capabilities": ["resolve_evidence", "check_revision"]
    }
  ],
  "extensions": {}
}
```
