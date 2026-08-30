# Morphz 0.1 开源发布与用户体验 TODO

> 文档类型：可执行工作清单，不替代发布规范
> 规范上位文件：[Morphz 0.1 Developer Preview 发布就绪规范](./morphz_0_1_developer_preview_release_readiness_specification.md)
> 审查基线：`9e3015a`
> 审查日期：2026-08-31
> 范围：开源仓库、安装分发、首次运行、CLI/TUI/Dashboard、`morphz-edge`、配置凭证、跨平台、安全、升级恢复、贡献者体验

## 1. 使用方式

这份文档把发布规范中的 G-02、G-03、G-07、G-09、G-10 转换成可以逐项关闭的工程任务。它不把研究、论文、主站叙事和独立人格的全部发布工作重复抄进来。

状态约定：

- `[ ]` 尚未开始；
- `[~]` 已有实现基础，但未达到本项验收标准；
- `[x]` 已由可定位证据关闭；
- `[!]` 当前确认的发布阻断；
- `[?]` 需要产品或法律决策，不能由代码自行决定。

优先级约定：

- `P0`：Developer Preview 公开发布前必须关闭；
- `P1`：首个公开版本应尽快具备，可以在 RC 后半段并行完成；
- `P2`：不阻断 0.1，但应留在公开路线图中。

关闭任务时必须同时补充日期、commit、验证命令或验收报告。只勾选复选框而没有证据不算完成。

## 2. 审查结论

Morphz 已具备较强的 Runtime、恢复、双存储、Dashboard、TUI、双语文档和协议测试基础，但目前仍处于“源码仓库可供核心开发者运行”，尚未达到“陌生用户可以安全下载、安装、诊断、升级和报告问题”的开源发行状态。

最先阻断发布的不是视觉细节，而是四个边界：

1. **法律授权尚未建立**：仓库没有正式 `LICENSE`；现有 IPR Notice 明确说明权利保留、尚未授予仓库级源码许可。
2. **没有真正的发行物**：CI 能构建源码，但没有跨平台 Release workflow、下载制品、checksum、签名、SBOM 或安装器；Quick Start 仍要求用户安装 Rust 并自行编译。
3. **支持范围还没有被完整冻结**：macOS、Linux 与 Windows 已有原生 sandbox 实现和对应 CI 门禁，但 Windows 原生门禁尚未在本变更提交后实际执行，README、Docker 与 Quick Start 也还没有在入口处给出统一支持矩阵。
4. **首次诊断仍可能失效**：审查中 `morphz doctor --language=en` 在 macOS 系统代理探测路径发生 panic；设置 `MORPHZ_HTTP_PROXY_MODE=direct` 后可运行，但在“未配置 Provider”时仍以退出码 0 结束。

另外确认：

- `cargo package -p morphz --allow-dirty` 当前失败，首先遇到 path dependency 缺少发布版本；Manifest 同时缺少 description、license、repository、homepage、documentation 等元数据。
- `.env.example` 仍建议复制工作目录 `.env` 并声称不自动使用系统代理，与当前“不隐式加载工作区 `.env`”和 HTTP 默认 `system` proxy 策略矛盾。
- `morphz-edge` 已拆成独立二进制且保留 `morphz edge`，但尚未进入公开网站文档、发行矩阵、安装脚本或系统服务生命周期。
- Dashboard 有较多领域与布局单测，但没有真实浏览器 E2E、视觉回归、键盘流程和自动可访问性门禁。
- 公开 website 已有中英文文档；根 README 仍以中文长篇架构说明开头，首次安装入口较深。
- CI 覆盖 Rust、PostgreSQL、macOS/Linux/Windows sandbox 与 Dashboard；公开 website 本身尚未进入 CI。
- 本机 `target/` 在审查时约 209 GB；已有保留增量编译的清理脚本，但贡献者仍缺少自动预算、可见报告和统一维护命令。

## 3. P0：公开发布阻断项

### OSR-001 `[!] [?]` 确定开源许可证与知识产权边界

**目标**：访问源码的人能够明确知道可以做什么，贡献者、规范实现者和商标使用者不会从沉默中猜测权利。

**TODO**：

