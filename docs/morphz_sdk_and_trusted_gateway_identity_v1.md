# Morphz SDK v1 与可信 Gateway 身份接入

> 状态：v1 已实现
> 范围：单一 `morphz` 二进制、Rust SDK Facade、HTTP/WebSocket 适配器、TypeScript Client、Principal 作用域的 Session Service

## 1. 目标

Morphz 不直接理解 GitHub、Google、Facebook 或网站 Cookie。接入层先完成认证，再把稳定的产品内部身份转换成 Runtime 权威的 `PrincipalAssertion`。模型看到的自然语言不能改变这个事实。

```text
GitHub / Google / 其他登录
          │
          ▼
Site Gateway 自有 users.id
          │  service credential + site-user-<id>
          ▼
Morphz SDK / HTTP Adapter
          │  PrincipalAssertion
          ▼
Runtime → Session binding → Event / Activation / Frame provenance
```

首版稳定面只包含：Context 创建、Session 创建/查询/更新、消息提交、Session 历史、Session 订阅和旧 Session 显式认领。调度器、Store、Orchestrator 与工具注册表仍是内部实现，不构成 SDK v1 的兼容承诺。

## 2. 两种宿主模式

### 2.1 默认单用户模式

- Runtime 默认身份是 `principal-default`；
- CLI、TUI、Dashboard 和 `morphz serve` 的默认模式都使用该身份；
- 启动本地适配器时，会给历史 Session 补充 `principal-default` 绑定；原有历史绑定不删除；
- 该迁移只适用于单用户宿主，不代表 Runtime 猜测公网用户身份。

### 2.2 可信 Gateway 模式

用户级配置：

```toml
[server.identity]
mode = "trusted-gateway"
provider_id = "morphz-site"
service_token_env = "MORPHZ_API_TOKEN"
```

启动前设置 `MORPHZ_API_TOKEN`。该配置属于宿主控制面，项目目录中的 `.morphz/config.toml` 不能覆盖它。

可信请求同时携带：

```http
Authorization: Bearer <service-token>
X-Morphz-Principal: site-user-42
X-Morphz-Principal-Name: Alice
```

服务令牌证明“这是受信 Gateway”；Principal Header 表示“Gateway 已认证出的当前用户”。`provider_id` 固定来自 Morphz 宿主配置，不允许请求自行指定。显示名称只是描述字段，不参与授权。

可信模式缺少 Principal 会失败，不会回退为 `principal-default`。

## 3. Session 授权契约

Runtime 持久化 `Principal ↔ Session` 绑定。以下接口都先校验绑定：

- `GET /api/sessions`
- `GET/PATCH /api/sessions/:id`
- `POST /api/sessions/:id/messages`
- `GET /api/sessions/:id/events`
- `GET /api/sessions/:id/context`
- `POST /api/sessions/:id/cancel`
- `GET /ws?session_id=...&principal_id=...`

Session 与初始 Principal 在同一个数据库事务中创建。带 `parent_session_id` 的 Session 还要求调用 Principal 已参与父 Session，防止通过父级关系跨身份挂载。

错误使用稳定机器码：

```json
{
  "error": {
    "code": "forbidden",
    "message": "Principal 'site-user-2' 未参与 Session 'session-a'"
  }
}
```

当前机器码为 `invalid_argument`、`unauthorized`、`forbidden`、`not_found`、`conflict`、`internal`。

## 4. 旧 Session 的显式认领

旧网站数据库已经保存 `users.id → morphz_session_id`，但旧 Runtime 可能没有 Principal 绑定。可信 Gateway 在读到该权威映射后调用：

```http
POST /api/sessions/:session_id/principal
Authorization: Bearer <service-token>
X-Morphz-Principal: site-user-42
```

该操作幂等。Morphz 不扫描网站数据库、不从 Session 标题猜用户，也不把未绑定 Session 自动分配给公网 Principal。

## 5. WebSocket

浏览器 WebSocket 无法可靠设置自定义 Header，因此 Gateway 到 Morphz 的单 Session 订阅使用 Query：

```text
/ws?session_id=session-a&principal_id=site-user-42&token=<service-token>
```

握手前同时校验服务令牌和 `Principal ↔ Session` 绑定。无 `session_id` 的全局事件流只应由可信运维面使用；普通网站用户永远不直接持有服务令牌。

## 6. SDK 形态

### 6.1 Rust

`morphz::sdk::MorphzSdk` 是传输无关的稳定 Facade。CLI、TUI 和 HTTP Session 适配器复用它；`MorphzRuntime` 继续承载实现和尚未稳定的高级能力。

### 6.2 TypeScript

`sdk/typescript` 提供无第三方运行时依赖的 `MorphzClient`，封装服务令牌、Principal Header、结构化错误、Session CRUD、消息、历史和 WebSocket URL。

## 7. 安全边界

这套机制解决的是身份混淆与文本冒充：B 在消息里声称“我是 A”不会改变 Runtime 的 Principal。它不替 Agent 决定知识是否应共享；共享认知和披露选择仍由 Agent 语义与产品策略决定。

必须保持的边界：

1. 服务令牌只存在于 Gateway 与 Morphz Server；
2. 公网浏览器只连接 Site Gateway；
3. Gateway 只能由已认证 `users.id` 构造 Principal；
4. 可信模式不做默认身份回退；
5. Runtime 不直接绑定社交平台账号，新增登录方式只改变 Site 的账号映射。

## 8. 验证

当前契约测试覆盖：

- A 创建的 Session 对 B 的读取、消息与历史操作返回 `forbidden`；
- 消息正文中的身份宣称不能覆盖 Principal；
- 父 Session 不能被其他 Principal 用作派生挂载；
- 旧 Session 只能由可信 Gateway 显式认领；
- 默认模式补充新默认身份时不删除历史绑定；
- TypeScript 客户端对 REST 与 WS 始终携带服务凭证和 Principal。
