# Provider 子系统测试矩阵

## 目的与边界

Provider 子系统不是单一 HTTP 客户端，而是一条跨层链路：

```text
Dashboard
  -> Web API
  -> SDK / 配置持久化
  -> Runtime 热更新
  -> 路由与账户选择
  -> 协议适配器
  -> 远端 Provider
```

过去的测试主要集中在协议解析、认证适配器和路由算法。它们能够发现局部错误，但不能证明一次 Dashboard 操作在磁盘配置、当前 Runtime 和真实请求路径上产生了一致结果。本矩阵把跨层不变量作为准入条件；每次 Provider 相关修复都必须对应一个能够复现历史故障的自动化测试。

## 准入不变量

1. 未完成的 OAuth 登录只存在于进程内存，不写账户、路由、凭证或 Secret 索引。
2. Dashboard 只显示服务实际发现并由用户启用的物理模型，以及用户明确设置的别名；不得制造模型名。
3. 模型选择值是稳定的路由 ID，显示值是用户别名或物理模型名，两者不得混用。
4. 现代配置只通过 `models -> services -> accounts` 解析；`llm.provider` 仅用于旧配置兼容，任何新功能不得依赖它。
5. 配置变更成功后，磁盘配置、Runtime 路由快照、模型选择器和 Context 容量必须一致；失败时不得产生半提交状态。
6. 目录发现是观测，启用模型是用户决策；远端临时失败不得删除已经启用的模型。
7. 容量字段只采用接口明确返回或用户明确填写的值；不得根据品牌或模型名猜测。
8. 健康实测必须显示进行中、成功或失败，并保留可诊断的 Provider 错误。
9. 流式与非流式响应必须分别经过协议测试；实现不得在没有测试证据时假定其中一种必需。
10. OAuth、API Key、无认证本地服务共用同一 Provider/Account/Route 运行时模型，不在请求路径中增加厂商特例。

## 自动化用例

状态含义：`完成` 表示已有确定性自动化测试；`本轮完成` 表示本次审查新增或强化；`待完成` 表示本目标关闭前必须落地。

| ID | 层级 | 场景与断言 | 自动化入口 | 状态 |
|---|---|---|---|---|
| CFG-01 | 单元 | 现代路由在没有 `llm.provider` 时把容量写入准确的 `services.<id>.models.<physical>` | `config::tests::managed_inference_capacity_follows_routed_service_without_legacy_provider` | 本轮完成 |
| CFG-02 | 单元 | 旧式单 Provider 配置仍可保存模型与容量 | `config::tests` 的 managed inference 兼容用例 | 完成 |
| CFG-03 | 单元 | 模型容量按完整物理模型名精确索引，不截断或改写名称 | `config::tests::provider_model_context_capacity_is_keyed_by_exact_model_name` | 完成 |
| CFG-04 | 单元 | 容量关系满足 `input + output <= context window`，非法值不落盘 | `sdk::tests` / Web 模型启用测试 | 完成 |
| AUTH-01 | 单元 | PKCE state、回调端口、device code 与 token refresh 行为 | `provider::auth::tests` | 完成 |
| AUTH-02 | 功能 | 未完成 OAuth 不写数据库、配置或 Secret Backend；成功后一次性写入 | `web::tests` OAuth setup 用例 | 完成 |
| AUTH-03 | 功能 | 设备码登录提供用户码、验证地址和轮询状态，错误可见 | `provider::auth::tests` + Web OAuth 用例 | 完成 |
| CAT-01 | 功能 | 远端目录失败时保留已启用模型，不让选择器变空 | `web::tests` account model catalog 用例 | 完成 |
| CAT-02 | 功能 | 目录容量字段原样进入模型编辑器；缺失字段保持空值 | `providerWorkflow.test.ts` | 本轮完成 |
| CAT-03 | 功能 | 启用/禁用模型同步更新路由和 Provider 模型表，移除最后模型时给出明确约束且不改变磁盘或 Runtime | `web::tests::enabled_account_models_remain_visible_without_discovery_cache` | 本轮完成 |
| ROUTE-01 | 单元 | 别名解析到准确物理模型，路由 ID 不冒充显示名 | `provider::routing::tests` + `runtime::tests` | 完成 |
| ROUTE-02 | 单元 | 多账户健康状态、冷却、上下文亲和与故障转移 | `provider::routing::tests` | 完成 |
| ROUTE-03 | 功能 | Runtime 热更新后下一请求立即使用新路由，重启后结果一致 | `web::tests::local_provider_setup_discovery_enablement_switch_probe_capacity_and_restart` | 本轮完成 |
| ROUTE-04 | 单元 | 给既有路由增加账户时保留显示名、别名、亲和性、选择器、回退策略和已有候选，并用当前最大优先级加一分配新候选 | `providerWorkflow.test.ts` 的 existing-route 用例 | 本轮完成 |
| CAP-01 | 功能 | Dashboard 容量保存经过 Web API 后同时更新磁盘与当前 Context 预算 | `web::tests::dashboard_model_capacity_is_persistent_and_immediately_updates_context_budget` | 完成 |
| CAP-02 | 功能 | CAP-01 在现代路由且没有 `llm.provider` 时仍成立 | `web::tests::dashboard_model_capacity_follows_modern_route_without_legacy_provider` | 本轮完成 |
| CAP-03 | 功能 | 多候选路由不能含糊地只修改一个物理目标；同一物理目标的多账号仍可修改 | `config::tests::managed_inference_capacity_rejects_ambiguous_physical_targets` 等 | 本轮完成 |
| PROTO-01 | 单元 | 四种协议的路径、Header、请求字段、正文与 usage 归一化 | `provider::conformance` | 完成 |
| PROTO-02 | 单元 | SSE 任意分片、并行工具、截断、非法结束和重试边界 | `provider::conformance` | 完成 |
| PROTO-03 | 功能 | 流式和非流式请求分别完成；健康探针不把合法的输出上限截断误报为 Provider 不可用 | `provider::tests::all_protocol_clients_reach_their_native_endpoint`、`all_protocol_streams_normalize_text_tools_and_lifecycle`、`health_probe_accepts_schema_valid_length_limited_chat_response` | 完成 |
| WEB-01 | 功能 | Provider + Account + Route 首次设置是一个原子 Web 操作 | `web::tests::provider_catalog_setup...` | 完成 |
| WEB-02 | 功能 | 发现、启用、切换、实测和容量修改构成完整闭环 | `web::tests::local_provider_setup_discovery_enablement_switch_probe_capacity_and_restart` | 本轮完成 |
| WEB-03 | 功能 | API Key 与 Provider 图通过一个 setup 请求提交；配置失败时新 Secret 回滚，Secret 值不进入 TOML | `dashboard_provider_setup_atomically_persists_a_complete_catalog`、`dashboard_provider_setup_rolls_back_new_secret_when_catalog_is_invalid` | 本轮完成 |
| UI-01 | 单元 | API Key 表单生成确定的协议配置，保留真实物理名与已有容量，不制造厂商或模型名 | `providerWorkflow.test.ts` | 本轮完成 |
| UI-02 | 单元 | 实测状态绑定发起操作的账户；进行中、成功、Provider 错误互不串号 | `providerWorkflow.test.ts` 的 account diagnostic 用例 | 本轮完成 |
| UI-03 | 单元 | 模型选择器提交路由 ID、显示 label；路由 ID 与其他别名冲突时精确 ID 优先；未知值不被制造为选项 | `modelSelection.test.ts` | 本轮完成 |
| E2E-01 | 端到端 | 本地无认证 OpenAI-compatible 服务：设置、发现、启用、切换、实测、请求、容量、重启 | `web::tests::local_provider_setup_discovery_enablement_switch_probe_capacity_and_restart` | 本轮完成 |
| E2E-02 | 冒烟 | Codex/Kimi/xAI 真实账号只在显式执行时测试，结果不得成为确定性 CI 前置条件 | `morphz provider test` | 手工 |

