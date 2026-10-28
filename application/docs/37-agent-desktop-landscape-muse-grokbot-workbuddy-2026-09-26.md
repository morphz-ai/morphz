# Muse、Grok Bot、WorkBuddy 客户端审计与 Morphz Desktop 启示

日期：2026-09-26

本文记录对本机已安装的 Muse、Grok Bot 和 WorkBuddy 三款 Agent 客户端的只读审计，并把观察结果映射到 Morphz 的现有抽象。它不是竞品功能清单，也不以界面上出现了相似名词就推断底层语义相同；重点是回答四个问题：它们真正解决了什么需求、功能大致怎样实现、产品路线会往哪里发展，以及 Morphz Desktop 应该吸收什么、拒绝什么。

## 证据口径

本文用三种标记区分证据强度：

- **实测**：在本机客户端中直接看到的界面和交互入口。
- **安装包证据**：来自签名、`Info.plist`、产品清单、打包资源、静态文案或随包源码。它可以证明产品包含相应实现，但不自动证明当前账号已经开放、服务端已经启用或端到端运行成功。
- **推断**：根据界面、模块命名和常见实现方式作出的架构判断，均明确保留为推断。

本轮没有创建 Bot、专家、自动化或共享链接，没有连接外部账号，没有执行任务、授权权限、发送消息、购买服务或修改客户端设置。因而本文不把静态功能入口冒充为端到端验收结果。

审计版本：

| 产品 | 本机版本或界面版本 | 关键实现证据 |
| --- | --- | --- |
| Muse | 4.1 | 原生 Swift/AppKit/SwiftUI 外壳，内嵌 WebKit/React；Meta 签名与资源 |
| Grok Bot | 0.59.1 | Electron；Anysphere 签名；包名 `sand`；SpaceXAI 作者信息；Cursor/Anysphere Agent 组件 |
| WorkBuddy | 界面 4.7.1；底层发行版 1.100.0 | 腾讯签名；VS Code 分支；内置 Genie/CodeBuddy Agent 扩展 |

## 结论先行

三款产品共同验证了一组已经稳定出现的真实需求：Agent 需要持续身份、长期状态、后台执行、自动化、外部能力、权限审批、跨入口触达、执行环境和可观察性。市场已经不满足于“更好的聊天框”。

但三者给出的答案并不相同：

1. **Muse 是“一个持续存在的私人 Agent”**。它最擅长把人格、记忆、目标、灵感、主动提醒、内容库和个人设备组合成一种有生命感的产品体验。
2. **Grok Bot 是“由 Bot、Computer、Routines、Channels 和 Team 组成的数字员工平台”**。三者中，它的执行与组织能力表面最完整，也是对 Morphz Desktop 产品形态最值得认真对待的参照物。
3. **WorkBuddy 是“从本地工作台长成通用 Agent 入口”**。它用 VS Code 的成熟宿主承载本地执行，再用专家、Skill、插件包、MCP、自动化和市场把能力包装给普通用户。
4. **它们都没有提供 Morphz 式结构化 Context 非确定性求值的证据**。它们可以拥有结构化数据库、工具参数、Memory 条目、Bot 配置和任务状态，但模型侧仍主要表现为线性 transcript、摘要、规则、记忆、技能说明和工具 Schema 的组合。结构化数据不等于结构化求值语言。
5. **Morphz 当前的主要劣势不是 Runtime 原语不足，而是原语还没有形成同样直观的产品投影**。Principal、Session、Thread、Objective、Context、Schedule、Approval 和 Execution Target 已经构成更统一的底层，但用户还不能像理解“这个 Bot 的电脑和例行任务”那样，一眼理解 Morphz 正在做什么。

所以，正确动作不是追着三个产品各造一套 Feed、Bot、Expert、Plugin 和 Automation 数据模型，而是用 Morphz 已有内核表达它们背后的真实需求，并把结果做成更清晰的 Desktop 体验。

## 一、Muse：持续存在的私人 Agent

### 1. 产品形态

Muse 的主界面围绕一个持续存在的私人 Agent，而不是项目、代码仓库或一次性任务展开。实测和安装包显示，它包含：

