# Morphz application

以对象为中心，让人与 Agent 共同推进工作。

桌面优先的开发版本。已接入对象与资料库、Runtime 工具与任务安排、内置浏览器、交互产物、身份隔离和语音入口；实际验证情况见[实施记录](docs/13-implementation-status.md)。不是可公开部署的服务或已签名的桌面发行版。

## 本地运行

需要 Node.js 24.13 或更新版本。依赖版本记录在 `package-lock.json`，推荐使用 `npm ci`。

```sh
npm ci
npm run build
npm run desktop
```

Desktop 内嵌共享应用业务层，直接打开本机 SQLite 和已构建界面 `morphz://app/`，不需要应用 HTTP 服务或 Vite。Morphz Runtime 保持独立。Web／远端模式才运行 HTTP 适配器：

```sh
npm start
```

Web 默认地址为 `http://127.0.0.1:65420`。桌面使用 `npm run desktop -- --center=http://127.0.0.1:65420` 可连接明确的远端／Web 中心；不要另起 HTTP 宿主打开正在被内嵌 Desktop 使用的同一中心。Electron 是开发依赖，不是 Morphz 的产品名称。macOS 本地开发包安装为 `~/Applications/Morphz.app`，尚不是正式签名发行版。

桌面开发时先启动中心（`npm run dev:server` 或已有独立中心），再执行 `npm run desktop:dev -- --center=http://127.0.0.1:65424`；省略参数默认中心为 65420。该命令启动 Vite 和桌面壳，不重启中心。普通 `npm run desktop` 仍加载已构建的界面。切换到热更新模式前，先从应用菜单退出旧桌面，沿用原来的桌面配置目录。

桌面开发窗口从 65419 的 Vite 加载，API 代理到明确指定的原中心；原生来源授权仍绑定原中心。首次切换时仅复制同中心、同身份的本地偏好与草稿，不覆盖开发窗口已有值，也不复制待执行命令。CSS 和 React 组件修改会自动更新；修改桌面主进程／preload 需重开桌面，修改服务端需单独更新中心。非组件模块变更可能触发整页刷新，不保证所有修改都保留 React 内存状态。

只开发 Web 时仍可用 `npm run dev`，热更新地址为 `http://127.0.0.1:65419`。不要与 `desktop:dev` 同时占用 65419。65418 的旧交互原型不属于正式工程。

## 已实现

- 事项、工作台、项目视图；Dashboard 同值、同用途的四色主题及亮暗模式。
- 认知应用启动台：图标、单击／回车启动、页签、独立 UI、版本固定与状态恢复。工作台原子保存为项目，保留原对话、对象和应用。当前自定义包与 Harness 接入契约见[认知应用与工作空间](docs/15-cognitive-application-host.md)。
- 所有页面共用的居中 AI 输入框：Cmd+J／Ctrl+J 显隐，Esc 收起。
- 对话与输入框位于同一主区域；“内容／对话”切换保留对象编辑状态，侧栏仅展示对象批注。保存输入后自动展示对话，刷新后恢复。
- 创建与编辑 Markdown 文档，查看历史版本。
- 导入 Markdown／UTF-8 文本副本，记录来源与原始版本；选择资料目录后先预览并跳过凭据、隐藏文件、依赖目录和构建产物。
- Cmd+K／Ctrl+K 搜索标题、正文和事项；按项目筛选，打开指定版本，或引用原文继续提问。
- 导入 PNG、JPEG、WebP 图片（单张最多 6 MB）；图片二进制独立保存在中心数据库中。
- 创建事项，设置 Human／Agent 负责人、模型策略、优先级、日期与状态；通过 Runtime 持久调度执行，按接收回执显示实际安排。
- 对象关联、引用具体版本原文的批注、与对象和版本关联的输入记录。
- SQLite 事务、操作幂等、对象修订冲突；Web／Desktop 轮询同步同一中心。
- 草稿按窗口隔离，同一窗口刷新可恢复；一端保存不会清掉另一端的草稿。
- PDF 原件、分页阅读、检索引用；桌面授权目录的只读同步、暂停和恢复。不扫描系统盘或用户主目录。
- Agent 检索、创建、修订和关联对象；版本冲突与请求重试遵循同一规则。执行详情、单次审批和精确停止接入 Runtime。
- 定时／来源变化触发、人工答复后接续、按身份保存的通知；“当前理解”来自 Agent 提交的公开上下文帧，支持提出纠正。
- 隔离内置浏览器、页面快照、获准填写与逐次确认点击；人接管使旧授权失效，未知提交结果不自动重发。
- 表格、表单、交互报告；数据保存为对象版本，不执行生成的 HTML 或脚本。
- 语音输入、对象朗读和 macOS 手动截图入口。真实豆包合成／识别、原生麦克风采集释放、桌面朗读停止、合成样例语音批注，以及系统截图取消／选区／预览／保存均已通过；实测范围见实施记录。

