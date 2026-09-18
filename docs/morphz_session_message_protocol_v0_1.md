# Session 通用消息 IO 协议设计 v0.1

> 状态：设计提案，已有默认关闭的实验实现。结构化输入、Context 投影、类型化交付、资源附件、类型化分页、客户端接入及显式升级／降级写入防护已落地，并通过 SQLite／PostgreSQL、旧版进程切换及隔离桌面链路验证。本文不等于正式可发布标准，实际接口、证据与运行边界见[实施记录](./session_io_implementation_v0_1.md)及[验收记录](./session_io_acceptance_v0_1.md)。
>
> 日期：2026-09-09。范围：Morphz Runtime、SDK、HTTP、Dashboard，以及 Morphz Desktop 的接入方式。
>
> 本文不是已发布的 Morphz 标准。若后续形成公共标准，须经过 MEP 流程，与现有 Draft 标准协调版本和一致性测试。

阅读路径：产品与协议边界看 1—6 节；实际消息与 Context 链路看 7—12 节；交付和客户端看 13—16 节；迁移、工作包与验收看 17—20 节。

## 1. 结论与设计目标

**Session 是 Context 拥有的、持久化且可恢复的双向消息通道。聊天是一种消息格式，不是 Session 的定义。**

采用「通用消息 IO」方向，不在这一阶段开放应用自定义 Context 编译器、可任意修改的私有 Context 分区或私有 retire 机制。

本提案确定以下原则：

1. 文本与附件聊天是长期、一等支持的标准格式；自定义结构化消息也是一等能力。两者不是新旧替代关系。首版自定义结构化消息统一使用 JSON；外部消息表示与内部 Context Encoding 分层，内部继续使用 S-Expr。
2. Runtime 定义信封、身份、路由、顺序、因果、接收与交付语义；应用定义消息内容、领域 Schema 和字段含义。
3. 消息自带类型、版本和必要约束，Runtime 按条校验；保留能力发现及请求 / 订阅级响应、流式能力约定。不要求预登记发送类型或先创建独立协商对象，不改变 Session 的认知归属。
4. 一条 Session 可以承载多个格式；多个客户端可以用不同能力集合访问同一条 Session。
5. 消息从接收、持久化、Observation 投影到 Context Encoding，保持其结构和来源。不能只在 HTTP 层接收 JSON，随后又拼成用户提示词。
6. 稳定的应用行为约定通过 Harness、工具契约表达；消息只携带这一次输入及必要的动态关联信息。
7. 结构化格式不是执行权限。业务操作仍通过真实工具、身份校验、审批、版本检查与成功回执完成。

TCP 类比只用于解释「通道不规定业务正文」。Session 不是无边界字节流：Runtime 仍需识别消息边界，持久化来源和因果，并对 Agent 可见内容进行受控编码。

## 2. 改造前基线与目标增量

以下是本提案提出时的代码边界，保留用于解释改造范围；当前进度以实施记录为准：

| 层次 | 当前实现 | 本提案增加的能力 |
| --- | --- | --- |
| SDK / HTTP 输入 | `text`、附件、Session 引用和调度选项 | 自描述消息信封、能力发现、逐条验证与请求级交付契约 |
| Event | 已支持 JSON payload、不可变历史、物理插入顺序 | 通用消息的权威信封、精确格式绑定及内容表示 |
| Inbox Observation | 已有来源、因果、资源和可见性元数据；消息内容主要是文本预览 | 类型化内容投影，不把对象序列化成 `text` |
| Context Encoding | 有统一的 Observation renderer，Full / Delta 共用 | 通用内容 AST、格式契约引用、有界且可追溯的结构投影 |
| Harness | 已有精确版本和行为契约 | 使用现有边界承载稳定实践，不逐条复制到用户正文 |
| 输出与客户端 | 以聊天回复和执行事件为主 | 类型化交付、通用检查器、格式明确的流式事件 |

关键代码入口：

- [SDK 消息命令](../morphz/src/sdk.rs)：`SendMessageCommand`、`MessageReferenceInput`。
- [HTTP 接入](../morphz/src/web.rs)：`SendMessageRequest`、消息提交与附件暂存接口。
- [Runtime 接收与路由](../morphz/src/runtime.rs)：Session 消息接收、身份校验、根事件与执行绑定。
- [Event 与 Observation 判定](../morphz/src/event.rs)：`Event`、`is_context_observation`。
- [幂等指纹](../morphz/src/memory/mod.rs)：`message_request_fingerprint`。
- [Context 编码](../morphz/src/orchestrator/context.rs)：`render_inbox_observation`、`render_context_delta_observation`。
- [Harness 契约](../morphz/src/harness.rs)。

当前 Event payload 可以放 JSON，不等于第三方已经拥有完整的结构化消息协议。外部接入、Schema、投影、执行语义、输出和客户端渲染必须贯通。

## 3. 对象与所有权

| 对象 | 职责 | 不负责什么 |
| --- | --- | --- |
| Context | 持久认知身份，共享 Mind 与历史的所有者 | 不随终端或消息格式复制 |
| Session | 持久 IO 路由与消息组织 | 不拥有独立 Mind，不固定某个应用格式 |
| Request binding | 接受请求时固化的输入格式、定义摘要、输出约束及执行配置 | 不是客户端预登记，不随订阅或页面切换改变 |
| Subscription preferences | 当前连接的流式版本、可识别格式与未知格式呈现策略 | 不限制 Session 的消息类型，不修改请求的交付契约，不赋予权限 |
| Message | 一次完整的领域输入或输出 | 不是一次物理执行，也不等于聊天气泡 |
| Event | Runtime 对已发生事实的不可变记录 | 不允许客户端伪造来源或覆盖 |
| Observation | 当前求值可见的 Event 投影 | 不是可修改的原始消息 |
| Evaluation / Thread | 一次求值及其执行、因果边界 | 不由前端切换页面重新绑定 |
| Format descriptor | 精确版本的格式、Schema、简短语义说明 | 不是第二个 Harness，不是可执行编译插件 |

一个 Session 可以有多个网络连接；网络断开不删除 Session。一个网络订阅也可以复用传输承载多个已授权 Session，但路由和游标必须分开。

共享认知沿用 Context 的访问与投影政策，不表示所有连接者可以读取所有 Session、资源或私人内容。能力发现与请求 / 订阅约定不扩大这一范围；不满足现有共享边界的团队或私密工作应使用相应隔离配置。

## 4. 协议分层与版本

区分四个版本维度，禁止混为「客户端版本」：

| 维度 | 示例 | 决定什么 |
| --- | --- | --- |
| IO 信封版本 | `io_version: "1"` | 请求、回执、控制事件的结构 |
| 消息格式版本 | `morphz.chat@1`、`morphz.work.input@1` | 业务内容的形状与含义，不等于内容编码或内部 Context 表示 |
| 格式定义摘要 | Schema / contract 内容摘要 | 相同名字和版本是否真的是同一份定义 |
| 流式版本 | `stream_version: "1"` | Delta、终态、断线恢复的处理方式 |

本文版本 `v0.1` 是设计文档版本；示例中的 IO `1` 是拟议首个线协议版本，不是发布声明。

应用命名空间由发布者管理。`morphz.*` 留给 Morphz 自带格式；第三方使用自己的稳定命名空间。Format ID 不是 URL，不触发下载。

相同 Format ID + version 的定义不可原地改变；内容摘要不一致必须报错。增删字段等演化须有明确版本和 Schema 策略，不能假定「多一个字段总是向后兼容」。