- 主对话与侧对话；
- Feed、Ideas、Goals、Library 与全局搜索；
- Activity、Approvals、Upcoming、Identity 等状态入口；
- Connectors、Devices、Permissions、Dictation、Wallet、Credentials、Data Import 和 Channels；
- 一个隔离的 Linux Secure VM，以及作为另一个设备/执行节点的本机 Mac；
- 带浏览器调试、标签页、脚本、下载、历史和书签权限的浏览器节点扩展；
- `SOUL.md` 式可演化人格和 `MEMORY.md` 式长期记忆；
- 约每 30 分钟运行的 Heartbeat 与定时任务历史；
- 从对话中识别并跟踪 Goal；
- 文档、网页、图片、视频、播客和系统文件组成的 Library；
- 受功能开关控制的 Shared Agents、移动端、通信渠道、Work OIDC、订阅和机密计算等能力。

它最有价值的地方不是某个单项功能，而是把 Agent 的长期存在感表达得非常完整：它有性格、有记忆、有待办、有自己的电脑、会主动发现事情，也会在需要时请求许可。

### 2. 大致实现思路

Muse 采用原生 macOS 外壳加 Web 内容的混合架构。Agent 的主要执行环境位于持续存在的隔离 Linux VM，本机 Mac 和浏览器则作为可连接的设备与能力来源。

人格与记忆采用容易理解的文本资产：`SOUL.md` 保存人格和行为倾向，`MEMORY.md` 保存提炼后的长期事实、偏好和承诺，原始每日记录另行保留。运行时再把人格、记忆、工作区说明、当前运行状态和对话历史组织进模型输入。

这是一种很务实的产品方案：文本透明、可迁移、容易让模型维护，也方便向用户解释。但它的结构主要依赖 Markdown 约定和运行时拼装；来源、置信度、作用域、因果关系、并发写入与冲突合并并没有因为文件名叫 Memory 就自然解决。

### 3. 产品设计哲学

Muse 的核心不是“让用户管理很多 Agent”，而是让用户相信同一个 Agent 一直在身边。Feed、Ideas、Goals、Library 和 Heartbeat 都是同一个持续认知主体的不同投影。

它的 Shared Agent 也更像从私人 Agent 中投影出一个受限副本：为它选择身份、说明、上下文、知识、目标、连接器、技能和凭证描述，再把它分享给别人。它不是 Agent Teams，也不是多个平等主体共享同一个完整心智。

### 4. 优势与风险

Muse 明显领先的部分是产品表达：

- 身份、记忆、主动性和状态都有直观入口；
- 权限、设备、连接器与执行环境不是藏在开发者配置里；
- 同一个 Agent 贯穿聊天、目标、内容和设备；
- 用户很容易形成“它一直活着”的心智模型。

主要风险则来自它的简化：

- 平面 Markdown Memory 很难自然表达作用域、来源、有效期、冲突和并发；
- 夜间整理和周期性 Heartbeat 容易退化为摘要任务与轮询任务；
- 浏览器调试、`all_urls`、Full Disk Access 和长期授权一旦边界不清，风险很高；
- Feed 如果先于高价值工作闭环成熟，可能变成制造活跃度而不是推进目标的机制。

### 5. 对 Morphz 的价值

Muse 最值得 Morphz 学习的是“把内核状态翻译成人能理解的产品体验”，不是照搬 `SOUL.md`、`MEMORY.md` 或 30 分钟 Heartbeat。

Morphz 可以用稳定 Agent 身份、Mind 投影、Objective、Schedule、Thread、Approval 和 Execution Target 提供更严谨的同类体验，同时保留来源、因果、并发和权限边界。

## 二、Grok Bot：Bot 即数字员工

### 1. 身份与技术来源

Grok Bot 0.59.1 是 Electron 客户端。安装包有几项很强的证据：

- Bundle ID 为 `com.anysphere.sand`；
- Apple 签名主体为 **Anysphere Incorporated**；
- 包内 `package.json` 的产品名为 Grok Bot、内部名为 `sand`，作者为 SpaceXAI，主页指向 Cursor；
- 依赖包含大量 `@anysphere/*` Agent、Context、Transcript、Summarization、MCP、Local Exec 和 Cloud Agent 组件；
- 客户端内置文档入口为 `https://docs.x.ai/grok-bot`。

因此可以确定：这不是一套与 Cursor 无关、从零开始的新客户端。它是 Anysphere/Cursor 技术栈为 Grok Bot 产品所做的正式实现或深度合作实现。

### 2. 用户可见的产品模型

实测主界面以 Bot 为核心：左侧管理 Bot/会话，中央与当前 Bot 对话，底部有 Marketplace，输入区支持附件、语音与语音通话。设置页包含通用、电脑、用量与账单、更新，并提供时区、麦克风、硬件加速和自动审核等配置。