配置 Runtime 后，输入会持久化并进入发送队列；Enter 发送、Shift+Enter 换行。应用显示排队、处理、完成或错误状态，并接收真实回复。未配置时仅保存输入并明确显示“未发送”，不伪造 Agent 回复。

## 本机 Runtime 连接

中心服务从应用数据目录的 `runtime.json` 读取连接配置：`url` 为 loopback HTTP origin、`token` 为本机 Runtime 的 Dashboard 凭据、`namespace` 为工作空间专用 UUID。该文件应仅当前用户可读写，不放进仓库、前端代码或浏览器存储。

macOS 开发环境可以复用一个明确选定的已运行 Runtime：

```sh
node scripts/connect-local-runtime.mjs <Runtime进程PID> http://127.0.0.1:<Runtime端口>
```

脚本只适用于本机单用户 Runtime，验证凭据后保存权限为 0600 的配置；随后正常重开相应应用宿主。不要更换已有配置中的 namespace 或地址来覆盖正在使用的对话。Runtime 凭据更新后可重新运行连接脚本，保留原 namespace。

个人模式的对话、工作台、事项及项目默认交流共用一条持续会话；显式创建的项目命名会话对应独立 Session。应用、对象、导航与执行授权分开，工具按真实输入根解析项目，不能按当前页面猜测。旧 Session、历史和在途请求保留原路由，团队模式仍按授权空间隔离 Context。不挂载 Runtime 中已有的其他会话认知。Session 默认请求审批与 workspace-write，不继承服务器的完全访问模式。详见[持续会话](docs/17-continuous-conversation-and-execution.md)。

发送队列与事件游标保存在中心数据库中。重试沿用同一个消息标识；刷新或重启不会重复执行已接受的消息。原来仅保存的输入不会自动补发，可点击“发送这条消息”。围绕对象发送时，会附上指定版本的正文、事项信息或图片，以及选中的原文。

回复和工具状态支持真实增量，最终以持久 Runtime 回执为准。对象工具、执行控制和调度接口需要配套 Runtime 开发构建。Desktop 生成私有 `host-tools-desktop.json`，通过 Unix 本地通信回调；Web 宿主使用 `host-tools.json` 和 HTTP。Runtime 启动时以 `MORPHZ_HOST_TOOLS_FILE` 指向对应清单；界面刷新不会自动重载 Runtime 的工具注册。独立中心与身份配置见[本机中心接入](docs/14-local-center-and-identity.md)。

## 语音服务

豆包语音凭据使用项目根目录 `.env` 中的 `DOUBAO_API_KEY`，变量示例见 `.env.example`。应用宿主启动时读取，已由宿主环境提供的同名变量优先；不会加载任意 `.env` 变量来覆盖进程设置，也不将密钥传给界面。默认位置跟随工程而不是启动目录；也可用绝对路径 `MORPHZ_APP_ENV_FILE` 指定文件，空字符串表示不读取配置文件。

`.env` 已被忽略，不能提交、索引或作为模型资料；不要使用 `VITE_` 前缀。录音与上传分别确认，识别后可编辑再放入输入框；朗读明确发起并可停止。识别和合成都使用豆包 Plan 专用接口，凭据需具备对应服务权限。已用现有凭据验证真实合成与识别回环；配置存在仍不等于连接一定可用，服务失败会明确显示。

## 数据位置与备份

| 系统    | 默认中心数据目录                                                                        |
| ------- | --------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Morphz/application/`                                     |
| Linux   | `$XDG_DATA_HOME/morphz/application/`，未配置时使用 `~/.local/share/morphz/application/` |
| Windows | `%LOCALAPPDATA%\Morphz\application\`                                                    |

目录内的 `workspace.sqlite` 保存对象、版本、批注、输入记录与资源。不依赖启动目录，不使用 Morphz Runtime 的数据库。可用绝对路径 `MORPHZ_APP_DATA_DIR` 或 Desktop 的 `--data-dir=` 指定中心；`MORPHZ_APP_PORT` 仅控制 Web HTTP 端口。桌面 Chromium profile 可用绝对路径 `MORPHZ_APP_PROFILE` 指定，缺省为应用数据根下的 `Morphz/desktop`。Windows 本机 Runtime 工具通信后端尚未实现，不能把目录支持当作完整桌面验收。

已有 `MorphzWork` 数据目录、profile 和 Chromium 分区就地继续使用，不自动搬移；同时发现新旧两份数据时拒绝猜测，要求显式选择。旧 `MORPHZWORK_*` 配置继续兼容，新名称优先（包括显式空字符串）；`MORPHZWORK_TEST_PROFILE` 对应 `MORPHZ_APP_PROFILE`。不要为了改名直接更改运行中的数据路径。

备份前停止中心进程，并备份整个数据目录。不要只复制运行中的 SQLite 主文件而忽略 WAL。草稿和界面偏好保存在各端 Web 存储中，不在这份中心备份内。草稿跨设备同步、关闭窗口后的恢复入口尚未实现；重要修改请保存成对象版本。

构建后可运行 `npm run backup:center`，通过 SQLite 备份接口把含已提交 WAL 数据的一致性副本保存到数据目录的 `backups/` 下。备份不包含 Runtime 凭据、客户端草稿或外部来源原文件。当前数据库格式版本为 11；升级前备份，升级后不要用旧程序打开新库。身份模式、Runtime 地址和 namespace 不允许直接更换来接管已有对话。

## 检查

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:desktop
npm run test:browser
npm run test:runtime-tools
npm run test:runtime-identity
```

