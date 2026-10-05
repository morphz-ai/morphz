# @morphz/cognitive-app-sdk

`0.1.0` 是实验性作者协议包，尚未发布到 npm。它可以独立构建为 ESM 与
TypeScript 声明，并通过本地 npm tarball 安装。`private: true` 防止误发布，
不妨碍 `npm pack` 或安装打包产物；未来公开发布需另行确认。

## 能力与边界

本包提供认知应用定义、有限 JSON Schema 校验、精确对象引用、领域请求与
回执校验，以及确定性请求身份的 JSON 字节。三个入口导出相同的既有协议：

- `@morphz/cognitive-app-sdk`：全部公开类型与校验函数。
- `@morphz/cognitive-app-sdk/protocol`：定义、资源、值与固定预算校验。
- `@morphz/cognitive-app-sdk/domain-wire`：Service 请求、响应、回执与身份字节。

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

构建只读取本包 `src` 下的三个入口文件，不依赖 Morphz workspace 的构建或
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

此阶段不包含 browser bridge、Host 网关、安装管理或作者服务脚手架。
