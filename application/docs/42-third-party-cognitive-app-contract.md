# 第三方认知应用接入契约

日期：2026-10-05。状态：纯声明／wire 校验及 v11 双后端迁移已验证；网关尚未接通。
这是 Morphz Application 的实验接入版本，不是 Runtime 或 HNS 的新标准。
文档存在不表示独立 SDK、服务网关或跨宿主闭环已经交付；实际完成项见
[实施记录](./13-implementation-status.md)。

第三方应用提供自己拥有的业务能力和原件，Morphz 负责让 Human 与 Agent
以相同权限调用这些能力，并可选地承载作者的界面。接入不要求作者使用
Morphz 数据库、React、Yao、Runtime 或特定云服务。首轮以作者自行运行的
独立 Service 验证真实链路，不把作者代码加载进 Host。

## 职责与接入范围

| 参与方 | 拥有的事实与职责 | 不因此获得的能力 |
| --- | --- | --- |
| 作者 Service | 领域对象、精确版本、业务规则、自身 ACL、事务与回执、备份 | Platform SQL、Runtime token、其他应用原件或用户未发送草稿 |
| Morphz Platform | 项目、本人授权、安装版本、连接关系、命令来源、同一内容目录 | 第三方正文的写权威或第三方数据库的备份责任 |
| Application Host | 真实身份验证、受权服务网关、私有连接解析、参数与结果校验 | 改写原输入、代替作者领域规则、执行任意作者 JS |
| Runtime | Agent 认知、原输入及 Thread 来源、既有工具／Harness 执行 | 第三方服务自身的账户凭据或界面渲染职责 |
| Client 和可选 GUI | 呈现、导航、小型视图状态、明确用户操作 | 自报调用身份、绕过 Host 授权、将正文放进窗口状态 |

工作台是管理与浏览入口，Dock／Launcher 是同一授权目录的快捷入口。
无 GUI 应用可在工作台管理，并从聊天发现能力；不捏造一个空窗口或要求先
打开界面才能调用。关闭 GUI 不撤销安装、不停止原 Runtime 工作；停用连接
也不删除作者原件。

首轮不建设应用市场、自动下载／启动作者后端、个人 SaaS OAuth、第三方私库
托管、Node relay、任意网络 iframe 或新的执行器。现有 `routeKind=node`
只是路由关系，不能作为第三方领域 API 已经沿执行节点转发的证据。

## 现有基础与需要补齐的边界

当前界面包 `morphz-app/v1` 的 `ui` 必填，能经 immutable Store 引用安装
HTML，并使用 opaque-origin iframe、CSP、source/channel 检查。它不是无界面
业务应用定义；旧 `morphz-work-app/v1` 的 HTML 与消息前缀继续原样读取。

当前操作目录有 `operations/list`、`describe`、`invoke`，但注册源是内置处理器，
结果 Schema 尚未形成第三方版本契约。当前输入的应用激活也只解析四个内置
manifest。`content_entries` 已有应用／实例／原件／opaque 版本引用，不能为
第三方另造一套 Artifact 正文或把版本字符串转成数字。

已有 Renderer 包权限检查不能代替服务端校验真实 view、包版本及操作。
新的调用必须在 Host 再次绑定这些事实。第三方不取得内部 builtin adapter、
WorkspaceClient、React controller 或 native port。

现有 `app_installations` 是租户内应用唯一记录，没有本人授权字段；
`app_instances` 的 active 检查也不等于安装与本人连接同意检查。
`command_receipts` 只保存已提交回执，不能描述尚未发出或结果未知的调用。
下面的补口扩展同一 Platform 权威，不再造一个 Renderer store 或独立目录。

## 不可变应用声明

新定义使用 `morphz-cognitive-app/v1`，与旧 UI-only v1 分开解析。一个
`appId + version` 对应一份不可变定义；相同版本不同内容必须拒绝，修订使用
新版本。安装方接受定义的实际 SHA-256，不以作者自报 digest 代替计算。