- [ ] 由负责人和法律顾问选择 Runtime 源码许可证；
- [ ] 决定 Yao、SDK、conformance runner、测试 fixtures、论文产物和规范文本是否使用相同许可证；
- [ ] 决定 patent grant、贡献者专利承诺、inbound-equals-outbound、CLA 或 DCO；
- [ ] 发布 trademark/compatibility mark policy；
- [ ] 添加根 `LICENSE`，需要时添加 `NOTICE`、规范文本许可证及文件级例外；
- [ ] 让 `Cargo.toml`、README、网站页脚和贡献指南引用同一权威政策；
- [ ] 对字体、Logo、图标、图片、数据集、Benchmark 和论文素材完成来源及许可清单。

**验收**：法律/IPR 负责人书面确认；公开 clone 根目录可以直接找到许可证、专利/贡献政策和商标边界；`docs/standards/IPR_STATUS.md` 不再是“尚未授权”的最终状态。

**证据**：当前仓库无 `LICENSE`；`docs/standards/IPR_STATUS.md` 明确保留权利并列出 Candidate 前必须作出的六项决定。

### OSR-002 `[!] [~]` 冻结 0.1 支持平台与安全能力矩阵

**目标**：用户在下载前就知道自己的系统能否运行、能否安全执行工具，以及哪些模式只适合实验。

**TODO**：

- [ ] 明确 0.1 支持的 OS/arch 组合，例如 macOS arm64/x86_64、Linux x86_64/arm64；
- [~] Windows 已采用固定版本的 Codex 原生安全子系统并生成完整 helper bundle；待原生 Windows CI 首次通过后冻结为 Developer Preview 支持级别；
- [ ] 分别声明对话、Dashboard、TUI、SQLite、PostgreSQL、Managed SSH、Edge 与 native sandbox 的支持级别；
- [x] Linux Developer Preview 的 workspace-write 后端采用 Bubblewrap；缺少或不能运行 `bwrap` 时 fail closed，不静默退回 full access；
- [ ] 明确 Docker 镜像中 `exec` 的实际安全/可用边界；
- [~] macOS、Linux、Windows 均已配置原生攻击 CI；仍需在本次实现提交后取得三平台首轮全绿证据，而不是把交叉编译当作验收；
- [ ] 在下载页、Quick Start、`morphz doctor` 和 `morphz-edge doctor` 中展示同一矩阵。

**验收**：所有发布制品都有对应 smoke；文档不会把容器内不可用的嵌套 sandbox 描述成已受保护执行；未支持平台会在安装前或启动时给出可行动解释。

**证据**：Linux 已在 Debian/Rust 原生容器完成编译、专属测试和 Clippy；CI 新增 Ubuntu Bubblewrap 真实攻击任务与 Windows Restricted Token/ACL/WFP/Job Object 真实攻击任务；Windows 安全结论仍以原生 Runner 首次通过为准。

### OSR-003 `[!]` 建立可下载、可验证的 Release 制品

**目标**：普通用户不安装 Rust、不 clone 仓库也能获得可信的 `morphz` 和 `morphz-edge`。

**TODO**：

- [ ] 建立 `v0.1.0-rc.N` 与正式 SemVer tag 规则；
- [ ] GitHub Release workflow 同时构建 `morphz` 和 `morphz-edge`；
- [ ] 为 OS/arch 产出统一命名的 `.tar.gz`/`.zip`；
- [ ] 产出 SHA-256 checksum manifest；
- [ ] 选择并实施签名/证明机制（例如 Sigstore provenance）；
- [ ] 生成 SBOM，并记录 Rust、npm 和系统动态依赖；
- [ ] Release Notes 列出兼容范围、Experimental 功能、迁移与已知问题；
- [ ] 让 Release workflow 从干净 tag 构建，并在产物中写入准确版本与 commit；
- [ ] 为制品安装后的 `--version`、`--help`、`doctor` 和首次启动建立 smoke。

**验收**：新用户只通过 Release 页面即可下载、校验、安装并完成首次响应；`morphz --version` 与 tag/commit 一致；两个二进制都包含在发行清单中。