安装包进一步显示，每个 Bot 的详情可以投影为：

- Overview；
- Routines；
- Media；
- Computer；
- Meetings；
- Members。

其能力面包括：

- 多 Bot、Private Bot、Team Bot、Bot 模板和 Bot 市场；
- 多 Bot 群聊、Subagent、Background Task 和 Async Task；
- Learned Context、Memories，以及把私人 Bot 的事实和技能携带到 Team Bot；
- Skills、Plugins、Files、Secrets、Credentials 和 Connectors；
- MCP、Slack、GitHub 及其他 listener integrations；
- 定时或事件触发的 Routines，事件源文案覆盖 Slack、GitHub、Linear、PagerDuty、Sentry 和 Webhook；
- Cloud Computer、本地电脑执行、VNC/屏幕预览、命令运行、目录读取和浏览器状态访问；
- Meetings、Phone Call、Voice Chat、Voice Memo、Email 与 Messages；
- Allow Once、Always Allow、Auto-review、团队策略和多种专项审批；
- 1Password、Passkey、Virtual Card、充值与购买审批；
- 文档、PDF、表格、Mermaid、Canvas、HTML Preview、Media 和 Artifact 发布。

这已经不是“Grok 聊天桌面版”。它在尝试定义一名数字员工需要的完整外壳：身份、电脑、记忆、能力、凭证、日程、沟通渠道、同事关系和支付能力。

### 3. 大致实现架构

安装包包含独立的 `local-exec-daemon`、`node-agent-coordinator`、VNC preload、Meeting preload、Desktop Mount，以及云端 Agent、MCP、Shell Exec 和本地执行模块。这说明它至少采用了三层执行结构：

1. Electron 客户端负责交互、权限、预览和本机桥接；
2. 本地守护进程负责命令、文件、浏览器或其他本机能力；
3. 云端 Agent/Computer 负责持续运行和远程执行。

Computer 不只是一个设置项。产品文案覆盖唤醒、断线重连、恢复、重置、计划更新、查看屏幕和把控制权交还给用户。它把执行环境作为 Bot 的一等产品对象。

Routines 也不只是 Cron UI。客户端存在自动化详情面板、立即测试、运行记录、失败状态、触发器、listener 集成和 Webhook 鉴权；因此它更接近“事件驱动的长期工作”，而不是定时发送一条 Prompt。

### 4. Prompt 与 Context 的推断

包内依赖明确分开了 Agent Transcript、Agent Summarization、Context、Skills、Plugins、Learned Context 和工具执行。由此可以合理推断，单次模型调用会从以下材料中组装上下文：

- 当前聊天 transcript 及其摘要；
- Bot 身份和指令；
- Learned Context/Memory 条目；
- Team policy 与权限约束；
- 已启用 Skill、Plugin、Connector 和工具 Schema；
- 当前 Computer、Routine、Meeting 或 Channel 的运行状态；
- 相关文件、媒体与 Artifact。

这是很强的 Context Engineering，但当前证据仍指向“Runtime 选择并拼装信息，模型继续处理线性消息与工具调用”。包里出现名为 `context` 的模块，并不能证明它实现了 Morphz 所说的结构化 Context 求值；Learned Context 是结构化数据，也不等于模型把它当成可求值的语义对象。

### 5. 它最值得重视的地方

Grok Bot 真正强的不是功能数量，而是把几个长期割裂的模块合在一个 Bot 产品模型里：

- Computer 让“它在哪里工作”变得可见；
- Routines 让“它什么时候、因为什么继续工作”变得可见；
- Channels 和 Meetings 让“它从哪里接收现实事件”变得可见；
- Members 和 Team Bot 让“它为谁工作、和谁协作”变得可见；
- Skills、Plugins、Secrets 和 Approvals 让“它能做什么、凭什么做”变得可见。

这是 Morphz Desktop 应该认真吸收的产品表达。用户不应先理解 Runtime 术语，才能知道 Agent 正在哪台设备上、为哪个目标工作、在等谁批准、下一次何时运行。

### 6. 局限和风险

Grok Bot 的复杂度也非常高：

