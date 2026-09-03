# Morphz Provider、Model、OAuth 与多账号架构 v1

> 状态：v1 主干已实现（阶段 A—D）；五种计划内 OAuth Adapter 已完成本地契约验证，真实订阅冒烟仍需由 Operator 使用实际账号验证
> 日期：2026-08-01
> 关联文档：[Provider Conformance Suite](./provider_conformance_suite.md)、[CLI 产品化 v1](./morphz_cli_productization_v1.md)、[Secret Store 架构 v2](./morphz_secret_store_architecture_v2.md)

## 1. 背景

Morphz 的核心价值是 Agent Runtime：认知上下文、非确定性与确定性交错求值、Objective、Thread、调度、恢复、权限和 Execution Target。模型接入是 Runtime 必需的基础设施，但不是 Morphz 应无限扩张的产品中心。

当前实现已经支持四种线协议：

- OpenAI Responses；
- OpenAI Chat Completions；
- Anthropic Messages；
- Gemini generateContent。

用户可以通过兼容端点接入 OpenAI、Anthropic、Gemini、自建模型、CLIProxyAPI、OpenRouter 或其他 Gateway。这个入口已经足够覆盖大量 Provider，但仍存在三类缺口：

1. 普通用户没有 Gateway 时，无法直接使用 Codex、Claude、Kimi、Antigravity、xAI 等产品的 OAuth/订阅认证；
2. 当前一个 Provider 只引用一个 Credential，无法表达同一 OAuth 类型的多账号池；
3. 当前 `llm.provider + llm.model` 只是一次连接选择，尚未形成模型路由、账号选择、配额、冷却、亲和性和故障转移的统一模型。

因此需要建立一套克制但完整的 Provider 架构。

## 2. 核心决策

### 2.1 Morphz 不重造完整 CLIProxyAPI

Morphz 不实现一个对外暴露多种兼容 API 的通用模型网关，也不把 CLIProxyAPI、sub2api 或类似项目嵌入 Runtime。

完整 Gateway 通常还要承担：

- 入站 HTTP API Server；
- 多协议双向转换；
- 多租户管理接口；
- 网关级模型映射；
- Provider 池、账号池和配额管理；
- 面向第三方客户端的兼容行为；
- 独立部署、日志、审计和运维。

Morphz 是模型服务的客户端，只需要完成出站请求所必需的子集：

```text
登录或读取凭证
  → 选择 Provider 实例与账号
  → 组装一种原生或兼容协议请求
  → 消费流式响应
  → 归一化为 Runtime 事件
  → 记录 usage、健康状态与账号状态
```

已部署 Gateway 仍是一等接入方式，但 Morphz 只把它看作普通兼容 Provider：配置端点、协议和 API Key/无认证即可，不感知它是 CLIProxyAPI、OpenRouter 还是其他网关。

### 2.2 主流 OAuth 内置，长尾 Provider 通过协议复用

Morphz 原生支持一组克制的主流认证适配器，而不是追逐上百家 Provider：

- Codex OAuth；
- Anthropic/Claude OAuth；
- Kimi OAuth；
- Google/Antigravity OAuth；
- xAI OAuth；
- API Key、无认证和现有 Credential Helper；OpenRouter 等网关只通过这里的协议入口接入，不单列品牌登录。

这里的“内置”指 Morphz 维护认证生命周期和必要的 Provider 方言，不代表所有服务都获得同等稳定性承诺。每个适配器必须明确标注：

- `stable`：官方公开接口、已通过真实端点契约测试；
- `compatibility`：兼容已知客户端行为，需要持续跟踪上游；
- `experimental`：接口或条款不稳定，不作为默认入口。

长尾 Provider 优先通过现有四种协议接入。只有无法由“协议 + 端点 + Header + Auth Adapter + 显式 Quirk”表达的服务，才值得新增 Provider Adapter。

### 2.3 采用进程内 Rust Adapter，不默认引入 Go Sidecar

OAuth 与 Provider 客户端默认在 Morphz 进程内实现。理由是：

- 保持单二进制交付；
- Secret Store、usage、熔断和调度可以共享同一事实源；
- 不引入第二套配置、日志、升级和进程生命周期；
- Morphz 只实现客户端子集，代码规模显著小于完整 Gateway；
- Provider 行为可以直接进入现有 Conformance Suite。

Go Sidecar 不是架构禁区。如果未来某个高价值 Provider 只能可靠复用成熟 Go SDK，可以通过私有 IPC Adapter 实现，但它是例外部署形态，不是 Provider 架构的默认基础。

### 2.4 同一 OAuth 类型必须支持多账号

OAuth 类型、Provider 实例和登录账号是三个不同概念：

```text
OAuth Adapter: codex-oauth
Provider Instance: openai-subscription
Auth Accounts:
  - codex-personal
  - codex-team
  - codex-backup
```

同一个模型别名也可以由多个 Provider 实例、多个不同的物理模型名提供：

```text
model alias: gpt-5.6
  → openai-subscription / gpt-5.6
  → cliproxy-local / gpt-5.6-sol
  → openrouter / openai/gpt-5.6
```

调用方只引用稳定别名 `gpt-5.6`，不必知道当前候选 Provider 把同一个模型命名为 `gpt-5.6`、`gpt-5.6-sol` 还是 `openai/gpt-5.6`。别名背后的 Model Route 再完成 Provider、物理模型和账号选择。

所以不能再把 Credential 作为 Provider 的单一字段，也不能以 Provider ID 作为账号 ID。

### 2.5 v1 的实现边界

v1 已按同一 `AuthAdapter` 生命周期实现五种计划内 OAuth 服务：

