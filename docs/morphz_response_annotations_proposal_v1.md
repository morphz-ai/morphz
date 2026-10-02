# Morphz Runtime 可选响应注解 Proposal

状态：隔离机制门槛通过后完成 Runtime 核心实施及本地生产链验收。支持范围见本文末尾，不代表所有 Provider 已通过。

日期：2026 年 10 月 2 日。

本文面向 Runtime 和调用方开发者，设计一种随既有模型响应提交的展示注解。目标是在不专门增加 LLM 请求的情况下，为一次 Execution 提供短标题、阶段说明、步骤意图和结果解读。先用隔离原型与真实模型验证，按验证发现修订本文，达标后再修改 Runtime。

## 范围与原则

活动沿用既有 Execution 边界。工具调用、重试、并行调用和本次执行的附属工作是其步骤，不新增用户目标分类器或另一套活动生命周期。

注解是模型写出的展示文字，不是执行授权、Mind、只读 Custom、工具回执或 Runtime 状态。Runtime 决定身份、所属执行、generation、运行状态、审批、取消、时间、退出码及终态。注解不能把失败改为成功、扩大权限或启动工作。

正常路径只复用本来就存在的模型请求。允许增加输出 token，不允许为了命名、补齐步骤说明、修复坏注解或收尾总结而追加模型请求。原工作流没有最后一次推理时，保留真实回执，不强行生成自然语言摘要。

## 启用与兼容

Runtime 默认关闭整个机制。关闭时必须保持原工具定义、提示词、回复边界、流式正文、请求数量和执行参数不变；不添加保留参数，不注册特殊回复入口，也不抽取名称碰巧相同的业务字段。

以 HTTP API 和 SDK 在提交执行输入时显式指定为主，不要求启动参数或重启进程。Request.activation 路由选项经 HTTP、SDK 和 SessionHandle 共用接收链。activation.response_annotations 取值 off 或 v1，缺省继承 orchestrator.response_annotations 配置默认值 off。用版本枚举而非布尔值，既能显式关闭，也能持久识别已采用的协议版本。进程配置仅提供默认值，不替代请求选择。同一个 Runtime 可以服务不同调用方和不同 Execution 的选择。

```json
{
  "activation": {
    "response_annotations": "v1"
  }
}
```

选择在接收输入时解析，写入 Accepted Event 的有效协议并冻结为 Thread.response_annotations；AcceptedInput.binding.execution 回传有效选择。后续工具轮次与重启恢复沿用它，不受后来配置开关变化影响。不允许运行中的 Execution 因全局配置变化而更换输出契约。Directed supplement 继承原 Execution 的选择，禁止以补充输入覆盖该路由选项；follow-up 新执行可另行选择。AcceptedInput 的原请求与幂等指纹不能被事后默认值变化改写：只将调用方显式选择计入指纹，缺省请求仍使用原指纹。启用不是模型自行决定的事，也不是“看到某个字段就隐式启用”。

现有尚未读取的普通输入可能合批到同一 DialogueTurn；有效响应注解版本必须成为合批兼容条件。off 与 v1 不得静默采用第一条或最后一条请求的设置，必须沿已有独立执行路径处理。

Morphz 应用可以选择默认启用，但底层 Runtime 的默认值不得因此改变。此次目标不包含默认改变现有应用行为。

启用后所有注解字段仍可缺省。旧纯正文和原 no_reply 形式仍合法；typed infer 的严格返回值不自动挂载注解回复协议。工具名 reply 或顶层参数 _annotations 已被调用方占用时，启用预检必须报告冲突，不覆盖业务能力。接收链在任何原子落库、Thread 或 Job 创建之前以 422、invalid_response_annotation_contract 和静态冲突原因拒绝；不能误报为暂时不可用而诱导重试。已有 AcceptedInput 的同请求重试仍返回原冻结绑定，不重新根据今日默认值检查新契约。

## 逻辑结构

底层字段使用 execution，不使用 UI 的 activity 命名。Application 将 Execution 的注解投影成活动列表，不在 Runtime 硬编码卡片、头像、项目表单或任务分类。