- Bot、Team Bot、Subagent、Group Chat、Background Task、Routine、Workflow 和 Cloud Agent 同时存在，普通用户很难理解它们的语义边界；
- “把事实、技能和插件携带到 Team Bot”表明跨 Bot 共享更像复制或提升上下文，而不是多个 Session 对同一持续 Mind 的受控视图；
- 群聊会让多个 Bot 对每条消息分别处理，产品自己也提示这会消耗更多额度；这不是共享 Context 上的并发求值；
- Computer、浏览器状态、Secrets、1Password、Email、Messages、支付和 Always Allow 聚合后，授权组合空间非常大；
- Team policy 能约束灵活性，但也说明大量安全语义位于产品层和策略层，而不是由一个更小、更稳定的执行内核自然保证。

Grok Bot 已经非常接近 Morphz 想要呈现的 Agent 产品外形，但它仍然更像“多个装备齐全的 Bot”，而 Morphz 的潜力是“同一个结构化 Mind 通过多个 Session、Thread、Objective 和 Execution Target 同时存在”。二者外观会越来越像，核心差异仍在 Context 与求值语义。

### 7. 可能的后续方向

从已打包但未必全部开放的模块看，Grok Bot 很可能继续沿以下方向扩展：

- 从单 Bot 对话走向 Team Bot、多人使用和 Bot 群聊；
- 从定时任务走向外部事件驱动的持续运营；
- 从文本任务走向会议、电话、语音、邮件和消息渠道；
- 从信息处理走向有凭证、有预算、有支付审批的交易执行；
- 从单次工具调用走向可观察、可接管的 Cloud Computer；
- 从个人插件走向团队策略、团队秘密和团队市场。

这会让它成为强大的数字员工平台，但也会进一步放大 Context 隔离、权限治理、状态恢复和多任务协调问题。

## 三、WorkBuddy：本地工作台与生态聚合器

### 1. 产品形态

WorkBuddy 的界面将下列入口放在同一侧栏：

- 新建任务与任务搜索/筛选；
- 已存在的 Agent/Bot；
- 专家；
- 技能；
- 插件；
- 自动化。

新任务页先区分“代码开发”和“日常办公”，再提供文档处理、视频生成、深度研究、金融服务、数据分析、数据可视化、幻灯片和产品管理等任务模板。输入区可以选择 Craft、Skill 和本地文件夹。

这说明 WorkBuddy 正在主动摆脱“腾讯代码助手”的单一定位：底层仍是开发工具，但产品入口已经朝通用本地 Agent 工作台扩展。

### 2. 专家、Skill、插件与 MCP 的分层

WorkBuddy 的四类扩展需要分别理解：

- **专家**：按设计、工程、营销、销售、产品、项目管理、测试、运营等行业分类的角色模板。它们有名字、头像、职业说明和“立即召唤”。现有证据更像预配置人格/指令/能力组合，不足以证明每个专家都有独立持久身份、Session 或 Objective。
- **Skill**：可启停的工作方法说明。客户端扫描 `.codebuddy`、`.workbuddy`、`.claude`、`.agents` 和 `.openclaw` 等目录，明显希望兼容现有 Agent Skill 生态；还内置 `skill-creator` 与 SkillHub。
- **插件**：一个分发包，可以同时携带 `skills`、`rules`、`agents`、`commands`、`hooks` 和 `mcp`。插件市场支持多个市场源、本地插件、安装/卸载与 MCP 服务器管理。
- **MCP**：外部工具和资源协议，是插件包可以包含的一种能力，而不是与插件完全同义。

这一设计非常务实：它不试图先发明全新协议，而是把 Claude/Codex/OpenClaw 等生态已经形成的目录与 Markdown 约定吸收进来，再用市场和 UI 做统一管理。

### 3. 自动化并非只有模板页

实测自动化页提供创建入口、近期运行记录说明和多个日常模板。安装包进一步显示：

- Main/Renderer 之间有专门的 Automation bridge；
- Agent 客户端协议提供 snapshot、创建/更新、删除、测试、执行、运行结果、Inbox 归档与删除；
- 自动化变更可以通过事件推送回 UI；
- 自动化与插件、模型变化共享一个长期 Agent 通道。

因此 WorkBuddy 的自动化不是纯前端定时器，而是宿主、Agent 协议与 UI 的联合能力。它目前更像“有模板和运行记录的定时 Agent 任务”，尚未看到与 Morphz Objective/Thread 同等级的多目标共享认知语义。

### 4. 本地实现基础

WorkBuddy 是一个腾讯签名的 VS Code 分支，内置 Genie/CodeBuddy Agent 扩展。底层天然获得：

- 本地工作区、文件树、编辑器、Diff 和终端；
- 多语言、Git、调试与扩展市场；
- 独立终端进程、命令执行和文件修改；
- VS Code Webview/Extension Host 的隔离与扩展机制。

