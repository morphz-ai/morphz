# @morphz/cognitive-app-sdk

`0.3.0` 是实验性作者协议包，尚未发布到 npm。它可以独立构建为 ESM 与
TypeScript 声明，并通过本地 npm tarball 安装。`private: true` 防止误发布，
不妨碍 `npm pack` 或安装打包产物；未来公开发布需另行确认。

完整接入流程见仓库的[第三方接入 quickstart](https://github.com/morphz-ai/morphz/blob/main/application/docs/42-third-party-cognitive-app-contract.md#接入-quickstart)，
独立作者示例见[认知笔记 Service](https://github.com/morphz-ai/morphz/tree/main/application/examples/cognitive-notes)。
这些是仓库文档链接，不是包内文件；若远端尚未包含本地阶段提交，以同一
源码版本的 `application/docs/42-third-party-cognitive-app-contract.md` 为准。
GUI 可选，作者领域 Service／账户 ACL／原件／事务与 Host 完全分离。
Agent 无需 GUI，沿真实输入或后台来源调用同一领域网关；Human 明确管理
安装、数据访问权限和本人连接，SDK 校验不替代这些门。

## 能力与边界

本包提供认知应用定义、有限 JSON Schema 校验、精确对象引用、领域请求与
回执校验，以及确定性请求身份的 JSON 字节。公开入口：

- `@morphz/cognitive-app-sdk`：全部公开类型与校验函数。
- `@morphz/cognitive-app-sdk/protocol`：定义、资源、值与固定预算校验。
- `@morphz/cognitive-app-sdk/domain-wire`：Service 请求、响应、回执与身份字节。
- `@morphz/cognitive-app-sdk/browser`：可选沙箱消息桥和严格 UI wire 类型；
  不从主入口自动导出或建立连接。

唯一运行依赖为固定版本 `zod@4.5.4`。本包不导入 Node、Host、Runtime、数据库
或浏览器私有实现，不读取环境、凭据或文件，也不自动发起网络请求。

声明消费已验证 `ES2023 + DOM` 标准库、`types: []`、严格模式且不跳过
依赖声明检查；Zod 的声明引用标准 `URL` 类型。这里的 DOM 标准库不是
Host 或浏览器界面依赖，不宣称缺少标准全局类型的任意配置也能通过。

校验成功只是数据符合协议，不是身份认证、授权或操作完成证明。作者独立
管理领域数据与业务规则；副作用与对应回执必须在作者数据库内原子提交。
相同 commandId 必须匹配原 requestHash，不能凭超时重试不确定的副作用。
Host 私有地址、密钥、路由与授权不属于作者定义或本包公开参数。

## 独立构建与打包

在本包目录运行：

```sh
npm install
npm run build
npm pack
```

构建只读取本包 `src` 下的文件，不依赖 Morphz workspace 的构建或
类型配置。开发工具为固定版本 `typescript@7.0.2`；`npm pack` 的 `prepack`
会执行同一构建。产物为 `morphz-cognitive-app-sdk-0.3.0.tgz`，只包含 JS、
声明、包清单、此说明与 Apache-2.0 许可证，不打包源码、测试或 source maps。
有完整 npm 缓存时可为安装与打包增加 `--offline`；缺缓存应明确报错，不能
把未安装依赖的构建称为通过。

在独立作者项目安装上述 tarball，再使用包名导入：

```ts
import {
  parseCognitiveAppDefinition,
  parseInvokeRequest,
  canonicalInvokeIdentityBytes,
  type CognitiveAppDefinition,
  type OperationDefinition,
} from "@morphz/cognitive-app-sdk";

const definition: CognitiveAppDefinition = parseCognitiveAppDefinition({
  format: "morphz-cognitive-app/v1",
  protocol: "morphz-domain/v1",
  id: "example.notes",
  version: "1.0.0",
  title: "Notes",
  description: "Independent notes service",
  icon: "document",
  harness: null,
  ui: null,
  operations: [],
});

// rawRequest 来自已认证的 Host；operation 取自同意的精确定义。
function inspectInvocation(
  rawRequest: unknown,
  operation: OperationDefinition,
) {
  const request = parseInvokeRequest(
    rawRequest,
    operation.effect,
    operation.scope,
  );
  const identityBytes = canonicalInvokeIdentityBytes(
    request,
    operation.effect,
    operation.scope,
  );
  return { request, identityBytes };
}
```

示例展示数据校验，不包含 Service、HTTP 路由或授权实现。
`canonicalInvokeIdentityBytes` 排除 issuer、expiry 和独立 command/hash 对，
保留实际语义来源、目标、参数与资源；调用者自行计算 SHA-256，不使用可变
传输字段作为业务身份。规范化使用确定的 UTF-16 键序与有限 JavaScript 数字，
并非全部 RFC 8785 或任意精度数字支持。

身份和持久展示元数据拒绝 NUL 与未配对 UTF-16 surrogate；合法 Unicode、
换行、tab 与字面空格不被修剪或规范化。业务参数、结果及正文中的 JSON
仍按既有预算保留原值，不继承元数据的字符限制。

## 可选 Browser SDK

作者在自己的项目构建时将 `browser` ESM 打包进自包含 HTML。不要在沙箱中
从 CDN、npm 或宿主地址动态 import；沙箱 `connect-src 'none'` 不允许网络。
导入模块本身不注册监听器；明确调用 `connectMorphz()` 后，它只领取
原作者 Document 的一次性固定 facade，不领取原生端口，也不监听 Window
业务消息或回退旧消息桥。它不接受地址、身份、授权、私有路由或自定义传输。
没有可信固定前缀的普通浏览器页或 Node 返回 `unsupported`；校验与 facade
关联仍不是授权，实际宿主请求继续通过当前 Human／view／binding gate。

```ts
import { connectMorphz } from "@morphz/cognitive-app-sdk/browser";

const app = await connectMorphz();
const context = app.context; // Host 提供的只读精确应用/视图；不含草稿或密钥
await app.invoke({
  operationId: "notes.read",
  parameters: null,
  resources: [{ objectId: "original", versionRef: "opaque:exact" }],
  commandId: null, // read 必须明确无副作用命令
});
await app.saveState({
  expectedRevision: context.view.revision,
  state: {
    object: { objectId: "original", versionRef: "opaque:exact" },
    view: "reader",
  },
});
```

`ready` 获取同一绑定的当前上下文；`invoke` 调用已同意的 operation；
`readObject` 读取精确原版本；`openObject` 请求宿主打开该引用；`compose`
只准备文字及可选精确引用，不发送；`saveState` 只保存小型导航且带 CAS。
`commandStatus(commandId)` 请求宿主账本事实；`recoverReceipt(commandId)`
请求宿主按原命令恢复，不能当成重新执行。全部能力由宿主真实
view owner、版本、许可、项目、连接及操作 gate 决定；SDK 的校验不授权。

`openObject` 可导航离开并销毁调用它的 Document。只有原件已实际发布、
源 Document／owner 仍有效且末尾授权门通过时，才可收到 `opened:true`；
不保证离开后的响应或 JavaScript 后续执行。保存或确认放弃编辑必须在
调用前完成，不依赖 `await openObject()` 后保存、清理或显示必要提示。
无回包、disposed、unavailable 或超时不证明导航未发生，不自动重试；
导航没有领域 commandId，不能按写命令 recovery 重放。

`parseBrowserNavigationState(input)` 是同一公开导航规则的独立解析入口，
仅接受 `{ object?: { objectId, versionRef }, view?: string }` 并捕获独立快照。
正文、草稿、未知字段及数字版本被拒绝；不透明引用不转换或规范化。

write/execute 的 `commandId` 必须由作者明确提供，并在未知结果后复用；它
与 SDK 自动创建的 RPC `requestId` 独立。没有队列或自动重试。每个连接最多
16 个待回应请求；同一活跃模块重复连接复用同一实例，不另开并发预算。
每个连接握手/请求使用固定 30 秒单调绝对 deadline，
包括同步校验时间。超时/关闭不证明回滚：查询或恢复原 commandId，不能
换 ID 重复创建。写结果保留真实命令与投影状态；已提交但投影尚未完成、
仅观察到作者提交但 Host 尚未持久化，与全部完成不同。结果正文不保证
在冷启动后的状态查询里再次出现。

`onContextChange(listener)` 订阅同一绑定的主题、活动状态和导航更新，最多
16 个订阅，返回幂等取消函数。通知只用于 UI，不自动触发对象读取或执行；
回调异常被隔离，不转发或记录原始错误。上下文被冻结，不能改成新的调用
身份或目标。

SDK 观察到本地 Document 或 binding/channel 退役后，旧实例拒绝所有本地 pending、
清除订阅和计时器，并忽略迟到响应；正在解析的结果也属于 pending。
每次 context 读取、订阅、逐位通知、解析／冻结／完成及发送均同步核原
Document；移除再插回原 root／doctype 不能复活该实例。它不会用旧 callback
自动绑定新窗口，同一退役 Document 再调用 `connectMorphz()` 返回 `disposed`。
宿主移除 iframe 不保证已销毁的 JavaScript 能继续执行或立即观察到 disposed，
也不承诺另一端同步取消；不能据没有回应判断业务或导航未发生。
只有真正新 Document、新模块与新固定端点才能明确重新连接；组件结束时
调用 `app.dispose()`。主题和同绑定导航
更新不授予新权限。SDK 错误仅有固定安全说明，不转发宿主原始异常。

SDK 的十六 pending 与私有原生端口的十六未消费 wire 是两个独立窗口；
无 credit 时当前请求返回安全 `busy`，没有排队或自动重试。原生传输确认
不是业务提交或许可。关闭一端不保证另一端立即取消所有任务，更不证明
已受理写入回滚；作者已有的数据引用或响应也不能事后撤回。

`0.3.0` 增加可选的操作声明 `compose: { kind: "create", label, prompt? }`，
用于 Host 的新建菜单。它仅用于 project-scoped write/execute 操作；label
最多 100 字符，prompt 最多 500 字符，均为非全空白的 portable text。
prompt 是可编辑的用户草稿，不是系统指令、权限或调用。仅有 write effect
不会自动出现在新建菜单，GUI 也不是条件。使用新声明必须发布新应用版本与
定义 hash；旧安装不被改写，省略该字段的旧定义保持原 canonical 字节。
菜单选项固定的是准确应用与数据连接，operationId 是发现来源，不是强制
调用。详情见 docs/42 中的新建意图贡献约定。

`0.2.0` 改变 Browser 的内部生命周期契约，不改变 `morphz-domain/v1` 或
`morphz-cognitive-ui/v1` 的八方法业务 wire。已安装的 `0.1.0` HTML／SHA
不会由 Host 注入代码或改写：GUI 作者应显式重新打包 SDK，生成新原字节
SHA，并通过现有一致的应用版本／UI packageVersion／定义 hash 升级与授权。
旧资料、旧绑定和原版本仍保留。仅使用领域协议的 headless 作者不必为
npm 依赖版本单独改变业务应用版本。

已验证仓库外真实 tarball 安装／严格声明消费，以及真实 Chromium opaque
Document 中打包 HTML 的固定 facade／native port、Window 伪造正控、并发、
受控单调 deadline 与退休行为。每位观察者及解析／冻结／分配／结算期间
的实际重写均同步拒绝，并保留原写命令 ID；清理异常不泄漏，重入调用
也不能超过十六 pending。这是受控业务 Host 的隔离 SDK 验收，
不是实际 SQL 授权、生产 GUI consumer 或原用户窗口验收。
Host 精确 UI 字节 gate、领域 Gateway 和生产 GUI owner 已另阶段分层验证：
完整 Web 的独立 packed 作者／公开 SDK／HPA／SQLite＋PostgreSQL 4/4；
实际 Electron Remote 的 SQLite＋PostgreSQL 与 embedded Local 的 SQLite
同属当前原生 20/20、零跳过组合，核对象终结导航、原草稿引用、同 Document
保存和关闭退休。真实 Rust 的普通输入、后台事项与 infer 链另有分层证据，
不混报为 Browser SDK 测试或付费模型验收。范围与原失败见仓库的
[最新交付与剩余](https://github.com/morphz-ai/morphz/blob/main/application/docs/42-third-party-cognitive-app-contract.md#最新交付与剩余)。
这些是隔离自动中心，不是用户原 App。原 App 已沿原 profile／中心重开，
完整 UI 与持久保全另有证据；重开前后 1,292 条落盘草稿 key/value 全等。
这收尾本轮实验接入目标，不证明未落盘编辑或逐个旧草稿当前选择。
公网 TLS／真实第三方账户、市场／OAuth 和
公开发布也不由上述测试证明。本包不包含 Host 网关、安装管理或作者
Service 脚手架，不赋予任意网络或宿主代码执行权限。