```json
{
  "format": "morphz-cognitive-app/v1",
  "id": "example.notes",
  "version": "1.0.0",
  "title": "笔记",
  "description": "创建、修订并读取项目中的笔记原件。",
  "icon": "document",
  "protocol": "morphz-domain/v1",
  "harness": null,
  "ui": null,
  "operations": [
    {
      "id": "notes.create",
      "title": "创建笔记",
      "description": "在本次获权项目保存新笔记，返回真实原件和版本。",
      "effect": "write",
      "scope": "project",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "minLength": 1, "maxLength": 180 },
          "markdown": { "type": "string", "maxLength": 30000 }
        },
        "required": ["title", "markdown"],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "objectId": { "type": "string", "minLength": 1, "maxLength": 200 },
          "versionRef": { "type": "string", "minLength": 1, "maxLength": 200 }
        },
        "required": ["objectId", "versionRef"],
        "additionalProperties": false
      }
    }
  ]
}
```

`icon` 与可选 PNG `iconImage` 沿用已有语义和作者图像边界，不要求第三方
重画一份 Host 专用小图。颜色不是执行权限或状态的唯一表达。
`ui` 为 null 时完全不安装可执行 HTML；有 GUI 时只包含本 app 的精确
`packageVersion + sha256` 引用，复用 UI Store 与既有沙箱。首轮要求
packageVersion 等于应用 version，界面修订也使用新应用版本，避免一个旧
窗口暗中选择新的领域声明。独立 UI／领域版本映射留到后续契约，不在本轮
制造浮动解析；安装与打开都固定确切字节。

`harness` 为 null 时普通领域调用照常可用；有值时固定 `id + version`，由
Runtime 检查已经加载的精确版本，不自动安装执行包、不改绑已接受输入。
其身份／内容核验继续既有 Runtime 契约，不能借声明替换为默认聊天冒称执行。
普通领域操作不以加载 Harness 为前置；只有应用认知模式的输入激活才检查
和固定 Harness。纯类型中的版本是精确字符串，Host 不解析版本范围或浮动
alias，直接核 Runtime 注册身份和真实 `.hns` artifact_hash。

操作声明是调用与发现的唯一版本源，不接受运行中服务返回一份可扩权的动态
Schema。`effect` 是 read、write 或 execute；副作用与实际结果说明由作者
明确提供。`scope=project` 允许在真实获权项目创建或查询；`scope=objects`
要求显式原件／基线版本引用，Host 逐一校验目录权限，Service 复核领域归属。
参数中的同名 principal、project 或 object 字段不覆盖 Host 授权上下文。

输入与结果使用 [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-validation)
的有限子集：string 的 Unicode 码点长度、number／integer 的范围、boolean、
null、与类型匹配的 enum、array 的 items
和长度、object 的 properties／required／`additionalProperties:false`。
可含 title／description，根部 `$schema` 只能为 2020-12 URI。首轮拒绝 `$ref`、
pattern、组合与未支持关键字，不静默忽略约束或访问远程 Schema。
第一份 JavaScript 校验实现仅接受有限数值，不提供任意精度数字解析；需要
精确大整数／小数的领域应声明字符串并由作者校验，不冒称完整方言支持。
应用与 GUI 版本为最多 100 字符的精确数字三段字符串；Harness 的精确
版本沿用 Runtime 的原样字符串契约，不套应用版本语法。

以下是防止资源滥用的初始工程预算，不是审美或性能承诺：定义总 UTF-8
256 KiB、128 个不同操作；单 Schema 16 KiB、根为 1 的最大深度 16、整棵
Schema 累计属性 128、每份 enum 128；单次原件引用 32 个，id／opaque
版本各 200 字符。协议包须明确检查
JSON 值、循环、字节与深度，不能仅凭 TypeScript 类型或字符串长度称已验证。
实际参数／结果另限序列化 JSON 256 KiB、数据深度 32、累计 JSON 节点
16,384；这也是初始安全预算，不是无限大对象可用的性能承诺。
需要扩展 Schema 时提升契约与测试，不让现有作者获得一组未实现的关键词。