随包扩展还包含企业微信消息、文档、会议、待办、智能表格、日程和联系人 Skill，以及若干内置 MCP 集成。这使它很容易借助腾讯生态切入中国企业办公场景。

### 5. Prompt 与 Context 的构建方式

WorkBuddy 对模型上下文的组织可以从随包说明和配置中较清楚地还原：

- Custom Agent 使用 Markdown/YAML frontmatter 描述名称、说明、工具、模式与指令；
- Rules 提供用户级和项目级约束；
- `CODEBUDDY.md` 和项目摘要描述代码库；
- `@` 可以加入文件、文件夹、Git 变更、知识库、终端和 Rules；
- Skill 以 Markdown 工作方法进入上下文；
- MCP 和内建工具以工具 Schema 进入模型；
- Memory 自动记录偏好和重要信息；
- Max Mode 尽量保留完整历史，普通模式仍需要截断或摘要；
- Task List 把计划与进度作为对话中的辅助状态；
- 内置 `code-explorer` Subagent 通过单独的 system prompt 约束工具和职责。

这是一套成熟的传统 Harness：Runtime 把规则、引用、记忆、技能、计划和工具组织成线性模型输入，模型在对话和工具调用范式里工作。它能做到很多事情，但没有证据表明 Context 本身是由模型执行的结构化程序。

### 6. 优势与局限

WorkBuddy 的优势非常现实：

- VS Code 提供成熟、稳定、用户熟悉的本地执行底座；
- 兼容多种 Skill 目录，比建立封闭生态更容易获得内容供给；
- 插件包能一次分发 Skill、Rule、Agent、Hook、Command 和 MCP；
- 专家和任务模板降低普通用户的理解门槛；
- 腾讯文档、会议、企业微信、云服务等本土连接具有渠道优势；
- 自动化、任务、代码和办公在同一应用中，商业化路径清晰。

它的局限同样明显：

- Expert、Agent、Skill、Plugin、MCP、Rule 和 Automation 的概念容易重叠；
- 专家中心可能变成大量名字不同、底层只是 Prompt 不同的模板货架；
- 本地任务历史仍是主要导航单位，没有看到跨 Session 共享 Mind 的产品证据；
- Task List 是单次执行辅助状态，不等于持久 Objective；
- 通用办公能力被放进 VS Code 外壳，长期会面临非开发者体验与 IDE 复杂度之间的矛盾；
- 兼容多个外部 Skill 目录能快速扩张生态，也会带来质量、冲突、权限和供应链安全问题。

### 7. 可能的后续方向

WorkBuddy 很可能继续从 Coding Agent 向以下方向扩展：

- 代码开发与日常办公合并为一个任务入口；
- 专家成为面向行业的 Agent 模板市场；
- 插件市场吸收 Skill、MCP、Hook、Command 和 Subagent 生态；
- 自动化从每日模板扩展到企业事件与工作流；
- 依靠企业微信、腾讯文档、会议和腾讯云形成企业闭环；
- 在保持 VS Code 能力的同时，逐步隐藏 IDE 复杂度，形成面向普通用户的 Agent Manager。

## 四、三款产品与 Morphz 的核心对比

| 维度 | Muse | Grok Bot | WorkBuddy | Morphz |
| --- | --- | --- | --- | --- |
| 主产品单位 | 一个私人 Agent | 多个 Bot/Team Bot | 任务、专家、Agent | 一个持续 Agent 下的 Session、Objective、Thread |
| Context 形态 | 对话 + SOUL/Memory/运行时拼装 | Transcript/摘要 + Memory/Skill/Plugin/状态拼装 | 对话 + Rules/Memory/Skill/@ 引用/工具 | 结构化 Context + S 表达式 + 非确定性求值 |
| 长期记忆 | 文本化长期记忆与每日记录 | Learned Context/Memories，可携带到 Team Bot | Memory + Rules + 项目说明 | Mind/Frame/Projection 与持久 Context |
| 并发表达 | 主动任务与后台活动 | Background/Async Task、Subagent、多 Bot | Task List、Subagent、Automation | 多 Thread、多 Objective、跨 Session 共享 Context |
| 执行环境 | Secure VM + Mac + Browser Node | Cloud Computer + Local Exec + VNC | 本地 VS Code 工作区/终端 + MCP | Execution Target/Edge/Node，与 Runtime 解耦 |
| 自动化 | Heartbeat + Schedule | Routines + Schedule + Event Listener | Automation 模板 + 运行记录 + Agent 协议 | Schedule + Objective + Custom hns + 外部事件 |
| 扩展 | Connectors/Skills/Shared Agent | Skills/Plugins/Connectors/Secrets | Skill/Plugin/MCP/Rule/Agent/Hook/Command | hns 应用、Skill、Tool/MCP、Provider/Target；边界应分别定义 |
| 协作 | 受限 Shared Agent | Team Bot、Members、群聊 | 专家/Subagent/企业生态 | Principal、Session 参与关系、受控 Context View、SDK 编排 |
| 当前最强项 | 私人 Agent 的生命感 | 数字员工的完整操作外壳 | 本地生态与能力分发 | 统一认知、并发与持久状态的内核语义 |
| 当前主要短板 | Context 治理与并发语义 | Bot 孤岛、权限组合与概念复杂度 | 线性任务/对话和概念堆叠 | 对内核能力的产品表达、生态与新用户入口 |