- Codex：浏览器 Authorization Code + PKCE 为通用登录，Device Authorization 是需要上游显式启用、适合远程/无头环境的推荐选择，Responses 方言；
- Kimi Code：Device Authorization、Chat Completions 方言；
- Anthropic/Claude：Authorization Code + PKCE、本地回调、Anthropic Messages 方言；
- Google/Antigravity：Authorization Code + PKCE；内置桌面凭据使用本地回调，自有 Web OAuth 客户端可使用 Runtime HTTPS 回调；使用 Cloud Code `v1internal` 的项目发现、必要时的用户 onboarding、Agent 模型目录与 Gemini Content 请求方言；
- xAI：OIDC Discovery + Device Authorization、OpenAI 兼容方言。

这些 Adapter 已完成不依赖真实订阅的确定性登录、刷新、敏感字段隔离和请求物化测试。真实登录和模型端点冒烟必须由 Operator 使用自己的账号完成，不能用假账号、静态展示数据或个人订阅作为 CI 依赖。OpenRouter、CLIProxyAPI 和其他 Gateway 继续通过四种兼容协议与 API Key/无认证方式接入，不需要 Morphz 感知网关产品本身。

Provider Instance、Auth Account、Model Route、Alias、多账号调度、Secret Store 与 Operator 控制面已经按统一结构实现。后续新增服务只属于兼容层增量，不能复制第二套 Token 生命周期或改变 Runtime 的领域模型。

## 3. 设计原则

### 3.1 分离五个维度

| 维度 | 回答的问题 | 示例 |
|---|---|---|
| Protocol | HTTP/SSE 的物理语义是什么 | `openai-responses` |
| Provider Adapter | 该服务有哪些端点、Header、模型目录和方言 | `openai-codex` |
| Provider Instance | 当前部署连接到哪里、采用什么配置 | `codex-subscription` |
| Auth Account | 使用哪一个实际登录身份 | `codex-personal` |
| Model Alias / Route | 稳定别名如何解析为 Provider、物理模型和账号 | `gpt-5.6` |

这五层不能再由一个 `[providers.<id>]` 对象隐式承担。

### 3.2 认证不决定协议，模型名不猜测协议

OAuth 只负责证明身份和产生请求所需的授权材料；Protocol Adapter 负责请求与响应语义；Provider Adapter 负责二者之间的服务特定组合。

禁止根据模型名推断协议。例如 `claude-*` 不必然意味着 Anthropic Messages，兼容网关也可能通过 OpenAI Responses 暴露同一个逻辑模型。

### 3.3 模型目录是能力信息，不是请求许可名单

远端模型目录、内置快照和手工配置都可能滞后。新模型上线时，OAuth 登录成功不等于 Morphz 自动知道模型名。

模型目录的可信顺序为：

1. Provider 当前返回的模型目录；
2. Operator 显式配置；
3. Morphz 内置、带版本的 Catalog；
4. 社区数据源和兼容补丁。

目录中没有某个模型时，Operator 仍可显式填写准确模型名并执行 `provider test`。Morphz 不使用过期的内置 allowlist 阻止请求。

### 3.4 OAuth 是可维护兼容层，不是一次性登录页面

OAuth Adapter 至少要处理：

- Authorization Code + PKCE 或 Device Authorization；
- 本地回调、设备码或手工回填；
- Access Token 到期判断；
- Refresh Token 轮换；
- 并发刷新串行化；
- Scope 与资源标识；
- 服务特定 Header、Client Metadata 和 Account ID；
- 撤销、失效和重新登录；
- 上游接口变化后的兼容测试。

这解释了为什么新模型或服务更新有时要求 CLIProxyAPI 升级：问题往往不只是模型目录，还可能是端点、Header、Scope、请求字段或流事件发生变化。

## 4. 目标领域模型

```text
ModelRoute
├── id
├── aliases[]
├── candidates[]
├── selection_policy
├── affinity_policy
└── fallback_policy
       │
       ▼
ProviderInstance
├── id
├── adapter_id
├── protocol_id
├── endpoint
├── model_mapping
├── account_pool[]
├── static configuration
└── capability overrides
       │
       ▼
AuthAccount
├── id
├── auth_adapter_id
├── credential_ref
├── subject metadata
├── status
├── quota state
├── cooldown
├── last_error
└── revision
```

### 4.1 ProtocolAdapter

负责线协议，不关心账号池：

```rust
trait ProtocolAdapter {
    fn build_request(&self, request: NormalizedModelRequest) -> HttpRequest;
    fn decode_stream(&self, response: HttpResponse) -> NormalizedModelStream;
    fn classify_error(&self, response: HttpResponse) -> ProviderFailure;
}
```

它把 Provider 原始响应归一化为 Morphz 已有的：

- text/reasoning delta；
- tool call；
- usage；
- finish reason；
- Provider 协议状态；
- 明确的失败分类。

### 4.2 AuthAdapter

负责某一种认证机制：

```rust
trait AuthAdapter {
    fn login(&self, request: LoginRequest) -> LoginFlow;
    fn refresh(&self, account: &AuthAccount) -> RefreshedCredential;
    fn materialize(&self, account: &AuthAccount) -> RequestAuthorization;
    fn revoke(&self, account: &AuthAccount) -> Result<()>;
}
```

`RequestAuthorization` 只能进入物理 HTTP 请求，不能进入 Prompt、Session、Mind、Event History 或普通日志。

#### 4.2.1 Device Authorization 的实际语义

Device Flow 不是把用户设备变成服务器，也不是让 Morphz 保存用户密码。流程是：

1. Morphz 向 Provider 申请短期 `device_code` 和可展示的 `user_code`；
2. 用户在任意已登录浏览器打开 Provider 的验证地址，输入 `user_code` 并批准；
3. Morphz 使用仅存在于当前进程内存中的 `device_code` 有界轮询 Token Endpoint；
4. Provider 在批准前返回 `authorization_pending`，批准后才签发 Access/Refresh Token；
5. 认证成功后才把 Token、账号、Provider 和 Route 作为一个完成边界提交；任一步失败都会回滚本次结果。