```json
{
  "execution": {
    "title": "检查运行环境",
    "progress": "已确认系统，继续检查处理器架构",
    "result": "已确认系统与处理器架构"
  },
  "intent": "检查处理器架构",
  "observations": [
    { "ref": "@e123", "result": "操作系统为 Linux" }
  ]
}
```

字段语义如下。

| 字段 | 对象 | 语义 |
| --- | --- | --- |
| execution.title | 当前 Execution 的输入修订 | 整次工作做什么；同一输入修订采用首个有效标题，用户补充或调整任务后可更新，不能漂移成步骤名 |
| execution.progress | 当前 Execution | 基于已观察结果的阶段说明，不是数字百分比或状态枚举 |
| execution.result | 当前 Execution | 最终结果短述，包含失败、部分完成和未执行部分 |
| intent | 承载它的当前调用 | 即将执行这一步的目的，不宣称结果已经发生 |
| observations[].result | 指定的已返回观察 | 对工具回执的自然语言解读 |

初始限额为：每个 title、progress、intent 最多 256 个 Unicode 字符；result 最多 512 个；每次响应最多 16 项 observation 注解；ref 最多 128 个 ASCII 字符。只接受普通字符串与规定结构，不接受模型提供的身份、状态、百分比、权限或任意可执行内容。

字段缺失保持既有展示记录；空字符串不自动删除历史。更新采用追加的生产者记录，读模型可选择当前有效版本，而非覆盖事实回执。不同注解的生成时间与其引用工具的完成时间分开保存。

## 工作响应的承载

首选在模型可见的工具参数 schema 中增加可选顶层保留字段 _annotations，与真实调用在同一模型响应中产生。schema 扩展与业务执行校验分层：不同 Provider 的 strict、nullable 或 schema 限制必须由适配层处理，不假设添加一个可选 JSON 属性就能在所有严格通道直接运行。例如：

```json
{
  "command": "uname -m",
  "_annotations": {
    "execution": { "progress": "已确认系统，继续检查处理器架构" },
    "intent": "检查处理器架构",
    "observations": [{ "ref": "@e123", "result": "操作系统为 Linux" }]
  }
}
```

Runtime 只抽出顶层保留字段，原业务参数仍按原 schema 和权限规则验证，业务工具不负责理解注解。文档、文件内容或业务对象内同名键不能被递归剥离。原始 Provider 调用参数和实际执行参数必须分别保留，不能为了剥离字段破坏原生 continuation 签名或历史回放。

当前调用的 intent 由承载对象隐式绑定实际 call ID，模型不预知或生成 Provider call ID。execution 隐式绑定当前受信任 Execution 与 generation。已返回结果使用 Runtime 提供的 observation_ref，解析成确切持久 Event，并检查它确实属于当前允许解释的执行范围且模型已获得它；不能根据结果顺序、相似命令或裸上一项猜对象。

同一响应的并行调用只能描述意图，不能解读尚未返回的同批结果。整体 execution 注解在同批只提交一次；各工具可有自己的 intent，避免互相覆盖。对已经返回的观察解读可随下一次工具响应或最终回复提交，不要求每个步骤都有模型注解。

工作响应中的 execution.result 不作为最终摘要生效；整体结果必须随真实终结边界或最后交付响应记录。未知字段、非法文案或非法引用只丢弃对应注解并记录诊断，不阻断合法工作，也不请求模型补写。

不以独立 annotate 工具作为通用基础：单调用模型可能将注解当作本轮唯一调用，从而挤掉工作并增加轮次。

## 最终响应的承载

候选方案为一个可选的保留 reply 响应形式：

```json
{
  "content": "检查完成，系统为 Linux，架构为 ARM64。",
  "annotations": {
    "execution": { "result": "已确认系统类型与处理器架构" },
    "observations": [{ "ref": "@e124", "result": "处理器架构为 ARM64" }]
  }
}
```

