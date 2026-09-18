# Morphz application

以对象为中心，让人与 Agent 共同推进工作。

源码现位于 Morphz 主仓库的 `application/`，下文 npm 命令均在本目录执行；在仓库根目录
可使用 `npm --prefix application`。原 MorphzWork 的提交历史完整保留，后续开发只在本仓库
进行。合并边界、原配置切换与验证见[仓库整合记录](docs/25-repository-integration.md)。

桌面优先的开发版本。已接入对话、事项、项目、内容、认知应用宿主、内置浏览器及模型设置；实际验证情况见[实施记录](docs/13-implementation-status.md)。Web 与 Desktop 共用业务层，但尚不是公开云服务或正式签名的桌面发行版；Mobile 尚未实现。

## 本地运行

需要 Node.js 24.13 或更新版本。依赖版本记录在 `package-lock.json`，推荐使用 `npm ci`。

```sh
npm ci
npm run build
npm run desktop
```

以上适用于全新安装。已有开发版继续从原 Morphz.app 打开；更新启动器前正常退出，保留
其数据目录、profile、配置文件引用等选项。不要以裸 `npm run desktop` 覆盖显式配置。
仓库合并不会要求建立新中心、重新登录或复制旧 `.env`。

Desktop 内嵌共享应用业务层，直接打开本机 SQLite 和已构建界面 `morphz://app/`，不需要应用 HTTP 服务或 Vite。Morphz Runtime 保持独立。Web／远端模式才运行 HTTP 适配器：

```sh
npm start
```

Web 默认地址为 `http://127.0.0.1:65420`。桌面使用 `npm run desktop -- --center=http://127.0.0.1:65420` 可连接明确的远端／Web 中心；不要另起 HTTP 宿主打开正在被内嵌 Desktop 使用的同一中心。Electron 是开发依赖，不是 Morphz 的产品名称。macOS 本地开发包安装为 `~/Applications/Morphz.app`，尚不是正式签名发行版。

桌面开发时先启动中心（`npm run dev:server` 或已有独立中心），再执行 `npm run desktop:dev -- --center=http://127.0.0.1:65424`；省略参数默认中心为 65420。该命令启动 Vite 和桌面壳，不重启中心。普通 `npm run desktop` 仍加载已构建的界面。切换到热更新模式前，先从应用菜单退出旧桌面，沿用原来的桌面配置目录。

桌面开发窗口从 65419 的 Vite 加载，API 代理到明确指定的原中心；原生来源授权仍绑定原中心。首次切换时仅复制同中心、同身份的本地偏好与草稿，不覆盖开发窗口已有值，也不复制待执行命令。CSS 和 React 组件修改会自动更新；修改桌面主进程／preload 需重开桌面，修改服务端需单独更新中心。非组件模块变更可能触发整页刷新，不保证所有修改都保留 React 内存状态。

只开发 Web 时仍可用 `npm run dev`，热更新地址为 `http://127.0.0.1:65419`。不要与 `desktop:dev` 同时占用 65419。65418 的旧交互原型不属于正式工程。

## 当前功能

