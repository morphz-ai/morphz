# Morphz HTTP API：AI Agent 接入契约 v1

> 本文描述适合外部客户端和 AI agent 使用的稳定最小接口面：Context、Session、Message、Event 和单 Session WebSocket。  
> 实现依据：`morphz/src/web.rs`、`morphz/src/sdk.rs`、`sdk/typescript/src/index.ts`。  
> `/api/execution-*`、`/api/edge/*`、`/api/objectives`、Inspector/调度/记忆维护等端点属于内部控制面，不在本文的兼容性承诺内。

## 1. 给调用方的最短说明

Morphz 是异步会话 Runtime。调用方应：

1. 启动服务：`morphz serve`，默认地址 `http://127.0.0.1:8080`。
2. 创建或选择一个 Session。
3. 为每条用户消息生成唯一且可重试复用的 `client_message_id`。
4. `POST /api/sessions/{session_id}/messages`；`202` 只表示消息已接受，不表示模型已回答。
5. 使用事件轮询或 WebSocket 等待 `topic == "chat/reply"`，并读取 `payload.text`。
6. WebSocket 断线、丢事件或进程重启后，以 HTTP Event Ledger 作为权威恢复来源。

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

如果服务配置了访问令牌，HTTP 请求必须携带：

```http
Authorization: Bearer <service-token>
```

服务也接受 `?token=...`，主要供无法设置 Header 的 WebSocket 握手使用。不应在日志、提示词或普通错误信息中暴露 token。监听非 loopback 地址时，服务强制要求 token。

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
- `413` 消息超过 1,000,000 字符
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

`sequence` 是持久 Event Ledger 中单调递增的游标。调用方不应依赖未知字段缺失，也不应拒绝未知 `topic`。

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

```json
{
  "text": "请分析这个问题",
  "client_message_id": "caller-generated-unique-id"
}
```

规则：

- `text` 去除首尾空白后不可为空，最多 1,000,000 字符。
- 强烈建议始终提供 `client_message_id`。
- 首次接受返回 `202 Accepted`。
- 使用同一个 `client_message_id` 重试时返回同一个逻辑消息的 `200 OK`，且 `duplicate: true`。
- 不要因为 HTTP 超时就生成新 ID；先用原 ID重试，否则可能产生两个回合。

响应：

```json
{
  "accepted": true,
  "duplicate": false,
  "event_id": "message-event-id",
  "client_message_id": "caller-generated-unique-id"
}
```

此响应不是模型最终答复。

### 读取 Event Ledger

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
- Event Ledger 用于权威补漏和重连。
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
若 MORPHZ_PRINCIPAL 非空，对 Session HTTP 请求发送 X-Morphz-Principal: <principal>；
WebSocket 则把 principal_id 和 token 放进 query string。

核心流程：
1. POST /api/sessions，body {"title":"..."}，保存响应的 id。
2. 每次发送消息都生成一个稳定的 client_message_id。
3. POST /api/sessions/{id}/messages，
   body {"text":"...","client_message_id":"..."}。
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

当前没有自动生成的 OpenAPI schema，也没有 Swagger UI。本文是基于当前实现核对后的人工契约；若需要让多语言 SDK 自动生成，下一步应把本文稳定接口面编码为 OpenAPI 3.1，并增加 CI 测试防止路由、schema 与实现漂移。