它特别适合 SSH、无 GUI 服务器和远程 Dashboard，因为浏览器不需要与 Morphz 运行在同一台机器。`user_code` 是短期配对码，不是长期凭证；过期、拒绝和慢速轮询都必须作为明确状态处理。Codex 官方目前把 Device Code（beta）列为无头设备首选，但个人账号需要先在 ChatGPT 安全设置中启用，工作区账号也可能需要管理员开放权限。因此 Morphz 把它显示为明确的“远程推荐”选择；启动失败时保留浏览器回调方案，不做不可见的静默降级。

#### 4.2.2 Authorization Code 回调的部署语义

Authorization Code + PKCE 必须显式区分三种回调能力：

- `loopback`：OAuth 客户端注册的是 `http://localhost:<port>/...`。浏览器把结果发送给“浏览器所在机器”的 loopback；只有浏览器与 Runtime 同机，或 Operator 建立了对应端口转发时，Runtime 才能自动收到回调。远程 Dashboard 可以把浏览器最终打开的完整回调 URL 粘贴回 Runtime，由 Runtime 校验 `state` 后交换 Token；不能把 `localhost` 直接替换成服务器 IP。
- `runtime`：OAuth 客户端注册的是 Runtime 的公开 HTTPS 地址。Provider 会直接回到 `/api/runtime/providers/oauth/callback`，控制面随后轮询同一个 Runtime 完成登录。
- `none`：Device Authorization 等不需要浏览器回调的流程。

`state` 是短期、一次性的回调能力。公开回调不使用 Dashboard Bearer Token，只接受当前 Runtime 已登记且未过期的 `state`，首次提交后立即失效；授权码、错误正文和 Token 均不得写入 URL 日志或持久化到浏览器。

远程部署的 `loopback` 界面必须给 Operator 四种可执行选择，而不是只报告 localhost 不可达：

1. Provider 支持且账号已启用时，优先改用 Device Code：Dashboard 展示一次性设备码和复制按钮，用户在任意浏览器输入，Runtime 轮询完成；不会产生 localhost 跳转。
2. Morphz 主机有图形桌面时，复制授权链接并在该主机的浏览器打开，回调自动进入本机 Runtime；Dashboard 不从远程 HTTP 请求擅自启动服务器 GUI 进程，因为它通常没有可复用的桌面会话。
3. 在访问端先执行 `ssh -N -L <port>:127.0.0.1:<port> <user>@<morphz-host>`，再在访问端浏览器授权；访问端的 localhost 会通过隧道进入 Runtime，自动完成登录。
4. 不建立隧道时，在浏览器到达 `http://localhost:<port>/...?code=...&state=...` 后复制**地址栏中的完整 URL**，即使页面显示连接被拒绝也不影响授权结果；Dashboard 可以从剪贴板读取并立即提交，也必须保留手工粘贴入口。

第 4 条使用全局、需要 Operator 身份的回填入口。服务端先从 URL 解析 `state`，再按 `state` 找回当前进程内创建该授权链接的短期内存上下文，包括 `login_id`、PKCE verifier 和 Adapter；不能用当前弹窗或当前页面保存的 `login_id` 代替这一步。这样即使 Dashboard 刷新、用户打开了新弹窗，旧回调也只会完成它所属的登录，或在过期后被明确拒绝，而不会产生含糊的 state 校验失败。CLIProxyAPI 的远程管理界面采用的也是这种“完整 redirect URL → 全局 callback endpoint → state 关联短期登录上下文”的交接方式。

桌面 OAuth 客户端的 redirect URI 由 Provider 的 allow-list 固定，不能通过运行时配置变成公网地址。Antigravity 只有在 Operator 同时配置下列三项、并在 Google Cloud 为该 Web OAuth 客户端精确注册生成的回调 URI 后，才切换为 `runtime`：

- `MORPHZ_OAUTH_PUBLIC_BASE_URL`：外部可访问的 HTTPS 基地址；
- `MORPHZ_ANTIGRAVITY_OAUTH_CLIENT_ID`：Operator 自有 Web OAuth Client ID；
- `MORPHZ_ANTIGRAVITY_OAUTH_CLIENT_SECRET`：对应 Client Secret。

任意一项缺失都会拒绝启动该登录，而不是退回一个看似可用但无法到达的回调地址。Codex Browser Flow 的公共 CLI 客户端目前只允许 `http://localhost:1455/auth/callback`，所以远程部署优先使用已启用的 Device Code；Browser Flow 则使用同机浏览器、SSH 端口转发或完整回调 URL 交接，不能伪装成 Runtime 公网回调。

### 4.3 ProviderAdapter

Provider Adapter 是薄组合层：

```text
ProviderAdapter
  = ProtocolAdapter
  + AuthAdapter compatibility
  + endpoint rules
  + model catalog strategy
  + provider-specific quirks
```

它不拥有 Runtime 调度，也不自行实现一个账号负载均衡器。

### 4.4 AuthAccount

账号是可独立健康检查、刷新、冷却和撤销的资源。推荐状态：

```text
ready
refreshing
rate_limited
quota_exhausted
cooldown
invalid
revoked
disabled
```

Auth Account 只在登录完成后成立。授权链接、PKCE verifier、Device Code、轮询间隔和 `state` 只存在当前进程内存，不写入数据库、Secret Store、配置文件或其他磁盘状态；取消、失败、超时或进程重启后不留下账号和待完成记录。认证成功后，账号元数据和运行状态才可以持久化；Access Token、Refresh Token 和敏感 Cookie 只存在 Secret Store 的值后端。

### 4.5 Model Alias 与 ModelRoute

Model Alias 是 Agent、用户、Profile 和 Evaluation 引用的稳定逻辑名称；Model Route 是该别名背后的解析与调度规则。

```text
alias: gpt-5.6
  candidate 1: codex-subscription / gpt-5.6
  candidate 2: cliproxy-local / gpt-5.6-sol
  candidate 3: openrouter / openai/gpt-5.6
```