通过 Function Calling 承载时，Runtime 在普通工具调度之前识别 reply，将其规范化为既有正文交付决定与可选注解；它不是物理工具、Job 或新的结束生命周期，不返回一个工具结果后再要求模型继续。

reply 必须独占工具调用边界，不能与物理工具或 no_reply 混批。正文合法性沿用原交付要求；文案错误可降级，但非法执行控制不能伪装成成功。后台工作未结束时仍沿用既有等待与终结检查，result 字段不能强制结束 Execution。

原 no_reply(mode=wait) 不代表 Execution 已结束。首版不扩展 no_reply 的参数；silent、wait 和独占语义严格保持。等待和无消息结束由真实 Runtime 状态展示，不为其补齐文案增加请求。后续扩展必须单独验证，不能默默给 no_reply 增加新状态机。

为保持流式正文，需要将 reply 的 ToolArgumentsDelta 中 content 字符串受控增量解码为正常 TextDelta，不能让客户端看到原始 JSON 或注解。必须覆盖跨 chunk 的键、转义、Unicode、代理对和长正文。完整与流式解码均拒绝重复的根控制字段，不能一边采用 JSON 的 last-wins、一边拒绝同一输入。Rust 生产解码保持 serde 的 Unicode 标量要求，不接受孤立代理码；JavaScript 原型在这一点的容忍行为不作为生产契约。未完成此适配不能宣称流式兼容。无注解的原始纯文本流继续原样工作。

正文增量与现有模型流一样，是最终响应校验前的草稿。若先输出 content、随后才出现非法混批或坏 JSON，已送达的文字不能撤回；此时必须走明确的协议失败边界，不能执行混入工具或把草稿记作成功交付。不能因这一限制把注解或原始 JSON 直接透传给正文客户端。

## 持久化与数据权威

Runtime 是生产者、绑定与事实记录的权威。优先将验证过的注解与原 assistant_call 或终态 Event 一起原子保存，不新增 renderer 数据库或双写活动生命周期表。记录 source attempt、响应 Event、注解次序、当前 Thread generation、当前调用 ID、被引用观察 Event ID及字段来源。

幂等身份由 Runtime 的实际生产者事件与注解次序构成。重放不能新增重复记录、换绑观察或再次执行工具。无效引用不能读取其他用户、Session、项目或执行的内容。授权沿用实际 Execution 来源，不能信任模型填入的路由身份。

来源 Event 在首次插入前尚无数据库序号。写入时不猜测 max+1，也不把模型序号当排序事实；读投影从实际包裹该记录的持久 Event 获取 sequence，验证来源 ID 后再用于排序。恢复沿用同一来源序号和身份。

优先复用已有 Event 存储与授权查询以保持 SQLite 和 PostgreSQL 一致；注解是有界结构化 Event payload，不是全工作区 JSON 快照。删除与保留跟随既有 Event 生命周期。若索引或展示查询不能仅靠现有模型实现，须修订本文的数据模型与迁移说明后再落地。

协议启用绑定采用 Thread 上写入一次的类型化版本字段，旧行默认 off，SQLite 与 PostgreSQL 分别有可重入迁移；Off 字段不进入旧序列化输出。原位 retry 与 supersede 保持原工作身份，仅增加 generation，因此只继承协议，不提供可变 setter；新用户执行使用新的根 Event 与 Thread。每个来源响应 Event 另存当时的协议与 generation，旧代恢复先经过既有 generation fence，再按来源快照解码。注解内容保存在 response_annotation_bundle 中，与来源响应 Event 同次原子写入。两者职责不同：前者决定这次执行的输出契约，后者记录该次响应确实产生了哪些展示解释。不得只把开关放进临时 ModelRequestOptions 后在下一次 Activation 丢失。