## 执行分组

快速回归：

```bash
cargo test -p morphz provider::conformance
cargo test -p morphz provider::routing
cargo test -p morphz provider::auth
cargo test -p morphz managed_inference --lib
cargo test -p morphz dashboard_model --lib
npm --prefix dashboard test
```

交付前验证：

```bash
cargo test -p morphz provider::
cargo test -p morphz web::tests --lib
cargo test -p morphz sdk::tests --lib
npm --prefix dashboard test
npm --prefix dashboard run build
```

真实账号冒烟测试必须由用户明确选择账号与模型后执行，避免在 CI 或普通开发验证中消耗订阅额度。

## 本轮验证结果

- Provider 认证、协议与路由：61 通过；2 个真实网络 OAuth 冒烟按设计忽略。
- 配置层：33 通过。
- Dashboard：109 通过；TypeScript 构建与 lint 通过。
- Provider Web 功能与本地假 Provider 端到端：全部通过。
- Clippy 编译检查通过；严格 `-D warnings` 中 Provider 与本轮 SDK 变更已无告警，仓库其他模块仍有 19 个既有告警，未借本轮改动跨模块清理。
- 完整 `web::tests`：38 通过，3 个既有 Dialogue Lane/调度器测试超时。失败用例分别是 `session_message_endpoint_is_idempotent_and_routes_to_session`、`model_stream_precedes_durable_reply_and_carries_stable_route`、`reasoning_summary_survives_runtime_rebuild_and_remains_queryable`；它们不经过本轮修改的 Provider setup、目录、路由或容量路径，作为 Runtime 基线缺陷单独跟踪，不能通过扩大超时掩盖。

## 历史回归登记

| 故障 | 原因 | 防回归用例 |
|---|---|---|
| 容量面板显示准确服务，保存却报“未配置 Provider” | 写路径仍依赖已退役的 `llm.provider`，读路径已使用模型路由 | CFG-01、CAP-02 |
| Dashboard 显示不存在的 `gpt-5.6` 等模型 | UI/默认配置曾使用硬编码或路由 ID 代替真实目录与显示名 | ROUTE-01、UI-01、UI-03 |
| 登录失败产生多个未完成账户 | 登录事务过早写入持久层 | AUTH-02 |
| 实测按钮无可见反馈 | UI 没有把诊断状态绑定到触发账户 | UI-02 |
| Kimi 实测因输出上限截断失败 | 健康检查把成功但截断的响应解释为服务失败 | PROTO-03、WEB-02 |
| Provider 短暂故障后任务长期不恢复 | 单次请求耗时与健康等待状态缺少跨层时序验证 | PROTO-02、E2E-01 |
| API Key 先写 Secret、后写 Provider 配置，第二步失败时遗留孤儿 Secret | Dashboard 把一个 setup 拆成两个 HTTP 写操作 | WEB-03 |
| 路由 ID 恰好等于另一条路由别名时选择器可能选错 | 旧选择器把 ID 与别名放在同一次、依赖数组顺序的查找中 | UI-03 |
| 增加第二个 Provider 后重启默认模型与当前 Runtime 不一致 | setup 无条件把新路由写成磁盘默认值，但热更新保留旧选择 | ROUTE-03、E2E-01 |
| 给既有路由增加账户时丢失路由属性或产生重复候选优先级 | UI 重建路由而不是在原路由上追加候选，并用候选数量代替最大优先级 | ROUTE-04、UI-01 |