- 固定对话、事项、工作台、项目与内容入口；设置中保留外观、模型与账号等选项，沿用四色主题及亮暗模式。
- 项目新建、改名、归档、可恢复删除；项目内命名会话的创建、改名、归档与恢复。新会话在第一次有效发送时持久化，空草稿不冒充已开始的会话。
- 事项支持按日期分组的紧凑列表和独立看板；负责人使用现有用户或智能体，支持截止日期与状态。优先级由持久顺序表达，人和智能体均可调整；安排事项不等于授权开始执行。
- 共用 InputBox 与消息记录，保留独立悬浮 Dock。Cmd+J／Ctrl+J 显隐输入；收起消息、切换内容不丢草稿，也不停止后台工作。右栏分别承载批注、当前理解与执行记录。
- 文件、图片可通过选择或粘贴加入当前消息附件，发送前可以预览、移除。不会因为添加附件就创建内容对象，或把文件自动关联到所有对话。
- 明确授权智能体读写目录后，工具按实际输入、身份和仍有效的授权操作原文件；不复制、导入、索引或同步目录，不隐含 Shell、删除或发布权限。旧只读来源不升级为写权限，自动来源同步已停用。
- 内容目录展示有权访问的非事项成果与既有素材，支持 Markdown 文档编辑、图片／PDF 阅读、批注和版本历史。当前理解留在状态检查器，不作为普通交付成果混入内容目录。
- Cmd+K／Ctrl+K 搜索；全文索引仅覆盖智能体生成且非导入的成果。外部文件不由应用批量建立索引，智能体通过获准的工具按需读取。
- 持续维护的数据表保留表格／记录／统计视图；分析报告与一次性对比默认是 Markdown 文档，可包含 Markdown 表格。这里不是 Excel／Office 文件编辑器。
- 工作台和项目中的认知应用启动、版本固定、状态恢复；启动台区分“继续工作”与“应用”。工作台保存为项目保留原对象、对话和应用，不复制或重新执行工作。契约见[认知应用与工作空间](docs/15-cognitive-application-host.md)。
- 浏览器个人收藏独立于内容对象，人和智能体使用同一操作。收藏只保存名称与 URL，不访问网页、不创建网站 Artifact；旧网站对象仍可读取。
- 隔离内置浏览器、页面快照、获准填写与逐次确认点击；人接管使旧授权失效，未知提交结果不自动重发。
- 人与智能体共享具备身份、修订和持久幂等检查的业务操作。流式回复、交付引用、执行详情、单次审批和精确停止使用真实 Runtime 回执；应用 SQLite 与 Runtime 数据库分别管理。
- 语音输入、对象朗读和 macOS 手动截图；图片、附件、草稿及旧对象保持兼容。各原生能力与语音服务的实际验收范围见实施记录，不将历史验收等同于所有平台均可用。

配置 Runtime 后，输入会持久化并进入发送队列；Enter 发送、Shift+Enter 换行。应用显示排队、处理、完成或错误状态，并接收真实回复。未配置时仅保存输入并明确显示“未发送”，不伪造 Agent 回复。

## 本机 Runtime 连接

中心服务从应用数据目录的 `runtime.json` 读取连接配置：`url` 为 loopback HTTP origin、`token` 为本机 Runtime 的 Dashboard 凭据、`namespace` 为工作空间专用 UUID。该文件应仅当前用户可读写，不放进仓库、前端代码或浏览器存储。

macOS 开发环境可以复用一个明确选定的已运行 Runtime：

```sh
node scripts/connect-local-runtime.mjs <Runtime进程PID> http://127.0.0.1:<Runtime端口>
```

脚本只适用于本机单用户 Runtime，验证凭据后保存权限为 0600 的配置；随后正常重开相应应用宿主。不要更换已有配置中的 namespace 或地址来覆盖正在使用的对话。Runtime 凭据更新后可重新运行连接脚本，保留原 namespace。

个人模式的对话、工作台、事项及项目默认交流共用一条持续会话；显式创建的项目命名会话对应独立 Session。应用、对象、导航与执行授权分开，工具按真实输入根解析项目，不能按当前页面猜测。旧 Session、历史和在途请求保留原路由，团队模式仍按授权空间隔离 Context。不挂载 Runtime 中已有的其他会话认知。Session 默认请求审批与 workspace-write，不继承服务器的完全访问模式。详见[持续会话](docs/17-continuous-conversation-and-execution.md)。

发送队列与事件游标保存在应用数据库中。重试沿用同一个消息标识；刷新或重启不会重复执行已接受的消息。原来仅保存的输入不会自动补发。围绕对象发送时固定对象 ID、版本和选中的原文，智能体通过工具读取确切版本；附件通过受授权的资源通道传递，不把所有对象正文拼接到提示词中。

