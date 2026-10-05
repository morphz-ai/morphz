# 认知应用原件的输入来源

## 范围与权威 owner

本文补充 `42-third-party-cognitive-app-contract.md`，说明精确原件引用和显式应用上下文如何贯穿草稿、不可变投递、Runtime 输入与历史。
它不新增应用数据库、不复制原件、不改变既有内置 Artifact 的数值版本。共享工作区的原件打开、历史导航和草稿已通过受控浏览器验收；第三方可执行 GUI、完整跨宿主链和用户原 App 尚未完成验收。

- 作者服务拥有原件及不可解释的 `objectId` / `versionRef`。
- Platform 的既有内容目录拥有 `contentId`、实际项目、应用数据实例及已观察版本；许可、本人连接、定义与保存方仍由既有关系表拥有。
- Host 的 `runtime_deliveries.body` 拥有一次待投递输入的不可变请求、精确来源和回执状态，不是另一份会话数据库。
- Runtime 的实际 accepted Session Event 拥有已接收输入。公开历史和 Agent 来源均从该事实解析；尚未送达的本地输入只能作为明确的待投递历史展示。

## 唯一精确引用槽位

Core 的 `CognitiveAppObjectLocator` 是一个有界、独立快照：

```ts
{
  contentId: string;
  projectId: string;
  connectionId: string;
  authority: {
    appId: string;
    version: string;
    definitionHash: string;
    instanceId: string;
    serviceId: string;
    dataAuthorityId: string;
  }
  object: {
    objectId: string;
    versionRef: string;
  }
}
```

`record-input` / `RecordedInput` 使用可选 `cognitiveObject`，不借用 `artifactId`、`artifactRevision`、阅读位置或剧本槽位。
所有 opaque 字符串原样保存；没有 trim、数值转换、排序版本、latest/head 替换。禁止 NUL、未配对 UTF-16 surrogate、未知字段及 getter；合法 Unicode、空格与换行按原协议保留。
这个槽位没有业务正文、凭据、私有路由、actor、许可修订或 iframe 状态。引用不是权限，也不自动选择、启动或激活 Harness。

## 显式应用上下文

Human 可在新输入中显式提供 `cognitiveApplication`。它只包含 `connectionId` 和上述完整六字段 `authority`，不要求 GUI 或原件，不接受 actor、服务地址、view ID 或调用者选择的 Harness。Host 根据当前获权的精确定义生成内部 `application`，而不是信任页面状态。

| 显式选择 | canonical 输入版本 | 语义 |
| --- | --- | --- |
| 只有 `cognitiveObject` | 10 | 讨论精确原件，不因此激活应用 Harness |
| 只有 `cognitiveApplication` | 11 | 使用精确应用上下文；模型可见的 `cognitiveObject` 必须为 null |
| 两者同时存在 | 12 | 同时保留完整目标与原件；connection 和六字段 authority 必须全部相等，原件项目必须等于输入项目 |

新目标与旧 `application`／`applicationInstanceId` 槽位互斥，即使填写相同应用也拒绝；不与 reading、scriptGeneration 或 scriptTarget 的专用输入范围混用。旧输入以及旧应用＋原件的已支持路径保持原语义，不改写旧请求。

无界面应用不需要空窗口。普通能力发现、读取与调用不以 Harness 为前置；定义的 `harness:null` 可作为应用上下文，但不冒称激活自定义 Harness。非空声明必须由 Runtime 核验已安装的精确版本与 artifact hash；缺失时如实失败并保留原请求，不转为默认聊天。

## 准入、重发与实际读取

发送端在任何 awaited policy 前解析并脱离调用者的引用。既有 `commandSchema` 与旧消息载体预算保持不变；仅新槽位使用独立 own-data / 协议预算检查。

初次准入、待投递重试及 redispatch 均复用真实 `Platform.resolveCognitiveAppObjectRead` 元数据门：
同一事务核当前 Human / 来源、项目成员、精确定义、本人连接、真实保存方、目录对象及 `contentId` 等值；比较完整六个 authority 字段。
可选的内部 `contentId` 约束不进入作者或 Browser 的公开请求 schema。

发送消息不为证明原件存在而新增网络读取；离线讨论不会由此多出一个强制作者请求。目录当前观察版本可能已更新，仍不替换 Human 引用的旧 `versionRef`。
真正打开原件或 Agent 调用 `cognitive read-object` 时，仍由原网关读取该精确版本，并在网络返回后复核当前许可；原件不存在或无法连接时必须如实报错。