## 作者 Service 接口

Host 只调用本人接入与 Host egress policy 共同批准的固定连接。
以下路径相对于该连接的协议基址，不来自 manifest、模型参数或 iframe。
协议使用 JSON；作者可以用任意语言实现，不必使用 SDK。

| 固定接口 | 请求的关键事实 | 响应与条件 |
| --- | --- | --- |
| `POST /describe` | 协议、待核 app/version/definitionHash | 稳定 serviceId／dataAuthorityId 与确实支持的精确声明；不修改 Schema |
| `POST /invoke` | Host delegation、operationId、parameters、resources；有副作用时 commandId/requestHash | read 的结果，或已持久提交回执；execute 必须区分工作受理与真实效果完成 |
| `POST /objects/read` | delegation、objectId、精确 versionRef、有界读取参数 | 同一原件、同一版本的结构化正文；仅产出原件引用的应用必须支持 |
| `POST /receipts/read` | 既有命令的 commandId/requestHash、原实例和声明 | committed/rejected/unknown；仅有副作用的应用必须支持，不重新执行业务 |

服务身份描述不等于网络认证。服务自身的持久数据身份在库被清空／替换后
必须不同；相同对象 id 不足以认定还是原实例。路由迁移核验仍是同一
dataAuthorityId，改为另一数据保存方时创建新实例，不能夺取旧目录身份。

Host delegation 由真实登录或 Runtime 持久来源生成，固定 issuer、tenant、
实际 principal／actant、Human 发起来源、app/version/definitionHash、instance、
operation、实际 project、获权 resources、命令身份及接收期限。它是经受认证
连接传递的有限调用声明，不是可用来调用 Morphz 的 token。Human／Agent
使用同一领域接口；Agent 不模拟点击，也不从模型读取身份。

作者验证连接、支持的定义、真实账户映射、项目／原件 ACL、基线版本和
接收期限。`resources` 为显式 `{objectId, versionRef}` 数组，objects scope
不能为空，project scope 可为空；v1 同次 resources 的 objectId 唯一，不能
为同一原件列多个基线版本。引用属于固定 instance 和本次 effective
project，read 操作检查读权，write／execute 检查对应写权与基线版本。
首轮同次 resources 不混用只读依赖与写目标：需要只读材料时先走受权读取，
不把可读目录当作可写许可。未声明资源不因藏在 parameters 中获得授权。
opaque 原件与版本字符串原样保留，不 trim、转数字或限制为内部 UUID；
Host 目录入口使用专门的有界 app object 校验，tenant／Runtime 等内部身份
继续自己的严格校验。
过期是接收新请求的截止时间，不是假定在途事务已经回滚的证据。

有副作用请求的稳定 requestHash 覆盖协议、精确定义、稳定数据实例、真实
来源与项目、operation、参数和 resources；按键排序规范化 JSON、数组保持
原顺序。credentials、expiry、诊断状态和每次 transport nonce 不参与业务
hash；这些是 Host 私有传输事实，不意味着公共 wire 接受 nonce 或 credential
字段。GUI 重试复用原 commandId；Agent 从实际工具 job/call 身份派生命令，
不因模型重新措辞生成第二份“重试”。

作者在自己的事务中原子提交业务变更及 commandId/requestHash 回执；同 id
不同 hash 冲突，同 id 同 hash 返回原回执。回执含绑定的 authority、定义、
命令身份、真实 result、committedAt 与已产生的原件摘要。
数据库中登记“外部任务受理”并不证明邮件已发送或外部效果已经完成，也
不能凭作者 progress 字符串伪造一个 Runtime 子 Thread。