## 5. 标准聊天、自定义格式与任意数据

### 5.1 首版内容表示

`message` 包含精确 `format` 与一个判别式 `content`：

| `content.encoding` | 内容 | 默认 Context 投影 |
| --- | --- | --- |
| `json` | `value` 为 JSON 值，保留对象、数组、字符串、布尔、数字、null 的区别 | 通用类型化 AST |
| `utf8` | `value` 为字符串 | 有边界的文本内容节点 |
| `resource` | `resource_id` 指向已授权、已提交的不可变资源版本 | 资源元数据与受控读取入口 |

首版结构化内容只支持 `json`；`utf8` 保留纯文本消息能力，`resource` 承载已授权资源引用。最小基线要求 `json` 与 `utf8`，资源能力单独声明；未支持资源时明确拒绝附件或资源输入，不能丢附件后继续发送。首版不声明或接受 `sexpr` 内容编码，内部使用 S-Expr 不意味着外部接口支持它。已实现的实验边界见实施记录。

「任意格式」表示业务内容可扩展，不表示 Runtime 自动理解任意二进制。自定义二进制可以作为资源保存、转交；是否能解码为 Agent 可读内容，由已安装并授权的资源处理能力决定。

### 5.2 一等标准格式

- `morphz.chat@1`：JSON 内容为 `text`、`attachments`、`references`，也支持仅文字的 UTF-8 表示；输入和输出均可用。JSON 文字可为空，但文字、附件、引用不能全部为空；UTF-8 内容不能为空。
- `morphz.data@1`：JSON 内容，允许任意合法 JSON 值；用于没有领域命名需求的结构化数据。

`morphz.chat@1` 是所有实现的基础聊天格式，不因支持自定义格式而降级。纯文本、文本加附件、仅附件都是其合理用法，附件须由 Runtime 实际支持并在本次提交中通过资源校验，不要求预先握手。

该标准格式明确规定：UTF-8 `value` 与 JSON 中相同 `text` 加空附件 / 引用具有相同聊天含义。仍保留实际输入的表示；改用另一种表示提交不是同一指纹。这项映射不推广到任意自定义格式。

现有 `text + attachments` HTTP / SDK 调用继续作为标准聊天的便利接口维护。它不是一个等待淘汰的旧消息类别；需要适配的是旧调用形状和历史记录格式，而不是聊天能力本身。

### 5.3 自定义格式不强制要求安装插件

存在两种明确的接收配置：

1. **已注册格式**：Runtime 有精确版本的描述、可选 Schema 和可选简短契约；接收时按明确声明的验证能力验证内容。
2. **通用结构化格式**：Runtime 允许 generic JSON 时，消息显式选择 `message.validation: "generic"`，并自带未注册的自定义 ID / version；Runtime 接受时只保证 JSON 语法、结构、来源和投影，不声称已理解或验证领域语义。

通用 JSON 不需要第三方实现 Context 编译器。只有需要强 Schema、明确输出约束和领域契约时，才注册格式定义。

`message.validation` 默认为 `registered`：必须找到精确格式定义，不存在就拒绝，不能自动降为 generic。generic 是针对未注册领域格式的明确模式，不能用于跳过已注册格式的 Schema；其可用范围由 Runtime 政策决定，不由客户端自行授权。

实际验证方式、格式定义及摘要在接受时写入请求绑定和回执。同名格式以后被注册，不得让已经接受的通用消息在回放时突然采用新契约。格式注册属于 Runtime 的应用安装 / 配置机制，不是每个客户端都要维护的发送清单。

### 5.4 外部 JSON 与内部 S-Expr 分层

首版选择 JSON，是因为当前的意图、对象引用、选区、事项、文档与执行回执都能直接用它表达，没有已确认的原生符号数据输入需求。Runtime 内部采用 S-Expr，并不要求客户端使用相同语法。

三个层次分别是：

1. **传输封装**：HTTP 使用 JSON 信封，SDK 可直接接受类型化值。
2. **消息内容**：自定义结构化内容使用 JSON；纯文本与资源引用保留各自的语义边界。
3. **Context Encoding**：Runtime 将 JSON 类型和字段映射为受控的 S-Expr 节点，保留来源、因果及权限边界，不把整个对象拼成自然语言提示词。

客户端 JSON → 类型化消息 / Observation → 内部 S-Expr Context Encoding，是编译分层，不是结构丢失。客户端无需依赖 Runtime 内部 AST、Yao 语法或未来的 Context 表示变化。

不在首版增加另一套数据方言、parser、Schema 与跨表示等价规则。这一取舍减少的是长期互操作和语义契约，而不只是编码工作量。

### 5.5 编码扩展边界与执行隔离

保留 `content.encoding` 和能力协商边界，允许未来基于真实接入需求提出新编码；这不等于已经定义或承诺 S-Expr 输入。首版不定义 Data S-Expr profile，不要求新增外部 S-Expr parser、专用 Schema、转换器或客户端检查器。

- 在消息、响应格式要求或订阅中声明未支持的 `encoding: "sexpr"`，必须明确返回 `unsupported_encoding`；不得静默按 JSON / 文本接收后执行。
- 通过 `utf8` 或资源提交 S-Expr 源文，仍然只是文本或文件内容，不享有原生结构化消息语义，也不能作为编译器节点或 Yao 程序自动执行。
- JSON 字符串中的 `(context_tx ...)`、`(send_message ...)`、`(kernel ...)` 同样只是数据；字段内容不能提升为 Runtime 顶层指令。
- 如需执行 Yao，继续经过程序提交、检查、授权和执行边界；消息载荷长得像程序不构成执行授权。

未来增加编码时，必须另行明确类型保真、校验、规范化指纹、Context 投影、回放与客户端降级规则。新增表示适配不能创造另一套 Session 或绕过通用权限和生命周期机制。

## 6. 能力发现与请求 / 订阅约定

### 6.1 不以独立握手作为发送前置条件