因此，`gpt-5.6` 在 Morphz 中不是某一家 Provider 的物理模型名，而可以是 Operator 定义的统一入口。不同 Provider 可以使用完全不同的物理名称。

Runtime 求值引用模型别名，而不是直接依赖某个 Provider 或 OAuth 账号：

```text
Evaluation Profile
  → Model Alias
  → ModelRoute
  → Provider candidate
  → Physical model
  → Auth account
  → Model Attempt immutable binding
```

路由解析遵守以下规则：

1. 一个别名在同一有效配置中只能归属于一个 Model Route；
2. 一个 Route 可以暴露多个同义别名，但别名不能继续指向别名，避免链式解析和循环；
3. 每个 Candidate 必须显式声明 `provider + physical_model`，不得根据别名猜测 Provider 物理模型名；
4. 普通 Evaluation 只使用别名；直接指定 Provider 和物理模型是 Operator 诊断/测试能力；
5. Route 的 affinity、优先级和 fallback 是别名的一部分，不由 Provider Catalog 暗中改变；
6. 路由修订后只影响新 Attempt，已经建立的 Attempt Binding 保持不变。

同义别名只适合真正等价的入口。例如 `gpt-5.6` 和 `gpt56` 可以共享一个 Route；`coding-primary` 如果具有不同候选优先级、推理强度或故障转移策略，就应是独立 Route，而不是简单同义词。

### 4.6 能力约束与别名解析

同一别名下的候选可能具有不同能力。Runtime 不能因为某个候选支持图片，就宣称该别名的所有请求都一定支持图片。

每次解析必须先根据请求需要过滤 Candidate：

```text
Model Alias
  + required capabilities (vision, tools, reasoning, context limit...)
  → eligible candidates
  → selection policy
  → immutable binding
```

Dashboard 可以同时展示：

- **保证能力**：所有可用 Candidate 的能力交集；
- **可选能力**：至少一个 Candidate 支持的能力并集；
- **本次绑定能力**：当前 Attempt 最终选中 Candidate 的准确能力。

Context window、价格、缓存语义和 usage 也以最终物理 Candidate 为准。别名只能提供路由前的预估范围，不能抹平 Provider 之间的物理差异。

一旦 Model Attempt 建立，必须冻结：

- 请求使用的模型别名与 Route revision；
- Provider Instance；
- Auth Account；
- 物理模型名；
- Protocol Adapter 版本；
- Provider Adapter 版本；
- Endpoint；
- 能力快照。

重试不能在不留下事实记录的情况下偷换账号或 Provider。

## 5. 多账号选择与故障转移

### 5.1 默认选择策略

默认采用“可用性过滤 + 稳定亲和 + 最少近期负载”：

1. 排除 disabled、invalid、revoked、quota_exhausted 和未结束 cooldown 的账号；
2. 优先复用当前 Context/Objective 已建立的账号亲和，减少行为和缓存漂移；
3. 在可选账号中选择近期并发较少且最久未使用的账号；
4. 记录不可变的 Attempt Binding。

不使用纯随机轮询。模型订阅账号可能具有不同能力、配额、区域和行为，频繁切换会降低可复现性。

### 5.2 亲和性层级

建议支持：

- `none`：每次独立选择；
- `session`：同一 Session 优先使用相同账号；
- `context`：同一共享认知 Context 优先使用相同账号；
- `objective`：长程 Objective 内保持账号稳定；
- `explicit`：Operator 固定账号。

默认采用 `context` 或 `objective`，具体由 Model Route 配置决定。

### 5.3 失败分类

| 失败 | 当前 Attempt | 账号状态 | Route 行为 |
|---|---|---|---|
| Access Token 过期 | 串行刷新后重试一次 | `refreshing → ready/invalid` | 不立刻换账号 |
| 明确额度耗尽 | 终止 | `quota_exhausted` | 可选择下一账号 |
| 429 临时限流 | 按 Retry-After 冷却 | `rate_limited/cooldown` | 可选择下一账号 |
| 首字节超时 | 终止当前 Attempt | 账号不直接判死 | 请求级退避或换候选 |
| 流中断 | 保留已收到内容并显式失败/续接 | 不自动重放 | 禁止静默换账号重放 |
| 401/403 且刷新无效 | 终止 | `invalid` | 需要重新登录或换账号 |
| Provider 5xx/网络错误 | 请求级退避 | 保留账号健康证据 | 达阈值后切实例 |

只有在尚未消费任何模型输出时，才允许透明地把一次请求重新发给其他账号或 Provider。已经收到正文、reasoning 或工具调用后，自动重放可能造成重复副作用，必须进入明确的续接或失败恢复路径。

### 5.4 熔断作用域

熔断不能再只按“端点 + 模型”粗粒度共享。至少区分：

```text
endpoint health        服务总体健康
provider instance      实例配置健康
auth account           单账号认证/额度健康
model capability       单模型可用性
request class          大 Context 与小健康探针
```

单个超大 Context 首字节慢、单账号额度耗尽或单模型不可用，不能封锁同端点下所有账号和所有 Session。

## 6. Credential 与 Secret Store 集成

OAuth 不新建第二套 Secret Store。

### 6.1 Catalog 中保存

- Account ID；
- Auth Adapter ID 与版本；
- Provider Instance ID；
- 非敏感 subject/account label；
- Scope 与创建时间；
- credential locator；
- token expiry 等可公开运行元数据；
- 状态、冷却和最近错误分类。

### 6.2 值后端中保存

- Access Token；
- Refresh Token；
- ID Token（若确有必要）；
- Provider 要求的敏感 Cookie 或会话材料；

PKCE verifier、Device Code 与回调 `state` 不属于值后端：v1 不恢复未完成登录，所有这些材料只在进程内短期存在。

### 6.3 禁止保存的位置