工作调用来源沿用实际 model attempt 身份；V1 的终结或等待来源使用 call_{activation}_final，避免同一 Activation 内的工作响应、失败的完成控制回执与最终正文争用同一个来源 ID。验收发现 Off 原逻辑也有完成控制被拒后同 Activation 争用 ID 的缺陷：只有当再次请求且已有非终态工作来源实际占用原 ID 时，最终来源改用 _final；普通 Off 来源 ID、载荷和交付不变。这是原有错误路径的限定修复，不是启用注解协议。等待保留候选 result，但不将其标为生效。恢复复验确切 manifest、原始调用、注解绑定与原 owner-bound Timer；它不重新请求模型、不重新发布正文，也不重设等待时钟。已拥有输入的启动恢复不是新 Signal，不应取消原 Activation 刚持久化的等待 Timer。

未来 Schedule 排队不必然表示当前用户回复仍在等待。既有 Runtime 在互动输入根收到合法交付时可以提交真实终态，而非互动定时任务根仍按既有条件报告 progress 并等待。V1 仅跟随实际选择保存终态或等待来源，不能由 result 文案改变该选择。互动提前交付分支必须先保存来源响应与注解，再沿原交付流程提交 Outcome；不能因为后续 yield_thread 看到 Thread 已完成而漏存来源。

Application 只读取授权后的投影。执行中显示 title 与 progress；终结后显示 title 与 result。取消、崩溃或没有模型收尾时显示 Runtime 事实和回执。迟到 progress 不得使终态倒退。数字进度只在执行事实存在可靠分母时计算。

title 按当前 generation 内的可信输入修订选择。初始修订为 0；同一修订按真实响应事件顺序选首个有效标题，防止普通步骤改掉整次工作标题。用户补充或调整当前任务时，既有 steer 输入真正进入后续模型请求后，允许该轮随原有工作调用或回复提供更新后的标题，不另加标题推理请求。

输入修订不是模型参数，也不等于全局 Context version 或事件上界。Runtime 核对补充 Event 的当前 Thread、generation、Session、发起 Principal、实际请求可见范围及已 Claimed 或 Acknowledged 的持久 Signal，以真实补充 Event ID 和 sequence 生成 host-only title_input_revision，并与来源响应的 manifest、注解一起原子保存。后续 Activation 可以从已验证来源继承修订，包括补充出现时尚未产生标题的情况，不能依赖补充 Signal 仍属于新 Activation 或仍驻留压缩后的 Context。恢复只复验保存的输入证据，不能扫描今日所有 Signal 而把旧响应升级为新修订。

展示选择最新已验证输入修订中的首个有效标题；若新修订没有有效标题，沿用已有标题。旧响应迟到或重放不得覆盖更新后的标题。阶段描述仍不能直接改名，补充输入也不自动新建活动、重跑已提交 Job 或扩大权限。progress 与 result 各按适用事实边界选最新有效值。

## Yao 和 typed infer 的边界

外层 eval 注解描述本批 Plan，不自动复制为内部每一步说明。内部 leaf ID 可能直到执行动态分支或 map 时才产生，不能预填未来序号。

首版内部步骤仍由真实工具、参数、状态和结果生成确定性展示。若希望后续模型解读内部结果，eval 返回必须提供有界且精确的 leaf observation refs；当前不能假设所有内部 ref 已可见。验证与实现必须明确这一限制，不新增 infer 只为注解步骤。

typed infer 的返回类型、普通业务 JSON 和现有 Yao 语法保持不变。本 Proposal 不创建新的 Yao 方言。

## 隔离验证计划

在 experiments/response-annotations 中建立独立协议原型；首次机制验收前不编辑 morphz/src。原型只运行无副作用合成任务，真实模型只读取本实验的合成回执，不读取用户对话、Profile、业务文件或凭据内容。

先验证确定性机制：可选 schema、顶层剥离、原始参数保持、精确引用、单调用与并行绑定、坏文案降级、reply 终结而非工具轮次、流式字符串解码、重放幂等、取消和无收尾的事实展示。它们只能证明原型，不证明真实模型会遵循协议。

随后通过已有授权的本地 Provider 路由做小规模真实模型 A/B：固定同一合成任务，控制工具结果与最大请求次数，比较关闭与启用协议。任务必须包含至少两次串行工作调用，以及最后一次交付；增加一次并行或失败重试案例。各次请求和返回都保留去敏证据，记录真实请求数量、工具参数、注解目标、结果生成时机、最终正文、增量到达与完成事件。验证记录区分单调用、多调用和严格 schema 通道，不由一个通道通过推导另一个通道已支持。

