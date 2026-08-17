# Morphz HTTP API：AI Agent 接入契约 v1

> 本文描述适合外部客户端和 AI agent 使用的稳定最小接口面：Context、Session、Message、Event 和单 Session WebSocket；同时定义只面向 Runtime Operator 的只读全局 Overview。
> 实现依据：`morphz/src/web.rs`、`morphz/src/sdk.rs`、`sdk/typescript/src/index.ts`。  
> 最后按实现重新导出：2026-07-31。
> `/api/execution-*`、`/api/edge/*`、`/api/objectives`、Inspector/调度/记忆维护等端点属于内部控制面，不在本文的兼容性承诺内。

## 1. 给调用方的最短说明

Morphz 是异步会话 Runtime。调用方应：

1. 启动服务：`morphz serve`，默认地址 `http://127.0.0.1:8080`。
2. 创建或选择一个 Session。
3. 为每条用户消息生成唯一且可重试复用的 `client_message_id`。
4. `POST /api/sessions/{session_id}/messages`；`202` 只表示消息已接受，不表示模型已回答。
5. 使用事件轮询或 WebSocket 等待 `topic == "chat/reply"`，并读取 `payload.text`。
6. WebSocket 断线、丢事件或进程重启后，以 HTTP Event History 作为权威恢复来源。

如果只需实现一个最小客户端，只实现以下四个调用即可：

- `POST /api/sessions`
- `POST /api/sessions/{session_id}/messages`
- `GET /api/sessions/{session_id}/events`
- `GET /ws?session_id={session_id}`

## 2. 通用约定

### Base URL 与内容类型

- 默认 Base URL：`http://127.0.0.1:8080`
- JSON 请求使用 `Content-Type: application/json`
- 时间是 RFC 3339/ISO 8601 UTC 字符串
- ID 长度为 `1..=128`，只允许 ASCII 字母、数字、`.`、`-`、`_`、`:`
- 标题最长 200 个字符

### 服务认证

HTTP 请求使用 Bearer token：

```http
Authorization: Bearer <service-token>
```

服务也接受 `?token=...`，主要供无法设置 Header 的 WebSocket 握手使用。不应在日志、提示词或普通错误信息中暴露 token。

令牌分为两个互不替代的凭证：

- `default` 模式：可选的 `MORPHZ_DASHBOARD_TOKEN` 同时保护 Dashboard 和 HTTP API；未配置时本机请求无需 token。
- `trusted_gateway` 模式：Gateway 使用 `[server.identity].service_token_env` 指向的服务令牌；Dashboard/Operator 使用独立的 `MORPHZ_DASHBOARD_TOKEN`。

在 `trusted_gateway` 模式中，这两个令牌必须不同。Gateway 不得持有 Dashboard/Operator 管理令牌；管理令牌也不应被当作最终用户身份凭证。监听非 loopback 地址时，至少必须配置一种令牌。

### Principal 身份

服务有两种身份模式：

- `default`：本机/单用户模式，调用方无需传 Principal。
- `trusted_gateway`：Gateway 必须在每个 Session 请求中传：

```http
X-Morphz-Principal: <stable-principal-id>
X-Morphz-Principal-Name: <optional-ascii-display-name>
```

Principal ID 必须来自 Gateway 已认证身份，不能由最终用户文本或模型输出推断。WebSocket 通常无法设置自定义 Header，因此使用：

```text
/ws?session_id=<id>&principal_id=<principal-id>&token=<service-token>
```

`principal_id` 与 Header 同时存在时必须一致。Principal 只能访问已绑定给自己的 Session。

Dashboard/Operator 管理令牌通过默认管理身份访问控制面，不允许借助 query 中的 `principal_id` 冒充某个最终用户发送消息。

`GET /api/overview` 是 Runtime Operator 的全局投影，只接受 Dashboard/Operator 管理令牌。在 `trusted_gateway` 模式下，Gateway 服务令牌即使携带合法 Principal 也会收到 `401`，不能借此枚举其他 Principal、Context 或 Session。

### 错误

稳定 SDK 错误形状：

```json
{
  "error": {
    "code": "invalid_argument | unauthorized | forbidden | not_found | conflict | internal",
    "message": "human-readable detail"
  }
}
```

部分较早的端点仍返回：

```json
{ "error": "human-readable detail" }
```

调用方必须同时兼容两种形状，并优先根据 HTTP 状态码处理：