- `morphz.toml` 或 `models.toml`；
- Event History payload；
- Context Encoding；
- Mind Frame；
- Dashboard Local Storage；
- 普通日志；
- Model tool arguments。

Headless 环境可以显式选择 Morphz `.env` 或企业 Secret Backend，但 OAuth Refresh Token 默认应使用系统凭证库或受管 Secret Backend；不得因 Keychain 不可用而静默写入明文文件。

## 7. 配置模型

Runtime 核心配置位于 `~/.morphz/morphz.toml`；Provider、Account、Model Route 与推理
配置位于 `~/.morphz/models.toml`。模型文件使用面向操作者的
`accounts / services / models / targets`；Runtime 内部仍可把 Target 称为
Candidate，但该术语不泄漏到配置文件：

```toml
[llm]
model = "cliproxy-default"
allowed_evaluation_models = ["gpt-5-6"]

[services.codex-subscription]
adapter = "openai-codex"
protocol = "openai-responses"
base_url = "https://chatgpt.com/backend-api/codex"
accounts = ["codex-personal", "codex-team"]

[accounts.codex-personal]
auth_adapter = "codex-oauth"
credential_ref = "oauth/codex-personal"

[accounts.codex-team]
auth_adapter = "codex-oauth"
credential_ref = "oauth/codex-team"

[services.cliproxy-local]
adapter = "openai-compatible"
protocol = "openai-responses"
base_url = "http://127.0.0.1:8317/v1"
accounts = ["cliproxy-local-key"]

[accounts.cliproxy-local-key]
auth_adapter = "api-key"
credential_ref = "provider/cliproxy-local"

# 单个调用目标直接写在模型表中，不需要数组或默认策略字段。
[models.cliproxy-default]
service = "cliproxy-local"
account = "cliproxy-local-key"
physical_model = "gpt-5.6-sol"

# 多目标模型才展开 targets，并声明非默认路由策略。
[models.gpt-5-6]
aliases = ["gpt-5.6"]
stickiness = "objective"
strategy = "least-recently-used"

[[models.gpt-5-6.targets]]
service = "codex-subscription"
physical_model = "gpt-5.6"
priority = 10

[[models.gpt-5-6.targets]]
service = "cliproxy-local"
physical_model = "gpt-5.6-sol"
priority = 20

[[models.gpt-5-6.targets]]
service = "openrouter"
physical_model = "openai/gpt-5.6"
priority = 30
```

`model` 是 Runtime 主模型，也是所有未显式选模求值的最终默认值。主模型始终允许 Agent
使用；`allowed_evaluation_models` 只增加 Agent 在 `infer`、`schedule_tx` 等委托求值中
显式选择其他 Route 的权限，空数组不授予额外模型。Operator 为 Session 选择模型属于控制面，
只要求 Route 已启用，不受该 Agent allowlist 限制。

普通 Evaluation 的模型解析优先级为：本次 Evaluation 的显式选择（包括 Schedule 持久选择）
→ Session 选择 → Runtime 主模型。`infer` 是当前求值内发起的独立子求值：显式指定时使用所选
Route，省略时使用 Runtime 主模型，不隐式继承 Session。解析结果在 Activation 首次执行前
持久化；重启、续接与同模型内的账号故障转移继续使用这条逻辑 Route，不自动切换到不同模型。

配置只描述静态意图。账号的动态配额、cooldown、refresh lease 和健康状态属于 Runtime Projection，不回写为配置事实。

Morphz 尚未发布，不保留当前单 Credential 模型的双重长期语义。实施时允许一次性配置迁移，但最终只能存在一套权威模型。

## 8. Model Catalog 与能力声明

### 8.1 Catalog 合并

```text
embedded catalog snapshot
  + remote provider model list
  + operator model declaration
  + compatibility patches
  → effective model catalog
```

每个条目至少包含：

- Provider 接受的精确模型名；
- 逻辑展示名；
- Context window、最大输入和最大输出；
- reasoning 控制能力；
- 图片/音频/文件输入能力；
- tool call 与并行 tool call；
- usage/cached usage 字段；
- 已验证的协议与 Adapter 版本；
- 信息来源和更新时间。

### 8.2 新模型发现

OAuth 不承担新模型发现。登录后能否看到新模型，取决于 Provider 目录接口和账号权限。

正确策略是：

- 支持远端目录时，在用户显式刷新、登录完成或有界后台任务中更新；
- 目录不完整时允许手工声明；
- 请求返回 `model_not_found` 或 `permission_denied` 时更新该账号的模型可用性证据；
- 不在每次求值热路径探测远端目录；
- 不因为本地 Catalog 尚未更新而拒绝 Operator 显式指定的新模型。

## 9. Operator 与用户体验

### 9.1 CLI

目标命令集合：

```text
morphz provider list|show|test
morphz provider account list|login|logout|enable|disable|test
morphz model list|refresh|use
morphz model route list|show|set|test
```

`login` 根据 Auth Adapter 启动浏览器回调或 Device Flow。CLI 必须清楚展示：

- 登录的是哪一种服务；
- 凭证将保存到哪个 Secret Backend；
- 当前账号 label；
- 授权 Scope；
- Adapter 稳定性级别；
- 是否属于订阅兼容接入。

### 9.2 Dashboard

Provider 管理属于 Operator 控制面，至少展示：

- Provider Instance 与协议；
- Model Catalog 和能力；
- 已登录账号数量及状态；
- 登录、重新登录、撤销、启用和禁用；
- 配额/限流/cooldown 的非敏感状态；
- Route 的候选顺序和亲和策略；
- 模型别名及每个 Provider 对应的物理模型名；
- 实际 Attempt 使用的 Provider、账号别名和模型；
- Token usage 与按账号/Provider 归因的成本。