不得把 fixture、多调用 schema 或原型测试当作各 Provider 上线能力的证据。只对实测的协议和模型确认通过；未测试路线保持显式未验证。

## 修改 Runtime 的门槛

| 验收项目 | 达标要求 |
| --- | --- |
| 请求数量 | 实测正常合成任务原有 N 次请求，启用后仍为 N 次，无注解补写请求 |
| 串行结果解释 | 下一轮能准确引用上一轮已返回观察，不把第二步说明当第一步结果 |
| 最终结果 | 正文与执行结果摘要在原末轮同时返回，无普通工具续轮 |
| 参数语义 | 业务执行参数保持不变，原始 Provider 参数与 continuation 完整保留 |
| 流式 | 使用生产同款 bound 原生流入口；真实终轮至少两次正文增量且首个先于完成，拼接精确一致，无 JSON 或注解泄露；原子兼容 fallback 不算通过 |
| 缺省与异常 | 缺注解、坏文案、取消、无收尾不追加模型调用，不伪造事实 |
| 可选性 | 默认关闭且关闭前后 schema、提示词和响应行为无变化；启用冲突明确拒绝 |
| 持久与恢复 | 幂等绑定可复现；Runtime 实施阶段再验真实 DB、恢复与权限链 |

任何机制未达标，先记录问题和原始证据，修订本文并重测。门槛达标后，先复核数据模型和实施范围，再修改 Runtime；修改完成后必须验证真实 Runtime 请求链、持久绑定、恢复、默认关闭和既有协议回归，不能用原型通过代替生产验收。

## 验证记录

独立注解工具已在设计审查中被排除为通用基础。首轮隔离原型通过了 14 项本地 node:test，覆盖默认关闭、参数剥离、回执引用、终轮规范化和字符串流式解码。审查后补测并通过 17 项：修复了真实工具流事件被吞掉的问题，加入来源事件序号排序、迟到结果保护和整个响应的 16 项观察注解总限额；这些结果只说明本地机制，尚不证明真实模型或生产 Runtime 已通过。

设计审查已据现有 API 结构把启用入口由初始布尔候选收敛为 activation.response_annotations 的 off 与 v1 版本枚举，并补充合批兼容条件和 typed infer 隔离。进一步完成 Rust 隔离实现的 17 项测试，并把重复根回复字段的完整/流式控制一致性补入 JavaScript（18 项通过）；Rust 的合法 UTF-8、完整 u64 和按字节预算为生产契约。Thread retry/supersede 增代但保留原工作身份的审查促使冻结绑定收敛为不可变 Thread 字段与来源 Event 代际快照，不增加另一张活动生命周期表。

JavaScript 隔离机制扩展至 20 项通过，Rust 机制 18 项及原生 bridge 5 项全部通过。补测了错误宿主 fact 归属不能取消或终结另一执行、诊断总数和超长未知字段路径预算。

初始脚本选用的 gpt-6.1-sol 在已加载模型别名中没有映射；按调用方最新要求仅增加该别名，不改变默认模型，原配置有可恢复备份。configured mini-m4.local:8317 route 的首个合成请求遭遇 transient_network，未返回响应。诊断发现旧主机当前未解析/连接；本机既有 CLIProxyAPI 的正常鉴权 catalogue 则包含精确 gpt-6.1-sol，因此只把新增别名映射到该既有本机 provider/account，不改变旧 custom/default。

本机 gpt-6.1-sol 首轮 A/B 返回了真实合成结果，串行关闭/启用均 3 次、重试关闭/启用均 4 次（合计 14 Client 请求），注解与正文同轮返回，无补写轮次。但复审发现两处问题：一是标题随步骤变化，已修订为整次工作标题及首有效标题投影；二是 bridge 调用了 RoutedClient 的兼容 measured_stream 默认实现，完成响应被拆成一次性事件，未走生产 bound_stream_with_options 的原生路径。首轮门槛判定已撤销；证据保留在 live-evidence-atomic-fallback.json 并注明撤销原因。