正文留在作者服务。精确读取不得悄悄返回最新版本；版本不存在须报错。
首轮普通内容读取支持有界 JSON、Markdown 或 text，并使用已有安全呈现。
响应中的 URL 不自动下载／打开，富媒体传输需要额外明确契约，不以 HTML
字符串绕过 iframe CSP。已知原件的变更提示可后续扩展；首轮不要求作者先
实现全量同步、外部写扫描或第二套权限目录。

## 连接安全与本人授权

生产连接使用 HTTPS 并校验真实服务身份。作者签发仅供该集成连接使用的
credential，Host 从私有配置 resolver 获取；不转发 Platform 单次 credential、
Runtime token、登录 cookie 或 CSRF。当前没有通用加密 Vault，首轮使用
仅当前用户可读的 Host 配置与环境凭据引用，不称其为已实现密钥保险库。
SQL 只保存 opaque `hostBindingId`，不保存 URL、文件路径、环境变量名或
secret locator；这些由 Host 私有配置解析。公开目录、模型、iframe、错误
与诊断导出不含凭据、私有配置或这个 Host alias。

共享 Web Host 的应用接入还须满足操作者批准的 egress policy；普通页面
不能临时指向本机／内网管理服务。禁止 URL userinfo、fragment、查询凭据、
非 HTTPS 协议和跨目标重定向。远端拒绝私网、loopback、link-local、metadata
及等价 IPv4／IPv6 地址；DNS 校验必须约束实际连接，不能先解析再普通 fetch
留下重绑定窗口。响应、超时、并发和解压预算在 Host 有界。

本机独立 sample 可以明确批准 numeric loopback HTTP 固定端口，仅作为
本机真实链路证据；它不是生产网络认证验收，也不让 manifest 自行开启内网
例外。多 Host 使用同一服务绑定时，各自缺少对应私有配置就明确不可用，
不回退到另一个人的凭据或 Host 本地“相似应用”。

安装声明、本人使用许可、连接使用权与项目原件权限分别核验。B 加入项目
不等于可借用 A 的个人 SaaS 账号。首轮是作者授予 Host 的集成连接，并由
Service 检查每次真实 actor；本人接入关系不自动成为全租户共享账户。
本人同意精确版本的完整声明集合；首轮不增加逐操作勾选管理，但每次调用
仍检查操作属于已同意声明。Agent 可以使用已有授权，不能安装代码或凭据。

## 统一入口与可选界面

在已有共享 Application handler 中增加 Human 接入／停用管理与领域调用；
Desktop 嵌入调用，Web 经 HTTP 调用，Agent 经现有真实来源工具适配调用。
不存在另一套仅按钮可用的第三方执行器或一个绕过授权的直连浏览器 SDK。

操作发现继续已有 list／describe／invoke 语义，返回确切 app、version、
definitionHash、instance、operationId、Schema、效果与真实不可用原因。
五个身份共同定位操作，不以孤立 operationId 猜版本或保存方。
注册源是已获权版本，不把所有
Schema 常驻模型输入。调用固定同一 gateway，经身份、安装、本人许可、
当前项目／对象、连接与版本检查，分别验证输入和实际结果。

GUI SDK 仅提供绑定当前 view 的 ready、operations、object exact read、
导航状态与 compose；不接受作者传入 Host identity、endpoint 或 credentials。
消息桥保留 source／opaque origin／channel，并由后端核 view owner、当前
包与精确定义、许可、operation 和请求身份。迟到请求不换到新用户／新窗口。
compose 只准备输入，打开／关闭／安装都不发送消息或启动任务。

作者 SDK 分成无 Node／Host 依赖的协议和校验、可选 browser bridge、可选
Service adapter。示例通过打包后的公开导出接入，自己的数据库与进程独立，
不能 import Host 内部模块、复制 builtin handler，或把手写 postMessage
便笺称为 Agent 业务闭环。SDK 不拥有作者事务或替作者决定备份责任。