**证据**：当前 CI 的 release job 只执行 `cargo build --release --workspace`，没有上传 artifact、checksum、签名、SBOM 或 release；当前 tag 主要是实验冻结标签，没有公开 SemVer Release 标签。

### OSR-004 `[!]` 建立 10 分钟 Fresh Install 路径

**目标**：没有历史 Morphz 配置的陌生用户可以从下载页完成第一次真实模型响应。

**TODO**：

- [ ] 为支持平台提供一条复制即可运行的安装命令；
- [ ] 提供不需要管理员权限的安装位置，以及显式 `--prefix`/目标目录；
- [ ] 提供卸载说明，区分二进制、用户配置、凭证和数据；
- [ ] Quick Start 首屏先给最短成功路径，再链接概念和架构；
- [ ] Dashboard Setup 与 `setup --tui` 各做一次全新用户验收；
- [ ] SSH/headless 环境不依赖自动打开浏览器；
- [ ] 首次运行明确显示正在做什么，不在 Keychain、模型目录、网络或数据库初始化处无提示等待；
- [ ] 记录总耗时、外部下载时间、失败位置和用户采取的恢复动作；
- [ ] 至少 5 名未参与开发的体验者在无作者指导下完成。

**验收**：发布规范 G-03 与 G-09 的验收报告落盘；文档命令在干净环境逐字可执行；首次真实响应目标时间不超过 10 分钟，外部 Provider 等待单列。

**证据**：现有双语 Getting Started 仍从 `cargo build --release` 开始；Setup 的 Dashboard/TUI 两条路径已经实现，可作为验收基础。

### OSR-005 `[!]` 让 Doctor 与启动错误真正可依赖

**目标**：用户遇到问题时，第一条诊断命令不会 panic、误报成功或要求阅读源码。

**TODO**：

- [ ] 修复/隔离 macOS SystemConfiguration 系统代理探测 panic；第三方库 panic 不能越过应用边界终止进程；
- [ ] 验证 `system`、`direct`、显式 proxy、`NO_PROXY`、`.local`、SSH/headless 和受限 launch context；
- [ ] `doctor` 检查配置解析、数据库读写、workspace、sandbox backend、Secret Store backend、Provider 路由、网络/DNS/TLS 和模型最小请求；
- [ ] 区分离线结构检查和有成本的 `--live` 请求；
- [ ] 添加稳定 JSON 输出、每项 stable code 和机器可用退出码；
- [ ] 缺少 Provider、不可用 sandbox 或关键凭证时不得打印 `[missing]/[error]` 后仍退出 0；
- [ ] 错误必须包含原因、影响、下一步命令，且日志保留英文 stable event code；
- [ ] 顶层 CLI 加 panic containment/崩溃报告提示，确保不会泄露 secret；
- [ ] 为 `morphz-edge` 提供对应的 `doctor`，检查凭证、Gateway、协议版本、workspace、sandbox、worker 和本地状态目录。

**验收**：故障矩阵中所有场景都产生稳定非零退出码或明确成功；无 panic；JSON schema 有测试；用户可以只凭输出进入正确修复路径。

**审查复现**：默认系统代理路径运行 `morphz doctor --language=en` 在 macOS SystemConfiguration 发生 `Attempted to create a NULL object` panic；设 `MORPHZ_HTTP_PROXY_MODE=direct` 后运行成功，但未配置 Provider 时仍退出 0。

### OSR-006 `[!]` 统一公开文档与真实默认行为

**目标**：README、`.env.example`、网站文档、CLI Help 和实际代码不互相矛盾。

**TODO**：

- [ ] 把根 README 重写为简短双语入口：一句定位、支持平台、安装、5 分钟 Quick Start、截图/演示、文档、限制、贡献与许可证；
- [ ] 将长篇架构与实验历史移到 docs 索引，不挡住首次运行；
- [ ] 修正 `.env.example`：工作目录 `.env` 不会隐式加载；默认 proxy mode 是 `system`；Provider/Auth/Route 以当前 setup/catalog 为准；
- [ ] 更新中英文 Getting Started，优先使用 Release 制品而不是源码编译；
- [ ] 将 `morphz-edge` 安装、配对、运行、服务管理和权限边界加入公开中英文网站；
- [ ] 新增当前支持矩阵、Known Limitations、升级/降级与数据目录说明；
- [ ] 生成并校验 CLI reference，避免 Help 与网站漂移；
- [ ] 所有公开示例进入可执行 docs test/smoke；
- [ ] 对历史设计文档增加醒目的历史/非权威标记，避免搜索结果传播过期边界。

