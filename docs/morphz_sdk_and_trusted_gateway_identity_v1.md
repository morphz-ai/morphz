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

启动前设置两个相互独立的凭证：

```text
MORPHZ_DASHBOARD_TOKEN  Dashboard / Operator 管理面凭证
MORPHZ_API_TOKEN        Site Gateway 服务凭证
```

`MORPHZ_API_TOKEN` 的变量名由 `service_token_env` 决定。两种凭证都属于宿主控制面，
项目目录中的 `.morphz/morphz.toml` 不能覆盖它们，也不能配置为相同值。

可信请求同时携带：

```http
Authorization: Bearer <service-token>
X-Morphz-Principal: site-user-42
X-Morphz-Principal-Name: Alice
```

服务令牌证明“这是受信 Gateway”；Principal Header 表示“Gateway 已认证出的当前用户”。`provider_id` 固定来自 Morphz 宿主配置，不允许请求自行指定。显示名称只是描述字段，不参与授权。

Principal ID 是 Identity Provider 所有的 opaque identifier，不使用 Morphz
Session/Context 的资源名语法。邮件地址、IM 地址和带命名空间的 provider subject（例如
`o9cq80-lk788_j4zgPcOdjWMblvY@im.wechat`）均可直接使用；Runtime 只拒绝空值、首尾空白、
控制字符和超过 512 字节的值。

可信模式缺少 Principal 会失败，不会回退为 `principal-default`。

Dashboard 管理令牌是例外：它证明当前请求来自 Runtime 自身的 Operator 面，而不是
Gateway 用户请求，因此不要求附带 `X-Morphz-Principal`，也不会被当作 Gateway
服务令牌使用。

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

### 3.1 Session 内的人工审批（2026-09-08）

普通 Gateway 用户使用原生 Session 接口，不代理 Dashboard 的管理员审批列表：

- `GET /api/sessions/:session_id/approvals`：最多返回 100 个本人发起、仍可处理的
  人工审批，附带 `truncated`。解决旧请求后，后续请求会进入这批列表。
- `GET /api/sessions/:session_id/approvals/:approval_id`：取得当前请求或已决定回执。
- `POST /api/sessions/:session_id/approvals/:approval_id`：提交
  `{ "expected_revision": 1, "decision": "allow_once" }`。

决定为 `allow_once`、`allow_thread`、`allow_objective`、`allow_session` 或 `deny`。
客户端展示原生 `action`、`requested`、`justification`、Target、作用域及租约截止时间，
只提供 `available_scopes` 中的允许选项。不接受自定义路径、权限、风险标签或身份字段；
审批不会改变 Session 的权限预设，也没有 `allow_all` / `full_access` 选项。
目标作用域需要 Job 的真实因果 Objective；显式 once 请求不产生可复用租约。

HTTP 先认证服务凭证，然后 SDK 校验 Session 参与关系；Store 在决定事务内再次确认
Session 活跃、参与关系未撤销、Principal 与 Job 发起人一致。仅共享 Session 不代表
可以批准他人的请求。即使是重复请求，也必须先通过当前参与关系校验。
非精确重复使用原始 `expected_revision` 做 CAS；同内容重试返回既有决定，拒绝、取消
或不同决定不可覆盖。自动审批中的请求不会通过该人工接口被抢先决定。

决定和审计 Event 在同一事务持久化，随后复用原生事件投递及审批等待者唤醒；进程内
等待者消失不丢失已提交的决定。网络失败或 503 时重试**同一个 ID、版本与决定**，
409 时刷新，不把旧页面的选择覆盖到新版本。数据库中仍等待的审批可以在重启后读取。

SQLite 和 PostgreSQL 共用上述语义；RemoteRuntimeStore 自动覆盖新增 Store 方法，
其远端确认仍是成功回执的前置条件。Rust SDK 和 TypeScript SDK 均提供列表、详情和
提交三个方法。Cloud 产品路由从可信目录选择用户的 `primarySessionId`，不接受查询
参数指定其他 Session。网站已实现审批收件箱，本机真实 Edge 跨进程门禁通过；
真实云端休眠/唤醒和三平台设备验收仍需单独完成。

恢复相同 Tool Call 时，审批请求 Event 必须沿用持久化的发生时间与序号；权限、身份、
路由或内容变化仍拒绝。重放决定不重复消费 Grant，且 Session 租约只覆盖批准目录，
不改变权限预设、也不覆盖 Edge 设备所有者独立的本机权限。

回归入口：`cargo test -p morphz --lib --features remote-store session_approval`；
PostgreSQL 使用显式隔离测试库运行 `session_approval_postgres_contract -- --ignored`，
不把未配置时跳过当作已通过。TypeScript SDK：`cd sdk/typescript && npm test`。

### 3.2 可还原的会话审批预设（2026-09-11）

`PATCH /api/sessions/:session_id` 的 `permission_mode` 区分三种输入：字段缺省
保持原值，具体预设设置会话覆盖，显式 `null` 删除覆盖并恢复继承 Runtime 默认值。
参与者仍通过同一服务凭证和 Principal/Session 授权；他人不能设置或清除该覆盖。
`custom` 仍被拒绝，清除覆盖不修改 Runtime 默认策略、sandbox 或现有审批决定。
此语义也适用于独立的 Operator 控制面，但产品参与者不得借用 Operator 凭证。

原生回归先复现旧接口在 `null` 返回成功后仍保留 `request_approval` 的问题，
修复后覆盖了缺省不改、明确还原、同值重复、跨身份拒绝和 `custom` 拒绝。

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