拟议 HTTP 接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/session-io/capabilities` | 获取当前调用者可用的 IO 版本、格式、表示、资源、激活和流式能力及限制 |
| POST | `/api/sessions/:id/io/messages` | 直接提交自描述消息和本次交付约束，Runtime 逐条验证 |
| GET | `/api/sessions/:id/io/events?after=<cursor>` | 按游标读取持久事件，用于首屏与恢复 |
| GET | `/api/sessions/:id/io/stream?after=<cursor>` | HTTP 事件流；认证沿用安全的 HTTP 会话或请求头机制 |

这些都是新增接口提案。能力发现是可选的预检：SDK 可以查询支持版本和格式，客户端也可以直接提交已知版本的完整请求。不支持时 Runtime 在接受之前明确拒绝，不能产生后台执行。

首版不提供独立协商对象的创建 / 续期接口，不使用 `negotiation_id`，不维护客户端发送格式白名单。现有 `/api/sessions/:id/messages` 与 SDK 便利方法继续将标准聊天规范化到同一接收管线。

能力发现返回当前调用者可用的 IO / stream 版本、格式定义及摘要、generic 政策、资源能力、Schema 验证范围和部署限制。可以附带能力修订号用于缓存，但发现结果不是权限凭证、资源预留或之后一定成功的承诺；正式提交仍须重新校验。

### 6.2 消息与请求级契约

- 每条消息携带精确 `message.format.id` / `version`、`content.encoding` 和正文。无需另外声明「客户端会发送这个类型」。
- 调用者可在 `message.format` 中附带期望的 `schema_hash`、`contract_hash`；若有期望摘要，Runtime 必须精确核对，没有期望时以已安装的不可变版本解析。接受后固化实际摘要。
- 注册 / generic 验证方式按 5.3 处理。消息有类型标签，不等于 Runtime 已安装对应定义，更不等于类型声明具有执行权限。
- 协议版本由请求的 `io_version` 明确指定；不支持时拒绝，不自动换版本。客户端可根据能力发现结果自行选择一个支持版本后重试。
- 本次允许与必须交付的结果，通过可选 `delivery` 声明；默认是标准聊天输出。输入类型不能代替接收方能力声明，具体规则见 13.2。
- 接受回执返回规范化的 `binding`：输入格式与表示、验证模式、Schema / contract 摘要、`schema_validation: "enforced" | "syntax_only"`、输出约束和已解析的执行配置。未使用定义时相应摘要为 null。
- `binding` 属于已接受请求的持久记录，不是需提前取得、会到期的客户端协商对象；客户端重试使用原 `client_message_id`，不靠绑定 ID 创建另一次输入。

### 6.3 订阅能力只影响当前连接的呈现

订阅与历史读取可附带 `io_version`、`receive_formats` 和 `receive_unknown`；流式订阅另带 `stream_version`。省略时采用 IO 1 的明确基线：IO / stream 版本为 `1`，可识别格式为标准 Chat 的 JSON / UTF-8 表示，未知领域格式使用只读检查。

以下是一个订阅参数的归一化示例，不是预先创建协商对象的请求：

```json
{
  "io_version": "1",
  "stream_version": "1",
  "receive_formats": [
    {"id": "morphz.chat", "version": "1", "encoding": "json"},
    {"id": "morphz.work.receipt", "version": "1", "encoding": "json"}
  ],
  "receive_unknown": "inspect"
}
```

HTTP GET 使用同名查询参数；列表采用 URL 编码的 JSON 数组，由 SDK 处理。Session 路由和 `after` 游标另行传递；认证使用安全请求头或会话，不在 URL 中放访问令牌。WebSocket 可在订阅帧中携带同一组参数，不建立另一个 Session。

语义规则：

- Runtime 检查 IO / stream 版本、编码和参数，成功建流时通过 `stream.opened` 确认有效订阅配置。历史读取响应同样返回有效配置；不支持时明确失败，不悄悄采用另一版本。
- `receive_formats` 表示客户端能专门识别的格式，不要求 Runtime 为此安装应用，也不强迫 Agent 产生这些类型。历史中的格式是否可读取仍按已有权限判断。
- `receive_unknown: "inspect"` 表示客户端愿意以通用只读方式查看未专门识别的 JSON / 文本 / 资源信息；它不能因此执行内容，也不能声称完成了领域交付。未支持的编码只能返回元数据，不能冒充已解析正文。
- `receive_unknown: "reject"` 时，未识别格式只返回最小 `unsupported-format` 元数据和游标，不返回正文；协议控制事件始终可用，不能因此卡住历史回放。
- 断线后重新提交订阅参数和游标即可。订阅配置没有需要续期的持久租约，也不会修改已经接受的输入、输出约束或消息原文。

### 6.4 并发、升级与授权边界

桌面端可以专门识别 Work 格式，TUI 只识别聊天并通用检查其他数据；两者仍可访问同一 Session。一个客户端改变订阅或升级，不能覆盖另一个客户端的能力，也不能修改运行中请求的交付契约。

每次消息、订阅、资源读取和取消都独立认证与授权。请求绑定不授予新权限；权限撤销优先于已固化契约，不能凭旧绑定继续访问或执行已撤销权限的操作。

新请求按当前能力和自身约束验证；已接受请求、重试与恢复沿用首次固化的精确绑定。如果升级后的 Runtime 无法继续旧绑定，应明确进入不可恢复或等待修复状态，不可换格式、换 Harness 或重发为新请求。无法完成某种呈现的后来订阅者可收到元数据提示，但不能因此改写已提交结果。

## 7. 输入信封与标准聊天示例

客户端提交示例：

```json
{
  "io_version": "1",
  "client_message_id": "input-01",
  "message": {
    "format": {"id": "morphz.chat", "version": "1"},
    "content": {
      "encoding": "json",
      "value": {
        "text": "帮我总结这份 PDF。",
        "attachments": [{"resource_id": "resource-pdf-r1"}],
        "references": []
      }
    }
  },
  "activation": {"mode": "evaluate", "dispatch_mode": "parallel"}
}
```

### 7.1 字段边界

| 字段 | 谁提供 / 确认 | 规则 |
| --- | --- | --- |
| `session_id` | URL / SDK 路由；Runtime 校验 | 不从业务正文提取；不允许正文覆盖 |
| `client_message_id` | 客户端 | 必填，重试稳定；不等于 Event ID |
| `message.format` | 客户端逐条声明、Runtime 对照格式定义与可选期望摘要 | 精确匹配，不猜版本，不要求发送类型预登记 |
| `message.validation` | 客户端请求、Runtime 检查政策 | 默认 `registered`；显式 generic 不能跳过已注册 Schema |
| `message.content` | 客户端 | 验证表示、限制和已绑定 Schema |
| `delivery` | 客户端声明、Runtime 接受时确认 | 本次允许 / 必须交付的格式，不从未来订阅推断 |
| `activation` | 客户端请求、Runtime 授权 | 独立于业务内容，不以某个 JSON 字段的名字暗中触发 |
| `principal_id`、来源身份 | Runtime 从认证与受信委托链派生 | 普通客户端不可指定权威值 |
| `context_id`、Event ID、顺序、时间 | Runtime | 提交时生成或解析 |
| `root_turn_id`、Thread / Target 绑定 | Runtime | 执行建立时决定，后续不可由 UI 改写 |
| 输入格式与可交付格式快照 | Runtime | 从本次请求、格式定义及明确默认值固化，不读取未来客户端偏好 |

首版信封拒绝未知的核心字段，扩展放在明确的命名空间扩展区并由 Runtime 在本次提交中确认支持；领域内容中的额外字段是否允许，由其 Schema 或 generic 规则决定。旧接口不能静默忽略新的 `message` 字段后按空文字或错误正文执行。

`actor` 展示名与权限身份必须分开。第三方客户端若代表团队成员发言，必须使用该成员的认证或 Runtime 可验证的委托；在 JSON 中写一个 Actant ID 不等于获得该人的身份。

### 7.2 接收回执

```json
{
  "status": "accepted",
  "message_id": "message-input-01",
  "event_id": "event-input-01",
  "session_id": "session-main",
  "cursor": "cursor-after-input-01",
  "activation_status": "queued"
}
```

`accepted` 仅表示消息及调度意图已可靠接收，不表示事项已经创建、文档已经保存或 Evaluation 已经执行。执行 ID 尚未建立时不伪造一个已运行状态；后续由权威事件补齐。

为便于阅读，上例省略了 6.2 所定义的完整 `binding`；正式回执必须返回该规范化契约。重复提交返回原输入及其原绑定，不能重新解析成另一个协议约定。

## 8. Morphz Desktop 输入示例

选择「安排事项」后，本次消息可以是：

```json
{
  "io_version": "1",
  "client_message_id": "input-work-02",
  "message": {
    "format": {"id": "morphz.work.input", "version": "1"},
    "content": {
      "encoding": "json",
      "value": {
        "text": "记下明天整理发布材料，由我处理，先不要执行。",
        "intent": "task.arrange",
        "scope": {"workspace_id": "workspace-a", "project_id": "project-a"},
        "subject": {"artifact_id": "artifact-a", "revision": 3},
        "selection": null,
        "attachments": []
      }
    }
  },
  "activation": {"mode": "evaluate", "dispatch_mode": "parallel"}
}
```

`morphz.work.input@1` 是 Work 应用格式示例，不进入 Runtime 的业务类型枚举。其 Schema 定义 `text`、`intent`、`scope`、可空 `subject`、可空选区和资源引用；当前输入者由权威信封提供。

没有选中事项时，`subject` 为 null。打开事项后关联该事项；切换关联改变下一条消息的快照，不切换 Session，不修改已在运行的请求。无需任务意图的普通问答，可以继续发送 `morphz.chat@1`，也可以按应用需要用带上下文的 Work 输入。

职责分配：

- 格式契约解释 `intent` 和字段含义，不要求 Runtime 认识「事项」。
- 选中的认知应用 Harness 和工具说明定义如何查询、创建、更新真实对象，以及合理默认值。
- 应用的 `host_morphz` 宿主适配从可信执行上下文取得当前 Principal、输入和范围；对客户端声明的 workspace / project / artifact 再做权限与版本校验。旧 `host_morphz_work` 仅作为兼容别名，共用相同授权与持久幂等身份；工具名称不成为 Runtime 的应用业务依赖。
- 模型不能通过修改工具参数中的身份或 scope 绕过宿主权限。消息中的引用也不自动授予文件、网页、项目或外部发布权限。
- 对象正文按需要通过授权资源 / 工具读取；需要固定证据时携带不可变版本引用或明确快照，不每次复制整个对象。
- 这次输入不再附加一大段「你应当如何创建事项」的用户正文。行为契约仍然可能含自然语言，但具有稳定位置、可信来源和版本，不伪装成用户发言。

## 9. 格式定义与行为契约

### 9.1 Format descriptor

注册格式的最小描述包含：

- ID、精确版本、允许的内容表示；
- 可选输入 / 输出 Schema 及其摘要；
- 可选、简短、声明式的字段语义说明及摘要；
- 注册者、安装范围与来源；
- 资源引用字段和必需可见字段的声明，用于安全读取与预算处理。

格式注册是应用安装或受授权配置操作，不是普通消息自动产生的管理操作。JSON 表示首版使用 Runtime 固定的 JSON Schema 验证子集；支持的关键字由能力发现声明，不支持的关键字在注册时拒绝，不得忽略。引用仅解析同包本地定义，禁止通过 `$ref` 或 Format ID 自动访问远程网络。无 Schema 的 generic 格式只保证语法与结构，不声称完成领域校验。

格式契约不得包含能修改 Context 的脚本，也不得提供绕开默认编码器的 HTML / 模板插值。UI renderer 可以由应用提供，但与 Context renderer 是不同能力，不能因为能渲染 UI 就获得 Context 写权限。

### 9.2 稳定说明放在哪里

| 内容 | 合适的位置 |
| --- | --- |
| 「这是事项 ID，这是用户选中的原文」 | 格式定义中的简短字段语义 |
| 「在这个领域怎样完成工作」 | 当前 Primary Harness / 可发现实践资料 |
| 「创建工具需要哪些参数、会产生什么效果」 | 工具契约 |
| 用户当前意图、对象版本、选区 | 当前消息 |
| 谁发的、允许访问什么、执行到哪里 | Runtime / 宿主权威上下文 |

一个 Evaluation 仍只有一个 Primary Harness；不能为了 Desktop 输入再隐式叠加一个「消息 Harness」。通用 Work 工具说明可以随工具能力出现，领域行为由实际选中的 Harness 承担。

格式说明按精确绑定去重，进入受限的应用格式定义区域；不放进 Runtime 最高权限 Kernel，不成为新的用户消息。在一次 Encoding 中，当前可见消息涉及的多个格式版本可以并存，且每条 Observation 都能定位对应定义。

必要的稳定说明仍可能在多个模型请求中出现，因为每次求值都需要理解输入；目标是结构正确、去重、可缓存、可溯源，而不是声称模型从此不需要任何文字契约。

## 10. 接收、调度与幂等

### 10.1 接收流程

1. 认证并验证调用者的 Session 权限，解析信封与稳定请求 ID，在授权范围内查询是否已有请求；重试分支按 10.3 使用原绑定。
2. 对新请求，逐条验证 IO 版本、格式、验证模式、表示、Schema、资源和交付约束，不依赖先前握手。
3. 解析受信元数据、精确格式定义与默认配置，生成规范化内容、请求指纹和本次有效绑定。
4. 在存储事务中完成幂等声明、不可变输入 Event、精确协议绑定，以及可恢复的调度意图。
5. 返回 `accepted`；调度器根据已提交意图创建 / 恢复执行，不依赖 HTTP 连接存活。
6. 后续进展、工具执行与输出沿同一根因果关系发布。

不能出现「Event 已接受，但崩溃后永远不会执行」或「请求超时，重试创建第二个根执行」的空窗。复用现有持久接收与恢复机制，扩展格式字段，而不是另建仅驻留内存的消息队列。

### 10.2 激活与消息类型独立

首版基线只要求 `activation.mode = evaluate`。它代表请求 Agent 处理本条消息，调度仍使用现有 `dispatch_mode`、steering / input destination、模型、Harness、Target 约束；不是强制新建一个与现有调度平行的执行系统。

未来可选 `observe` 表示记录事实但不立即求值，只有能力发现明确支持时才可提交。第一阶段没有实现就必须拒绝，而非假装支持。鼠标移动、窗口焦点、页面轮询不因「都能封装成消息」就自动成为认知历史。

模型 / Harness / Target 选择是受控的 activation 参数，不能藏在业务正文中直接获得调度权。Target 一旦绑定物理执行 Thread，延续其不可变规则；新的执行目标要走现有新 Thread 机制。

### 10.3 幂等边界

沿用现有 `(session_id, client_message_id)` 唯一范围，指纹绑定 Principal、规范化内容、格式与契约摘要、资源不可变标识及所有影响执行和交付的显式选项。

实现需区分「调用者请求指纹」与「首次接受的解析后绑定」。重试先在当前授权范围查找已有请求，再用原绑定验证相同请求，不能先按新默认值、当前格式 registry 或新订阅偏好重算并覆盖它。幂等响应返回旧绑定；能力发现刷新、客户端新增可识别格式不改变原输入。

- 相同 ID + 相同有效请求：返回同一已接受输入及当前状态，不重复激活。
- 相同 ID + 不同请求或身份：冲突，不覆盖历史；未授权调用者不得因此获知旧内容。
- 换网络连接、重建订阅、刷新能力发现缓存、资源迁移物理存储位置，不应改变同一请求的业务身份。
- 格式、内容、资源内容摘要、显式模型 / Harness / Target、输入目的地、交付约束变了，就不是相同请求。
- 首次接收解析出的默认配置一并固化；重试不因默认模型或 Session 设置变化而重算旧请求。
- 恢复后的权限必须重新检查，但不把权限失败转成一条新的输入。

这里保证的是幂等接收和恢复，不承诺外部工具操作 exactly-once。写文件、发布、付款等物理效果仍由工具执行系统自己的幂等、审批和成功回执约束。

## 11. 持久化与 Context Encoding

### 11.1 从原始消息到 Observation

存储保留以下层次：

1. 原始业务内容及资源摘要，便于审计；不是把含令牌的 HTTP 请求整体保存。
2. 规范化消息：格式、表示、内容、来源与精确绑定。
3. 不可变 Event：Runtime 顺序、时间、因果和执行引用。
4. 可重建 Observation：依据权限、Working Set、预算和 attention 生成。

新增通用输入事件类型，例如 `session_message`，由受信来源区分 Human、应用或其他 Agent；不能把所有机器事件标成 `user_message`。现有聊天事件可通过同一内部读取接口投影为 `morphz.chat@1`，无需批量改写历史。

Event admission、恢复、Observation 判定、统计和 SDK 订阅必须同时覆盖新类型。不能只新增一个 Event 名字，却让 `is_context_observation` 或恢复扫描忽略它。

### 11.2 确定性的类型化编码

拟议编码示意，具体节点名须在实现测试中固化：

```lisp
(observation
  (ref @e42)
  (session "session-main")
  (principal "principal-user-a")
  (kind "session-message")
  (format "morphz.work.input" "1")
  (binding "format-binding-work-input-1")
  (content
    (json
      (object
        (entry "text" (string "记下明天整理发布材料，由我处理，先不要执行。"))
        (entry "intent" (string "task.arrange"))
        (entry "subject"
          (object
            (entry "artifact_id" (string "artifact-a"))
            (entry "revision" (number "3"))))
        (entry "selection" (null))))))