回复和工具状态支持真实增量，最终以持久 Runtime 回执为准。对象工具、执行控制和调度接口需要配套 Runtime 开发构建。Desktop 生成私有 `host-tools-desktop.json`，通过 Unix 本地通信回调；Web 宿主使用 `host-tools.json` 和 HTTP。Runtime 启动时以 `MORPHZ_HOST_TOOLS_FILE` 指向对应清单；界面刷新不会自动重载 Runtime 的工具注册。独立中心与身份配置见[本机中心接入](docs/14-local-center-and-identity.md)。

## 语音服务

豆包语音凭据使用应用目录 `application/.env` 中的 `DOUBAO_API_KEY`，变量示例见 `.env.example`。应用宿主启动时读取，已由宿主环境提供的同名变量优先；不会加载任意 `.env` 变量来覆盖进程设置，也不将密钥传给界面。默认位置跟随应用工程而不是启动目录；也可用绝对路径 `MORPHZ_APP_ENV_FILE` 指定原文件，空字符串表示不读取配置文件。仓库迁移不会复制或改写已有凭据文件。

`.env` 已被忽略，不能提交、索引或作为模型资料；不要使用 `VITE_` 前缀。输入框听写需要明确的麦克风与语音服务授权，识别文字实时写入本次草稿，不自动发送；朗读明确发起并可停止。识别和合成都使用豆包 Plan 专用接口，凭据需具备对应服务权限。已验证真实服务通路；配置存在仍不等于连接一定可用，服务失败会明确显示，实际噪声和口音下的体验仍需试用。

## 数据位置与备份