## Platform 生产数据模型

复用 `app_installations`、`app_instances`、`app_view_instances` 与
`content_entries`。UI-only 安装和 Service 接入同一 app 必须复用既有
installationId；规范化创建入口，不能两边各生成一个互相冲突的安装 ID。
新增以下关系，均由 Platform 拥有并走相同 SQLite／PostgreSQL 事务接口。

| 关系 | 身份及字段 | 约束与主要查询 |
| --- | --- | --- |
| `cognitive_app_versions` | tenant/app/version、definitionHash、bounded canonical definition、installedBy、installedAt | PK tenant/app/version；FK 同一 installation；内容不可变；查精确定义与安装版本 |
| `cognitive_app_grants` | tenant/principal/app/version、state、revision、consentedAt、updatedAt | PK tenant/principal/app/version；FK 精确定义；CAS active/disabled；本人许可查询，不替代项目成员 |
| `cognitive_app_authorities` | tenant/app/instance、serviceId、dataAuthorityId | FK 已有数据实例；唯一 tenant/app/serviceId/dataAuthorityId；绑定真实保存方，不保存地址与凭据 |
| `cognitive_app_connections` | tenant/connectionId、ownerPrincipal、app/instance、serviceId/dataAuthorityId、opaque hostBindingId、state/revision、createdAt/updatedAt | FK 同一 app/instance；本人绑定与固定保存方；CAS 接入／许可；Host alias 不含凭据位置，公开 catalog 排除 |
| `cognitive_app_view_bindings` | tenant/viewId、ownerPrincipal、app/version、instance、connectionId、revision | FK 真实 view、精确定义与本人连接；同版 GUI 不猜保存方；CAS 选择与后端迟到守门 |
| `cognitive_app_commands` | tenant/commandId、app/version/hash、instance/dataAuthority、connection/revision、grant/revision、真实 actor/source、project、operation、requestHash、bounded resources、state、receiptHash/ref、有界原件回执摘要、目录状态、createdAt/updatedAt | PK tenant/commandId；FK 精确定义、连接、实例、项目；只为副作用调用持久 admission；查询命令、input/source 与待核结果 |

一个 tenant/app/serviceId/dataAuthorityId 对应唯一数据实例；多个 Human
接同一原件库复用该 instance，分别保留本人连接，不复制内容目录。
第三方 Service 的 `app_instances.route_ref` 是稳定 authority 引用，不是
某个人的 URL 或连接 alias；物理接入从本人 connection 解析。内置路由不改。
command 的复合 FK 确保 connection、grant、app/version、instance 与来源
关系一致；grant／connection 的 mutable revision 是 admission 快照，不能
外键指向当前 revision 后随授权变化破坏旧命令证据。

view binding 固定当前领域定义和连接；选择另一个数据实例使用 CAS，并
原子清空或核验旧原件导航、退休旧 frame channel。旧迟到 compose／请求
不能带入新实例，已经 admitted 的工作仍固定原目标。沿用现有每本人／项目／
应用／版本的窗口语义，不用 view id 充当领域实例。

旧 UI-only 读取仍仅限其 installedBy，本人的领域 grant 不自动解锁他人的
历史 HTML。新的 cognitive UI 必须从已同意定义的精确 Store 引用读取，
通过独立的本人 grant 字节 gate；不放宽既有 UiPackageService.read 来
共享旧私有包。安装新的定义显式核验界面来源和 SHA，不凭引用猜字节。

definition 是一份有界不可变声明，不是全工作空间 JSON。关系不保存作者
正文、未发送草稿、任意业务数据库快照或凭据。command 不保留原业务参数副本；
有原调用字节的正常重试可核 hash，没有参数的恢复只查询旧回执，不补造参数。