- `400` 参数错误
- `401` token 或 Principal 缺失/无效
- `403` Principal 无权访问资源
- `404` 资源不存在
- `409` ID、状态或版本冲突
- `413` 消息正文或 HTTP Body 超过限制
- `500` Runtime 内部错误

## 3. 数据结构

### Session

```json
{
  "id": "session_123",
  "agent_id": "default-agent",
  "context_id": "default-context",
  "parent_session_id": null,
  "title": "接口测试",
  "status": "active",
  "created_at": "2026-07-28T00:00:00Z",
  "updated_at": "2026-07-28T00:00:00Z",
  "last_activity_at": "2026-07-28T00:00:00Z",
  "attention_state": "active",
  "attention_revision": 0
}
```

`status` 只能是 `active` 或 `archived`。归档 Session 不能接收新消息。

### Event

```json
{
  "id": "reply_...",
  "sequence": 42,
  "timestamp": "2026-07-28T00:00:01Z",
  "actor": "Agent-Morphz",
  "type": "agent_call",
  "topic": "chat/reply",
  "payload": {
    "context_id": "default-context",
    "session_id": "session_123",
    "root_turn_id": "...",
    "attempt_id": "...",
    "text": "最终答复"
  }
}
```

`sequence` 是持久 Event History 中单调递增的游标。调用方不应依赖未知字段缺失，也不应拒绝未知 `topic`。

对消息调用最重要的 topic：

- `chat/user_message`：已持久化的用户消息
- `chat/progress`：非终态进度
- `chat/reply`：成功终态；答复正文在 `payload.text`
- `chat/no_reply`：成功完成但没有面向用户的答复
- `chat/runtime_error`：执行错误；错误详情通常在 `payload.error`
- `runtime/model_stream`：瞬态模型文本增量，仅用于 UI，不能当作持久最终答复
- `runtime/model_attempt_state`：模型尝试状态/重连快照

用 `root_turn_id` 关联同一逻辑用户回合，不要假设 Session 同一时间只有一个回合。

## 4. 核心端点

### 健康检查

```http
GET /health
```

成功返回 `200`，无 JSON 契约。

### 创建 Context

```http
POST /api/contexts
```

```json
{
  "id": "optional-context-id",
  "agent_id": "optional-agent-id",
  "title": "optional title"
}
```

成功返回 `201` 和 Context 对象。通常不必单独创建 Context；创建 Session 时可通过 `mount` 创建。

### 创建 Session

```http
POST /api/sessions
```

最简单请求（挂到服务的默认 Context）：

```json
{ "title": "My session" }
```

挂到已有 Context：

```json
{
  "id": "optional-session-id",
  "title": "My session",
  "mount": {
    "type": "existing_context",
    "context_id": "context_123"
  }
}
```

创建新的空白 Context：

```json
{
  "title": "Isolated session",
  "mount": {
    "type": "new_blank_context",
    "context_id": "optional-context-id",
    "context_title": "optional title"
  }
}
```

从已有 Mind snapshot 派生隔离 Context：

```json
{
  "title": "Forked session",
  "mount": {
    "type": "new_context_from_mind",
    "source_context_id": "context_123",
    "source_version": 7,
    "context_id": "optional-new-context-id",
    "context_title": "optional title"
  }
}
```

`source_version` 可用于乐观并发保护；与当前 Mind 版本不一致时返回 `409`。成功返回 `201` 和 Session 对象。

### 列出、读取和更新 Session

```http
GET /api/sessions?include_archived=false
```

```json
{ "sessions": [/* Session */] }
```

```http
GET /api/sessions/{session_id}
PATCH /api/sessions/{session_id}
```

PATCH Body：

```json
{
  "title": "new title",
  "status": "active | archived"
}
```

### 发送消息

```http
POST /api/sessions/{session_id}/messages
```

纯文本消息：

```json
{
  "text": "请分析这个问题",
  "client_message_id": "caller-generated-unique-id",
  "dispatch_mode": "parallel"
}
```

带图片的消息：

```json
{
  "text": "请描述这张图",
  "client_message_id": "caller-generated-unique-id",
  "attachments": [
    {
      "name": "diagram.png",
      "media_type": "image/png",
      "data_base64": "iVBORw0KGgoAAA..."
    }
  ]
}
```

引用已有 Session 的消息：