| 系统    | 默认中心数据目录                                                                        |
| ------- | --------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Morphz/application/`                                     |
| Linux   | `$XDG_DATA_HOME/morphz/application/`，未配置时使用 `~/.local/share/morphz/application/` |
| Windows | `%LOCALAPPDATA%\Morphz\application\`                                                    |

目录内的 `workspace.sqlite` 保存对象、版本、批注、输入记录与资源。不依赖启动目录，不使用 Morphz Runtime 的数据库。可用绝对路径 `MORPHZ_APP_DATA_DIR` 或 Desktop 的 `--data-dir=` 指定中心；`MORPHZ_APP_PORT` 仅控制 Web HTTP 端口。桌面 Chromium profile 可用绝对路径 `MORPHZ_APP_PROFILE` 指定，缺省为应用数据根下的 `Morphz/desktop`。Windows 本机 Runtime 工具通信后端尚未实现，不能把目录支持当作完整桌面验收。

已有 `MorphzWork` 数据目录、profile 和 Chromium 分区就地继续使用，不自动搬移；同时发现新旧两份数据时拒绝猜测，要求显式选择。旧 `MORPHZWORK_*` 配置继续兼容，新名称优先（包括显式空字符串）；`MORPHZWORK_TEST_PROFILE` 对应 `MORPHZ_APP_PROFILE`。不要为了改名直接更改运行中的数据路径。

离线备份前正常关闭持有数据库的应用或服务，并备份整个数据目录。不要只复制运行中的 SQLite 主文件而忽略 WAL。桌面草稿和界面偏好属于原 Chromium profile，应在桌面退出后连同 profile 备份；应用数据库备份不包含它们。同一桌面的刷新、正常退出重开可恢复已保存草稿，但不承诺草稿跨设备同步。

构建后可运行 `npm run backup:center`，通过 SQLite 备份接口把含已提交 WAL 数据的一致性副本保存到数据目录的 `backups/` 下。备份不包含 Runtime 凭据、客户端草稿或外部来源原文件。当前数据库格式版本为 12；升级前备份，升级后不要用旧程序打开新库。身份模式、Runtime 地址和 namespace 不允许直接更换来接管已有对话。

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

语音输入持续发送 200 ms PCM 音频帧，并通过双向 WebSocket 接收实时转写增量；不攒满一段录音或等待停止才显示文字。停止时关闭麦克风并完成已采集尾段；取消、离开输入现场或手动改字会阻止迟到识别覆盖草稿。长文朗读仍按段合成并预加载下一段，支持暂停、章节跳转及本机进度恢复。TXT／Markdown 单对象支持 8 MB／200 万字符，已验证百万字文本；不代表支持 EPUB 解析或无限大小文件。

## 当前边界

- 中心仅监听 loopback；团队认证已接入个人凭据、会话撤销、项目授权和 Runtime 可信网关，但仍是本机模拟中心，不得公开暴露。没有邀请邮件、企业 SSO 或公网 TLS 部署。
- 共享项目内输入、对象与认知对项目成员共享；私有工作使用私有项目，不把同项目的不同 Session 当作秘密边界。
- Electron 开启进程沙箱与上下文隔离，关闭 Node 集成。第三方网页使用独立 WebContentsView／Session，不获得应用凭据和任意本机接口。
- 暂停／取消关注停止后续触发；已经派生的工作仍在执行记录中单独停止，不假装一个按钮取消了全部在途执行。
- 无签名安装包、自动更新、Mobile 或浏览器扩展；当前已验收的是 macOS 开发版，其他桌面平台尚未实测。
- 索引持久化并在授权范围内查询；工作空间快照仍面向小规模使用，未做大团队容量承诺。

当前业务边界以 [AGENTS.md](AGENTS.md)、[实施记录](docs/13-implementation-status.md)和[共享应用层](docs/24-shared-application-host.md)为准；早期对象模型与多端设计草案不等同于当前已实现功能。

## 名称与兼容边界

产品统一为 Morphz，应用工程包为 `morphz-application`，源码位于主仓库的 `application/`；Runtime 仍是独立模块。原 MorphzWork 仓库保留为历史与回退副本，不再作为日常开发源。仓库合并不迁移数据库、profile 或配置，也不重新命名历史协议。

新应用包使用 `morphz-app/v1` 和 `morphz-app:*` 消息，新输入使用 `morphz.application.input`：普通输入为 v1，兼容本地文件引用为 v2，目录授权为 v3，定向补充／后续输入为 v4。对象工具为 `host_morphz`，HTTP CSRF 标头为 `X-Morphz-Token`，终端存储键为 `morphz:`。已安装旧包继续使用原协议；旧输入格式定义保持原字节，旧工具名继续接受且沿用同一幂等命令身份。旧登录态与同中心、同身份的草稿可读取，新值优先，原始数据不删除。历史文档、消息、对象 ID、Context/Session 命名空间以及兼容测试中的旧名称有意保留，不代表当前产品仍叫 MorphzWork。

已安装的兼容 macOS 开发启动器不会仅因名称更新被改写或重新签名；这避免破坏当前授权，但不代替未来正式发行所需的稳定签名与更新机制。

## 仓库联测与许可证

从 Morphz 仓库根目录构建联测用 Runtime：

```sh
cargo build --locked -p morphz --bin morphz --features experimental-session-io
npm --prefix application run test:runtime-ipc
npm --prefix application run test:continuation-runtime
npm --prefix application run test:runtime-identity
```

脚本默认使用本仓库 `target/debug/morphz`（Windows 为 `morphz.exe`），不依赖当前工作目录
或旧相邻仓库。可用 `MORPHZ_APP_RUNTIME_BINARY` 显式选择测试二进制；这不会更换正在运行
的用户 Runtime。本地 SQLite、HTTP 和 Session IO 集成均使用隔离测试数据。

原创应用源码遵循仓库根目录的 [Apache-2.0 许可证](../LICENSE)及[适用范围](../LICENSE_SCOPE.md)。
第三方依赖保持各自条款，清单见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)；
品牌素材遵循 [TRADEMARKS.md](../TRADEMARKS.md)。此说明不是已完成正式签名安装包的声明。
