# @morphz/cognitive-app-sdk

`0.1.0` 是实验性作者协议包，尚未发布到 npm。它可以独立构建为 ESM 与
TypeScript 声明，并通过本地 npm tarball 安装。`private: true` 防止误发布，
不妨碍 `npm pack` 或安装打包产物；未来公开发布需另行确认。

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
会执行同一构建。产物为 `morphz-cognitive-app-sdk-0.1.0.tgz`，只包含 JS、
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
导入模块本身不注册监听器；明确调用 `connectMorphz()` 后，它只连接实际
`window.parent`，不接受地址、身份、授权、私有路由或自定义传输。

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
请求宿主按原命令恢复，不能当成重新执行。全部能力仍由未来宿主真实
view owner、版本、许可、项目、连接及操作 gate 决定；SDK 的校验不授权。

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

当前 binding/channel 退役后，旧实例拒绝所有 pending、清除订阅并忽略迟到响应；
它不会用旧 callback 自动绑定新窗口。需要由新的应用生命周期明确重新
调用 `connectMorphz()`；组件结束时调用 `app.dispose()`。主题和同绑定导航
更新不授予新权限。SDK 错误仅有固定安全说明，不转发宿主原始异常。

已验证仓库外真实 tarball 安装/严格声明消费，以及真实 Chromium opaque
iframe 中打包 HTML 的握手、source/channel、并发、受控单调 deadline 与
退休行为。这是隔离消息桥 fixture，不是实际 Host 授权或原用户窗口验收。
Host 精确 UI 字节 gate、业务 Gateway 接线及认知对象打开/输入引用仍由
宿主另阶段实现；本包不包含 Host 网关、安装管理或作者 Service 脚手架。