服务、登录方式和账号身份必须是三个不同概念。Codex 在服务目录中只出现一次；浏览器 PKCE 与 Device Code 是进入 Codex 后选择的登录方式，不能伪装成两个 Codex 服务。用户第一次点击服务时只进入登录准备页，先看到远程回调条件、设备码启用要求和现有账号状态；只有再次明确点击“生成设备码”或“打开授权页面并登录”才真正启动授权。Device Flow 生成设备码后停留在 Dashboard，由用户复制设备码并主动打开验证页面，不自动用新窗口遮挡当前说明。

账号只有在授权完成后才创建。授权前不写 Account、Provider、Route、状态行或凭证，也不在 Dashboard 账号列表显示任何“未完成登录”；取消、失败、超时和 Runtime 重启都只丢弃进程内短期上下文。已经认证的多账号分别展示，并优先显示 Provider 返回的 `email`、`subject` 或账号 ID；Provider 没有返回可显示身份时必须如实说明。产品界面中的标识直接称为“ID”，不使用“内部记录”之类面向实现者的描述。

Dashboard 不展示 Token，不允许复制 Refresh Token，也不把 OAuth 回调结果保存在浏览器中。

### 9.3 Setup

首次启动继续保持简单：

1. OAuth 入口选择服务；API Key 入口只选择 `openai-responses`、`openai-chat`、`anthropic-messages` 或 `gemini-content` 协议，不把 OpenRouter 等品牌伪装成独立认证类型；
2. OAuth 界面先按 `loopback`、`runtime` 或 `none` 展示真实交付方式，再由用户明确开始；API Key 界面只要求 Base URL 与 API Key；
3. API Key 在不持久化任何配置的前提下连接 `/models` 目录，取得模型列表；
4. 用户从返回目录选择模型，不手填物理模型名；
5. OAuth 登录成功或 API 模型选择确认后，才创建 Account、Provider 和默认 Model Route；
6. 对完成配置执行 Provider Conformance 冒烟测试。

多账号、复杂 Route 和优先级不是首次启动必填项，后续在 Provider 管理中配置。

## 10. Pi Agent 与 CLIProxyAPI 的启示

### 10.1 为什么 Pi 可以用较少代码支持多种 OAuth

Pi 实现的是 Agent 客户端所需的单向子集，而不是完整网关：

- 一个统一 OAuth 接口处理 `login / refresh / toAuth`；
- 多个 Provider 复用少数协议实现；
- Provider Factory 很薄，只负责组合协议和认证；
- 模型目录从外部数据源生成，再附加少量修正；
- 不实现入站兼容 API 和协议转换矩阵。

在审计版本中，Pi 的多个 OAuth Adapter 合计仍有约数千行代码，Codex Responses 和 Anthropic Messages 也各自具有上千行协议实现。它不是“OAuth 几十行即可完成”，而是通过正确分层避免重复。

Pi 当前凭证仓库以 Provider ID 为键，天然表达一个 Provider 一个 Credential，不包含 Morphz 需要的多账号池、亲和、配额、冷却和故障转移。因此不能直接照搬它的账号模型。

### 10.2 Morphz 应吸收什么

从 Pi 吸收：

- 进程内 Provider/Auth/Protocol 抽象；
- 薄 Provider Factory；
- OAuth 生命周期接口；
- 共享协议实现；
- Catalog 生成与显式修正。

从 CLIProxyAPI 吸收：

- 多账号状态模型；
- 账号选择与 session affinity；
- refresh 并发控制；
- quota/cooldown；
- 失败分类和账号级故障转移。

明确不吸收：

- 入站 API Gateway；
- 多租户网关控制面；
- 与 Morphz Runtime 重复的调度系统；
- 对所有 Provider 的无边界兼容承诺。

最终目标不是“Rust 重写 CLIProxyAPI”，而是：

> Pi 风格的 Provider Client Runtime，加上 CLIProxyAPI 风格的多账号资源调度，并服从 Morphz 自己的 Evaluation、Thread 与 Model Attempt 事实模型。

## 11. 测试与兼容纪律

### 11.1 四层测试

1. **Protocol Conformance**：继续验证请求、SSE、工具调用、usage、错误和中断；
2. **Auth Conformance**：使用录制夹具验证登录回调、刷新、轮换、失效和敏感字段隔离；
3. **Account Scheduler**：验证亲和、并发刷新、quota、cooldown、failover 和 fencing；
4. **Real Endpoint Smoke**：显式使用测试账号执行目录、正文流、工具调用和 usage 验证。

核心测试不能依赖真实订阅、互联网或服务稳定性。真实响应脱敏后沉淀成最小夹具。

### 11.2 OAuth 兼容变更

每个内置 OAuth Adapter 必须有：

- 独立 Adapter 版本；
- 上游行为来源；
- 最后真实验证日期；
- 最小登录与刷新夹具；
- 可禁用开关；
- 明确的错误提示和重新登录路径。

不得通过抓取、Cookie 形状猜测或静默降级掩盖接口变化。兼容失效时只隔离对应 Adapter/账号，不能拖垮其他 Provider。

## 12. 分阶段实施路线

### 阶段 A：统一领域模型

- 引入 `ProviderInstance`、`AuthAccount`、`ModelRoute` 和 immutable Attempt Binding；
- 引入稳定 Model Alias，并显式保存 Alias → Provider/Physical Model 候选映射；
- 将现有 API Key、Env、Keychain、Command、None 映射为 Auth Adapter；
- 把当前单 Provider/单 Credential 配置迁移到新模型；
- Runtime、SDK、CLI、HTTP API 和 Dashboard 使用同一 Application API；
- 不同时保留两套权威配置语义。

### 阶段 B：多账号调度

- 实现账号状态 Projection；
- 实现 refresh lease/fencing；
- 实现亲和、cooldown、quota 和 failover；
- 将熔断拆分到 endpoint、instance、account、model 和 request class；
- 完成确定性调度测试。

### 阶段 C：主流 OAuth Adapter