改用生产同款原生 bound_stream_with_options 后，串行样本 6 次请求全部取得真实多增量与 usage。脚本另发现自己过度要求 Provider 必须返回 opaque continuation；实际适配器仅在 Provider 返回需要保留的 reasoning items 时产生该状态，本次路由没有提供。规则因此修订为：提供时必须完整保留，未提供时不得伪造或据此增加请求。已完成的串行证据保留在 live-evidence-native-serial.json，按这一正确规则复核，不重复花费 6 次请求。原生 bridge fixture 验证了提供状态时的完整回放；本轮没有观察到真实签名状态，不能声称其在线验证已覆盖。

随后新发 8 次真实重试对照请求，最终 live-evidence.json 合并了上述 6 次已完成串行样本与 8 次新重试样本。关闭和启用的串行任务各 3 次，失败重试任务各 4 次，共 14 次。启用串行终轮正文产生 41 次增量，首个约在 4.83 秒，完成约在 9.01 秒；启用重试终轮为 36 次增量，首个约在 3.73 秒，完成约在 7.85 秒。拼接正文与完整 reply.content 精确一致，没有 JSON 或注解泄露。上一轮回执在下一次既有调用中被准确引用，失败回执、重试成功及最终结果均有绑定说明；标题稳定描述整次核对工作，没有注解补写请求。

独立复核确认每个业务调用只收到 key 参数，所有注解诊断为空，实际绑定模型均为 gpt-6.1-sol，入口为 native_bound_with_options。当前确定性检查为 Node 21 项、Rust 协议和流式 19 项、原生 bridge 6 项，全部通过。机制门槛因此通过，可以开始生产实施；SQLite、PostgreSQL、权限、恢复、默认关闭的真实 Runtime 验收仍是后续完成条件。

配置别名、路由初始化、未鉴权的 401 或兼容流事件都不能冒充对应能力已验证。上游代理内部 HTTP 重试次数在该 Client 边界仍不可见；记录未知，不写成零。始终不读取或记录用户对话、Profile 或凭据内容。

后续记录需写明实际问题、修订以及重测结果，不能把设计预期写成已实现能力。

生产实施复核发现普通工具回执走独立执行器写入，不能只在 Orchestrator 的通用事件函数增加 generation；遗漏会使实际已返回、已提供的合法引用被拒绝。已补本次本地执行链回执的冻结协议/代际快照，重测后合法引用及跨执行拒绝场景通过。等待来源事件进入独立恢复分支，保存准确 manifest、model attempt、原始调用与提供时的 native continuation，复验已持久化的 owner-bound Timer，不能当作普通 assistant_call 或重问模型。补充验收又发现互动提前交付分支遗漏注解；测试原先把未来 Schedule 错当成必然等待，已按真实 Runtime 行为拆分互动终态与非互动等待场景，不修改执行事实来满足错误预期。

调用方另提供 Muse 在任务补充后同步更新活动标题并接续执行的观察。据此修订了此前“整个 generation 永远只取首标题”的设计：同输入修订稳定，新可信 steer 输入可更新。真实 Runtime 与 SQLite 的两个 Steer 用例已通过，分别比较正常两请求及延迟命名三请求的 Off/V1 路径，验证同一 Execution、输入真正进入请求、跨 Activation 修订继承、Job 不重跑与迟到标题保护。这验证的是 Morphz 的行为，不推断 Muse 的内部协议。

## Runtime 验收记录

当前已完成的核心验收为 57 项：30 项协议、流式与入口单元测试；真实 SQLite Runtime 的 19 项工具、正文、typed infer、跨作用域引用、代际、持久边界恢复及真实生命周期测试；2 项真实 Steer 请求链；3 项 SQLite 与隔离 PostgreSQL 协议生命周期、混合输入合批及迁移测试；3 项真实 API 接收与拒绝预检测试。PostgreSQL 用例实际执行，不计跳过为通过。Runtime 测试使用 native bound-with-options 的合成 Client 和真实持久 Job，不是上游模型质量测试；真实模型机制门槛仍由前述 14 请求证据单独证明。