需要特别避免四个误判：

1. 有多个 Bot 或 Subagent，不等于同一个 Mind 上有并发 Thread。
2. 有 Background/Async Task，不等于整个 Agent 执行流程具备持久、可恢复的多 Objective 调度。
3. 有 Memory 条目，不等于 Context 具有结构化认知和可求值语义。
4. 有 Plugin Marketplace，不等于 Runtime 内核更强；它首先说明分发与生态更成熟。

## 五、真实需求应由 Morphz 哪一层承载

| 外部产品呈现的需求 | Morphz 应采用的机制 | 不应采用的捷径 |
| --- | --- | --- |
| Agent 有持续身份、性格和长期理解 | 稳定 Agent 身份 + Mind/Frame 的只读投影、来源和纠正入口 | 把原始 Mind Frame 暴露为普通用户手工编辑文件 |
| 多入口与同一 Agent 交流 | 多 Session 绑定同一 Agent/Principal，并按授权共享 Context | 每个入口复制一份 Memory 或创建一个孤立 Bot |
| 同时聊天和做后台工作 | Session/Thread/Objective 分离，UI 同时展示交互线程和后台线程 | 把后台任务塞进当前聊天的隐藏 Promise |
| 目标长期推进 | Objective + Thread + Schedule + Custom hns | 在 Desktop 再造一套与 Runtime 平行的 Automation/Task 调度器 |
| 外部事件唤醒 Agent | Provider/Tool 将事件转为持久 Signal/Effect，进入 Objective 求值 | 让任意插件改写 Runtime 核心 Context 构建流程 |
| 本机、云端、浏览器和机器人执行 | Execution Target + Edge/Node + capability/ownership/lease 投影 | 为每种设备发明独立 Agent 或独立上下文 |
| 技能与工具市场 | Skill 负责方法；Tool/MCP 负责外部能力；hns 负责应用逻辑；分发包只负责组合和安装 | 用一个含义无限扩张的 Plugin 概念覆盖全部层次 |
| 专家/角色模板 | hns 模板、任务模板或受限 Agent profile，按是否需要独立身份决定 | 每个职业名称都创建一个伪独立 Agent |
| 团队共享 Agent | Principal + Session 参与关系 + Context View + Capability Grant；复杂编排由 SDK 完成 | 复制私人 Agent 的全部记忆后称为 Team Agent |
| 例行任务与运行历史 | Objective/Schedule 的产品投影、测试运行、历史和失败恢复 | 仅保存一条 Cron Prompt |
| 人工审批与长期授权 | Approval 绑定 Principal、Objective/Thread、Target、资源、动作和有效期 | 全局、无限期、语义模糊的 Always Allow |
| Agent 的“电脑” | 将 Execution Target 做成一等产品对象，展示状态、能力、归属、位置和接管 | 把机器仅藏在 Provider 配置或日志中 |
| Learned Memory 的导入与迁移 | 带来源、时间、作用域和置信度的导入事件，再由 Runtime 求值吸收 | 将外部 `MEMORY.md` 无来源地覆盖当前 Mind |

## 六、Morphz Desktop 的建议优先级

### P0：把已经存在的内核能力变成可理解的产品对象

#### 1. Agent 状态中心

把当前执行检查器、等待审批、Schedule、非终态 Thread、最近结果和 Target 连接状态投影到统一状态中心。它回答的是：