- 通过统一接口实现 Codex、Kimi、Anthropic/Claude、Antigravity 和 xAI；
- 每个 Adapter 都具备独立版本、登录/刷新状态机、Secret Store 隔离和请求物化契约；
- OpenRouter 作为 API Key Provider 接入，不伪装成 OAuth 服务；
- 每次兼容变更先补确定性夹具，再由 Operator 执行真实账号冒烟。

### 阶段 D：Operator 产品面

- Dashboard Provider/账号/Route 管理；
- Setup OAuth 流程；
- 模型目录刷新和手工声明；
- usage、配额和成本归因；
- Adapter 健康度、版本和重新登录提醒。

### 阶段 E：可选扩展 SPI

当内置 Adapter 接口稳定后，再开放受限扩展 SPI。扩展只能提供：

- Auth Adapter；
- Provider Adapter；
- Model Catalog Source；
- Protocol Quirk 或全新 Protocol Adapter。

第三方扩展不得访问 Context、Mind、Session 正文或 Runtime Secret Store 的其他条目。插件签名、进程隔离和供应链安全没有成熟前，不把 OAuth 插件作为 v1 前置条件。

## 13. 当前实现状态

### 13.1 已落地主干

| 能力 | v1 实现状态 | 权威事实 |
|---|---|---|
| 线协议 | 已保持四种协议，并由现有 Conformance Suite 验证 | `ProtocolAdapter`/现有 LLM Client |
| Provider | 已实现 `ProviderInstanceConfig` 与显式 Adapter/Protocol/Endpoint | `morphz.toml` 受管配置 |
| Auth Account | 已从单 Credential 拆为独立账号池，支持同 Provider 多账号 | 静态配置 + `provider_account_states` |
| Model Route | 已实现稳定 Alias、多 Candidate、不同物理模型名和能力过滤 | `ModelRouteConfig` |
| Attempt Binding | 已持久化 Alias、Route revision、Provider、账号、物理模型、协议、Adapter 与 Endpoint | `model_attempt_bindings` |
| 多账号调度 | 已实现 durable affinity、状态过滤、cooldown、LRU 选择、failover 与 refresh fencing | SQLite/PostgreSQL Projection |
| OAuth | 已实现统一生命周期，以及 Codex、Kimi、Claude、Antigravity、xAI 五种服务；Codex 浏览器 PKCE 与远程推荐的 Device Flow 是两个兼容 Adapter | `AuthAdapter` + Secret Store |
| Secret 隔离 | OAuth Token 只物化到物理 HTTP Authorization；控制面 DTO 不携带敏感值，错误正文会脱敏 | Secret Store + `RequestAuthorization` |
| Catalog | 已实现显式手工模型与成功远端目录的持久 Projection；刷新失败不抹除最后成功快照 | `provider_model_catalog` |
| SDK/HTTP/CLI | 已共用 Application API，支持查看、诊断、测试、配置、账号控制、OAuth、目录刷新 | `MorphzSdk` |
| Dashboard | 已提供 Provider、账号、Route、远端模型目录、Attempt 绑定和 usage 控制面 | Provider Operator 页面 |
| Setup | 已写入统一 Instance/Account/Route 图；OAuth 复用同一 Runtime 登录生命周期 | Setup + Runtime Auth Manager |

### 13.2 有意保留的后续增量

- 五种 OAuth 的真实订阅兼容验证：本地实现和确定性契约已完成，上游变更仍需在发布前用实际账号冒烟；
- 真实订阅端点冒烟：必须由 Operator 显式提供测试账号，CI 不依赖个人订阅或外网稳定性；
- 更完整的动态 quota/cost：当前保存 Provider 返回的真实 usage 与账号归因，但不同订阅产品的货币成本需要 Operator 价格表；
- endpoint/model/request-class 的主动健康探针和更细熔断：现有路由已避免把单账号失效扩散到账号池，完整多维健康策略继续由故障证据驱动；
- 第三方 Adapter SPI：等内置接口经过更多上游变更验证后再开放，不作为 v1 前置条件。

### 13.3 存储后端验证边界

SQLite 的账号状态、亲和、刷新 fencing、Attempt Binding 与远端目录已有确定性回归测试。PostgreSQL 不只复用相同 Store Contract 和编译路径：本轮已连接本机 PostgreSQL 15.14，并在独立数据库 `morphz_live_conformance_20260802_1` 中完成真实迁移与 Store Conformance。测试会为每次运行创建隔离 schema，不清理或复用业务表；覆盖 Session Directory/Projection、Context Transaction、Recall Projection、Thread/Activation、Scheduler Dependency、Schedule、Delivery、Delegation、Timer/Objective Lease、Action Group、Execution Target/Authorization、Capability Lease、Edge Execution、Execution Job、Approval Grant、迁移回填、双 Store fencing 与双 Runtime 单次交付。

本轮收口验证结果：

- `cargo test -p morphz`：库测试 682 通过、0 失败、5 条人工/外部环境测试按设计忽略；主程序 20 通过；Attempt Loop 53 通过；CLI Contract 4 通过；默认 Store Conformance 3 通过；
- `MORPHZ_TEST_POSTGRES_URL=... cargo test -p morphz --test runtime_store_conformance postgres_supported_capabilities_satisfy_the_same_conformance_suite_when_configured -- --nocapture`：在真实 PostgreSQL 15.14 上 1 通过，0 失败；
- `MORPHZ_TEST_POSTGRES_URL=... cargo test -p morphz --lib runtime::tests::runtime_builder_selects_postgres_only_when_explicitly_configured -- --nocapture`：真实 PostgreSQL Runtime Builder 初始化通过；
- `cargo check -p morphz --lib --bin morphz`：通过；
- `cargo fmt --all -- --check`：通过；
- Dashboard `npm run build`：通过。

这些结果证明本地确定性契约、SQLite/PostgreSQL 存储 Projection、路由、OAuth 状态机、控制面和嵌入式 Dashboard 可以共同构建与回归。真实 PostgreSQL 已验证；尚不能由自动测试替代的边界仅是需要用户订阅账号的 OAuth/模型端点，以及上游服务变更后的发布前冒烟。

