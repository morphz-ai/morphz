# Morphz CLI 产品化 v1

## 1. 目标

Morphz CLI 产品化 v1 将现有可工作的 Agent Runtime 变成一个可配置、可迁移、可诊断、可流式交互的终端产品。

本阶段统一实现五项能力：

1. 建立配置所有权边界，阻止项目文件重定向宿主凭证或模型 Provider。
2. 实现分层配置、命名 Profile、配置来源追踪与诊断。
3. 将模型接入拆分为 Provider、Protocol、Model 三层，并支持四种主流协议。
4. 实现 `morphz setup`、Provider Catalog、凭证引用与连接测试。
5. 建立统一流式模型事件，并在其上实现现代化 Ratatui TUI。

本阶段不改变 Morphz 已有的核心语义：

- Agent 拥有 Cognitive Context。
- Session 挂载于 Context，可共享或隔离认知结构。
- Objective 是持久化的一等运行目标。
- `reply` 是 Session 消息投递和回合终止的明确决定。
- Runtime Ledger 是物理事实来源，TUI 只是事件消费者。

## 2. 核心边界

### 2.1 控制面与项目面的所有权

配置分为两类。

宿主控制面配置由操作者拥有：

- Provider 地址与协议
- 凭证及凭证获取方式
- 本机代理
- 权限审批和完全访问默认值
- 遥测、通知及外部命令

项目配置由工作区拥有：

- 项目级模型偏好
- Context 和工具的非敏感行为参数
- 工作区说明和项目扩展
- 不扩大宿主权限的 UI 偏好

项目配置不得修改 Provider 地址、认证方式或凭证引用。Morphz 不再隐式加载当前工作目录的 `.env`。只有进程环境、用户级 Morphz 环境文件，或操作者显式指定的环境文件可以提供模型连接配置。

### 2.2 Provider、Protocol、Model、Profile

- **Provider**：一个具名的连接实例，描述端点、协议、认证引用和额外请求元数据。
- **Protocol**：模型服务的线协议及其请求、流式事件和错误语义。
- **Model**：Provider 上的具体模型标识及其能力声明或探测结果。
- **Profile**：一次 Morphz 运行采用的模型、权限、Context 策略和 UI 偏好组合。

支持大量 Provider 不等于在核心中实现大量条件分支。普通 Provider 是 Catalog 数据加一个协议适配器；只有特殊签名、OAuth 或云身份链需要独立 Driver。

v1 协议集合：

- `openai-responses`
- `openai-chat`
- `anthropic-messages`
- `gemini-content`

### 2.3 密钥边界

配置文件默认只保存凭证引用，不保存明文密钥：

```toml
[providers.local-m4]
protocol = "openai-chat"
base_url = "http://mini-m4.local:8317/v1"
credential = "local-m4"

[credentials.local-m4]
source = "env"
name = "LOCAL_M4_API_KEY"
```

凭证来源按 v1 能力逐步实现：

- 进程环境变量
- 操作系统 Keychain/Keyring
- 无 stdin 的凭证 helper 命令
- 无凭证的本地端点

凭证值不得进入配置诊断、事件 Ledger、Context Encoding 或工具参数。

## 3. 配置分层

配置优先级从高到低为：

1. CLI 专用参数和 `--set`
2. `--config-file` 显式可信配置
3. 可信项目配置
4. `--profile` 选择的用户 Profile
5. `setup` / `model use` 维护的用户选择状态
6. 用户配置
7. 系统配置
8. 内置默认值

进程环境变量不是一个任意配置层，只覆盖被明确允许的部署字段和凭证引用值，避免环境变量绕过配置所有权。

推荐位置：

- 系统：Unix `/etc/morphz/config.toml`；其他平台使用平台约定位置
- 用户：`$MORPHZ_HOME/config.toml`，默认使用平台用户配置目录
- Profile：`$MORPHZ_HOME/profiles/<name>.toml`
- 项目：从项目根到当前目录逐层读取 `.morphz/config.toml`

`morphz config explain` 必须展示最终值、来源层和被覆盖链。`morphz config check` 必须验证所有已发现层，而不是在解析失败时静默退回默认值。

## 4. Setup 与 Provider 体验

`morphz setup` 是普通用户的唯一必需入口：

1. 从内置 Catalog 或自定义协议开始配置 Provider。
2. 从内置 Catalog 选择 Provider，或选择兼容协议并输入自定义地址。
3. 在全屏 TUI 中选择 Keychain、用户级 Morphz secrets 文件、既有环境变量或无认证；
   密码输入只显示圆点与字符数，Keychain 失败会留在向导内提供可恢复选择。
4. 在支持时读取模型目录；不支持时允许手工输入模型。
5. 执行连接、流式响应和工具调用握手。
6. 保存默认 Provider 和 Model；命名 Profile 仍由独立的 Profile 配置承载。