```json
{
  "text": "把这个需求同步给 @开发",
  "client_message_id": "caller-generated-unique-id",
  "references": [
    {
      "kind": "session",
      "session_id": "session-stable-id"
    }
  ]
}
```

也可直接传完整 Data URL；服务会剥离 `data:*;base64,` 前缀：

```json
{
  "text": "",
  "client_message_id": "image-only-0001",
  "attachments": [
    {
      "name": "photo.jpg",
      "media_type": "image/jpeg",
      "data_base64": "data:image/jpeg;base64,/9j/4AAQSk..."
    }
  ]
}
```

规则：

- `text` 最多 1,000,000 字符；正文、附件与引用不能同时为空，因此允许纯附件或纯引用消息。
- 强烈建议始终提供 `client_message_id`。
- 首次接受返回 `202 Accepted`。
- 使用同一个 `client_message_id` 重试时返回同一个逻辑消息的 `200 OK`，且 `duplicate: true`。
- 不要因为 HTTP 超时就生成新 ID；先用原 ID重试，否则可能产生两个回合。
- `dispatch_mode` 可省略；省略时使用 Runtime 配置的默认行为。显式值为：
  - `interrupt`：前一轮仍处于纯模型思考阶段时原子替换它；若已经形成物理执行，则本轮并发运行；
  - `parallel`：立即创建独立 DialogueTurn，并绕过当前 Session 的串行对话通道；
  - `follow_up`：创建独立 DialogueTurn，等待紧邻的上一条用户消息达到终态并完成用户可见交付后再运行。
- 发送模式是单次请求属性；它不会修改 Runtime 的默认配置，并会固化在 `chat/user_message` Event 中以保证重放语义稳定。
- `references` 是稳定、结构化的对象引用。当前只支持 `{ "kind": "session", "session_id": "..." }`，单条消息最多 64 个；Runtime 会重新校验 Principal 可见范围、同 Agent 边界和归档状态，并在 Event 中补齐权威标题、Context 和 Agent 信息。
- Session 引用不读取目标 Session 的消息历史，不导入另一 Context 的 Mind，不激活目标，也不创建 Session；它只向当前 Agent 提供可用于 `send_message` / `session_signal` 的稳定身份。
- `attachments` 可省略，最多 8 个。
- 单个附件解码后最多 20 MiB，一条消息的附件解码后合计最多 40 MiB。
- `name` 不能为空，最长 255 个字符。服务只保留文件名部分，例如 `../diagram.png` 会归一化为 `diagram.png`。
- `media_type` 为空时按 `application/octet-stream` 处理；最长 128 个字符，只允许 ASCII 字母、数字和 `/ . + -`。
- `data_base64` 必须是标准 Base64，或带 `data:*;base64,` 前缀的 Data URL。
- HTTP JSON Body 上限为 64 MiB。Base64 会比原始文件约增大三分之一，调用方仍需同时满足 Body 和解码后附件限制。

图片没有单独的上传端点，也不使用 `multipart/form-data`；它与消息一起作为 JSON Base64 附件提交。当前附件机制也接受非图片文件，但能否被模型直接理解取决于所用模型和 Provider。

响应：

```json
{
  "accepted": true,
  "duplicate": false,
  "interrupted": false,
  "dispatch_mode": "parallel",
  "event_id": "message-event-id",
  "client_message_id": "caller-generated-unique-id"
}
```

此响应不是模型最终答复。

成功持久化后，对应 `chat/user_message` Event 的 `payload.attachments` 只包含元数据，不包含原始 Base64：

```json
{
  "attachments": [
    {
      "id": "attachment_<sha256>",
      "name": "diagram.png",
      "media_type": "image/png",
      "size_bytes": 12345,
      "sha256": "<hex-digest>",
      "storage_path": "<runtime-managed-path>"
    }
  ]
}
```

`storage_path` 是 Runtime 内部路径，不是公共下载 URL；外部客户端不应依赖它。附件字节按摘要存到配置的 artifact 目录，Event History 不保存附件原文。

`payload.references` 保存 Runtime 校验后的稳定引用和发送时的展示快照：

```json
{
  "references": [
    {
      "kind": "session",
      "session_id": "session-stable-id",
      "title": "开发",
      "context_id": "context-stable-id",
      "agent_id": "agent-stable-id"
    }
  ]
}
```

后续重命名只改变目录中的展示标题，不改变已经持久化的 `session_id` 指向。

### 读取 Event History

向前增量读取：