## 14. 验收状态

| # | 验收项 | 状态 |
|---|---|---|
| 1 | 同一 OAuth Adapter 的多账号凭证和值状态隔离 | 已由独立 Secret alias、账号状态与多账号路由模型实现；真实双订阅账号待 Operator 冒烟 |
| 2 | 稳定别名路由到多个 Provider 与不同物理模型名 | 已通过确定性路由测试 |
| 3 | Context/Objective 亲和可恢复且避开失效账号 | 已持久化并通过 SQLite 回归 |
| 4 | 并发刷新只产生一个 owner | 已通过 durable refresh lease/fencing 测试 |
| 5 | 单账号失效不封锁其他账号 | 已通过 durable 账号禁用后的同 Alias failover 回归 |
| 6 | 已收到流输出后不透明跨账号重放 | 已由 Attempt immutable binding 与现有流恢复边界保证 |
| 7 | 新模型可手工配置、诊断并刷新远端目录 | 已实现 SDK/CLI/HTTP/Dashboard |
| 8 | OAuth Token 不进入配置、Event History、Prompt、Dashboard 或普通日志 | 已由类型边界、Secret Store 与错误脱敏实现；继续保留回归审计 |
| 9 | 兼容 Gateway 仍作为普通 Provider 接入 | 已保留四协议配置入口 |
| 10 | 内置 Adapter 确定性契约与真实端点冒烟 | Codex、Kimi、Claude、Antigravity、xAI 的确定性契约已通过；2026-09-03 的 Antigravity 真实账号冒烟连续暴露并修复了公共 `/models` 误用、旧客户端标识，以及把请求体 `project` 错发为 `x-goog-user-project` 配额头的问题。同期对 CLIProxyAPI 当前主线做兼容审计：Kimi 的 Device Flow 与推理端点保持一致；Claude 更新到 `platform.claude.com` Token Endpoint 和当前 CLI 请求身份；xAI 更新当前 Grok CLI 版本及身份 Header。Codex 已由 Operator 真实验证；其余真实订阅仍需 Operator 使用自己的账号复验，未伪造完成 |

### 20.1 Codex 订阅可观测性

固定人格需要把“模型暂时没有响应”与“订阅额度已经耗尽”明确区分。Morphz
通过官方 Codex App Server 的 `account/rateLimits/read` 与
`account/usage/read` 读取 ChatGPT 订阅窗口、重置时间、Credits 和 token
活动，不猜测私有 HTTP 接口。Runtime 只提供需要 Operator 认证的只读端点：

```text
GET /api/runtime/providers/accounts/{account_id}/usage
```

Morphz 以 `chatgptAuthTokens` 外部凭据模式将现有 OAuth token 交给短生命周期的
Codex App Server 子进程。子进程使用隔离的临时 `CODEX_HOME`，token 不进入命令行
或响应，查询完成、失败或超时都会终止进程并清理目录。默认执行文件是 `codex`，
部署环境可以用 `MORPHZ_CODEX_APP_SERVER_BIN` 指向兼容版本。

公共应用不得直接转发这个 Operator DTO。它应在自己的身份边界内决定公开粒度、
缓存频率和显示名称；账户 ID、OAuth 邮箱与 token 元数据不应因接入额度组件而自动
公开。

因此 v1 的代码完成标准是：前九项具备确定性证据，第十项的本地契约部分完成；真实订阅冒烟作为发布前外部验证门，而不是把个人账号变成自动测试依赖。

## 15. 结论

Morphz 应当原生支持 OAuth，但不应因此变成一个通用模型网关。

最合适的边界是：

```text
Morphz Runtime
  ├── 少量稳定 Protocol Adapter
  ├── 克制的主流 Provider/Auth Adapter
  ├── 一等多账号资源池
  ├── Model Alias、Model Route 与 immutable Attempt Binding
  ├── Secret Store
  └── Provider Conformance Suite

外部 Gateway
  └── 继续通过兼容协议作为普通 Provider Instance 接入
```

这样既保留单二进制和普通用户的直接登录体验，又不会复制 CLIProxyAPI 的完整网关复杂度；同时，多账号、配额、亲和和故障转移成为 Morphz Runtime 可观察、可恢复的正式资源，而不是隐藏在某个 Provider 客户端里的临时逻辑。

## 参考实现与审计依据

- Pi Provider 文档：<https://github.com/earendil-works/pi/blob/a116523434806910336b9de3e38a41aa5860030b/packages/coding-agent/docs/providers.md>
- Pi OAuth 抽象与 Credential Store：<https://github.com/earendil-works/pi/blob/a116523434806910336b9de3e38a41aa5860030b/packages/ai/src/auth/types.ts>
- Pi Codex Provider Factory：<https://github.com/earendil-works/pi/blob/a116523434806910336b9de3e38a41aa5860030b/packages/ai/src/providers/openai-codex.ts>
- CLIProxyAPI：<https://github.com/router-for-me/CLIProxyAPI>
- Codex CLI 登录命令：<https://learn.chatgpt.com/docs/developer-commands#codex-login>
- Codex 无头设备登录说明：<https://learn.chatgpt.com/docs/auth#login-on-headless-devices>
- Codex Device Code 实现：<https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs>
- Codex loopback 回调实现：<https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs>
- CLIProxyAPI OAuth callback state 路由：<https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/oauth_callback.go>
- CLIProxyAPI Codex OAuth session 与 callback forwarder：<https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/auth_files_provider_oauth.go>
- CLIProxyAPI Management Center 远程回调 URL 交接界面：<https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/src/pages/OAuthPage.tsx>
- Google 桌面应用 OAuth：<https://developers.google.com/identity/protocols/oauth2/native-app>
- Google Web Server OAuth：<https://developers.google.com/identity/protocols/oauth2/web-server>