**验收**：建立自动一致性门禁；随机抽取的公开命令能在对应制品上运行；中英文页面字段和链接对齐；README 首屏不要求理解 Context 内核即可完成安装。

**证据**：`.env.example` 当前要求复制为 `.env` 并声称 Morphz 不自动读取系统代理；代码默认 proxy mode 为 `system`，README 又明确工作目录 `.env` 不会被隐式加载。

### OSR-007 `[!]` 冻结安全、隐私与供应链发布边界

**目标**：开源用户知道数据在哪里、如何报告漏洞，发行方知道交付物包含什么第三方代码。

**TODO**：

- [ ] 添加 `SECURITY.md`：支持版本、私密报告渠道、响应时限、披露流程；
- [ ] 发布数据目录、凭证后端、日志/Event 内容、删除、备份和遥测政策；
- [ ] 明确 Morphz 默认不上传哪些本地数据；若未来有遥测必须 opt-in；
- [ ] 对 Git 历史与 Release artifact 运行 secret scan；
- [ ] 对 Rust/npm 依赖运行漏洞、许可证和来源审计；
- [ ] 建立 Dependabot/Renovate 或等价更新流程；
- [ ] 对 Dashboard token、Gateway token、Edge pairing code 和设备凭证做发布前 threat-model 复核；
- [ ] `morphz-edge pair` 支持交互式/STDIN/文件读取一次性配对码，避免默认写入 shell history 和进程参数；
- [ ] 发布制品、容器和安装脚本遵循最小权限，不默认启用 full access；
- [ ] 生成依赖/素材许可清单并与 SBOM 对齐。

**验收**：安全入口可公开访问；secret/license/vulnerability gates 进入 CI/Release；一次演练能够从报告到修复公告闭环。

### OSR-008 `[!]` 建立干净 RC、完整 CI 与发布前验收

**目标**：发布 commit 不依赖作者工作区状态，所有公开产品面都在同一门禁中。

**TODO**：

- [ ] 发布候选前 `git status --short` 为空，未跟踪实验产物和设计草稿被明确归档或排除；
- [ ] 从全新 clone 运行 format、Clippy、workspace tests、SQLite/PostgreSQL conformance；
- [ ] CI 增加 website lint/build/test，并校验双语 docs 与 CLI 生成物；
- [ ] Dashboard 增加真实浏览器 E2E，而不只测试纯函数；
- [ ] 对支持平台运行 Setup → first reply → restart → resume → tool → shutdown smoke；
- [ ] 对 `morphz-edge` 运行 pair → execute → reconnect → revoke smoke；
- [ ] 运行升级旧数据库、Provider 错误、SQLite busy、磁盘满、SIGTERM 和中断恢复场景；
- [ ] 运行 4–8 小时单进程 soak 并记录内存、DB、任务、Token、句柄和错误率；
- [ ] 建立 RC checklist，要求 commit、binary hash、配置、验证者和证据路径齐全。

**验收**：发布 tag 的 CI 全绿；全新 clone 可复现；无未说明的 flaky test；发布规范 G-02/G-07 有正式验收报告。

**审查现状**：Rust、PostgreSQL、macOS sandbox 与 Dashboard 已有 CI；website 尚未进入 CI。本次审查开始时工作区仍存在与本任务无关的 tracked/untracked 变化，因此当前 HEAD 不能直接视作干净 RC。

### OSR-009 `[!]` 定义升级、备份、恢复与降级策略

**目标**：Developer Preview 可以允许 breaking change，但不能让用户在升级时无提示丢失 Context、Session、凭证或后台任务。

**TODO**：