```http
GET /api/sessions/{session_id}/events?after_sequence=41&limit=200
```

向后翻历史：

```http
GET /api/sessions/{session_id}/events?before_sequence=1000&limit=200
```

`after_sequence` 和 `before_sequence` 互斥。`limit` 默认为 100，范围被限制在 `1..=1000`。

```json
{
  "events": [/* Event */],
  "next_before_sequence": 800
}
```

增量消费算法：

1. 将本地 `last_sequence` 初始设为 `0`。
2. 请求 `after_sequence=last_sequence`。
3. 按 `sequence` 处理事件，并更新最大值。
4. 没有终态时继续轮询（建议带退避和整体超时）。
5. 收到目标回合的 `chat/reply`、`chat/no_reply` 或明确失败事件后停止等待。

### WebSocket 实时事件

```text
ws://127.0.0.1:8080/ws?session_id=session_123
```

服务器发送的每个 text frame 都是一个完整 Event JSON。连接建立时可能先发送 `runtime/model_attempt_state` 快照，随后发送实时事件。

正确恢复策略：

- WebSocket 用于降低延迟。
- Event History 用于权威补漏和重连。
- 连接关闭时丢弃未完成的 `runtime/model_stream` 草稿。
- 以最后持久化的 `sequence` 调用 HTTP events 补齐，再重连。

### 取消 Session 当前执行

```http
POST /api/sessions/{session_id}/cancel
```

```json
{ "cancelled": true, "was_running": true }
```

取消是协作式的；`was_running: false` 表示当时没有运行中的前台执行。

### 读取 Context（诊断用途）

```http
GET /api/sessions/{session_id}/context
GET /api/sessions/{session_id}/context/projection
GET /api/sessions/{session_id}/context/encoding
```

`encoding` 端点返回：

```json
{
  "context_id": "context_123",
  "session_id": "session_123",
  "mind_revision": 7,
  "encoding": "(morphz-context ...)"
}
```

这些接口适合诊断和审计，不应成为发送消息的前置依赖。

### Runtime 全局 Overview（Operator）

```http
GET /api/overview
```

可选 query：

| 参数 | 默认值 | 最大值 | 含义 |
|---|---:|---:|---|
| `include_archived` | `false` | — | 是否包含已归档 Context 和 Session |
| `context_limit` | `40` | `100` | 本次返回的 Context 上限 |
| `sessions_per_context` | `6` | `20` | 每个 Context 展示的 Session 卡片上限 |

示例：

```http
GET /api/overview?context_limit=40&sessions_per_context=6
Authorization: Bearer <dashboard-operator-token>
```

响应是一个有界、只读的 Runtime 权威投影：

```json
{
  "generated_at": "2026-07-31T08:00:00Z",
  "summary": {
    "contexts": 2,
    "active_sessions": 4,
    "total_sessions": 7,
    "objectives": 3,
    "open_threads": 5,
    "running_activations": 2,
    "attention_required": 1
  },
  "contexts": [
    {
      "context": {
        "id": "context_123",
        "agent_id": "default-agent",
        "title": "产品开发",
        "status": "active"
      },
      "mind_revision": 42,
      "delegation": null,
      "active_session_count": 3,
      "total_session_count": 5,
      "hidden_session_count": 1,
      "objective_count": 2,
      "open_thread_count": 3,
      "running_activation_count": 1,
      "attention_count": 1,
      "last_activity_at": "2026-07-31T07:59:00Z",
      "sessions": [
        {
          "session": {
            "id": "session_123",
            "agent_id": "default-agent",
            "context_id": "context_123",
            "title": "修复发布流程",
            "status": "active",
            "last_activity_at": "2026-07-31T07:59:00Z"
          },
          "principal_ids": ["principal-default"],
          "state": "running",
          "attention_required": false,
          "pending_dialogue_turns": 0,
          "open_thread_count": 1,
          "running_activation_count": 1,
          "current_thread": {
            "id": "thread_123",
            "kind": "execution",
            "phase": "running",
            "control_state": "active",
            "objective_id": "objective_123",
            "target_id": "target-default",
            "updated_at": "2026-07-31T07:59:00Z"
          },
          "current_objective": {
            "id": "objective_123",
            "stated_objective": "完成发布流程修复",
            "status": "active",
            "status_reason": null,
            "wait_condition": null,
            "revision": 7,
            "updated_at": "2026-07-31T07:58:00Z"
          }
        }
      ]
    }
  ],
  "has_more_contexts": false
}
```