若输入显式包含 `application`，它必须与引用的应用、版本和真实数据实例吻合；Host 从精确定义固定 Harness，redispatch 复核同一值。单有引用不激活 Harness，也不把第三方对象伪装成 `morphz.objects`。

新的 `cognitiveApplication` 复用 Platform 当前真实 actor、项目成员、本人许可、本人连接与精确定义的核验；比较完整 authority，dispatch 再比较 Host 从定义生成的 application。选择目标不为核上下文而读取作者正文，不授予新权限，也不使 Agent 获得不同于同一 Human 来源的业务能力。

## 定向补充与幂等

新补充只能选择既有真实活动投影给出的 continuation；不得显式提供 `cognitiveObject` 或 `cognitiveApplication`。Host 从本人、同项目/对话的原投递记录继承完整原件、应用目标及派生 application，并通过既有实际 Thread / generation 门准入。
它保留原 Session、执行节点和引用，不创建另一根执行、不重新激活 Harness；补充本身仍有独立输入 ID 与 accepted Event。

对已接收补充的同命令重试，先沿用其持久来源与原请求，再返回原回执。此路径不再次要求原 Thread 仍打开，因而执行完成后的回执恢复不被误拒；仍复核当前本人和项目/对象权限。
相同输入 ID 不得变更引用、来源或请求，也不重写原投递正文。当前授权撤销阻断新准入/重发/披露，不删除或伪造已提交的历史事实。

## Session IO 与迁移

新增 canonical `morphz.application.input` 版本 `10`，以既有 immutable v4 的 continuation 结构为基础，要求整个 `cognitiveObject`，并在 `required_visible_paths` 包含 `/cognitiveObject`。
版本 `11` 要求整个 `cognitiveApplication` 和严格 null 的 `cognitiveObject`；版本 `12` 要求两个完整对象。两者均显式列出 `/cognitiveApplication` 与 `/cognitiveObject`，沿用 Runtime 的单类型 Schema，不新增 anyOf／组合方言。
Runtime 必须接受对应精确已安装格式；没有旧格式 fallback。模型可见的完整引用和目标与 Host 来源 metadata 必须全值一致；IO11 的可见原件是严格 null，来源 metadata 不新增原件字段。accepted 历史解析同时核真实格式，拒绝缺失或不一致的来源。

旧 canonical 1–9 的实际已注册描述（1、2、3、4、5、8、9）及两个 legacy 描述的 SHA 保持不变。旧排队请求、客户端消息 ID、格式、正文及指纹不重写。

Host transport 的 SQLite `user_version` 由 19→20→21 增加语义 downlevel fence，分别保护原件引用与显式应用上下文；不新增表、回填原输入或迁移作者原件。旧 Host 的 source parser 会剥掉未知来源，却保留 IO 请求且可能重新准入，因此必须阻止它打开新版投递库。Platform 的既有 SQLite/PostgreSQL 关系迁移不变。

## 验收层次与查询

默认正式测试包含严格 parser、旧载体兼容、有界引用、全部旧 descriptor SHA、19→20 逐字节请求/指纹保持，以及实际双 SQL 的本人元数据准入、冷重开重试、撤权、目录/保存方错配、显式补充引用拒绝。常见读取复用既有 input key、项目/状态及 Session 的 ledger 索引，不新增 whole-workspace 快照或第二目录。

明确 opt-in 的真实 canonical Rust 测试使用独立 npm-packed 作者服务和其 SQLite 原件：先创建 V1 再更新至 V2，实际 IO10、Agent read-input、精确作者读取及 accepted 历史均保持 V1；真实补充继承到同执行，完成后原回执重放不新建 Thread、不变请求。旧格式 Runtime 明确拒 IO10，零根 Thread、零模型请求。模型 HTTP 是受控 fixture，不是付费账户或原用户应用。

`scripts/cognitive-input-old-reader-smoke.ts` 是显式历史验收：从固定真实 Git revision 归档旧 Host，在独立临时数据上证明旧 source 剥字段/保留 IO10/旧 retry 准入，以及旧 Store 拒 20。默认 CI 不依赖该历史；显式执行缺少 revision 时立即失败，不 fetch、不 skip、不复制旧 parser 冒充原件。

显式目标阶段的 Root 正式九文件 58/58、required PostgreSQL、零跳过及全工程类型检查通过，覆盖实际双 SQL 的准入、拒绝、重试和来源。该阶段 Runtime HTTP 受控，不等于真正执行安装的 HNS。`scripts/cognitive-application-old-reader-smoke.ts` 另从真实旧 transport 20 Host 归档验证 source 降级及拒绝 21；同样是显式历史测试，不 fetch、不 skip，也不复制旧 parser。