- [ ] 明确 0.1 的 Schema、配置、Provider catalog 和 Edge credential 兼容策略；
- [ ] 升级前自动检查版本、空间和备份条件；
- [ ] 提供可验证的 SQLite 备份/恢复命令与 PostgreSQL 操作指南；
- [ ] 配置迁移必须原子、可审计，并保留可恢复副本；
- [ ] 明确是否支持 binary downgrade；不支持时要在升级前阻止并解释；
- [ ] 用至少两个历史版本 fixture 验证升级；
- [ ] 对升级中断、磁盘满、迁移失败和旧 Edge protocol 建立回归；
- [ ] Release Notes 明确数据格式变化与回滚步骤。

**验收**：在副本上完成 backup → upgrade → verify → restore 演练；失败不会破坏原数据库/配置；用户能知道何时可以安全回退。

### OSR-010 `[!]` 决定 Cargo/crates.io 发布策略

**目标**：不要让仓库看起来可 `cargo install`，实际却在打包时失败。

**TODO**：

- [ ] 决定 0.1 是否发布到 crates.io；
- [ ] 若不发布，在 package 中设置 `publish = false`，公开文档只指向 Release 制品；
- [ ] 若发布，为所有 path dependency 补兼容 version 并先发布依赖 crate；
- [ ] 补齐 package description、license、repository、homepage、documentation、readme、keywords/categories；
- [ ] 处理嵌入 Dashboard 产物不位于 `morphz/` crate package 内的问题；
- [ ] 将 `cargo package` 与解包后 build/test 加入 CI；
- [ ] 验证 `cargo install morphz` 同时安装哪些二进制，并明确用户如何只安装 `morphz-edge`。

**验收**：要么 `cargo package`/`cargo install` 从干净环境通过，要么仓库明确、主动地声明不支持 crates.io 安装。

**审查复现**：`cargo package -p morphz --allow-dirty` 因 `morphz-cognitive-coordination` path dependency 没有 version 失败；Manifest 同时报告缺少全部主要发布元数据。

## 4. P1：首发体验收口

### OSR-101 `[~]` Setup 状态机与凭证体验

- [ ] Setup 每一步显示当前动作、是否涉及网络/系统授权、可取消和可重试边界；
- [ ] Keychain 授权等待采用面向人的时限，并允许改选 host env/file backend，不阻断 Runtime 启动；
- [ ] SSH/headless 模式不会触发不可见系统弹窗；
- [ ] OAuth、API Key、本地无认证服务和自定义 Provider 都能从失败步骤继续；
- [ ] 完成页显示实际 Route/Account/Model，并提供立即实测；
- [ ] 未完成 Setup 不写入半成品可选账号。

### OSR-102 `[~]` CLI 输出、语言与脚本契约

- [ ] 所有管理命令支持统一 human/JSON 输出和 stable error code；
- [ ] `--language=en` 时不再出现硬编码中文错误；
- [ ] `morphz-edge` 接入统一语言、日志和错误 envelope；
- [ ] stdout 只承载结果，诊断和进度进入 stderr；
- [ ] 管理命令的成功/失败退出码建立契约测试；
- [ ] shell completion 随安装器自动安装或给出明确命令。

### OSR-103 `[~]` Dashboard 真实浏览器体验门禁

- [ ] Playwright 覆盖 Setup、登录、首条消息、切模型、切 Sandbox、停止回复、错误恢复和重连；
- [ ] 320/375/768/1024/1440 px 关键布局做截图回归；
- [ ] 键盘焦点、Dialog trap、Escape、Tab、屏幕阅读器标签通过自动/人工验收；
- [ ] 增加 axe 或等价可访问性检查；
- [ ] 所有动画尊重 `prefers-reduced-motion`；
- [ ] 长模型名、长路径、长身份、CJK/英文混排和 200+ 模型列表成为固定 fixture；
- [ ] WebSocket 断线、401、Provider 配额耗尽和 Runtime 重启有明确恢复界面。

### OSR-104 `[~]` TUI 兼容性与可发现性

- [ ] 在 iTerm2、Terminal.app、WezTerm、Windows Terminal/SSH 等声明支持的终端验收；
- [ ] 小尺寸、窄字符、Emoji/CJK 宽度、无真彩和 reduced-motion/静态模式验收；
- [ ] 首次进入提供不打扰的快捷键提示，所有重要动作可从 Control 面搜索；
- [ ] 剪贴板、鼠标选择、内嵌 Shell 返回和异常退出恢复有 smoke；
- [ ] 提供 `--no-color`、非交互检测和日志文件定位。