command 区分 admitted（尚未宣称已发出）、dispatching、unknown、
committed、rejected、cancelled 与独立目录状态。首次网络发送前持久标记，
崩溃窗口仍可能无法断言是否已送达；恢复保守视为 unknown。取消仅在确知
未发送时成立。已提交不是目录已补齐，目录补齐也不是整个 Agent 任务完成。
admitted→dispatching 的 fence 与当前 grant／connection revision 校验在
同一事务；dispatching 只表示可能发出，不宣称已送达。网络等待不保持 SQL
事务锁。已核回执的原件摘要只保留 object/version、kind、
title、commit 身份与时间等目录事实，不复制业务 result／正文；补偿可使用
该受认证、已核的持久摘要，不能以 caller 自报 receiptId 当作证据。
项目归档／删除的工作检查纳入尚未确定结果的相关副作用命令，不把断网
改为 cancelled 来绕过原活动保护。

原件摘要只登记到现有 `content_entries`，目录唯一键仍是 tenant/instance/object。
Service 响应中的 actor／project 不成为授权；Host 使用既有 admission 与
原件回执核验。对象已经属于另一个项目时不能用新回执偷偷搬动。move、关联、
删除继续对应明确平台／领域操作；停用不会级联删除原件、目录、Session 或
命令证据。依赖只有 committed receipt，不能从回复文字推测交付链接。

主索引按真实读取建设：grant 的 principal/state/app/version；connection 的
owner/state/app/instance；command 的 source、state/updatedAt/commandId。
Tenant 全部纳入身份和唯一约束。JSON 的字节／深度在应用层校验，SQL 提供
有界字段、枚举、FK、revision 和 uniqueness，不依赖某后端专有 JSON 行为。

本契约设计基线为 Platform schema v10，当前已验证 v11。新关系通过 v10→v11 迁移，同时更新权威 DDL
和生成 schema；冻结真实旧 v10 的 DDL/hash，v9→v10 先写旧 hash 再继续
v11，不能让旧迁移误用新的当前 hash。旧库测试 fixture 使用准确旧基线，
不得从新 DDL 仅减去头像字段而把新关系混进旧库。
新关系只增加真实接入事实，既有内置实例、原件和 UI 包不重建、不
重签、不重命名。迁移自身事务化、schema hash 严格校验，SQLite／PostgreSQL
均做旧库升级、约束、幂等、CAS、并发与重启测试；不只修改 fresh-create SQL。
备份只保证 Morphz 自有关系，第三方正文仍由作者备份。

## 实现分层与已有入口

Platform 内部分为 registry（版本、本人许可、保存方、连接、窗口绑定）与
commands（副作用受理、发送 fence、未知结果、回执投影、退休保护）两项
职责；Store 保留薄入口，复用单一 backend／事务／策略，不自开第二连接，
不把 SQL Query 暴露给作者 SDK 或 Renderer。不是按文件行数重写整个 Store。

Host 的 CognitiveAppGateway 负责固定连接、网络安全、实际 wire 校验和
回执核验，只通过 Platform typed port 调用上述职责；由共享应用 Host 与
已有 Human／Runtime authority 组装。真实身份解析在 SQL 事务之前完成，
避免 Runtime verifier 再读取 Platform 时嵌套进入 SQLite 写门；事务内使用
已解析身份与同一个 q-aware policy。原调用、GUI 和 Agent 仍共用这一入口。

Scheduled task-run 即使带 sourceInputId，也仍是 task-run；来源分类须依
持久 task-run evidence／resolved actor，不能仅按 inputId 是否为空猜测。
第三方原件核验组合进已有 Host verifier，不替换内置核验，更不能一律放行。
现有 active-instance 新业务写规则保持，停用后的目录补齐只允许确切持久
admission 和已核 committed 摘要，不给予通用恢复写权。

## 超时撤销升级与恢复