约定：

- `state` 为 `needs_attention | waiting_user | running | queued | paused | waiting | idle`。
- Context 和 Session 按“需要用户关注、正在执行、已排队、存在开放目标/线程、最近活动”依次排序，而不是仅按创建时间或标题排序。
- `hidden_session_count` 表示该 Context 中未进入本次 Session 卡片窗口的数量；`has_more_contexts` 表示还有未进入本次 Context 窗口的数据。
- `delegation` 非空表示该 Context 是副 Agent 的子 Context，并给出父 Context、父 Session、子 Session、任务和 Delegation 状态。Dashboard 可以据此把它收束到父 Context，但 API 保留完整记录。
- Summary 和 Context 计数来自存储层权威投影；接口不会逐卡扫描 Event History，也不会为每张卡片单独查询数据库。
- 该接口用于全局指挥台、运维控制台和管理 SDK，不属于 Principal-scoped Web App 接口。外部 Gateway 应继续使用自己的 Session 目录，不应调用该端点。
- Rust SDK 对应方法为 `MorphzSdk::runtime_overview(RuntimeOverviewQuery)`；当前 TypeScript v1 Client 尚未封装该 Operator 端点。

### 托管凭证（Operator）

以下接口只接受 Dashboard/Operator 管理令牌。`trusted_gateway` 服务令牌即使携带合法 Principal 也无权读取或修改凭证目录。

```http
GET    /api/runtime/secrets
POST   /api/runtime/secrets
POST   /api/runtime/secrets/import
GET    /api/runtime/secrets/scope-options
DELETE /api/runtime/secrets/{name}
```

读取响应只包含凭证别名和非敏感元数据：

```json
{
  "secrets": [
    {
      "name": "DEPLOY_TOKEN",
      "secret_ref": "secret://runtime/DEPLOY_TOKEN",
      "scope_kind": "runtime",
      "value_backend": "macos_keychain",
      "created_at": "2026-07-31T08:00:00Z",
      "updated_at": "2026-07-31T08:00:00Z"
    }
  ],
  "default_value_backend": "macos_keychain",
  "backends": [
    {
      "id": "macos_keychain",
      "storage_kind": "native_keyring",
      "available": true,
      "writable": true,
      "supports_import": false,
      "detail": "macOS Keychain"
    },
    {
      "id": "morphz_env_file",
      "storage_kind": "host_env_file",
      "available": true,
      "writable": true,
      "supports_import": true,
      "detail": "$MORPHZ_HOME/.env"
    }
  ],
  "import_candidates": [
    {
      "name": "EXISTING_TOKEN",
      "value_backend": "morphz_env_file"
    }
  ],
  "recent_usage": []
}
```

写入或轮换一项凭证：

```http
POST /api/runtime/secrets
Content-Type: application/json

{
  "name": "DEPLOY_TOKEN",
  "value": "write-only-value",
  "scope_kind": "execution_target",
  "scope_id": "target-production",
  "value_backend": "morphz_env_file"
}
```

`value_backend` 可省略，此时使用 Runtime 默认后端。系统凭证库不可用时接口会明确失败，不会静默写入明文文件；无交互服务器必须显式选择 `morphz_env_file`。

已有 `$MORPHZ_HOME/.env`（或 `$MORPHZ_ENV_FILE`）变量必须显式导入后才能被 Agent 发现：

```http
POST /api/runtime/secrets/import
Content-Type: application/json

{
  "name": "EXISTING_TOKEN",
  "scope_kind": "context",
  "scope_id": "context_123",
  "value_backend": "morphz_env_file"
}
```

导入只把别名、作用域和值后端写入 Catalog，不复制或返回值。未导入的进程环境和 `.env` 变量名不会出现在模型可见的 `list_secrets` 结果中。

作用域可取 `runtime | context | session | objective | execution_target`。除 `runtime` 外必须提供 `scope_id`。Dashboard 使用 `GET /api/runtime/secrets/scope-options` 获取实体列表，避免要求 Operator 手抄内部 ID。

撤销：

```http
DELETE /api/runtime/secrets/DEPLOY_TOKEN
```

成功返回 `204`。删除会移除 Catalog 条目和其指定值后端中的值。API 不提供读取凭证原值的端点。

Rust SDK 对应方法：