### OSR-105 `[~]` `morphz-edge` 产品化

- [ ] 增加 `morphz-edge doctor` 与结构化 `status --json`；
- [ ] 提供 launchd/systemd 安装、启动、停止、日志和卸载命令；
- [ ] 配对成功后可选择立即运行或安装为服务；
- [ ] 服务端协议不兼容时在配对前清晰失败；
- [ ] 断线重连、凭证轮换、撤销、workspace 变更和升级不产生重复 Target；
- [ ] 明确一个节点多 workspace/Target 的产品模型；
- [ ] 日志显示 Node、Target、Gateway、权限模式和最近心跳，不泄露 token；
- [ ] 完整 `morphz edge` 入口继续保留并与独立二进制共用行为测试。

### OSR-106 `[ ]` 可分享的脱敏支持包

- [ ] 增加 `morphz support-bundle`，收集版本、平台、配置 provenance、Doctor、Schema、队列摘要和最近 stable event codes；
- [ ] 默认排除用户消息、Mind、工具正文、Token、API Key、OAuth、路径敏感段；
- [ ] 用户可预览 manifest 并显式选择是否包含内容；
- [ ] 归档带生成时间、版本、redaction report 和校验和；
- [ ] issue template 引导附上支持包而不是截图全部日志。

### OSR-107 `[ ]` 启动、体积与磁盘预算

- [ ] 定义 `--help`、`doctor`、TUI warm start、Server ready 和 Edge reconnect 的时间预算；
- [ ] 记录 Release 二进制大小、冷/热启动、RSS 与空闲连接数；
- [ ] 非模型管理命令不得初始化 Provider、Keychain 或完整 Runtime；
- [ ] 为数据库、Artifact、日志和缓存提供可见磁盘用量及安全清理命令；
- [ ] 将 Cargo debug object 清理脚本封装为容易发现的开发命令，并增加 dry-run/预算提示；
- [ ] CI 或本地检查在 target/cache 异常增长时给出建议，不自动删除用户产物。

**审查数据**：本机 `target/` 约 209 GB；已有 `scripts/prune-cargo-unpacked-debuginfo.sh`，但需要更明显的入口和预算反馈。

### OSR-108 `[ ]` 发布运维与已知问题入口

- [ ] 添加 `CHANGELOG.md`、`KNOWN_ISSUES.md` 与公开状态页入口；
- [ ] 区分 Runtime、Provider、额度、数据库、Edge、Gateway 和计划维护故障；
- [ ] 发布回滚、停止接入、只读模式和数据库恢复 runbook；
- [ ] 定义 Release 当天值守、事故级别、通知与复盘模板；
- [ ] 每个 Release Notes 链接已知限制与安全公告。

### OSR-109 `[~]` 贡献者首次开发体验

- [ ] CONTRIBUTING 增加依赖安装、仓库结构、最小测试、完整 Gate、前端生成物和提交约定；
- [ ] 提供一条 `just`/`make`/`xtask` 统一命令，不要求新人记住多套 Cargo/npm/Perl 命令；
- [ ] 添加 PR template、bug/feature issue template、Good First Issue 规范；
- [ ] 明确 DCO/CLA、行为准则和治理升级路径；
- [ ] 提供最小 fixture 与无需真实 Provider 的开发模式；
- [ ] 记录常见 macOS/Linux 链接、SQLite、Node、Dashboard dist 和磁盘问题。

### OSR-110 `[~]` Docker 与服务部署体验

- [ ] Docker build 同时明确是否包含 `morphz-edge`；
- [ ] 提供非交互配置、持久卷、强 token、反向代理/TLS 和 WebSocket 示例；
- [ ] 镜像启动前检查非 loopback token，不在运行时才模糊失败；
- [ ] 使用 digest 固定基础镜像或记录供应链策略；
- [ ] 提供 graceful SIGTERM、健康检查、备份和升级 smoke；
- [ ] 明确容器内 native sandbox 不可用时的工具执行策略；
- [ ] 若发布多架构镜像，真实验证 amd64/arm64。

## 5. P2：0.1 后续体验与生态