- Agent 现在同时在做什么；
- 哪些事情在等待模型、工具、外部事件或人工；
- 下一次会在什么时候醒来；
- 哪个 Objective/Thread 正在哪个 Execution Target 上执行；
- 哪些结果刚刚完成或失败。

这不是新增调度器，只是把 Runtime 的真实状态翻译给用户。

#### 2. 正式 Objective 界面

当前实现状态已明确记录：尚未接入独立 Objective 列表、目标正文和完成状态，不能把线程标题、intent 或 Target 冒充 Objective。这个缺口比复制 Muse Feed 或 WorkBuddy 专家市场更优先。

Objective 界面至少应展示目标正文、状态、父子关系、关联 Thread、来源 Session、发起 Principal、当前等待条件、Target 和最近结果，并复用现有暂停、恢复、取消和修订语义。

#### 3. Devices / Execution Targets 页面

借鉴 Muse Devices 与 Grok Bot Computer 的可理解性，但直接投影 Morphz 的 Execution Target：

- 本机、云端、浏览器、移动端、机器人等目标；
- 在线状态、能力、所属 Principal、数据位置和授权范围；
- 当前占用/控制关系、在途执行和可接管状态；
- 配对、断线、恢复和版本信息。

用户看到的是“Agent 可在哪里工作”，而不是底层节点协议。

#### 4. 能力目录，而不是万能插件页

在 UI 上清楚区分：

- hns 应用：定义一种认知工作方式；
- Skill：可复用的方法说明；
- Tool/MCP：外部操作能力；
- Execution Target：能力实际运行的位置；
- Connector/Provider：外部系统或事件来源；
- 安装包：上述内容的分发组合。

WorkBuddy 的市场证明用户需要统一发现和安装入口，但不意味着内核概念也应该合并。

#### 5. Trust / Approval 中心

吸收 Grok Bot 对审批状态的重视，但权限规则应绑定明确作用域：谁、为哪个 Objective/Thread、在哪个 Target、调用什么能力、访问什么资源、有效到何时。默认优先提供单次或本 Objective 有效，不把全局永久授权当成便捷功能。

### P1：提高日常可达性与生态启动速度

#### 1. 全局快速入口

菜单栏、全局快捷输入、Push-to-talk 和系统分享入口能显著提高 Agent 的存在感。它们都应进入正确 Session，并继续使用同一个 Mind，而不是创建“快捷聊天 Agent”。

#### 2. 统一搜索

搜索应跨 Session、Objective、Thread、Artifact、Message 和可见 Mind 投影，并显示对象之间的关系。WorkBuddy 的“搜索任务”和 Muse 的全局搜索说明需求真实存在，但 Morphz 能提供更强的因果导航。

#### 3. Starter hns 与任务模板

可以提供“研究、编程、运营、会议准备、日报”等入门模板，但模板应落到 hns/Objective/Capability 组合，不建立一个数量不断膨胀的卡通专家宇宙。模板的价值是降低第一次使用成本，不是掩盖底层边界。

#### 4. 自动化产品化

采用 `Objective + Schedule/External Event + Custom hns`：提供自然语言创建、测试运行、下次执行、历史、失败恢复和静默通知策略。WorkBuddy 的模板页值得借鉴，Grok Bot 的 event listeners 更值得作为后续目标。

#### 5. 带来源的迁移

可以导入 Muse/OpenClaw/WorkBuddy 等产品的 Persona、Memory、Rules 和 Skills，但导入内容先成为有来源的候选认知或能力包，再由 Morphz 求值吸收；不直接覆盖现有 Mind。

### P2：协作、渠道与高风险执行

- 用 SDK 构建 Agent Teams；内核只提供 Principal、Session、Objective、Thread、Context 与授权原语。
- 支持企业微信、Slack、邮件、移动端等 Channel，但每个 Channel 只是 Session/Edge，不拥有独立认知。
- 提供受限 Agent/共享 Agent 视图，使用 Context View 和 Capability Grant，而不是复制完整 Agent。
- 在支付、凭证代理和 1Password 一类高风险能力上保持克制，等审批、审计、撤销、恢复和 Principal 边界成熟后再进入。
- Artifact 发布、分享和交付可以逐步产品化，但必须保留版本、来源和授权关系。

## 七、明确不建议照搬的设计