- `secret_backend_statuses`
- `secret_import_candidates`
- `recent_secret_usage`
- `list_managed_secrets`
- `put_managed_secret_with_backend`
- `import_managed_secret`
- `delete_managed_secret`

完整安全模型见 `docs/morphz_secret_store_architecture_v2.md`。

## 5. 最小调用示例

```bash
BASE_URL=http://127.0.0.1:8080
TOKEN=replace-if-configured
PRINCIPAL=caller-identity

curl -sS "$BASE_URL/api/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Morphz-Principal: $PRINCIPAL" \
  -H "Content-Type: application/json" \
  -d '{"title":"agent integration"}'

curl -sS "$BASE_URL/api/sessions/session_123/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Morphz-Principal: $PRINCIPAL" \
  -H "Content-Type: application/json" \
  -d '{"text":"你好","client_message_id":"request-20260728-0001"}'

IMAGE_BASE64="$(base64 < diagram.png | tr -d '\n')"
curl -sS "$BASE_URL/api/sessions/session_123/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Morphz-Principal: $PRINCIPAL" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"text":"请分析这张图","client_message_id":"request-20260730-image-0001","attachments":[{"name":"diagram.png","media_type":"image/png","data_base64":"$IMAGE_BASE64"}]}
JSON

curl -sS "$BASE_URL/api/sessions/session_123/events?after_sequence=0&limit=200" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Morphz-Principal: $PRINCIPAL"
```

在 `default` 身份模式或未配置 token 时，应分别省略对应 Header，不要发送空 token。

## 6. 可直接交给另一个 AI agent 的任务描述

```text
你需要把 Morphz 当作异步 HTTP Session Runtime 调用。

Base URL 由 MORPHZ_BASE_URL 提供，默认 http://127.0.0.1:8080。
若 MORPHZ_TOKEN 非空，对所有 HTTP 请求发送 Authorization: Bearer <token>。
trusted_gateway 模式下该值必须是 Gateway 服务令牌，而不是 Dashboard/Operator 管理令牌。
若 MORPHZ_PRINCIPAL 非空，对 Session HTTP 请求发送 X-Morphz-Principal: <principal>；
WebSocket 则把 principal_id 和 token 放进 query string。

核心流程：
1. POST /api/sessions，body {"title":"..."}，保存响应的 id。
2. 每次发送消息都生成一个稳定的 client_message_id。
3. POST /api/sessions/{id}/messages，
   纯文本 body {"text":"...","client_message_id":"..."}；
   图片放进 attachments：
   [{"name":"image.png","media_type":"image/png","data_base64":"..."}]。
   最多 8 个附件，单个解码后 20 MiB、合计 40 MiB；也允许 text="" 的纯附件消息。
   202/200 仅表示已接受；网络失败必须复用同一个 client_message_id 重试。
4. 用 GET /api/sessions/{id}/events?after_sequence={cursor}&limit=200 读取事件，
   或订阅 /ws?session_id={id} 降低延迟。
5. 只把 topic=chat/reply 的 payload.text 当作最终文字答复；
   chat/progress 和 runtime/model_stream 都不是最终答复。
6. 用 event.sequence 保存持久游标。WebSocket 断线后通过 HTTP events 补漏。
7. 用 root_turn_id 区分并发回合；不要假设同一 Session 串行。
8. 兼容两种错误：{"error":"..."} 和
   {"error":{"code":"...","message":"..."}}。
9. 保留未知 JSON 字段并忽略未知 topic，以保证前向兼容。

完整字段契约见 docs/http_api_agent_contract_v1.md。
```

## 7. 当前文档状态与兼容边界

仓库原有资料：

- `docs/morphz_session_service_v1.md`：架构语义和端点概览。
- `docs/morphz_sdk_and_trusted_gateway_identity_v1.md`：SDK 与身份边界。
- `sdk/typescript/src/index.ts`：可用的 TypeScript Session Service v1 Client。

当前没有自动生成的 OpenAPI schema，也没有 Swagger UI。本文已于 2026-07-31 按当前路由、请求结构、Runtime 限制和测试重新核对；它仍是人工契约。TypeScript v1 Client 当前只封装纯文本 `sendMessage`，使用图片附件或 Operator Overview 时请直接调用对应 HTTP 端点。若需要让多语言 SDK 自动生成，下一步应把本文稳定接口面编码为 OpenAPI 3.1，并增加 CI 测试防止路由、schema 与实现漂移。