高级管理命令保持小而正交：

```text
morphz provider list|test
morphz model list|use
morphz profile list|show|use
morphz config show|check|path|explain
morphz doctor
```

Catalog 只提供默认端点、协议、认证方法和展示元数据。用户配置始终可以覆盖 Catalog 实例；Catalog 更新不得覆写用户选择。

## 5. 统一模型流式事件

Runtime 不向上层暴露 Provider 原始 SSE/JSON。所有协议适配器输出统一事件：

```text
ModelStreamStarted
TextDelta
ToolCallStarted
ToolArgumentsDelta
ToolCallCompleted
UsageUpdated
ModelStreamCompleted
ModelStreamFailed
```

事件必须携带稳定的 attempt、session、context 和 call 标识。协议适配器负责处理供应商差异，Orchestrator 只消费规范化结果。

对于 `reply`：

- 支持工具参数增量的 Provider 可以把已解析的 `reply.content` 片段作为 UI 草稿流展示。
- 只有完整、合法、成功执行的 `reply` 才进入 Ledger 并投递 Session。
- 不支持增量工具参数的 Provider 自动退化为原子回复。
- UI 草稿不是事实，不得被 Context Recall 当作已投递消息。

## 6. TUI

TUI 使用 Ratatui/Crossterm，只依赖公开 Runtime 事件和命令接口，不直接访问 Orchestrator 内部状态。

默认布局以对话为中心：

- 顶部：Session、模型和求值状态
- 中部：历史消息、Agent 增量进度、工具卡片和审批请求
- 底部：多行 Composer、Context pressure、Frame 和 Objective 状态
- 内置命令：`/ctx`、`/jobs`、`/cancel`、`/clear`、`/help`、`/quit`

视觉原则：

- 一个品牌强调色，语义色只用于成功、警告和错误
- 日志与对话分离
- 工具与运行进度原位更新
- 键盘优先；Enter 发送，Shift/Alt+Enter 换行
- 不把 Dashboard 密度搬进默认聊天界面

首版 TUI 可以与 Runtime 同进程运行，但接口必须允许未来替换为 stdio/WebSocket 的独立 Host，从而复用到桌面应用、IDE 和 SDK。

## 7. 公共入口与验收

下列入口构成首版公开命令面：

- `morphz [PROMPT...]`
- `morphz exec [PROMPT...]`
- `morphz resume [ID] [PROMPT...]`
- 所有现有 Agent、Context、Session、Objective、Job 管理命令
- `--format=json` 的非交互管理输出

每个阶段必须同时包含：

- 配置或协议的单元测试
- 至少一个本地假服务集成测试
- CLI 回归测试
- 无密钥泄露测试
- 清晰且可操作的错误信息

最终验收要求：一个新用户能够只通过 `morphz setup` 完成模型接入并进入 TUI；高级用户能够用 Profile 和配置层复现同一运行环境；非交互用户不需要启动 TUI。

## 8. 当前实现结果

五项能力已经形成一条可运行的主链路：

| 能力 | 当前结果 |
| --- | --- |
| 配置所有权 | 工作目录 `.env` 不再隐式加载；项目层只能使用 `.morphz/config.toml`，且不能定义 Provider、Credential、权限或监听地址 |
| 分层配置 | 支持 system、user、managed、profile、逐级 project、explicit、environment 和 CLI；`config explain` 显示最终值、来源与覆盖链 |
| 模型协议 | OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、Gemini `generateContent` 均有显式请求/响应适配和 SSE 增量适配 |
| Setup 与诊断 | 支持 Catalog、自定义端点、Env/Keychain/Helper/无认证、模型目录、流式正文和工具调用握手；`provider test` 分项报告结果 |
| TUI | 交互式终端默认启用 Ratatui；非 TTY 自动保持纯文本；`--tui` 与 `--plain` 可显式覆盖；人工审批和 `reply` 草稿均已接入 |

流式增量使用 `runtime/model_stream` 瞬时事件，只投递实时订阅者，不通过 durable subscriber，也不写入 SQLite。最终 `reply`、工具回执、用户消息和 Context transaction 的持久化语义没有变化。

## 9. 首次启动与本地代理

Morphz 没有隐式模型后端或协议猜测。首次使用先建立显式 Provider：

```text
morphz setup
morphz provider list
morphz provider test <provider-id>
morphz config explain
```

对于本地 OpenAI-compatible 代理，在 `setup` 中选择“自定义 Provider”和 `openai-chat`，再选择 Keychain、Morphz secrets 文件、既有环境变量或无认证。协议始终由 Provider 配置明确声明，Runtime 不会根据模型名称或 URL 猜测协议。

交互式终端运行 `morphz` 或 `morphz resume` 时默认进入 TUI；脚本使用 `morphz exec`，需要行式交互时使用 `morphz --plain`。
