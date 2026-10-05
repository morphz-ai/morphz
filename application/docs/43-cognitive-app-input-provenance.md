# 认知应用原件的输入来源

## 范围与权威 owner

这是第三方认知应用接入的后端来源阶段，补充 `42-third-party-cognitive-app-contract.md`。
它不新增应用数据库、不复制原件、不改变既有内置 Artifact 的数值版本，也不证明 GUI、导航或未发送草稿已经接通。

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

## 准入、重发与实际读取

发送端在任何 awaited policy 前解析并脱离调用者的引用。既有 `commandSchema` 与旧消息载体预算保持不变；仅新槽位使用独立 own-data / 协议预算检查。

初次准入、待投递重试及 redispatch 均复用真实 `Platform.resolveCognitiveAppObjectRead` 元数据门：
同一事务核当前 Human / 来源、项目成员、精确定义、本人连接、真实保存方、目录对象及 `contentId` 等值；比较完整六个 authority 字段。
可选的内部 `contentId` 约束不进入作者或 Browser 的公开请求 schema。

发送消息不为证明原件存在而新增网络读取；离线讨论不会由此多出一个强制作者请求。目录当前观察版本可能已更新，仍不替换 Human 引用的旧 `versionRef`。
真正打开原件或 Agent 调用 `cognitive read-object` 时，仍由原网关读取该精确版本，并在网络返回后复核当前许可；原件不存在或无法连接时必须如实报错。

若输入显式包含 `application`，它必须与引用的应用、版本和真实数据实例吻合；Host 从精确定义固定 Harness，redispatch 复核同一值。单有引用不激活 Harness，也不把第三方对象伪装成 `morphz.objects`。

## 定向补充与幂等

新补充只能选择既有真实活动投影给出的 continuation；不得显式提供另一 `cognitiveObject`。Host 从本人、同项目/对话的原投递记录继承完整引用，并通过既有实际 Thread / generation 门准入。
它保留原 Session、执行目标和引用，不创建另一根执行；补充本身仍有独立输入 ID 与 accepted Event。

对已接收补充的同命令重试，先沿用其持久来源与原请求，再返回原回执。此路径不再次要求原 Thread 仍打开，因而执行完成后的回执恢复不被误拒；仍复核当前本人和项目/对象权限。
相同输入 ID 不得变更引用、来源或请求，也不重写原投递正文。当前授权撤销阻断新准入/重发/披露，不删除或伪造已提交的历史事实。

## Session IO 与迁移

新增 canonical `morphz.application.input` 版本 `10`，以既有 immutable v4 的 continuation 结构为基础，要求整个 `cognitiveObject`，并在 `required_visible_paths` 包含 `/cognitiveObject`。
Runtime 必须接受这个精确已安装格式；没有旧格式 fallback。模型可见的引用与 Host 来源 metadata 必须全值一致；accepted 历史解析拒绝缺失或不一致的引用。

旧 canonical 1–9 的实际已注册描述（1、2、3、4、5、8、9）及两个 legacy 描述的 SHA 保持不变。旧排队请求、客户端消息 ID、格式、正文及指纹不重写。

Host transport 的 SQLite `user_version` 从 19 升到 20，是语义 downlevel fence，不新增表、回填原输入或迁移作者原件。旧 Host 的 source parser 会剥掉未知引用，却保留 IO 请求且可能重新准入，因此必须阻止它打开新版投递库。Platform 的既有 SQLite/PostgreSQL 关系迁移不变。

## 验收层次与查询

默认正式测试包含严格 parser、旧载体兼容、有界引用、全部旧 descriptor SHA、19→20 逐字节请求/指纹保持，以及实际双 SQL 的本人元数据准入、冷重开重试、撤权、目录/保存方错配、显式补充引用拒绝。常见读取复用既有 input key、项目/状态及 Session 的 ledger 索引，不新增 whole-workspace 快照或第二目录。

明确 opt-in 的真实 canonical Rust 测试使用独立 npm-packed 作者服务和其 SQLite 原件：先创建 V1 再更新至 V2，实际 IO10、Agent read-input、精确作者读取及 accepted 历史均保持 V1；真实补充继承到同执行，完成后原回执重放不新建 Thread、不变请求。旧格式 Runtime 明确拒 IO10，零根 Thread、零模型请求。模型 HTTP 是受控 fixture，不是付费账户或原用户应用。

`scripts/cognitive-input-old-reader-smoke.ts` 是显式历史验收：从固定真实 Git revision 归档旧 Host，在独立临时数据上证明旧 source 剥字段/保留 IO10/旧 retry 准入，以及旧 Store 拒 20。默认 CI 不依赖该历史；显式执行缺少 revision 时立即失败，不 fetch、不 skip、不复制旧 parser 冒充原件。

后续 GUI owner 仍须把这个同一槽位贯穿精确原件打开、导航、未发送草稿与真实发送；不得创建 fake content ID、把 opaque ref 转数值，或从任意当前页面猜连接。此文不将该后续接线列为已交付。