### OSR-201 `[ ]` 包管理器与自动更新

- [ ] Homebrew、Scoop/WinGet、AUR 或适合支持平台的包管理器；
- [ ] 可关闭的版本检查；
- [ ] 签名验证后的更新、回滚与 channel（stable/preview）；
- [ ] Desktop 分发形成独立路线，不阻塞 CLI Developer Preview。

### OSR-202 `[~]` Linux/Windows native sandbox

- [x] Linux 使用 Bubblewrap 的只读宿主根、显式 bind、user/PID/IPC/network namespace 与 capability drop；
- [~] Windows 使用固定 Codex revision 的 Restricted Token、ACL/Capability SID、WFP、私有桌面与 Job Object；待原生 Windows CI 首次通过；
- [x] Linux/Windows 与 macOS 使用同一 PermissionProfile 和 Permission Broker；
- [x] Shell 语法分析仅负责把显式后台意图规范化为受管 Job，不冒充 OS sandbox；缺少原生后端时 fail closed。

### OSR-203 `[ ]` SDK/crate 物理稳定面

- [ ] 将支持的 SDK 与内部 Runtime 类型从 crate 结构上分离；
- [ ] 明确 Rust/TypeScript SDK 版本策略；
- [ ] 生成 API docs、示例和兼容测试；
- [ ] 内部模块不再因为评测依赖而被误认为公共稳定 API。

### OSR-204 `[ ]` 插件、扩展与社区发现

- [ ] 冻结 Harness/Skill/Extension 的安装、权限、签名和升级边界；
- [ ] 社区模板必须经过最小安全检查；
- [ ] 市场、计费、SaaS 组织能力留在后续版本，不扩大 0.1 范围。

## 6. 建议执行顺序

### Wave 0：先做决定，不写更多功能

1. OSR-001：许可证、专利、贡献和商标；
2. OSR-002：支持平台与 sandbox 矩阵；
3. OSR-010：是否发布 crates.io；
4. 冻结 0.1 的安装渠道与版本命名。

这些决定会直接改变 README、CI、Release workflow 和安装器。未决定前不应分别实现多套互相冲突的分发方案。

### Wave 1：让陌生用户能安全安装

1. OSR-003：Release artifacts；
2. OSR-004：Fresh Install；
3. OSR-006：README、Quick Start 与真实默认统一；
4. OSR-007：Security 与供应链入口。

### Wave 2：让故障可以自助解决

1. OSR-005：Doctor 与 panic/exit code；
2. OSR-009：升级、备份与恢复；
3. OSR-106：脱敏支持包；
4. OSR-108：Known Issues 与事故入口。

### Wave 3：产品面验收

1. OSR-101：Setup；
2. OSR-102：CLI；
3. OSR-103：Dashboard；
4. OSR-104：TUI；
5. OSR-105：`morphz-edge`。

### Wave 4：RC 冻结

1. OSR-008：clean clone、CI、E2E、soak；
2. OSR-107：性能、体积与磁盘预算；
3. OSR-110：Docker/服务部署；
4. 私密预览后只修阻断问题，生成 RC tag。

## 7. 建议立即领取的五个任务

为了保持“大道至简”，第一轮只做下面五项：

1. **作出 OSR-001 的许可证/IPR 决定**，否则“开源发布”在法律上尚未发生；
2. **取得 OSR-002 三平台原生 CI 证据并发布统一能力矩阵**，避免安装器和文档超出实际验证范围；
3. **建立 OSR-003 的最小 RC Release workflow**，先让两个二进制能够被下载和校验；
4. **修复 OSR-005 的 Doctor panic 与退出码**，让排障入口先可靠；
5. **关闭 OSR-006 的 `.env`/proxy/安装文档矛盾**，为第一次陌生用户演练准备唯一正确路径。

这五项完成后，再进行第一次 Fresh Install 录屏和非作者验收；不要在尚无可下载制品时先大规模招募体验者。

## 8. 关闭记录

| 日期 | 任务 | 状态变化 | Commit/证据 | 验收人 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-08-31 | 初始统一审查 | 新建 | 基线 `9e3015a` | 待定 | 记录当前发布阻断、已有基础与建议执行波次 |