```

这是结构映射示意，省略了 Event 时间等已有字段，不是完整输入样本。通用节点不认识 `task.arrange`：它只是一个领域字符串。

必须满足：

- JSON 对象按确定性键顺序编码，数组保持顺序；数字不能经由浮点格式化悄悄改变精度。
- 解析保留数字词法值；指纹首版保守地区分 `1` 与 `1.0`，但忽略对象键排列和无意义空白。重复键、非法 Unicode、非 JSON 的 NaN / Infinity 拒绝；大整数的 SDK 不得先转成有损 JavaScript Number。
- String 使用 AST 字符串节点和统一转义，不拼接 SExpr 源码。字符串中的 `(kernel ...)` 仍然是字符串，不能逃逸为节点。
- 内部 S-Expr 节点只能由 Runtime 根据类型化消息构造；不得将正文当作 S-Expr 源码解析后拼入 Context，也不得把业务内容提升为顶层编译指令。
- 来源、格式与内容是不同节点；正文里的 `principal_id` 不覆盖外层身份，正文里的 `tool_result` 不是权威工具回执。
- Full Encoding 与 Delta Encoding 必须调用同一内容 renderer，回放、缓存增量路径不能退回文本预览。
- JSON 被编码为模型可见文本是不可避免的序列化；与「把所有东西塞进一个自然语言 text 字段」不同，类型、字段路径和权威边界必须保留。

### 11.3 大对象与预算

原始消息持久化与当前可见投影分开。不能对 JSON 执行 `stringify(...).slice(...)` 后假装它仍是一条完整消息。

首版使用确定性的全量或资源引用策略：小消息完整编码；超过可见预算时保留消息身份、格式、原始大小、不可变资源引用，以及明确的 `complete: false`。已注册格式可以声明有界、必需可见的字段路径；未提供自定义编译代码。

需要缩减时记录可见 / 省略路径和投影原因，Agent 可通过授权读取按路径或范围取原文。generic 消息无法确定哪些字段更重要，不擅自宣称预览已完整表达请求。连格式规定的必需字段都放不下时，拒绝该输入或报告执行预算错误，不能静默丢失约束后继续执行。

引用必须指向不可变版本，不能只有会漂移的 URL 或本地路径。引用网站并不默认抓取网页；引用 PDF、图像或视频并不把原始二进制塞进 Context。

## 12. Attention 与生命周期

自定义消息沿用原有 Event / Observation / Mind 生命周期：

- 接受后原始消息不可变；修改提交新消息，并可显式引用被修正消息。
- 当前关联、选区或应用变化影响下一次输入；不会重写已接受消息或旧 Activation。
- Agent 用现有 Context transaction 将需要保留的认知沉淀到 Mind，并在允许时 retire Observation。
- retire 影响当前注意力投影，不删除历史，不改变已发出的工具调用，不丢失消息格式。
- 活跃执行和未交付根输入遵守既有保护规则；不能由客户端 `retire: true` 跳过。
- 格式定义和资源保留须覆盖依赖它们的历史与未完成执行；卸载应用不能让历史只剩无法定位的格式名。

首版不增加「客户端可以直接写任意 Context 分区」的接口，不允许第三方执行自己的 retire 脚本。将来如果需要持久领域状态，先判断它属于 Artifact、Harness 管理的 Mind，还是确实需要新的 Context 扩展，再单独提出设计。

## 13. 双向消息与交付

### 13.1 同一种消息抽象，不同的来源权限

输入和输出共享 `format + content` 抽象，但提交权限不同：

- 客户端提交的是客户端输入，不能通过正文中的 `role: assistant`、`status: completed` 或同名结果格式伪造 Runtime 交付。
- Agent 的普通文字回答通过同一个输出通道形成 `morphz.chat@1`。
- Agent 的类型化输出通过受控的 Runtime 交付能力产生；服务端填充 source、根输入、执行与因果信息。
- 工具完成与 Runtime 执行终态由工具 / 调度系统产生，不由模型输出的业务 JSON 认定。

参考实现拟新增 `deliver_message` 能力，允许 Agent 向当前 active Session 提交 `format + content`。它验证输出格式、数据及目的地，返回持久交付回执；普通文字回答隐式走相同发布管线，无需模型为了说一句话额外调用工具。

当前 `send_message` 用于向其他 Session 发送可见消息，且拒绝回复当前 active Session。实现时不悄悄改变这一边界：跨 Session 的类型化扩展仍沿用其原有权限与「不自动激活目标 Session」语义；新 `deliver_message` 只负责当前执行的输出。

### 13.2 输出约束如何确定

每次根输入固化本次允许与必须交付的格式。省略 `delivery` 时，默认允许标准 Chat 的 JSON 输出，无强制领域结果。客户端若能处理其他格式或要求特定类型结果，直接在当前请求中声明：

```json
{
  "delivery": {
    "accept_formats": [
      {"id": "morphz.chat", "version": "1", "encoding": "json"},
      {"id": "morphz.work.receipt", "version": "1", "encoding": "json"}
    ],
    "required_formats": [
      {"id": "morphz.work.receipt", "version": "1", "encoding": "json"}
    ]
  }
}
```

这是输入信封的可选顶层字段，不是业务内容中的暗示，也不依赖客户端先前登记的类型列表：

- `accept_formats` 表示本次请求允许交付的格式，不要求每项都产出；必须是非空的精确格式列表。省略时默认是标准 Chat JSON；若同时显式提供 `required_formats`，默认允许集合还包括这些所需格式。
- `required_formats` 默认空列表，表示本次成功交付必须满足的结果类型；若有多项，每项至少交付一条通过验证的消息，不是多个候选选其一。显式提供 `accept_formats` 时，所需集合必须是其子集，否则拒绝。
- Runtime 在接受之前验证声明的格式、编码、可选定义摘要和验证要求；不支持就拒绝，不能承诺以后临时安装或静默删除某项。首版领域输出须使用已注册格式；generic 输入不代表可以向客户端发送未声明的任意领域结果。
- 原始显式约束与有效默认值均记入请求记录，精确输出绑定和请求指纹按 10.3 保存。后来的能力发现、订阅或 UI 变化不重新解释该约定。
- `receive_formats` 是订阅呈现能力，`accept_formats` 是当前请求允许的交付，`required_formats` 是成功交付义务，三者不能互相替代。通用 JSON 检查器能显示某条消息，不代表该消息已满足所需领域结果。

强 Schema 要求通过可选 `delivery.require_schema: true` 明确提出，默认 false；该要求覆盖本次允许交付的格式，存在绑定为 `syntax_only` 时拒绝。标准 Chat / Work 的已注册 JSON Schema 按定义执行验证，不需要此开关才启用。

没有强类型要求时，可只回复普通聊天。存在要求时，聊天可以作为解释，但不能代替所需结果。接收方后来断线不取消已接受的工作：结果先持久化，再等待具有相应权限的客户端读取。

所需格式未交付时，不得把执行标为成功交付；执行失败、取消和交付校验错误仍可通过基础控制通道正常结束。存在物理成功但交付失败的情况时，应分别保留这两个事实，不重做物理操作来「补一份 JSON」。

### 13.3 事项创建的交付样本

```json
{
  "message_id": "message-output-02",
  "source": {"kind": "agent", "agent_id": "agent-a"},
  "session_id": "session-main",
  "in_reply_to": "message-input-02",
  "root_event_id": "event-input-02",
  "execution_id": "execution-02",
  "message": {
    "format": {"id": "morphz.work.receipt", "version": "1"},
    "content": {
      "encoding": "json",
      "value": {
        "operation": "task.created",
        "artifact": {"id": "task-02", "revision": 1},
        "evidence": {"tool_result_event_id": "tool-result-02"},
        "summary": "事项已记录，由你处理，尚未请求执行。"
      }
    }
  }
}
```

这是交付内容示意，外层持久事件还包含自己的 Event ID、顺序和时间。Work 适配必须验证引用的真实工具回执、对象及版本，才能展示「已创建」状态；Runtime 通用 Schema 校验只证明结构合法，不证明这个业务事实成立。

如果仅有一条模型生成的 `task.created` 数据，没有成功工具回执，客户端不得据此伪造真实事项。收到输出消息也不能自动执行外部发布等操作；有副作用的动作仍走执行工具与授权。

同一输入可产生多个消息：阶段性说明、对象回执、最终文字交付。每条消息独立持久化、具有稳定 ID，执行终态另行记录，不能把「一条消息提交成功」等同「整个任务成功」。

## 14. 流式、并发顺序与恢复

### 14.1 数据消息与控制事件分开

业务格式可以任意扩展，但以下 IO 控制事件由 Runtime 定义，所有 IO 1 客户端必须理解其外层：

| 事件 | 含义 | 是否是完整业务消息 |
| --- | --- | --- |
| `stream.opened` | 确认当前连接的有效订阅参数；重连会重新确认 | 否，仅为连接控制事件 |
| `input.accepted` | 输入已持久接收 | 不是业务完成通知 |
| `run.state` | 排队、运行、取消、失败、完成等权威执行状态 | 否 |
| `output.started` | 开始一个有稳定输出 ID 的交付草稿 | 否 |
| `output.delta` | 同一草稿的递增内容 | 否 |
| `output.committed` | 完整输出已验证并持久提交 | 是 |
| `output.aborted` | 草稿终止，不能当作完整结果 | 否 |
| `execution.event` | 允许客户端查看的工具调用、结果、审批等 | 否 |
| `stream.reset` | 增量窗口失效，需要读取快照恢复 | 否 |

控制事件不可被客户端上传或模型业务内容冒充；错误控制通道不依赖某个应用输出格式是否可用。

### 14.2 首版流式粒度

- 聊天文字：`text.append` Delta，携带 output ID、递增 `delta_seq` 和追加文本；服务端与客户端按序号去重，不能按到达次数追加。
- JSON：首版交付完整、验证后的结构化值；可以通过独立 `run.state` / 聊天进展体现处理过程。不把不完整 JSON 交给业务处理器。
- 通用树 Patch 不是首版必需能力。以后引入需独立协商路径语义、版本与快照恢复，不借用文本 Delta 猜测。
- 工具过程：实时发出已知调用、等待审批、运行及结果事件。部分参数仅作为未完成草稿显示，完整校验前不得作为可执行调用；敏感字段按现有权限脱敏。
- 协议不要求暴露模型内部推理；可见过程来自公开交付与执行系统事实。

`output.committed` 对一个 output ID 至多一次，内容以提交的完整消息为准。取消或错误先赢得终态时，迟到 Delta 和输出不能复活该草稿。取消不撤销已经发生的物理操作，已完成工具事实仍保留。

### 14.3 两种顺序都保留

1. **因果顺序**：每条回复关联根输入和执行，便于追踪「它在回应什么」。
2. **交付顺序**：已提交消息按服务端持久 Event 顺序展示，表示「用户什么时候收到结果」。

例如请求 A 在创建事项，随后请求 B 问进度，B 先答「仍在处理中」，A 最后交付「已创建」。消息列表应按 B 的回答、A 的最终回答排列，同时 A 的结果仍能追溯原输入；不因为 A 的输入更早就把完成结果塞回旧位置。

Event 顺序是权威排序键，时间戳用于展示，不依赖不同机器的本地时间比较。流式草稿可以临时占位，完成后进入交付序；客户端在用户阅读旧内容时避免强制跳滚。

### 14.4 断线重连

持久事件使用服务端不透明游标；客户端提交最后已确认游标。订阅与补历史之间要有高水位衔接，避免「刚查完历史，还没订阅」导致漏事件。

首版不承诺每个 token Delta 都永久持久化：

- 输入、完整交付、终态和必要执行事实必须可恢复。
- 活跃草稿有独立的缓冲序号与快照机制。
- 能补齐时按 output ID + Delta 序号重放；不能补齐时显式 `stream.reset`，返回当前草稿快照或已提交完整消息，不让客户端把残缺前缀当完整内容。
- 重连不重新提交输入、不重复触发工具、不改变输出格式绑定。
- 无权读取的事件不得进入历史或流；未知格式按当前订阅的 inspect / reject 策略处理，游标不会因此无限卡住。订阅策略仅影响呈现，不修改持久消息或原请求的交付义务。

HTTP SDK 与 WebSocket 适配应共享这些事件语义，而不是为每种传输维护不同的任务状态机。新增事件流的传输选型不修改现有 `/ws` 的兼容契约。

## 15. Dashboard、Desktop 与其他客户端的呈现

### 15.1 Dashboard

- 标准聊天仍显示用户实际输入和 Agent 回答，不显示一段伪装成用户正文的应用规则。
- Work 等已知格式可提供摘要视图，例如实际 `text`，并允许展开查看结构、来源、版本和关联对象。
- 未知领域格式的 JSON 用只读树 / 源数据检查器，明确标注格式。纯文本或资源使用对应的基础查看方式。未知领域格式不等于未知编码；未支持的编码按能力拒绝或历史元数据策略处理，不能假装已正确解析，更不能执行其内容。
- 权威身份、因果和执行状态来自信封与控制事件，不从业务字段猜测。

### 15.2 Desktop

- 输入框保持一个，底部关联与意图产生结构化字段，不附加提示词。
- 消息列表以交付顺序展示；运行中视觉标记绑定根输入，右侧执行过程读取同一执行事件流。
- 文档 / 事项等入口来自已验证对象回执和对象索引，不从模型自然语言中正则猜测「已创建」。
- 同一 Session 切换内容关联，只改变下一次消息快照。选择项目中的另一个 Session 才改变对话通道。
- 所有主要客户端都应能读基础聊天；缺少某认知应用 GUI 不等于不能访问对应 Session。可查看通用数据，但不宣称拥有该应用的完整交互能力。

GUI 是认知应用可选的平台能力，Format descriptor 不要求每个客户端承载 GUI。

## 16. 权限、安全与错误模型

### 16.1 不可突破的边界

1. 能力发现、格式声明、订阅配置和 Schema 不授予 Principal、Session、文件、浏览器、工具或执行 Target 权限。
2. 消息是外来输入，格式契约也有来源与信任等级；结构化不意味着能消除语义上的提示注入。
3. 结构隔离防止消息成为编译器指令；真实访问与副作用仍由 Runtime / 宿主权限检查约束，不能依赖模型「遵守字段说明」。
4. 资源读取不信任客户端 MIME、文件名、URL、Actant、workspace 等声明，按实际内容和授权检查。
5. JSON parser 在深度、节点数、字符串 / 数字大小、总字节和处理时间上有显式限制；不能先构造无限递归 AST 再检查。纯文本和资源另行遵守已声明的大小及读取限制。
6. 格式契约不包含密钥，资源内容不进入诊断日志；业务敏感消息、资源与请求绑定元数据沿用存储访问和保留政策。
7. 默认不加载远程 Schema、reader 扩展或自定义编码脚本；未知格式不会自动安装插件或执行 UI 内容。

### 16.2 失败要可区分

| 错误码（拟议） | 典型 HTTP 状态 | 客户端应如何处理 |
| --- | --- | --- |
| `unauthenticated` / `forbidden` | 401 / 403 | 重新认证或说明缺少授权，不换格式重试 |
| `unsupported_io_version` | 400 | 根据能力发现结果选择明确支持的版本，不把新结构发到旧 text 接口 |
| `unsupported_stream_version` | 422 | 用明确支持的版本重建订阅，不重发业务输入 |
| `invalid_delivery_contract` | 422 | 修正允许 / 必须交付集合等冲突，不隐式扩大接受范围 |
| `unsupported_format` / `unsupported_encoding` | 422 | 说明缺少能力；只有用户 / 应用明确允许时才选择另一格式 |
| `format_definition_mismatch` | 409 | 校验安装包和摘要，不采用同名替代品 |
| `invalid_content_syntax` | 422 | 显示格式与局部语法位置，不泄露整条私密输入 |
| `schema_validation_failed` / `schema_validation_unavailable` | 422 | 明确字段路径 / 验证能力，不宣称已接受 |
| `resource_unavailable` | 422 | 补齐或重新授权资源，不忽略附件 |
| `idempotency_conflict` | 409 | 不覆盖已有输入；确认这是新意图后才使用新 ID |
| `message_limit_exceeded` | 413 | 按声明限制改为资源 / 分段，不悄悄截断 |
| `projection_budget_exceeded` | 422 或执行错误事件 | 明确缺少完整处理所需预算，不丢约束继续执行 |
| `unsupported_activation_mode` | 422 | 不支持 observe 时明确失败 |
| `delivery_validation_failed` | 执行错误事件 | 保留真实工具效果，说明结构化交付失败，不能伪称业务回滚 |

同步拒绝发生在接受之前；接受后的失败通过原执行的错误 / 终态事件报告。不能对同一输入既返回「未接受」又在后台秘密执行。

## 17. 兼容与迁移

### 17.1 三种不同的兼容问题

| 对象 | 策略 |
| --- | --- |
| 标准文本 / 附件聊天能力 | 长期维护的一等格式，不是迁移负担 |
| 已有 text 中心的 SDK / HTTP 调用形状 | 保留便利接口，规范化为标准聊天，复用同一个核心管线 |
| 已持久化的旧 Event 和已发送提示词 | 保留原始历史，以读取适配兼容；不篡改过去的用户消息 |

因此，「这里确实需要兼容」针对的是第二、三行；不能由此把第一行也称为过时格式。

### 17.2 迁移顺序

1. Runtime 增加通用模型、能力发现、按条验证和读取适配；现有客户端仍可正常聊天，新接口也不依赖预先握手。
2. 标准聊天输入输出也通过该管线，不维护一套功能完整旧管线和一套功能不全新管线。
3. Dashboard 支持已知摘要和未知结构检查，再打开自定义格式的接入开关。
4. 安装 / 注册 Work 格式定义，整理对应 Harness / 工具契约与宿主权限绑定。
5. Desktop 在能力确认后发送 Work 结构化输入，移除每条消息中的规则前缀；按真实回执提供对象入口。
6. 端到端验证普通聊天、Work 和非 Work 的自定义 JSON 消息后，才宣称结构化消息链路已完成。

Desktop 对不支持 Work 的旧 Runtime 可以继续提供标准聊天；但必须明确说明结构化工作能力不可用。不得无提示地退回「拼一大段提示词」模式。

切换期间，已经接受或进入可靠 outbox 的旧请求保持原协议 / 原 ID / 原指纹，不中途把它改写成新格式重发。新输入从切换点使用新格式。历史兼容不要求删除或伪造旧消息。

### 17.3 存储与升级

- 优先扩展现有 Event payload、请求记录和根执行绑定；不另建与现有历史脱节的第二套 Session 数据库。
- 精确格式定义按内容摘要保留，可由历史读取定位；进程内 registry 只是缓存，不是唯一来源。
- 增加 IO schema / 数据库能力版本检查；旧二进制不能在新格式运行中盲目接管写入。必要时拒绝回退，或进入明确只读模式。
- 防护安装是独立、显式确认的存储迁移，普通启动与启用实验功能不会自动安装。只允许兼容且启用 IO 的连接写入；已连接的旧进程也受数据库约束。降级使用启用前备份，不通过删除防护兼容旧写入。具体命令、权限边界与版本覆盖见实施记录。
- SQLite 与 PostgreSQL 都必须覆盖新请求指纹、事务与恢复测试；不能只验证本机 SQLite 就宣称多后端完成。
- 默认与显式选项、旧指纹兼容需独立测试，避免升级后相同重试变冲突或相异请求被误认为相同。

## 18. 实施工作包

这是一项纵向协议改造，不是只增加 Desktop JSON 字段。建议按下列依赖顺序推进，每包都留下可自动验证的契约。

| 工作包 | 交付内容 | 完成判据 |
| --- | --- | --- |
| A. 数据与能力约定 | Envelope、类型化 JSON 值、标准聊天、资源引用、能力发现、请求 / 订阅约束 | 不预登记也可提交合法消息；响应 / 流式约定明确；不支持项拒绝；不改 Session |
| B. 可靠接收 | Event、请求指纹、根绑定、权限、资源与恢复 | 超时 / 重启 / 并发重试只产生一个有效根输入 |
| C. Context | 类型化 Observation、定义引用、Full / Delta、预算和 recall | 模型可见的是保真结构；无提示词前缀、无源文本拼接、无静默截断 |
| D. 交付 | 普通回答统一发布、typed delivery、因果、执行事件和流式恢复 | 文本实时追加、结构结果验证后提交、结果按交付序可恢复 |
| E. 客户端迁移 | Dashboard 检查器、Desktop Work 格式、对象回执入口 | 同一 Session 可聊天、安排事项、查看真实产物，且没有规则伪装成用户发言 |

修改位置包括 SDK / HTTP、Runtime、Event admission、SQLite / PostgreSQL 接收、Context renderer、输出工具与发布服务、Dashboard，以及独立 Desktop 仓库的 Runtime 适配。所有改动应采用窄范围提交，不混入其他开发和发布工作。

首版不实现原生 S-Expr 消息输入 / 输出及其 parser、Schema、转换器、增量解析或专用 UI；S-Expr 只保留为未来可评估的外部编码候选，内部 Context Encoding 不受影响。通用树 Patch、任意二进制解码、观察型输入 `observe` 和私有 Context 区域也不属于首版范围。这些不影响 JSON 结构化 IO 形成完整闭环；能力字段必须如实报告未支持。

## 19. 验收矩阵

| 场景 | 必须验证的结果 |
| --- | --- |
| 现有 text 调用、不显式握手 | 正常发送 / 流式回答；内部归一为标准聊天 |
| 新接口直接发送 | 未调用能力发现、未预登记类型也能接受合法请求；仍执行全部格式、权限和资源检查 |
| 标准聊天加附件 / 仅附件 | 资源授权、完整性、读取和回执保持有效；无静默丢弃 |
| 自定义 JSON，无注册包 | 显式 generic 请求按 Runtime 政策接受，保留结构与来源，回执明确没有领域 Schema 验证 |
| generic 不绕过校验 | 不允许用 generic 跳过已注册 Schema；registered 格式缺失时拒绝，不静默降级 |
| 注册 Work 输入 | Schema 拒绝非法内容；用户正文不含应用规则前缀 |
| 未支持编码 | `sexpr` 等未支持编码在消息、响应要求和订阅中明确拒绝，不静默转为另一种格式 |
| 数据 / 指令隔离 | JSON 字段、字符串及纯文本中的 `context_tx`、Kernel 等同名内容不会成为 Context 编译指令或自动执行；深层 / 超大输入安全拒绝 |
| 非法 JSON | 重复键、非法 Unicode、非标准数值拒绝；大数不会静默舍入 |
| 多客户端同 Session | 各自能力不同不相互覆盖；未知领域格式的 JSON 进入检查或元数据策略，未支持编码不冒充已解析内容 |
| 响应约束与订阅分离 | accept 不等于 required；改变 receive / inspect 策略不修改已接受请求的输出义务 |
| 不兼容交付约束 | required 不是显式 accept 的子集、所需格式不可用或强 Schema 不可满足时，在接受前拒绝且不执行 |
| 多格式同 Session | Chat、Work 与第三方自定义 JSON 格式可以共存；新增第三方格式无需向 Runtime 添加业务分支 |
| 格式版本并存 / 升级 | 旧输入仍用旧绑定回放；同版本不同摘要拒绝 |
| 重复提交与重启 | 相同 ID 返回相同输入；不同内容冲突；持久调度意图可恢复 |
| 能力变化与旧绑定 | 刷新能力发现、修改格式 registry、重建订阅不重新绑定旧请求；无法恢复时明确失败，不换格式重做 |
| 切换页面、关联或模型 | 只影响下一次显式输入，不修改运行中 Thread 或根消息 |
| Principal 伪造 / scope 越权 | 正文不能冒充身份；宿主工具拒绝未授权对象和执行 |
| 大对象投影 | 无字符串截断伪装完整结构；省略可见、原文可授权读取 |
| Full / Delta / 回放 | 相同 Observation 内容和类型；差异只在允许的投影元数据 |
| typed output | Schema 与实际工具回执分别验证；自然语言「已创建」不能伪造对象 |
| 慢任务 A、快问答 B | B 先交付，A 后交付；时间线与因果关联同时正确 |
| 流断开 / 重放 / reset | 不重复追加、不漏完整结果、不二次执行；残缺草稿不成为完成消息 |
| 取消与迟到 Delta 竞争 | 终态唯一，草稿不复活；已经发生的物理效果仍可追溯 |
| 旧 Desktop / 新 Runtime | 标准聊天持续可用 |
| 新 Desktop / 旧 Runtime | 明示缺少 Work 能力，不退回重复提示词方案 |
| SQLite / PostgreSQL | 都通过接收、指纹、事务和恢复测试；证据分别记录 |

必须增加至少一个真正使用自定义字段的非 Work 测试格式，证明协议不是把 Desktop 的字段换了个地方硬编码。

最终人工 / 实机验收：在同一 Session 先普通问答，再用 Work 输入创建一份文档和一个仅记录、不执行的事项，再发送非 Work 的自定义 JSON 消息；查看 Dashboard 原始消息与模型实际 Context Encoding，确认身份、结构、格式绑定、工具回执和 Desktop 对象入口一致。特别检查外部 JSON 的类型与字段经过内部 S-Expr 编码后仍然保留，不退回拼接提示词。模拟断线重连，确认不会重复创建对象。

「类型和单元测试通过」「结构化 Context 已验证」「真实工具链完成」「客户端体验已验收」须分别记录，不互相代替。

## 20. 决策清单与非目标

本提案已经确定、后续实现应遵循的边界：

- Session 是通用 IO；标准聊天和自定义消息并列。
- 首版外部自定义结构化消息统一使用 JSON；HTTP 信封统一，文本 / 附件仍是一等能力。内部 Context Encoding 继续使用 S-Expr，不据此增加外部 S-Expr 协议。
- 不设置发送类型预登记或独立的有期限协商对象；能力发现可选，消息逐条验证。精确输入 / 输出契约绑定根请求，订阅参数只约束当前连接的呈现，不绑定整个 Session。
- Runtime 提供通用数据编码，不允许客户端注入编译器程序或任意 Context 分区写入。
- 原始历史不可变，attention 沿用已有机制；GUI 是可选能力。
- 输入 acceptance、工具物理成功、输出验证、消息交付、执行结束是不同事实。
- 第一阶段覆盖完整输入到交付链路，不以重复提示词作为静默兼容后门。

实现前仍需在对应代码变更中固化的工程细节：JSON Schema 支持关键字集合、实际资源与 parser 预算默认值、游标 / 草稿快照存储结构、数据库迁移版本，以及 SDK 类型的最终命名。这些必须有测试和能力声明，但不需要再次争论 Session 的产品定位。

如果未来开放更强的 Context 扩展，需另行说明所有权、事务、权限、回放、retire、预算和版本治理，不从本次格式注册接口偷偷演变出第二套 Context 系统。

## 21. 相关设计与标准边界

- [Context-Owned Session Service](./morphz_session_service_v1.md)：Session / Context 所有权及既有接口。
- [Session / Thread 模型](./morphz_session_thread_model_v1.md)：根输入、线程与执行因果。
- [Session 投影范围](./morphz_session_projection_scope_v1.md)：认知共享与可见性。
- [Structured Context Constitution](./standards/structured_context_constitution_v1.md)：认知、事实、权限与历史边界。
- [Structured Context Specification](./standards/morphz_structured_context_specification_v1.md)：对象模型与扩展规则；不能把本文的拟议线协议当作已经发布的标准格式。
- [Harness Specification](./standards/morphz_harness_specification_v0_1.md)：Primary Harness、精确绑定与执行边界。
- [Yao Core Language](./standards/yao_core_language_specification_v0_1.md)：程序语言语义；消息数据不因包含 Yao 源文而自动成为可执行 Program。
- [MEP 治理流程](./meps/MEP-0001-specification-governance.md)：后续标准化的决策与发布边界。