浏览器端到端测试使用已安装的 Chrome、独立临时数据库及 65421 端口。桌面测试使用独立临时配置和 65419 端口，运行前需确保该测试端口空闲；不会连接或清理已有用户数据库。两种测试均禁用项目 `.env` 加载，不依赖真实语音凭据。

`npm run test:native-input` 是单独的交互式 macOS 验收：真实麦克风采集仅送至本机无网络测试替身，随后丢弃，再等待人在系统界面选择一小块测试区域；超时失败，不自动截取全屏。使用独立数据与 65421 端口，不可与界面回归同时运行，不读取密钥、不调用语音供应商，不属于无人值守测试套件。`--microphone-only` 可只验收麦克风，避免重复截图。

如果麦克风已经验收，使用 `npm run test:native-input -- --capture-only` 只验证截图：先取消一次在途系统选择，再等待人工选区，核对本机预览和明确保存；不重复采集麦克风。各阶段的实际结果独立保存，后续阶段超时不会抹掉前面已通过的记录，也不会将未完成项标为通过。

`npm run test:desktop-speech -- --synthetic-wav=<合成 WAV 的绝对路径>` 单独验证真实豆包服务与原生语音 UI，需要有效的服务端凭据，会消耗语音服务用量。测试样例仅限 10 秒以内的单声道 16 kHz PCM WAV（这是测试夹具限制，不是产品时长限制）；通过 WebAudio 提供给实际 AudioWorklet，不读取或上传现场声音。使用独立配置与 65423 端口，验证朗读停止、识别确认和对象版本批注；`--asr-only` 可跳过 TTS，`--long-reading` 使用一份跨合成分段的短测试文档。失败会保留合成测试界面与阶段信息，不能用它代替真实麦克风权限验收。

语音输入可持续采集、自动分段识别，停止后确认文字，不自动发送 Agent；网络积压时暂停采集并保留待处理内容。长文朗读自动连续分段、只预加载下一段，支持暂停、章节跳转及本机进度恢复。TXT／Markdown 单对象支持 8 MB／200 万字符，已验证百万字文本；不代表支持 EPUB 解析或无限大小文件。

## 当前边界

- 中心仅监听 loopback；团队认证已接入个人凭据、会话撤销、项目授权和 Runtime 可信网关，但仍是本机模拟中心，不得公开暴露。没有邀请邮件、企业 SSO 或公网 TLS 部署。
- 共享项目内输入、对象与认知对项目成员共享；私有工作使用私有项目，不把同项目的不同 Session 当作秘密边界。
- Electron 开启进程沙箱与上下文隔离，关闭 Node 集成。第三方网页使用独立 WebContentsView／Session，不获得应用凭据和任意本机接口。
- 暂停／取消关注停止后续触发；已经派生的工作仍在执行记录中单独停止，不假装一个按钮取消了全部在途执行。
- 无签名安装包、自动更新、Mobile 或浏览器扩展；当前已验收的是 macOS 开发版，其他桌面平台尚未实测。
- 索引持久化并在授权范围内查询；工作空间快照仍面向小规模使用，未做大团队容量承诺。

核心设计与本轮实现边界见 [对象模型与工程基础](docs/10-object-model-and-foundation.md)。

## 名称与兼容边界

产品统一为 Morphz，应用工程包为 `morphz-application`，Runtime 仍是独立模块。当前 checkout 目录可以仍叫 `MorphzWork`；目录重命名和并入主仓库是独立操作，本次没有合并仓库。

新应用包使用 `morphz-app/v1` 和 `morphz-app:*` 消息，新输入格式为 `morphz.application.input` v1，对象工具为 `host_morphz`，HTTP CSRF 标头为 `X-Morphz-Token`，终端存储键为 `morphz:`。已安装旧包继续使用原协议；旧输入格式定义保持原字节，旧工具名继续接受且沿用同一幂等命令身份。旧登录态与同中心、同身份的草稿可读取，新值优先，原始数据不删除。历史文档、消息、对象 ID、Context/Session 命名空间以及兼容测试中的旧名称有意保留，不代表当前产品仍叫 MorphzWork。

已安装的兼容 macOS 开发启动器不会仅因名称更新被改写或重新签名；这避免破坏当前授权，但不代替未来正式发行所需的稳定签名与更新机制。