1. **不要把“一个用途一个 Bot”作为默认组织方式。** 这会用身份复制掩盖 Context 作用域问题，也破坏 Morphz 的 One Mind, Many Sessions 优势。
2. **不要让 Plugin 成为万能名词。** Runtime、hns、Skill、Tool/MCP、Provider、Target 与安装包的边界应保持清楚。
3. **不要用大量专家头像替代真正的能力模型。** 如果差别只有 system prompt，它就是模板，不是独立 Agent。
4. **不要把 Memory 简化为可随意改写的 Markdown 真相文件。** 用户需要查看、纠正和追溯，但不应被迫维护内部 Mind Frame。
5. **不要默认提供无限期 Always Allow。** 便捷不能消除 Principal、资源、Target 和 Objective 的作用域。
6. **不要让 Desktop 再造一套任务调度权威。** Desktop 负责投影、输入和控制，Runtime 继续拥有状态与调度语义。
7. **不要过早建设无限 Feed。** 先证明 Objective 能持续推进并产生高价值结果，再决定是否需要信息流。
8. **不要把异步工具、Background Task 或 Subagent 宣称为多 Objective 共享认知。** 这些能力可以很有用，但不是同一个问题。

## 八、最终判断

这三款客户端说明，Morphz 所判断的产品方向正在快速成为行业共识：Agent 会有长期身份、后台任务、主动性、设备、自动化、技能、权限和团队关系。Morphz 不再是在和“聊天机器人”竞争，而是在和越来越完整的 Agent 工作环境竞争。

其中，Grok Bot 对 Morphz 的产品压力最大，因为它已经把 Computer、Routines、Team Bot、Channels、Approvals、Secrets、Meetings 和 Marketplace 组织成一个相当完整的数字员工外壳；WorkBuddy 对生态与中国市场的压力最大，因为它用兼容与分发迅速吸收现有 Skill、MCP 和企业办公能力；Muse 则对人格、记忆和日常存在感的表达最成熟。

但这并没有削弱 Morphz 的核心。恰恰相反，它们越努力给线性聊天补上 Memory、Bot、Routine、Computer、Team 和 Plugin，越说明传统 transcript 不是足够的 Agent 状态模型。真正需要验证的是：Morphz 能否把结构化 Context、非确定性求值、多 Thread、多 Objective、共享 Session 和 Execution Target 的内核优势，做成用户立即可感知、开发者愿意采纳的产品与协议。

Morphz Desktop 的近期目标因此可以压缩成一句话：

> 不复制它们的对象模型；用 Morphz 的对象模型，提供比它们更统一、更可解释的同类体验。

## 本机证据索引

### Muse

- `/Applications/Muse.app/Contents/Info.plist`
- `/Applications/Muse.app/Contents/Resources/chrome/manifest.json`
- `/Applications/Muse.app/Contents/Resources/hatch/metaconfig.json`
- `/Applications/Muse.app/Contents/Resources/hatch/i18n/zh_CN.json`
- `/Applications/Muse.app/Contents/Resources/hatch/index.html`

### Grok Bot

- `/Applications/Grok Bot.app/Contents/Info.plist`
- `/Applications/Grok Bot.app/Contents/Resources/app.asar`
- 包内 `package.json`
- 包内 `dist/electron-main/`、`dist/local-exec-daemon/`、`dist/node-agent-coordinator/`
- 包内 Renderer 的 Bot、Routine、Computer、Meeting、Connector、Approval、Team Bot 与 Marketplace 模块
- Apple 签名：`Developer ID Application: Anysphere Incorporated (DCNK4UB866)`

### WorkBuddy

- `/Applications/WorkBuddy.app/Contents/Info.plist`
- `/Applications/WorkBuddy.app/Contents/Resources/app/product.json`
- `/Applications/WorkBuddy.app/Contents/Resources/app/extensions/genie/package.json`
- `/Applications/WorkBuddy.app/Contents/Resources/app/extensions/genie/product.json`
- `/Applications/WorkBuddy.app/Contents/Resources/app/extensions/genie/README.md`
- `/Applications/WorkBuddy.app/Contents/Resources/app/extensions/genie/CHANGELOG.md`
- `/Applications/WorkBuddy.app/Contents/Resources/app/out/codebuddy/main.js`
- Apple 签名：`Developer ID Application: Tencent Technology (Shanghai) Company Limited (FN2V63AD2J)`

### Morphz 对照

- [产品方向](./01-product-direction.md)
- [Runtime 集成评估](./09-runtime-integration-assessment.md)
- [实现状态](./13-implementation-status.md)
- [持续会话与并发执行](./17-continuous-conversation-and-execution.md)
- [应用存储模型](./35-application-storage-model.md)