后续 `tests/cognitive-app-application-actual-runtime.test.ts` 使用真实 canonical CLI，在隔离 Runtime 安装 test-owned `.hns`，再沿实际 Human 输入、IO11／12、Harness binding、入口 Plan 与 Host Job 执行。成功用例有两个已完成根线程、两个成功入口 Plan、四个成功 Host Job，以及独立 packed 作者服务的两笔 Agent 命令／两个原件；每笔作者来源固定对应的真实输入 ID。定向补充产生实际 steering Event，继承完整目标与原件；终态回执重放不再运行入口。

精确原件读取另由真实 Human API 核验，不冒称该用例已经执行 Agent 原件读；既有 IO10 实际 Agent 读取回归仍单独保留。未注册 IO11／12 的真实 Runtime 分别拒绝两种输入，不创建根线程、不发模型请求、不执行 Agent 写入，原请求格式保持；Human 为 IO12 准备的基线原件不归为 Agent 成果，旧 IO1 仍正常完成。

本次 Root 正式十二文件 79/79、required PostgreSQL／Runtime、零跳过，包含新真实 HNS、原 IO10、双 SQL 准入及 capability 门，类型与格式检查通过。新 Runtime、Host 与作者中心均为隔离 SQLite，PostgreSQL 证据来自组合内的双后端测试；模型 HTTP 受控、付费请求为零。runtime-owned HNS 入口完成后模型只解释结果，遵守既有执行契约；本阶段不改 Rust、Schema 方言或工具权限。

## 共享工作区的原件打开与草稿

公开历史保留完整 locator。显式打开先经当前 Human 的目录与精确作者读取门，成功后才切换原工作区并记录本人近期打开；不创建 Session、不发送输入、不复制正文到导航偏好。标题与正文采用真实返回的原件，不用目录 head 的标题冒充历史版本。

读取、失败重试或更新导航期间，未发送输入保持原草稿与来源，不能把旧内容发向尚未核验的新原件。用户主动打开原件才展开其内容；后台读取或被动恢复不制造近期记录。身份／项目变化和迟到结果不能改变当前工作面或披露旧正文。同一原件再打开不会重复初始化草稿；首个草稿修改即固定完整 opaque 引用，后续目录升级不改绑。

Root 正式十四文件 170/170、required PostgreSQL、零跳过及全工程类型检查通过。新集成测试实际挂载生产 App、Conversation 与原 CSS，使用 Chromium StrictMode 和受控 logical transport，并保留旧导航、草稿、viewport、回执与 topbar 门。它不是 native Electron、真实作者网络或用户原窗口验收。

第三方可执行 GUI 的 compose consumer、安全沙箱与统一安装／应用选择入口仍须接通；不得以只读原件工作面或消息叶模块冒称完整作者 GUI。Desktop／Web／Agent 的整体链和原 App 更新验收仍属剩余交付。

## 普通草稿的显式应用目标准备

现 InputDraft 的独立 `cognitiveApplication` 槽位复用完整 Core target。
纯选择／清除在原 latest-state updater 中处理，不改变工作面键、原件 opaque
版本、正文、附件、引用或执行参数，不产生 Session／导航／网络或授权。
特殊输入拒绝改绑；普通输入已有原件或 view 时核实际项目、完整连接与
authority，选择本身不制造原件。新目标 own-data 门在原 command 首次
浅拷贝前执行，发送快照在 Profile await 前固定，只限制独立槽位，不收紧
旧消息载体预算。显式目标不再自动夹带旧应用或 Browser 页面。

消费沿旧草稿 owner 保留当前最新目标，发送 A 后选 B，迟到 A 回执既不
覆盖 B，也不复活已消费的原件；定向补充与不确定重试不注入当前选择。
没有目标的空稿／清理继续原有 no-op，不开始解析未使用的工作面。

Root 独立八文件 118/118、相邻五文件 101/101，required PostgreSQL
入口、零跳过及类型／格式检查通过；实际 command 的受控端口与相邻
生产 App／writer Chromium 回归分开保留。该阶段不运行新的选择界面、
SQL 业务、native IPC 或用户原窗口，不代替已独立验证的后端 IO11／12，
也不冒称共同应用目录和 GUI 已完成。原始空稿／清理失败与验收日志见
实施记录。