新增验收比较了 Off/V1 的实际 silent、wait、operator cancel 和互动提前交付，均维持原有两次业务请求、真实物理回执及 Lifecycle；取消实际销毁了未返回最终响应的原生模型 Future，没有请求模型补写结语。真实 create_session_schedule 经 Scheduler Timer 产生非互动 schedule_due、运行物理 Job，再正常选择 progress 与 waiting，候选 result 保留但不生效；测试未伪造等待事件、Timer 或终态。另一项 V1 旧式纯正文验收为一次请求、零 Job、空注解，正文仍完整交付。完成控制被拒后的 V1 与 Off 同 Activation 两来源均独立持久，未增加请求。入口测试核对冲突拒绝发生于 AcceptedInput、Thread、Job、模型请求之前；切回 Off 保留完整 Registry 业务 schema 和原参数，缺省旧请求重启后保持原 Off 绑定，缺省/显式 Off/显式 V1 指纹彼此可区分。

实际发现并修复了跨 Activation 后补充标题修订丢失、已拥有输入在恢复时误取消等待时钟、导入 Thread 的 Custom 绑定错误地重新计算稳定 ID，以及不兼容 ensure_thread 在拒绝之前先写入 Principal 的问题。测试读取 EventStore 的真实持久 sequence 后再绑定 Signal，不能将接收接口返回对象尚无 sequence 误认为未落库，也不能伪造序号使恢复测试通过。

执行循环首次默认并行运行是 77 通过、2 失败；两项都在第二输入发送前的固定 800 毫秒首工具启动门槛失败。保持原代码、预算和断言，同一 binary 的交替复测为 20/20、完整串行为 79/79。该证据支持并行负载敏感，不记为原并行运行全绿。串行日志另有 HangingClient 两次和 BlockingClient 一次测试 worker 的预设 unreachable 异常；主 deadline 断言通过，但日志不是全无异常。

启用 remote-store 的跨进程审批回归实际暴露了默认 Tokio worker 栈溢出：首轮为 2 通过、16 失败，普通恢复与 Objective 创建路径均受影响。仅将下层执行器放到堆上仍不足以修复；将恢复与新模型评估分成同任务内分别等待的 Future，并隔离新增协议失败交付 Future 后，原 18 项跨进程用例全部通过。没有调大线程栈、改 fixture 的环境清理、改超时或放宽断言。当前 macOS debug binary 的恢复函数 poll 栈帧从约 860 KB 降至约 84 KB；该尺寸是本次编译的观测值，不作为其他平台的保证。补齐互动提前交付及限定 Off 来源 ID 修复后，当前 remote-store binary 再次通过跨进程审批 18/18、执行循环串行 79/79、Plan infer handoff 5/5、terminal handoff 1/1；审批子进程 fixture 本身的 ignored 标记不是未执行，18 个父用例实际调用它。8 项原 PostgreSQL 审批回归此前已在独立 schema 中实际通过且清理完成，不把默认忽略项算作已执行。全目标 cargo check 已通过；另有 9 项 HTTP Custom 授权、Steer、指纹、旧 SQLite 和等待 Timer 的单元回归实际通过。macOS lib-test 链接器仍提示异常 unwind 段过大，此为构建警告，不冒充日志零异常。

目前验证范围是本地工具执行、指定真实模型 Responses 路由与上述 SQL Store。未据此声明所有 Provider strict-schema、Edge 回执、在线 opaque continuation 签名或 Muse 内部协议已验证。Title 继承只查询最近 32 个来源响应，但当前 Thread Signal 校验仍读取该 Thread 的历史信箱；32 不是整个查询链的数量上界。Application 活动卡片消费、产品默认启用和 Yao 内部 leaf 语义注解不属于此次 Runtime 契约实施。
