# Morphz Agent–Provider Account Authority v1

> 实现状态：已落地  
> 最后核对：2026-09-01

## 1. 目标

Morphz 的模型凭证属于 Agent 的运营者，而不是与 Agent 对话的 Principal。

同一个 Agent 可以接待任意数量的 Principal；这些 Principal 可能来自网页、微信、API Gateway 或其他入口。Principal 只表示“谁正在与 Agent 交互”，不会因此拥有、选择或提供该 Agent 的模型凭证。

## 2. 领域边界

| 对象 | 含义 | Provider 权限 |
| --- | --- | --- |
| Operator | 创建、运营和配置 Agent 的控制面主体 | 决定 Agent 可以使用哪些 Auth Account |
| Agent | 长期运行的认知主体 | 持有一组 Auth Account 关联 |
| Principal | 与 Agent 发生一次或多次交互的对话主体 | 不参与 Provider 路由 |
| Provider Instance | 模型服务端点、协议与模型目录 | 可供多个 Auth Account 使用 |
| Auth Account | 一次独立登录或 API Key 及其 Secret 引用 | 可关联到同一 Operator 的多个 Agent |
| Agent Provider Binding | `Agent ID -> Auth Account ID` 的持久授权 | 是模型求值时的强制过滤边界 |

当前 Runtime 是单 Operator 控制面，因此核心层不重复保存租户所有权。多租户 Cloud 必须在调用 Operator API 前验证“当前登录用户是否拥有该 Agent 和 Auth Account”；这一控制面鉴权不能下放给 Principal。

## 3. 选择语义

一次模型求值按以下顺序解析：

1. 由 `context_id` 读取持久 Context，并解析其 `agent_id`；
2. 读取该 Agent 的 Auth Account 绑定集合；
3. 在 Model Route 原有候选中，只保留绑定集合内的账号；
4. 再执行账号健康状态、冷却、优先级、LRU、模型 fallback 和 affinity 逻辑。

由此得到以下不变量：

- Principal ID 不出现在 Provider Account 选择路径中；
- 一个 Auth Account 可以同时关联多个 Agent，不复制凭证和登录状态；
- 一个 Agent 可以关联多个 Auth Account，继续使用既有故障转移能力；
- 持久 Agent 的绑定集合为空时，模型求值明确失败，不回退到 Runtime 全局账号；
- 数据面请求必须解析到持久 Context 和 Agent；未知 Context 不得绕过绑定边界；
- Operator 启动诊断和账号测试走独立控制面路径，不受某个 Agent 的数据面绑定限制；
- Auth Account 仍被任意 Agent 引用时，管理 API 拒绝删除该账号。

## 4. 关联与导入

规范操作是“关联”：多个 Agent ID 指向同一个 Auth Account ID，配置和凭证只有一份。

“导入”属于上层产品便利功能：它读取已有账号的非敏感配置，创建一个新的 Auth Account，并让用户重新选择或授权 Secret。导入得到的两个账号彼此独立，不自动同步。核心 Runtime 不把复制行为伪装成关联。

## 5. 自部署与 Cloud

### 自部署

- 升级前已经存在且尚无 Provider 策略的 Agent，在首次启动时一次性继承当前 Runtime Auth Accounts；
- 新创建的 Agent 从明确的空策略开始，需要 Operator 选择账号；
- 空策略已经持久化后，重启不会重新注入全局账号；
- Dashboard 新增 Provider Account 时，会把它关联到默认 Agent，保持单 Agent 自部署体验兼容。
- Dashboard 删除只被默认 Agent 使用的账号时，会先安全解除该关联；账号被其他 Agent 复用时仍要求 Operator 显式处理关联。

### Cloud

- 用户登录后是其 Agent 的 Operator，同时也可以是该 Agent 的一个 Principal；
- Cloud 控制面创建 Auth Account、保存 Secret，并把 Account 关联到用户拥有的 Agent；
- 该 Agent 后续可以接待其他 Principal，而无需、也不允许这些 Principal 提供 API Key；
- 同一 Operator 创建多个 Agent 时，可以复用同一个 Auth Account 关联。

## 6. 持久化与管理接口

持久化表：

- `agent_provider_binding_scopes`：保存 Agent 策略是否已经初始化及其 revision；
- `agent_provider_bindings`：保存 Agent 与 Auth Account 的多对多关联。

Operator HTTP API：

```text
GET    /api/agents/{agent_id}/provider-accounts
PUT    /api/agents/{agent_id}/provider-accounts/{account_id}
DELETE /api/agents/{agent_id}/provider-accounts/{account_id}
```

`PUT` 和 `DELETE` 都是幂等操作，返回完整的最新绑定集合。以上接口只接受 Runtime Operator 凭证；Cloud 面向最终用户的接口应在自身控制面完成租户所有权检查后再调用。