| 状态或变化 | 行为 |
| --- | --- |
| 副作用尚未发出 | 当前授权失效就拒绝／取消，不发送 |
| 请求已经发出而响应丢失 | 标为结果未知；超时、关闭 GUI、断网都不证明回滚 |
| 回执查到 committed | 核原实例、精确定义、id/hash、对象与来源，补同一目录，不重新执行 |
| 回执 not_seen 或读取失败 | 仍可能有旧请求在途；保持未知，不换 ID、版本或实例补做 |
| 停用本人 grant | 禁止该版本新的 admission／dispatch；在途响应仍可留下真实结果 |
| 撤销连接 | 不再发新调用或回执查询；未知结果保留；本人重接原保存方后才能核验 |
| 安装新版本 | 重新同意其声明；不改绑旧输入、在途命令、旧 UI 或已固定引用 |
| 路由迁移 | 本人同意和 revision CAS，核验仍是同一 service/data authority；旧回执不改身份 |
| 原件库被替换 | 新 data authority、新实例；不能把旧目录指向空库／新对象 |

现有 `recordCommittedContent` 仍要求 active instance，新的恢复必须专门允许
已持久 admission 的确切 committed 回执投影，不放宽停用后的新业务写。
新安装不自动停用旧 grant，旧输入只解析其原版本；本人显式停用后，仍可在
未撤销连接上核验既有命令的回执，不能因此再执行写入。恢复 delegation 来自
旧 admission 的真实来源与专用恢复目的，不伪装成当前 Human 的新业务调用。
receipt-read 统一 committed／rejected／unknown；not_seen 是 unknown 的
原因。rejected 必须是权威证明此命令没有提交，HTTP 403、异常、输出 Schema
失败都不能直接当作 rejected；committedAt 只出现在 committed。受认证响应
若已完整符合协议及原 admission 的 committed 绑定，另行业务 output Schema
失败仍保留已提交事实，并显式报告数据契约错误；不降为 unknown 或补做写入。
认证、绑定或协议回执本身不成立时则不能据其宣称 committed，保留未知。
后台核验有界、失败不阻塞整个 Host 启动，也不为每个页面加入定时轮询。
使用启动／接入完成／真实回执／显式重试触发；没有状态变化时保持安静。

## 分阶段提交与验收

1. 契约与校验。复核职责、数据模型、作者声明与严格 wire 校验；不称服务已接通。
2. 受权网关与双后端关系。共享 Human／Agent 来源、版本、连接、admission、
   回执及同一目录；真实独立 headless Service 先通过。
3. 可选 GUI 与薄 SDK。作者安装包、沙箱后端 gate、精确对象打开和纯聊天
   交付共用网关，原 UI／草稿／Session／执行保持。
4. 独立示例与跨宿主验证。作者包可单独构建／打包；另进程自管数据库；
   Desktop embedded、Web HTTP、实际 Agent 调用与原 App 分别留证。

每阶段验证后做聚焦本地提交，不自动推送、发布包、接通真实第三方账号或
改业务资料。必测 headless 发现／创建／修订／精确读／真实回执／目录与交付、
GUI 同一操作、权限撤销、伪造来源、跨对象、Schema 失败、重放／重启、响应
丢失、同 id 异 hash、升级／路由冲突、服务离线与安装不执行。
实际 provider／模型、Runtime、浏览器、原 App 与 SQLite／PostgreSQL
证据分开报告，不能以 mock 或源码目录存在代替整个生态闭环。

## 决策依据

本方案延续[认知应用业务对等](./29-agent-operable-cognitive-applications.md)、
[唯一存储权威](./35-application-storage-model.md)、
[共享应用宿主](./24-shared-application-host.md)和
[前端架构的第三方边界](./41-frontend-architecture.md)。接口与预算是本轮
工程决定，不是外部平台强制值。当前源码审计对应
`core/src/applications.ts`、`application/src/application-operations.ts`、
`application/src/ui-package-service.ts`、`application/src/runtime-platform-authority.ts`
及 `platform/src/store.ts`，上述目录均位于 `application/packages/`。
