# 桌面能力实施记录

## 2026-10-06 原 App 同中心恢复与持久保全复核

最终构建通过后，冻结真实 service／desktop 依赖和实际 renderer 入口图。
按用户已有的「备份后恢复原应用」批准，先重新核实际 Runtime／Platform
无在途工作、Host 无已连接工具请求；正常退出和 SIGTERM 仍被旧模态阻塞，
两次失败及回执保留。仅对原 main PID 82919 发出一次 SIGKILL，未对 Runtime、
进程组或猜测的子进程发信号。内核空闲不证明旧内存断开 Promise 为零；
此前批准也不保证尚未落盘的临时内容可保留。

确认 profile／center 无文件持有者后，独占复制停止后的 7,491 个普通文件、
逐份核原字节 hash，保留三个原 Singleton symlink 而不跟随。随后只重开原
`/Users/shafreeck/Applications/Morphz.app`，原 profile／中心 UUID／身份路径
不变；新 main 为 38448，原 Runtime 68670 的 start／executable／cwd 保持。
CoreGraphics 的原窗口连续两次截图均显示完整对话、项目、Dock／输入框和
「智能体已连接」，无旧 destroyed-object 弹窗或 bootstrap 空白。截图为
`/tmp/morphz-original-app-recovered-ROOT-oct06.png` 与
`/tmp/morphz-original-app-recovered-ROOT-STABLE-oct06.png`，不是隔离测试窗口。

Root 实际 query-only 复核原十一个中心库：163 张原表全部主键列／顺序保持，
完整性与 FK 通过；160 张字段／键集／完整 typed 行摘要精确不变。三项差异
逐项解释而非整类豁免：Platform schema marker 升级；runtime_deliveries 中
旧 running 根仅 state→cancelled，另一 completed 行仅顶层 JSON 键序；
runtime_state 仅连接、旧错误及活动读取完整标志恢复。两条投递的 request、
source、root、input、Session、causal IDs 保持，历史／Session 原表保持，
cursor 仍为 6484，没有回退或伪造回复。

Root 完整冷审并在独立私有目录再次实际核原 Runtime 77 张表：全部原主键、
行数、typed 全行 digest 精确不变，旧取消链七个事件保持；未来 10 月 23 日
Schedule 仍 queued／revision 1。成功日志
`/tmp/morphz-runtime-original-postreopen-ROOT-oct06.log`，回执 SHA-256
`7b26980da5e61a6cdef6257076d7b3f6c0b68d6c7749a066aa5bcc085b78c0a2`。
这证明没有新增持久 IO、模型尝试或执行记录，不是物理网络尝试的完整审计。

原 App 已恢复不等于第三方真实账户已连接；没有安装作者应用、改本人许可、
发送模型请求或改变原业务资料。停止后 profile 字节备份也尚不等于全部逻辑
草稿及原窗口交互验收；这些保全边界继续单独核查，不据截图宣称整个目标完成。

Root 另完整冷审并实际执行固定停止后快照的有限离线 LevelDB 解码：十个
manifest 活文件的 SHA 前后保持，WAL／SST CRC、序列与 tombstone 检查通过；
分别取得 1,292 个草稿记录的 origin／原编码键／UTF16LE 值摘要和五个 session
owner。八组合成 codec 检查通过，但自制窄解析器不是 Chromium 等价实现。
只读逻辑报告 SHA-256 为
`7123b0103085044d982902d50d54352eac15df6190cbcfa3f5a8ded07784d491`。
未读取运行中的 profile；owner 跨 map 交集和 JSON 有效不能证明当前窗口
选择或显示该草稿，canonical 空值遮蔽旧 legacy 值也不能据摘要推断不存在。

## 2026-10-06 原输入根线程取消后的有限投递恢复

原 App 的只读持久链核验发现：一项 Host ledger 仍为 running，但其原输入、
唯一根 Thread、旧 generation 取消 Event 和 no_reply outcome 已在 10 月 3 日
提交；Activation／Job／Plan 均无在途执行。旧 Host 过滤取消事件却推进 cursor，
仅重开不能恢复已越过的终态，不能据 running 投影声称后台仍在工作。

修复只核已接受普通输入的精确原根：启动时有限候选，以及新提交的同根取消
事件触发；不新增定时器／轮询，连接失败或重连不触发核对。每轮最多八项，
每项最多四页一百事件。原 Human 的 Platform 读权、完整输入来源与原请求
语义、当前 cancelled 根／family 身份和 revision、旧 generation 取消事实、
末次权限／owner 核验全部成立，才只更新该 delivery 的取消状态元数据。
不回退 cursor、不重发 IO、不产生回复；保留原输入字节、历史、草稿及请求身份。
子线程取消／父级 terminal barrier 不结算，未知／超页／撤权／退休保留原账本。

Root 完整冷审并独立正式五文件 46/46、required PostgreSQL、零跳过，日志
`/tmp/morphz-runtime-root-cancellation-ROOT-FINAL-oct06.log`；全工程类型、
新测试格式与差异检查通过。新三十一项使用真实 Host SQLite／Human 门和
受控 Runtime HTTP，不冒称本轮真实 Rust／付费模型或用户原窗口验收。
原 RED、真实 Rust Option 为 null 的比较失败与连接重试重复核对风险均保留；
修正仅归一比较副本，并移除连接 observer 的额外触发，不改原请求或旧断言。

原窗口为已有单用户模式，沿用原令牌和 Host Human 权限；隔离 gateway 测试
另验证真实 IdentityCenter／Human headers，不能据此声称原 Runtime 识别
Human role。跨 Runtime／Platform 的读取不是原子事务；未知旧事实只由新
Host 或新提交的同根取消事件重新核验，不做无限重试。此阶段尚未重开原 App。

## 2026-10-06 原用户中心备份与 schema-only 副本升级审计

原 App 安全恢复前，已独立在线备份十二个原数据库并逐库做完整性、FK、
字段／键集／行数／完整行 digest 基线；另复制中心原文件、原客户端资料、
Runtime 工作目录和启动配置。源只读，不 checkpoint、停止 Runtime 或
执行测试业务；原 App／Runtime 的 PID、start、executable 在前后相同。
各 SQLite 快照一致，但不是跨数据库同一原子时刻；仍运行的 profile 原
文件复制仅 best-effort，四十三个 opaque draft/storage 文件 SHA 不等于
逐项逻辑草稿解码证明。私有备份保持 0700 目录／0600 文件，不提交原数据。

另以全新私有目录、COPYFILE_EXCL 只复制审批快照的 Platform／Workspace。
脚本先复现原 manifest 的六十二张表全部字段、主键、行数和 typed full-row
digest，随后只在副本调用生产 Store 的 schema 初始化；不打开原库，甚至
不为备份快照创建 SQLite 句柄，不启动 Host／Application／Center／Runtime。
Workspace 19→21、原 UUID 不变；Platform 10→12。六十一张原业务表及
sqlite_sequence 全部精确不变，另一表只有 schema marker 更新；新增七张
认知表为空，真实注册派生集合也为空，四项 authority verifier 调用数为零。
前后原 App／Runtime 身份及审批 manifest／快照 hash 保持。

Root 完整冷审、实际执行的成功日志为
`/tmp/morphz-schema-copy-audit-ROOT-THIRD-oct06.log`，私有回执 SHA-256 为
`a05cb6e2f10d6edcef54408c2b8f5d32c3947c476dc4dca66b93d5edf55a4002`。
首轮外部脚本缺 ESM 上下文、第二轮 Node SQLite null-prototype 行对象与普通
期望对象比较失败的原日志和副本均保留；后者尚未运行初始化。修正仅增加
私有 module 配置、以原字段 spread 归一查询对象，并在新目录重新审计。
没有删除数据断言、覆盖失败、改迁移或把脚本错误归因数据库环境。

这不是原中心已经升级、原 App 已恢复、在途工作连续性或跨库原子恢复证明。
复制副本的最终主文件 hash 也不代表忽略 WAL 的独立迁移后备份可用。

## 2026-10-06 真实 Web 迟到 locator 响应与当前 Document 验收

新增两个完整生产 App 的负控分别使用真实 SQLite／PostgreSQL、HPA、
独立 packed 作者与公开 SDK。唯一受控项是 Node 在原 SQL／授权操作完成
且写出真实 JSON HTTP200 后暂缓该 response body；没有替换 DTO、权限、
浏览器 API、SDK 或原请求。Human 真导航到「对话」后，源 Document 退场、
该精确请求实际 `net::ERR_ABORTED`、ServerResponse `close` 且 destroyed。
随后只向同一个已销毁 endpoint 释放一次原 end／原字节；全体旧／新范围
草稿、作者六组原表、Platform 命令和未发送 ledger 保持，零自动 POST。
这是实际取消／body discard 的负控，不声称销毁后的 SDK Promise 终态或
私有 wire ACK 可观测；忽略 abort 的迟到末门仍由独立受控 owner 测试证明。

Root 首轮正式六项 5P1F 保留于
`/tmp/morphz-cognitive-late-compose-ROOT-FINAL-oct06.log`：grant3 的 helper
捕获 Frame 后等 inner 超时，但真实截图已显示完整作者 GUI 和「工作区已
连接」，不能据此声称生产空白或数据库缺失。helper 的早采样与当前
published DOM 不绑定是可达缝隙；修正为同一十二秒总预算内，以当前 DOM
FrameLocator 先等真实 inner／connection，再捕获并核 DOM 节点、src／URL
及 documentProof 一致。原断言保留，不重试 read／click，不扩大 timeout。
相关 selector／只读 parser 诊断失败也保留；裸事件等待增加同预算失败
清理，准确称 response-close，不冒称 TCP socket 见证。

Root 完整冷审两路径并独立正式 6/6、required PostgreSQL、零跳过；日志
`/tmp/morphz-cognitive-late-compose-ROOT-PUBLISHED-oct06.log`。这扩展此前
真实生产双 SQL 的 4/4，并未改生产实现或用户原 App；类型、格式与相邻
回归另有独立记录：全工程类型与三路径格式通过；只读 owner／提示、显式
选择和原呈现四文件 71/71、零跳过，日志
`/tmp/morphz-cognitive-neighbor-ROOT-SECOND-oct06.log`。该相邻 React transport
受控，不能混算真实作者 SQL；第一次选错不存在的测试文件，入口直接拒绝，
原日志保留，不是环境缺失。原窗口安全恢复仍未完成。

## 2026-10-06 独立作者 GUI 的当前原生 Local／Remote 业务矩阵

新增自动验收使用 unchanged 当前二十七个 desktop 文件的逐份 hash 副本、
当前完整生产 Web／CSS 和真实 Service 编译，不改 main、资源 resolver、
Client、API 或 SDK 回包。实际 Electron `morphz://app` 走共享 Document／
沙箱；作者独立 packed 包、自有 SQLite／Service／公开 SDK 与真实 HPA。
这些是隔离自动测试，不创建第二个人工验收 App／Center，不触及用户原资料。

Remote 两项分别连接真实 SQLite／PostgreSQL Application：实际身份登录，
原生认证资源转发、作者原件／历史保存、原回执恢复、CAS2 同 Document、
同窗重载、原草稿准备和精确原件终结导航。Local 两项由真实 production
main `--data-dir` 自己创建 SQLite UUID 中心，配置只有已有 synthetic
成员和固定 loopback 作者接入，公开 Human IPC 设置许可／连接；没有
Application HTTP 服务、listener、Runtime配置或工具 socket。作者 Service
自身的隔离 HTTP 不冒称 Host HTTP。原生偏好 sandbox／no Node／context
isolation 与 opaque author origin／无 parent DOM 均实际观测。

Local 自有保存、恢复、compose／terminal 导航、真 grant2 撤权→旧 GUI
退场→同精确资源 HEAD403／零 body、grant3 显式重开，以及 close3 元数据
提示→在任何 guest 业务调用前自动退场→按已知 closed CAS 显式 reopen4
全部通过。许可循环不创建第二个 own slot、重放命令或改原作者版本／草稿；
未发送任务／Session／投递／事件 ledger 保持。真实两个中心 SQL 的资源
授权门仍在同组回归，不泛称 Local 本轮也用 PostgreSQL。

Root 完整冷审四新路径并独立正式三文件 20/20、required PostgreSQL、
零失败／取消／跳过；日志 `/tmp/morphz-native-cognitive-current-matrix-ROOT-FIRST-oct06.log`。
全工程类型／十路径格式通过。原 Local 授权 hash／reload generation／HEAD
错误体／close 退场 RED 保留并分别定位，未删断言或归因“环境不可用”。
这不是付费模型或用户原 App 验收；原 App 恢复仍需处理在途工具离线边界。

## 2026-10-06 窗口关闭的事件驱动 metadata 退休

真实 native Local 的 close RED：SQL 已 closed／CAS3、原 preload 已收到
changed 且 accessChanged=false，后续 readUi2 已 409，但旧 Document 仍
显示。普通变更不是撤权，不应清整个私有树；也不能只靠下一次作者请求
才退场，更不能把每个 CAS／提示塞进 mountKey。

共享只读 leaf 捕获初始 readUi 的固定 slot／hash／view／binding／authority
和同一 private lease。真实 Client hint 仅触发 strict locate，首轮 metadata
核验覆盖 readUi 到安装 observer 间的关闭；没有轮询、正文／HTML／UI重读、
自动 launch、binding、保存或授权。最多一个在途读取＋一个最新 dirty token，
绝对三十秒期限；旧 token 回复不发布、失败不重试、导航／身份／layout
cleanup 同步取消。关闭、缺失、解绑或固定关系变化先同步退休业务 lease，
再显示当前 owner 的诚实状态；同固定元组的较高 CAS 只保温，不制造 ACK
或改 channel/source。自有真实 save2 仍是同一个 Document。

Root 完整冷审并独立五文件 84/84、required PostgreSQL、零跳过；日志
`/tmp/morphz-cognitive-view-invalidation-ROOT-FINAL-oct06.log`。新有限 UNIT／
React 测试的时序／transport 明确受控，原 owner／consumer／channel 断言
全部保留。独立 native 当前矩阵 20/20、零跳过另见原生验收记录：真实
Local close3 提示使旧 GUI 在任何 guest 业务调用前退场，原命令、作者
版本、草稿及未发送 ledger 均不变。早期关闭 RED 保留，不归因数据库环境。

## 2026-10-06 旧 SSR Client 测试迁移至真实挂载 owner

原五项业务测试通过 SSR 构造取得 Client 后直接操作，未挂载 effects。
生产已收紧 mounted 门，故原正式运行 0P／5F；不是 PostgreSQL 缺失，也
不应为适配旧测试放松私有投影生命周期。原失败记录保留。

两组旧测试迁移为真正 Chromium／createRoot／原 Client，接同一个隔离
SQLite／HTTP／身份／SSE，真实 cookie 和 localStorage；唯一时序 seam
暂缓消费已实际收到的 HTTP response，不发假回包。纯 SSR 构造仍单独
以原生网络观测断言零 API／EventSource，不代替业务 owner。

原头版本／历史字节／版本 union／一次 live GET／零多余 body、真同 realm
引用相等、授权 V3 延迟跨真实 V4 后拒绝、冻结输入及原 commandId／createdAt、
真正卸载再挂载零自动 POST、实际 503 单 POST 和 logout／新 login 后旧
503 不发布到新 Boot 的断言全部保留。没有修改生产 mounted 门。

Root 完整冷审四路径并独立正式七文件 45/45、required PostgreSQL、零跳过，
日志 `/tmp/morphz-client-migration-ROOT-FINAL-oct06.log`；五项新挂载业务自身
为原 SQLite／HTTP，不混报双 SQL、完整生产 App、Electron 或用户原窗口。
全工程类型与四路径格式通过；所有原失败及缺 domain 的诊断记录保留。

## 2026-10-06 原生网页句柄销毁后的启动／焦点崩溃

原用户 App 的只读窗口截图与线程采样见证 native 网页销毁后，focus 的
state→publish→changed→recover 仍调用 destroyed navigation getter，弹出
`Object has been destroyed`，模态弹窗阻塞主线程，主界面 bootstrap 超时。
不是数据库消失：原 Platform v10／Workspace v19 一致性检查正常，独立
Runtime 仍在运行，尚有一项 running 投递。原日志和截图保留。

修复只把确实销毁的 exact guest 句柄退休，保留逻辑页、分区、网址、标题
和原身份；撤销临时协助／待批动作，不恢复权限或自动重放业务。所有旧
guest 回调核 exact view，不能覆盖同页新 guest；快照／主窗口发送只在
实际见证销毁时处理异常，存活句柄的无关错误继续抛出，没有全局压错。
显式 Human close 仍删除逻辑页面。grant 发布中的销毁末门另有独立 RED。

Root 完整冷审并独立正式 40/40、required PostgreSQL、零跳过；日志
`/tmp/morphz-desktop-browser-destroyed-ROOT-FINAL-oct06.log`。
新项目是生产 browser.cjs 的受控 native 句柄／事件测试，非用户原窗口
恢复或全面异步 Promise 故障证明。原 App 未重开、原 Runtime 未停止；
实际重开还需完整备份并处理在途工作与嵌入 Host 暂时离线的边界。

## 2026-10-06 独立作者 GUI 接入生产 Web 原导航／草稿

生产 App 复用原 private incarnation、身份、导航和未发送草稿 owner，
不增加正文缓存、授权存储或另一套工作台。GUI 应用从原 Dock／工作台
进入显式连接选择；无 GUI 应用仍关联本次输入，不伪造窗口。窗口位置
只存固定 slot，不存许可／CAS／正文；Document 不因普通主题、草稿、
上下文刷新或自有 save2 重挂。原布局、图标、CSS 和动效未改。

compose 在实际父 layout 提交后确认准备的原 scoped 草稿，末尾再核固定
来源与私有 lease，不自动发送、不复制第三方正文。openOriginal 提交原
精确目录原件导航与实际 layout 见证，然后同步退休源 GUI；不以假 ACK、
第二个并列窗口或延迟导航维持作者 Promise。原件保留 opaque 精确版本。

Root 独立真实完整生产 Web／原 CSS／独立 packed 作者／公开 SDK／HPA／
SQLite＋PostgreSQL 4/4、required PostgreSQL、零跳过；日志
`/tmp/morphz-notes-production-app-ROOT-SECOND-FINAL-oct06.log`。
初次 3P1F 是测试 CDP 观测已退休 response body 的 No data 错误；仅此精确
观测失败记入 trace 并等另一真实 response，未重发 API、改业务或松断言。
实际 grant2 撤销自动清旧 Document，grant3 后显式重开使用新许可。真实
SQL／命令／原件／草稿／不新增输入和 Runtime ledger 都有独立证据；此前
受控 React 的 109 项 owner／consumer 和 28 项呈现回归不混算作者网络。

这不代表用户原 App 已更新或完整跨宿主目标完成。原 App 的 native 网页
对象销毁异常仍待安全恢复；隔离 native Local 已发现关闭窗口只拒绝后续
调用、旧 GUI 未自动退场的 RED，正在修复只读 metadata 失效机制。原失败
日志保留；不停止原 Runtime、不改用户资料、不自动推送 GitHub。

## 2026-10-06 私有投影清空后的会话提示与退出边界

真实生产 App 发现最终授权／导航读取冲突清空私有 Boot 后，变更订阅随
Boot 退出，后续 grant3 提示无人接收。现由已校验 bootstrap 的 center／
principal／csrf 三字段会话元数据拥有提示生命周期；不保留私有树或权限，
恢复仍走原完整读取和末授权门。同会话普通刷新稳定复用 owner，真正退休
后再校验安装的新生命周期对象会重订阅，即使 token 相同。

私有投影为空时仍能真正退出登录；退休立即封原读取 epoch/controller，
不等退出回包才封门。500／实际原 8 秒超时保持原错误，仅在同 epoch、
仍挂载时请求一次完整授权重读，供下一次显式退出；不重发 logout、不
恢复旧 owner、不越过登录／401／卸载。没有新增轮询或变更传输协议。

Root 完整冷审并独立正式 40/40、required PostgreSQL、零失败／取消／跳过，
日志 `/tmp/morphz-workspace-change-owner-ROOT-FINAL-oct06.log`；新 mounted
矩阵是实际 Chromium／React／原 Client、受控 logical bridge，不冒称 SQL
或 native。真实生产双 SQL App 的恢复已由 Root 后续 4/4 验证。原 clear
算法、历史 raw/hash 和负控保留；有限当前生命周期 raw／AST 期望单独
扩展，未改历史原文。旧 SSR 业务五项的未挂载假设另行迁移真实 owner，
不能放松生产 mounted 门或把原失败归因环境。原 RED 日志均保留。

## 2026-10-06 原生资源 HEAD 错误体边界

真实 native Local 自动验收发现：授权已拒绝的 HEAD 返回 403，但 Electron
custom protocol 仍递送 81 字节安全 JSON；Node HTTP 自动抑制 body，不能
据此推定原生协议相同。共享 embedded carrier 在唯一响应边界统一清除
HEAD body，包括提前拒绝和异常；原 GET 错误说明、状态、安全 header、
HPA／精确资源授权检查均保持，没有增加公开资源方法或 HTTP 依赖。

Root 独立正式双 SQL carrier／view transport 44/44，required PostgreSQL、
零失败／取消／跳过，日志 `/tmp/morphz-native-head-body-ROOT-THIRD-FIX-oct06.log`。
原真实 403 错误体负控及 16 项中的 3 个 RED 保留；第二轮 43P1F 是新 UNIT
写错了既有 assets 路径（漏 /api），改为真实路径后再验，未松生产授权。
新 UNIT 明确受控，双后端真实原件字节／撤权门保留；Local 完整闭环另有
关闭窗口后旧 GUI 未自动退休的 RED，不能以本 carrier 修复算作全部完成。

## 2026-10-06 自有保存与展示刷新共用 CAS 的并发修复

真实生产 App／独立作者／SQLite 与 PostgreSQL 发现同一失败：save1 已提交
CAS2，普通展示刷新并发 readUi1 返回 conflict，旧 Document 被错误退休。
真实请求／响应／DOM detach 时间证据保留，不归因环境。共享 channel 修复
语义相同的展示不重读；真主题投影只保留一个最新值，等待原 save 的最终
真实 gate／ACK 后合并 CAS2。已在途的 init gate 先完成，save 才可 mutation。

隐藏仍同步取消，身份／权限门不放松；取消但未结算的 save 仍占原十六项
预算及原三十秒 deadline。未知保存不猜最新 CAS、不重试写，缓冲投影清除
并退休。未新增方法或并发保存协议，不以 Root memo、关闭 SSE 或重挂救场。

Root 完整冷读两路径并独立正式五文件 119/119、required PostgreSQL、零
失败／取消／跳过，日志 `/tmp/morphz-cognitive-channel-presentation-ROOT-FIRST-oct06.log`；
新十项明确 UNIT，旧十八项断言保留，相邻含真实 native port／公开 SDK／
双 SQL/HPA 认证 Document 资源。原四项 RED 与后续集中／相邻日志保留。
Root 全工程类型与两源文件格式通过；首轮类型失败为在途新测试导入的
不存在 parser，修实际导入后重验，不删除断言或冒称环境缺失。
真实生产 App FOURTH 双后端 happy 均通过，同 Document save2、原设置亮暗
转换、compose 与历史原件终结导航通过；整组为 3P1F，授权恢复订阅断链
另已定位并继续修复，绝不把 happy 通过算作完整闭环或原用户窗口验收。

## 2026-10-06 固定 Document 的 React 展示叶

新增 React 生命周期组件，只借原应用画布／pane／frame 样式，未改 CSS、
图标或动效。初始 consumer 等父真实 layout 发布后创建；固定原 source／
owner 回调，普通回调替换不能借新授权。外部失活与卸载先 layout 同步 abort，
再清旧 Document；迟到 ready 不复活。重试／返回仍是显式 Human 操作，不
持久关闭窗口或开始任务。

Root 冷读三路径，正式七文件 109/109、required PostgreSQL、零失败／
取消／跳过；其中组件新七项含父测试，使用真实 Chromium／StrictMode、
实际双 SQL/HPA 认证字节、公开 SDK／native port。父 owner 为受控 React，
业务 compose／openObject 明确拒绝，不冒称生产 App 或原生 origin。
日志 `/tmp/morphz-cognitive-opening-and-component-ROOT-THIRD-oct06.log`；
全工程类型、五叶源文件格式通过。实际原样式测量画布宽高、自身 save2 后
主题／普通 rerender 保暖及换 owner 重新读取，不以 CSS 断言代替视窗。

初版 fixture 字段／SDK rAF 等待 oracle 的失败保留；改为真实 SDK Document
事件后核原 Frame，不删除行为断言、加长超时或修改 SDK/consumer。生产 App
真实 own save 与 presentation 并发另有 RED，正在共享 channel 层修复。

## 2026-10-06 显式认知窗口打开叶

新增纯边界叶复用实际 Human 的 locate／launch／readUi 三方法；已有同保存方
窗口只读，确切 absent 的 0/0 创建只接受 1/1 回执，closed 使用原窗口／绑定
CAS 显式重开。固定完整 authority、定义版本／hash、许可与连接修订；历史
unbound、另一保存方、矛盾回执或晚到结果均拒绝，不隐式 bind、授权、换连接、
重试或“清理回滚”。回执不是可执行权限，最后仍要求原 readUi gate。

Root 完整冷读两路径，独立正式七文件 109/109、required PostgreSQL、零
失败／取消／跳过；其中新十二项是明确 finite UNIT，不冒称 SQL／HPA 或
生产导航。日志 `/tmp/morphz-cognitive-opening-and-component-ROOT-THIRD-oct06.log`；
全工程类型与五叶源文件格式检查通过。Root 第二轮误选不存在的测试和脚本，
入口拒绝的原日志保留；改用实际名称重跑，未归因环境或跳过。

生产 App 显式打开接线另行验证中；真实作者 own save 与展示刷新旧 CAS 的
并发失败已保留，不能将本叶通过算作原 App／native 完成。

## 2026-10-06 独立作者 GUI 的真实三入口业务矩阵

新增三测试路径，沿独立 tgz 作者的真实 SQLite、原 Platform SQLite／
PostgreSQL、IdentityCenter／HPA、Managed 原字节、公开 Web／Local／Remote
adapters、固定 Document／SDK／私有 port 及原 public draft writer。
连接通过作者真实 describe/admission，没有伪造 connection proof、业务
回执、contentId 或正文。创建／修订与历史 V1 重开、实际 COMMIT 后丢响应
原 ID 恢复、最新未发送草稿及附件／设置／共享引用保持均通过。许可恢复
后真操作旧 Document仍拒；真 close 后拒 protected读取，用真实 receipt
CAS和当前grant再explicit launch，未自动 bind／换authority／重试0/0。

Root 冷读三路径并独立联合九文件 120/120、required PostgreSQL、零失败／
取消／跳过；其中该矩阵三十二项，作者旧包十九项，原读／导航／新 view
owner 六十九项。日志 `/tmp/morphz-cognitive-view-AND-GUI-ROOT-SECOND-oct06.log`；
作者 freeze 联合 51/51 日志另保留。全工程类型、十四源文件格式通过。
真实无发送证据读取 Host delivery/session/event/publication/thread账本，
不是不存在的 Platform inputs 表；近期设置不动，作者定义／ACL／authority不变。

初版状态／恢复等待旧已显示文案的 oracle 已独立审查补强为本次真实
调用、同原命令回执／requestHash／authority以及实际 SDK busy完成。
初版 fixture inputs 表／过期 grant revision 的 RED 保留，修测试不松生产。
拒绝迟到 compose 的标题只说实际无发布，不冒称量测物理成功 ACK 零。

private owner和Local／Remote browser resource递送壳受控；后两者实际
embedded adapter／认证 bytes，但不是 native origin。openObject仍明确
拒绝，不用并列保暖制造假导航 ACK。不称原用户 App／Electron完成，
不改原业务资料、Session、Runtime或已冻结作者代码，无外部推送／发布。

## 2026-10-06 原导航位置的只读认知窗口 owner

原 `prefs.cognitiveLocation` 扩为 exact original 或 view slot，不存权限、
正文或 mutable CAS。view 恢复只 locate→exact readUi，absent／closed／
unbound 明确拒输入；没有 launch、grant、connect、bind、默认连接或轮询。
原 original 合法 view 不读取／阻断，旧 falsey-invalid 行为保持。捕获
原身份、读取 epoch 与 layout incarnation；失活／清树／重试拒迟到结果
及旧回调，合法 own save CAS 推进不偷换固定绑定、字节与授权前提。

Root 冷读九路径，独立正式九文件 120/120、required PostgreSQL、零失败／
取消／跳过，日志 `/tmp/morphz-cognitive-view-AND-GUI-ROOT-SECOND-oct06.log`。
其中新二十项为六 finite UNIT＋十四真实 Chromium／React StrictMode 机制，
metadata／current-Human 回调明确受控，不冒称 SQL／HPA／SHA／生产 App。
其余一百项为原读导航与独立作者实际跨适配器组合。全工程类型／十四
源文件格式通过。Root 首轮误选不存在测试名被正式入口拒绝，日志保留，
不是环境缺失；重新使用实际文件，没有跳过或削弱断言。

该阶段未接原 App GUI。新 hook、source props 或 lease 比较不是权限租约，
真实 private owner 接线与后续业务／原生／原用户窗口仍在活动目标内。

## 2026-10-06 精确原件终结导航语义

明确实验 SDK `openObject` 可销毁调用的 Document：只有真实原 layout
已发布获权原件、源仍有效且末尾授权门通过才可返回成功；离开后不保证
响应或后续 JavaScript。保存／确认放弃编辑在调用前完成，无回包不证明
未导航，不自动重试或套用领域写命令 recovery。更新 docs42／43、公开
SDK 与独立作者说明和类型注释，不改八方法 wire／业务代码／旧原字节。

只读独立审查确认没有外部契约要求销毁后 Promise 必达。生产 publisher
仍需实际对象引用／完整 locator／epoch／目的地的 layout 证据，并即时
退休源 GUI；不能用函数返回、prefs 排队、结构相等或并列保暖当验收。
该记录是明确语义，不宣称生产接线或原 App 已完成。Root 全工程类型与
两 SDK 源文件格式通过；联合叶回归 120/120 的业务部分不属于此语义的
原 App 完成证明。

## 2026-10-06 固定认证 Document consumer 接线叶

新增可信 consumer，不挂旧 unsafe prototype，不改 SDK、原 builtin／
legacy sandbox、CSS 或用户资料。固定同实际 App origin 的认证 URL、
唯一 proof、原 outer WindowProxy、一次 native peer；每个调用前后复核
实际 owner／signal，初始 readUi 与 parser-ready 后才发 init，绝对30秒
期限。presentation 更新仅合并当前 channel 的已确认 CAS／state；自身
save2 后主题与隐藏／再显示不复写为1或重挂，隐藏请求仍拒绝。

Root 冷读四路径，独立正式六文件 106/106，required PostgreSQL、零
失败／取消／跳过，日志
`/tmp/morphz-cognitive-document-consumer-ROOT-FINAL-oct06.log`；新二十二
项实际双 SQL／HPA／原 Managed 字节／完整安全 header、Local readUi/
save/撤grant 和实际 Chromium packed SDK/native port；作者业务 DTO
明确 controlled。测试根壳仅递送 Host JS，不拦实际认证文档资源。

实际正控包括两并发消费者不互清 peer、复制 exactproof 的 opaque
作者拒绝后真 outer 可连接、自己带未知字段的 native peer、正常 DOM
保暖、parser-ready 在真实 load 被 capture 屏蔽时仍初始化、原 owner
abort／late continuation／期限／实际二次 navigation 清理。
`FIFTH` 源 CAS 和未 init 残留、`SIXTH` held gate 原生timer1、
`ELEVENTH` 复插新 WindowProxy仍被旧叶 init、`FIFTEENTH` 同步 abort
后旧 true 导致 iframe1/timer1 的 RED 均保留；日志使用
`/tmp/morphz-cognitive-document-consumer-` 前缀与 `-oct06.log` 后缀。
修复在共享 channel保留原30秒语义但退休立即清 init timer／回调，
固定原 mount身份且guard回调后再核，不能在退休之后重新append。

全工程类型与四文件格式检查通过。生产 view owner／原 App 仍待装配；
真实原生 custom origin业务另外验收，不假称互端即时取消／native队列
GC 或原用户窗口可执行 GUI 完成。生产装配与 openObject交接边界已写
入 docs42，仅为实施约束，无完整闭环完成声明。

## 2026-10-06 独立笔记作者可选 GUI 发布包

只改独立 `examples/cognitive-notes` 作者项目：公开 Browser SDK 0.2.0
与固定 esbuild 0.28.2，真实仓库外源码 tgz 安装／构建／二次确定性构建／
含产物 tgz 打包。产物自包含 HTML、精确 SHA 的 1.1.0 定义及安装载体；
原 1.0.0 原字节 SHA `9fb7bbea47fb891a103fb342e4d2d7cb3d75f74221ba8bfaa1bcc79027af7acd`
不变。默认服务仍 headless，显式 `--gui` 支持两版；无 schema 迁移，
原文、dataAuthority、ACL 与原命令回执保持，同版新 hash 事务拒绝。

Root 冷审九路径，独立六文件 96/96 含作者新九项，相邻七文件 75/75
含原作者十项，日志分别为
`/tmp/morphz-cognitive-GUI-LEAVES-ROOT-FINAL-oct06.log` 与
`/tmp/morphz-compose-author-ROOT-ADJACENT-oct06.log`；required PostgreSQL、
零失败／取消／跳过。作者数据是独立实际 SQLite；Browser GUI 的 Host
业务 DTO 明确 controlled，不能把组合内 required PG 当 GUI 的真实
Platform／HPA 业务证明。独立 GUI 类型及全工程类型／生产构建通过。

实际点击核 opaque 历史原件、HTML 字符安全显示、显式列表／读取／
新建／修订／状态／回执／引用／位置、未知命令 ID 不变与不重试、dirty
离开确认、失败读保原草稿、退休 Document 不再发送。新作者 build 的
replacement-string 特殊替换序列破坏脚本、原 sandbox 不允许 form submit、
回执 summary 多字段误入严格 resource 等 RED 原日志保留；分别改为
callback 注入、明确按钮 click、精确两字段提取，不扩 sandbox 或 SDK。
实际明亮 960px 与深色 380px 截图 Root 已查看，原宿主视觉完全未改。

编辑仅 Document 内存，没有跨窗口持久化或任意版本管理。此阶段不
表示真实授权连接／GUI owner／Web-Local-Remote-native／原 App 闭环
完成；这些继续在活动目标内，无 GitHub 推送或外部发布。

## 2026-10-06 认知界面准备原未发送草稿的提交确认

新增纯 latest-draft 变换与准备 leaf，复用原 public functional writer、
共享 quotes bucket 与 scoped 草稿；不新增 store、发送、授权或数字
版本转换。来源与原件严格核同一应用／连接／保存方／项目，原件引用
精确版本不替换；无 object 不猜目录 ID，专用请求与不同原件版本拒绝，
原正文、附件、model/effort 和其他工作面保留。owner 必须提供当次真实
identity/navigation incarnation/generation、持久草稿归属和 view lease。

Root 正式六文件 96/96，日志
`/tmp/morphz-cognitive-GUI-LEAVES-ROOT-FINAL-oct06.log`，required
PostgreSQL、零失败／取消／跳过。新增七纯 unit 与实际 Chromium
StrictMode 十一项＋parent，使用原 public writer、scopedStorage、
flushSync、真实 layout 发布与 NavigationOriginLifetime；Host 元数据与
locator 明确受控，不冒称 SQL 或生产 owner 已挂载。

真实 RED 显示 updater 生成 A 后 StrictMode 仅为纯度重算 B，layout 发布
A，旧 ACK 却取最后 B：`/tmp/morphz-cognitive-compose-ROOT-IDENTITY-RED-oct06.log`。
修复以本次候选 WeakMap 校验实际提交引用，不降低为结构相等。另一次
held fixture 直接改冻结原件导致 TypeError，原日志保留，仅把测试请求
复制为可变载体，和生产引用 bug 分开。测试覆盖 locator await 中最新
草稿／请求变化、退休后重激活、真实 unmount、binding CAS 改变、updater
退休、延迟 updater 封口、缺提交证据以及实际 localStorage 失败仍保留
React 已发布正文与原 notice。缺 quotes 的专用／不同原件拒绝不造空桶。

全工程类型、生产构建及五文件格式通过。接线必须使用原未装饰 writer，
不能让旧原件 pin decorator 二次克隆候选引用；`prepared` 不等于持久
保存或发送。原生产 view owner 与实际授权链仍在目标内，未冒称完成。

## 2026-10-06 本人精确认知窗口只读定位

补充 `cognitive-app-views.locate` Human-only 共享 API，严格要求当前项目、
精确 app/version/definitionHash；原 Human/HPA、项目 reader 和同一只读
事务核本人登记，原唯一槽覆盖 open/closed/历史未绑定状态。只读绑定／
CAS 标量，不读正文、导航 state 或 UI 字节；不启动、不重绑、不新增
权限、schema、迁移或轮询。Web／Local／Remote 复用同一 Application。

Root 冷审七个生产路径与新五十一项，独立六文件组合 96/96、required
PostgreSQL、零失败／取消／跳过，日志
`/tmp/morphz-cognitive-GUI-LEAVES-ROOT-FINAL-oct06.log`。定位专项包含
真实双 SQL／三适配器的缺失、已关闭、历史未绑定、不同连接、两个
版本／项目、本人登记撤回、外人／tenant、归档恢复元数据而无执行
许可、并发开窗冲突与旧 CAS、真实身份换代／撤销、后读取消与 Host
close。locator 前后持久行不变且正文列、作者业务与 UI 字节调用零。
受控错误 DTO 的 Service 防御与真实 SQL 证据分开标注。

原缺方法 Local 400、tracked Host 漏映射 503／类型失败日志保留。
全工程类型和生产构建通过；新增片段格式通过，Store 原全文件格式债
保持。两个旧契约测试仅加入第七 Human 方法的合法请求／固定路由，
旧断言不删不放宽。定位结果不是授权租约，不冒称生产 GUI owner、
原用户窗口或完整生态已完成。

## 2026-10-06 实际打包 Browser SDK 的固定 Document 生命周期

实验 SDK 升为 0.2.0，八方法业务 wire 仍 v1、领域协议不变。Browser
只领取原 Document 的同步 facade，没有 Window 业务回退或第二个 SDK
port。固定前缀的可选本地退休回调在同步守门／实际 MutationObserver
发现 root／doctype 移除时清本地 pending、订阅和 deadline；正在解析
和结算的请求仍被覆盖。原写 commandId 保留，关闭不宣称业务回滚。

Root 独立正式十五文件 300/300，required PostgreSQL、零失败／取消／
跳过，日志 `/tmp/morphz-cognitive-browser-document-SDK-ROOT-FINAL-oct06.log`。
其中新二十四项使用仓库外真实 npm pack／安装、实际共享包装／完整
header、Chromium opaque Document、真实 native port 和原 channel；
Host 授权／业务结果明确受控，不冒称这二十四项有真实 SQL 或生产 GUI。
旧打包与独立作者 Service／Gateway／Human／Agent 回归保持，双 SQL
业务证据和纯协议／隔离机制范围分开，不因组合通过就混报完整生态。

初次本地退休漏清、UUID／timer 分配中退休、清 timer 成功结算重入及
第十七 pending 的真实 RED 均保留：`SDK-THIRD-RED`、
`SDK-ALLOCATION-RACE-RED`、`SDK-SETTLE-RACE-RED`、
`SDK-SETTLE-BUDGET-RED`，同 `/tmp/morphz-cognitive-browser-document-`
前缀和 `-oct06.log` 后缀。修复在分配后／插入前重核生命周期和预算，
结算保持当前项到实际清 timer／clock／guard 后，再移除且再核失活。
真实 native clear 后作者抛错不泄漏、不打断其他 pending；十五个 held
请求的 native credit 已实际返还后 UUID 重入，第十七 wire 仍零发送。
不承诺阻止作者的任意自身 renderer 自毁或无限循环。

固定前缀三项新实际 Chromium 回归及原打包矩阵保留；旧纯 wire 六项
不改，旧真实 browser 迁移只将退休后的重连换成真实新 Document，保留
全部原业务／ID／deadline／攻击断言。当前最大载体实测 1,343,325 字节，
固定开销 9,989，作者百万字节与包装 1.5 MB 上限均不改。

全工程类型、生产构建、十五路径专项格式通过；fresh 生产构建另跑
实际隔离 Electron 原 scheme／adapter 一项通过，日志
`/tmp/morphz-document-sdk-ROOT-NATIVE-oct06.log`，这里只核更新后共享
字节／origin／port，不称实际 SDK native 业务或原用户窗口。SDK 的本地
退休不是互端业务同步取消。已安装 0.1.0 HTML／SHA 不自动改写，作者
显式重包并以新一致应用／UI版本升级；headless 仅更新依赖不改业务版本。
生产 owner／compose、独立可选 GUI 与原 App 跨宿主验收继续在目标内。

## 2026-10-06 本人认知许可与连接的事件失效

真实 SQLite／PostgreSQL 的提交提示已被原 Session observer 消费，但旧
工作区摘要缺少本人认知许可和连接；停用后仍只有 initial frame。原始
RED 为 4/8 失败，补充读取已完成的正控后仍 4/8 失败，日志
`/tmp/morphz-cognitive-workspace-observer-CONSUMED-HINT-RED-oct06.log`。

修复只在原 workspaceChangeVersion 的同一只读事务加入当前 Human 的
登记／不可变版本／安装／许可与本人连接标量元数据，同时纳入 version
和 accessVersion。没有正文读取、轮询、全租户访问计数器、新表或迁移；
目录分页不是数据行数上限，摘要不加 LIMIT 静默漏掉后续许可。

Root 独立正式五文件 39/39，required PostgreSQL、零失败／取消／跳过，
日志 `/tmp/morphz-workspace-observer-ROOT-FINAL-oct06.log`。新增十二项
使用真实 IdentityCenter／HPA、双 SQL、Local 与原 Session drain，证明
本人许可／连接停用及恢复发 accessChanged，已存在的外人许可／连接
状态改变不清本人，自己的窗口状态保存发 changed 但不退休访问；第
101 项真实登记／连接不在首屏仍能失效。observer 不调用作者业务或
读取 UI 字节，观察前后的持久行一致。既有安装／route 的全租户摘要
保持，不能将有限外人负控概括为所有外人活动完全隔离。

全工程类型与生产构建通过，新增测试及新增生产片段格式通过；store
既有全文件格式欠账保持，不重排无关代码。GUI owner／document consumer
仍待接线，事件修复不冒称已经完成可执行界面或原 App 验收。

## 2026-10-05 实际 Electron 的固定文档 origin 机制

隔离自动化使用原生产 main／custom scheme／embedded adapter 和单个
真实 `morphz://app/` owner；测试资料目录由原共享 fixture 隔离，不打开
第二个人工验收应用、不触碰用户数据库／草稿／Session 或后台 Runtime。
业务资源端口与同步 Host 明确受控，不冒称 SQL、生产 SDK 或原用户窗口。

Root 组合独立一项通过，完整 GET／HEAD／iframe GET 的实际载体字节、
CSP、UTF-8 SHA 与共享 source 构造器逐字相等；实际外层 origin 为
`morphz://app`、作者为 `null`。复制 proof 的作者 peer 因 source／origin
不符被拒，只接收实际外层单 peer；作者原文 DOM 可见、无 Node、桌面桥
或父页面 DOM。parser-ready 一次与实际 credit `[1]` 通过，TCP／旧 raw／
legacy 读取及 pageerror 均为零。证据
`/tmp/morphz-document-credit-and-native-ROOT-PAIRED-FINAL-oct05.log`，
另有 agent 原始 formal FINAL、类型与专项格式日志。

初轮选到生产临时偏好读取窗、旧构建字节、转译辅助函数以及假设 author
frame URL 为 about:srcdoc 的失败均保留。实际 Electron opaque OOPIF 的
frame.url 是空字符串，改为真实 DOM frameLocator 后原文断言通过；
不是取消断言或宣称环境缺失。下一阶段继续真实 SDK／业务 GUI consumer。

## 2026-10-05 认证文档载体贯通 Web／Local／Remote／embedded

固定包装投影接入 UiPackageService 原不可变读取管线，完整 Store／SHA
await 都处于 SAME HPA credential 生命周期；摘要之后重核原完整
prepareCognitiveAppUiRead 快照。metadata read 不能代替 Human／项目／
grant／connection／安装字节及窗口双 CAS 的披露许可复核。

HTTP 与 Local 使用同一私有 ApplicationSession document resource；
Remote 直接读取已认证专用 endpoint，不先拿 raw 再客户端包装。
embedded 消费同一有界载体，不新增 HTTP server。旧 raw endpoint、
readUi DTO、公开方法表及 64 槽／30 秒绝对期限保持；HEAD 同样授权，
socket abort、身份 epoch 与 close 按真实 task signal 等待清理。

Root 独立正式四文件 127/127，零失败／取消／跳过，包括 Local 三十四、
HTTP 三十八、Host 十五和旧 raw 四十项；真实 SQLite／PostgreSQL、
HPA、Store、HTTP／Local／Remote 及 embedded 适配验证与明确的 Remote
单元故障注入分别标注。真实摘要已计算后 held result，撤权、关闭、重绑、
connection／membership／logout／HPA 到期均拒绝披露；无作者服务或
Runtime 业务调用，原行与旧资源字节不变。
日志 `/tmp/morphz-document-authorized-adapters-ROOT-FINAL-oct05.log`。
九路径专项格式、全工程类型和生产构建通过；Application／HTTP 原文件
有既有全文件格式欠账，本次新增片段独立比较通过，不格式化无关内容。
初轮入口缺失和后续 fixture／错误码假设失败全部保留，不归因环境缺失。
本阶段不执行 GUI，真实 SDK、实际 owner／compose 与原 App 仍待验收。

## 2026-10-05 固定文档原生端口的有限窗口

独立 Chromium 实测原 v1 facade 绕开 SDK 后能一次排入 1,000 条 wire，
真实 RED 保留在 `/tmp/morphz-document-credit-BURST-RED-oct05.log`。
私有 framing 升至 v2，固定前缀和可信 Host endpoint 各限十六个未消费
wire；单调连续 credit 只确认传输消费，不是业务 ACK、事务回滚或授权。
没有待发队列、自动重试或增加作者预算，满窗即同步拒绝。

Root 独立正式组合中的本阶段五文件 67/67、零失败／取消／跳过，包括
既有原型二十、纯资源八、新 Chromium 六、独立端口三十与真实两端
Chromium 三项；同组合另含独立原生机制一项，范围另行记录，不混称。
日志 `/tmp/morphz-document-credit-and-native-ROOT-PAIRED-FINAL-oct05.log`。
端口三十项中二十六项使用真实 Node MessageChannel，四项显式描述符
单元验证；不把它们当作 Chromium 或生产 SDK。新的浏览器测试验证
1,000 次 burst 只有十六次发送、显式 credit 恢复不重放、重复控制退休、
数组框架与同步 doc.open 回调守门；两个移除守门的受控 mutant 实际
触发错误交付／多余 credit，作为正向攻击 oracle。初轮 mutant 转义
定位错误的失败日志也保留，不修改生产守门或旧测试断言来通过。

两端 witness 使用生产固定构造器及 Host endpoint，实际 HTTP 加载完整
字节与 header；受控 receive-start gate 只推迟原生 start，不制造消息。
双向千次 burst、真实连续 credit 后第二窗与失败请求不自动重发均通过。
类型、九路径专项格式通过，日志 `ROOT-TYPES-CORRECT`、`ROOT-FORMAT-FINAL`
沿上述 `/tmp/morphz-document-credit-and-native-` 前缀及 `-oct05.log` 后缀。

原型受控 peer 只适配新 private framing，旧原型断言未减弱。每方向 native
队列分项为十六 wire＋十六反向 credit，作者至 Host 再有一个 ready；
不是整个队列十六条。单端关闭不保证另一端即时取消所有业务 pending，
也不保证浏览器原生队列回收；后续 SDK／owner 生命周期必须另行验收。
当前 private Host endpoint 尚未挂载，真实 SDK 与原 App 仍未完成。

## 2026-10-05 单源的共享作者文档资源叶层

已验收固定文档构造器移入共享 Application，Web 旧路径仅 reexport，
固定前缀逐字节不变，不形成第二套构造／CSP。Core 的专用只读请求严格
接受窗口和绑定双 CAS＋唯一 `documentProof`，拒绝额外字段、getter、
重复 query、片段或 URL 凭据；proof 只关联传输，不是权限。

构造器在摘要 await 前脱离原作者字节，保留 BOM、SHA 与原 1,000,000
字节上限。包装载体另外验证实际 UTF-8 字节和 1,500,000 上限，未扩大
作者或消息预算。旧字符串 API 的异步拒绝语义不变；迁移初轮错误把它
改成同步抛出，真实 RED 保留，修复后原断言与原型 test／fixture 不变。

Root 独立四文件 61/61、零失败／取消／跳过、专项格式与生产构建通过，
日志 `/tmp/morphz-document-resource-ROOT-FINAL-SECOND-oct05.log`、
`/tmp/morphz-document-resource-ROOT-FORMAT-oct05.log` 和
`/tmp/morphz-directory-document-ROOT-BUILD-oct05.log`。这组包括新纯叶
八项与既有原型／channel／router 53 项，后者范围不升级为真实 SDK。
本阶段尚未接 HTTP、Local／Remote、embedded 或可执行 GUI；完整
许可复核必须覆盖包装 await，不能以窗口 metadata read 代替。

## 2026-10-05 共同应用目录与显式输入选择

工作台、Launcher、Dock 与输入关联消费同一判别投影及连接选择内容。
内置、旧 UI-only 与认知应用保持各自真实身份；认知版本不伪造旧 manifest，
多个连接不选首条。选择只更新原未发送草稿，既不打开 GUI、读取作者正文，
也不授权、发送或启动工作。未开放 GUI 与无 GUI 分别明确呈现。

新选择在 latest-state writer 内再核中心／Human／CSRF、持久窗口 owner、
工作面及实际目录。V1 原件错配拒绝此前会经旧 helper 新增空引用 bucket，
现只在新选择分支提前拒绝并保留完整原存储，不改变旧 composer 行为。
旧固定键、不可用隐藏键和明确空 Dock 保持；恢复的矛盾旧实例不借旧沙箱
执行，不删除原标签、偏好或草稿。当前 SQL 已过滤认知包，此项是防御
测试，不是宣称发现了当前 SQL 可达漏洞。

Root 正式五文件 56/56、required PostgreSQL 入口、零失败／取消／跳过，
专项格式、全工程类型及生产构建通过；日志
`/tmp/morphz-directory-choice-ROOT-FINAL-oct05.log`、
`/tmp/morphz-directory-choice-ROOT-FORMAT-oct05.log` 和
`/tmp/morphz-directory-document-ROOT-BUILD-oct05.log`。其中完整生产 App／
CSS／StrictMode 的 29 项使用受控 logical transport，不冒称 SQL、作者
服务、native IPC 或原用户窗口。同阶段另跑未修改旧 Dock Playwright
27/27，实际 Chromium 下验证拖拽、移除、空偏好、原几何与放大动效；
日志 `/tmp/morphz-directory-legacy-dock-CHROMIUM-oct05.log`。

四场景最终截图均等待入口动画完成并逐张审查：宽屏浅／深色、窄屏和
CSS 200%。新列表 header 与公共 dialog 样式冲突的 RED 已保留，修复
只限新组件；原材料与布局不改。截图为实际生产组件加受控目录，不将
测试图标或 CSS zoom 冒称真实作者品牌／原生缩放验收。原始失败、无效
负向选择器及 fixture 常量自证均先纠正，保留真实 DOM 正控与完整草稿
断言。作者 GUI、安全资源、跨宿主和原 App 的最终验收仍在活动目标内。

## 2026-10-05 作者界面的文档隔离原型

独立原型先执行固定 Host 前缀，私藏原生端口，再加载原作者字节；SDK
只可领取一次同步 facade。原 Document 的 root／doctype 移除永久退休，
同一 turn 复插也不能续用。就绪来自原 parser-ready，不把首次 load 或
WindowProxy 当作原文档身份证明。作者 UTF-8、BOM 和 SHA 独立保持。

Root 独立正式三文件 53/53，required PostgreSQL 入口、零失败／取消／
跳过，类型、三文件专项格式和 diff 检查通过。日志
`/tmp/morphz-cognitive-document-ROOT-FIRST-oct05.log`、
`/tmp/morphz-cognitive-document-ROOT-TYPES-oct05.log` 和
`/tmp/morphz-cognitive-document-ROOT-FORMAT-oct05.log`。
其中新原型 20 项含纯字节校验与实际 Chromium，SDK／Host 是明确受控的同步 stub；
另外两个文件是既有 channel／router 回归。不能把数据库准备入口当成
新原型的 SQL 业务验收，也不是实际 Browser SDK、Electron 或原 App。

JavaScript URL 首先没有执行，原失败日志 FIRST 至 SEVENTH 全部保留。
随后同代码、真实鼠标点击与同 header 的非生产 sandbox 对照实际执行
doc.open 并替换 root；同一执行段的 check／send／subscribe／factory
均明确返回已退休。原 opaque sandbox 的真实点击仍未执行该 URL，
原 Document／root／peer 保持、原回复只到原页；此项是浏览器机制观察，
不是重写隔离通过，也不推断标准禁止一切 opaque origin 的此类 URL。
生产 CSP 未放宽；网络自导航阻断与允许导航的机制对照分别留证。

原型尚未挂载。原生消息背压、真实 SDK 的逐观察者／结果发布守门、共享
认证资源、Electron custom scheme、实际 owner／compose 与原 App 验收
仍需实现。下一阶段的共享资源职责与独立包装预算见第三方接入契约。

## 2026-10-05 普通输入的显式应用目标准备层

既有 scoped 草稿增加严格的完整应用目标，选择／清除复用原 latest-state
owner，不新建目录、存储或发送入口。仅普通新输入可选择；原件、项目与
完整 authority 错配时保留原稿。发送首次 await 前脱离目标，显式目标抑制
旧应用／Browser 注入；补充与未知重试沿原请求，不注入当前新选择。
正文消费保留最新目标，旧 A 回执不覆盖后来 B 的正文或选择。

Root 独立正式八文件 118/118，相邻五文件 101/101，required PostgreSQL
入口、零失败／取消／跳过；全工程类型、十五文件专项格式和 diff 检查通过。
日志 `/tmp/morphz-headless-target-ROOT-ACCEPTED-oct05.log`、
`/tmp/morphz-headless-target-ROOT-ADJACENT-oct05.log`、
`/tmp/morphz-headless-target-ROOT-TYPES-ACCEPTED-oct05.log` 和
`/tmp/morphz-headless-target-ROOT-FORMAT-oct05.log`。纯准备与受控 command
端口不是 SQL 业务验收；相邻 Chromium 挂载实际生产 App／writer／CSS，
但没有新增选择 UI，logical transport 受控，不是 native 或原用户窗口。

两个新增旧行为回归均先真实失败再修复：无目标空稿不解析未使用工作面，
既有空稿清理不引入新的原件一致性检查。日志分别为
`/tmp/morphz-headless-target-LEGACY-NOOP-RED-oct05.log` 和
`/tmp/morphz-headless-target-LEGACY-CLEANUP-RED-oct05.log`。合法超过
512 KiB 的旧引用载体即使带新目标也保持原预算和数组引用，不将独立槽位
预算扩为整个草稿预算；历史固定提交 fixture 字节未变，当前有限 recipe
只增加确切新目标门，并保留丢字段／原始对象／补充越权的负例。
共同 Dock／工作台／输入关联消费、作者 GUI 与跨宿主原 App 仍须完成。

## 2026-10-05 工作台的认知应用管理入口

原工作台现有应用区接入共享管理面板，沿本人目录与原管理 owner 查看精确
版本、预览能力、明确安装／登记、许可和连接 CAS。没有把无界面应用变成
UI-only manifest，也不在打开面板、文件预览或连接恢复时自动授权、开窗、
读取原件、发送输入或启动 Runtime。图像呈现提取为同一 metadata-only
原图组件，内置图标和作者原图保持原画法，不新增装饰或改 Dock 外观。

原连接未知结果保留完整 DTO、ID 和原 CAS；目录出现连接不是 ACK。
重开／真实刷新可只读查找原记录，明确重试仍用原请求。放弃有就地风险
确认，并在旧等待超时后重新只读核验当前身份／窗口／目标，才清本机原
记录；不撤销连接或创建第二条。关闭或自身访问刷新卸载视觉面板不取消
已发事务；真实 ACK 仍清原固定 scope，迟到结果不重开面板或披露旧预览。

Root 独立正式五文件 80/80、相邻四文件 32/32、随后真实完整 App 入口
十六项 16/16，均 required PostgreSQL 入口、零失败／取消／跳过；全工程
类型、生产构建和专项格式检查通过。日志
`/tmp/morphz-manager-ROOT-ACCEPTED-oct05.log`、
`/tmp/morphz-manager-ROOT-ADJACENT-oct05.log`、
`/tmp/morphz-manager-ROOT-REAL-ENTRY-SECOND-oct05.log`、
`/tmp/morphz-manager-ROOT-TYPES-oct05.log`、
`/tmp/morphz-manager-ROOT-BUILD-oct05.log` 和
`/tmp/morphz-manager-ROOT-FORMAT-oct05.log`。这些组合有重叠，不相加称为
独立总数。宽／窄／200% 截图和实际焦点、滚动、viewport 边界已审查。

完整 App 入口检查使用生产 App／ApplicationHost／原 CSS，核真实工作台
按钮、原草稿字节、零副作用和关闭后的焦点返回；管理细节挂载实际组件和
useWorkspace。logical transport 受控，没有在本组执行 SQL／native IPC
或作者网络，不能把 PostgreSQL 准备入口冒称数据库管理或用户原窗口验收。
输入目标／共同 Dock 目录、作者 GUI 和原用户应用跨宿主验收仍在目标内。

首次联合 74/77 的失败日志保留；独立实际 Vite reloadModule 又复现了夹具
没有退休旧 React root 的缺陷，现标准 hot.dispose 真正 unmount 并还原
自身拦截，不过滤 console error、不禁用 HMR，原重试字节仍保留。该失败
证据在 `/tmp/morphz-manager-connection-HMR-LIFECYCLE-RED-oct05.log`；
不能据此断言首次所有失败都由该缺陷造成。Root 新入口检查首轮错误只是
空文案预期不符，改为实际文案，原禁止副作用／草稿／焦点断言均保留，日志
`/tmp/morphz-manager-ROOT-REAL-ENTRY-FIRST-oct05.log`。

## 2026-10-05 认知连接的本机原请求恢复

独立准备层以实际中心、Human、持久窗口身份和精确目标定位重试记录，
只保存完整公开原 DTO 与 SHA-256。查找键不含候选连接 ID 和当前许可
修订，因此许可刷新或重开不会自动生成第二次尝试；完整记录仍校核
原连接 ID、原 CAS、可选参数是否缺省和全部目标字段。同步捕获先于
哈希，异步核验后的最后复读拒绝迟到替换。

只读查找不保存缺失记录、不生成 ID、不联网，也不推断原创建结果。
真实 ACK 可按原固定 scope 清理；明确放弃仅清理仍匹配的本机记录，
不是业务 ACK 或撤销连接，已取消／窗口身份变化的能力不能再清理。
严格读、清理和持久窗口身份复用共享端口，不增加 renderer 数据权威。

Root 独立正式三文件 54/54，并已参加相邻五文件 88/88，required
PostgreSQL 入口，零失败、取消与跳过；全工程类型、生产构建和两文件
专项格式检查通过。日志 `/tmp/morphz-connection-retry-ROOT-ACCEPTED-oct05.log`、
`/tmp/morphz-cognitive-strict-cleanup-ROOT-ADJACENT-SECOND-oct05.log`、
`/tmp/morphz-cognitive-connect-ROOT-TYPES-SECOND-oct05.log`、
`/tmp/morphz-cognitive-connect-ROOT-BUILD-FIRST-oct05.log` 和
`/tmp/morphz-connection-retry-ROOT-FORMAT-oct05.log`。
旧兼容前缀误删反例保留于 `/tmp/morphz-connection-retry-LEGACY-RED-oct05.log`。

新检查运行实际生产浏览器 bundle、独立 VM、真实 WebCrypto 和受控
存储，覆盖重开、并发、损坏／配额、替换、取消、身份隔离和只读缺失；
不是 SQL、native IPC 或用户原 App 验收。管理面板在原等待取消后须
重新只读核验再明确放弃，组合接线仍待挂载验收，本阶段只提交准备层。

## 2026-10-05 认知应用连接创建的持久回执

公开 connect DTO 不变。Host 同步捕获原请求、实际 Human 握手身份和
许可修订，沿既有回执关系保存连接创建事实；连接、回执与一次访问
修订同事务。回执标识属于不能由公开 commandId 输入的内部命名域，
完整请求指纹保留原可选参数是否缺省，不以当前许可或握手路由替换它。

未知结果的原请求重试先查回执，再判断首次创建权限。命中只读取本人
当前连接状态，不重新请求作者、读取凭据、启用连接或更换原路由；
并发晚握手同样在事务内先锁和重读回执。本人重新认证后可查看旧结果，
不同 Human 不能消费握手。新创建仍检查完整实际身份和两项许可前提；
已有无回执连接不被收养，损坏回执或缺失连接不被自动重建。

Root 独立正式十八文件 383/383，required PostgreSQL，零失败、取消
与跳过；全工程类型和十七文件专项格式检查通过。日志
`/tmp/morphz-connect-creation-ROOT-ACCEPTED-oct05.log`、
`/tmp/morphz-cognitive-connect-ROOT-TYPES-SECOND-oct05.log` 和
`/tmp/morphz-connect-creation-ROOT-FORMAT-oct05.log`。Store 只规范新增
片段，不重写原有整文件格式。新二十项实际运行隔离 SQLite／PostgreSQL、
IdentityCenter／HPA 和 Local／HTTP／Remote，另有受控真实 loopback
作者 HTTP；覆盖撤权、同本人 actant 轮换、并发、原始可选参数、证据
同步捕获及回执写入失败的事务回滚。旧 Service／Host／Renderer 回归
也保留实际独立打包作者的 HTTP 首次创建路径。

首轮十六项 RED 保留于 `/tmp/morphz-connect-creation-FIRST-oct05.log`，
原因是旧 setup 没有必需的完整原请求和实际握手快照。有限迁移只先
获取真实 Human 快照，负例随后仍调用实际创建边界；没有删业务断言
或伪造授权。本阶段不等于管理面板、native IPC、生产作者或用户原
App 验收，不改变用户资料、Session、原窗口和在途工作。

## 2026-10-05 本机重试记录的严格清理

复现当前前缀遮住旧兼容前缀时，安装 ACK 可能误删另一条重试记录。
共享清理端口现先核验两个前缀的所有现存记录，写前复读原始字节；
损坏、替换和存储失败均明确报错，不删除别人的记录。安装与连接借用
同一端口，原宽容偏好读取、普通清理和草稿写入保持不变。本机存储不
提供跨窗口原子 CAS，第二次删除失败仍可能留下另一份原记录，不能
把局部清理失败说成业务提交失败或自动重发。

Root 正式三文件 42/42，扩大到五文件 88/88，required PostgreSQL
入口，零失败、取消与跳过；七文件专项格式和全工程类型检查通过。日志
`/tmp/morphz-cognitive-strict-cleanup-ROOT-ACCEPTED-oct05.log`、
`/tmp/morphz-cognitive-strict-cleanup-ROOT-ADJACENT-SECOND-oct05.log` 和
`/tmp/morphz-cognitive-strict-cleanup-ROOT-FORMAT-oct05.log`、
`/tmp/morphz-cognitive-connect-ROOT-TYPES-SECOND-oct05.log`。
真实误删反例保留于 `/tmp/morphz-installation-cleanup-ROOT-RED-oct05.log`。
这些新测试运行生产 bundle、WebCrypto 和受控存储，没有实际 SQL 或
native IPC；required PostgreSQL 入口不是数据库写入验收。

扩大首轮的四项失败属于旧当前创建夹具固定了原三方法定义，日志
`/tmp/morphz-cognitive-strict-cleanup-ROOT-ADJACENT-oct05.log`。
现仅为当前有限 recipe 补上已验证的两个严格方法，保留原三条草稿
路径、冻结历史检查和原拒绝反例；新增八个错误 scope、宽容替代及
遗漏方法的拒绝变体。本阶段不提交仍在接线的管理界面，也不证明
第三方 GUI 或用户原 App 已验收。

## 2026-10-05 原件消费守门夹具的当前输入包装器

已提交的当前 App 以认知原件保护包装器借用原八命令草稿 owner，旧夹具
却只接受直接解构 writeInputs，导致五项检查失败。现保留完整历史 oracle、
原直接解构分支和原拒绝反例，只新增有限的当前包装器分支；核验实际运行时
导入、完整固定 options、原 writer 以及同步捕获的真实 Host 绑定，不以
整个 App 快照或名义相同的镜像对象代替来源证明。新增独立正例与九个
拒绝变体，本次只提交夹具和检查，没有回退生产 App 或删断言。

正式夹具及邻接导航检查 32/32，Root 独立扩大至五文件 55/55，required
PostgreSQL 入口，零失败、取消与跳过；全工程类型及专项格式检查通过。
日志 `/tmp/morphz-reference-writer-focused-FINAL-oct05.log`、
`/tmp/morphz-cognitive-manager-ROOT-THIRD-oct05.log` 和
`/tmp/morphz-cognitive-manager-ROOT-SECOND-TYPES-oct05.log`。首轮五失败
保留于 `/tmp/morphz-cognitive-manager-ROOT-ADJACENT-FIRST-oct05.log`，
不是数据库能力跳过。扩大组还验证实际 Chromium owner、草稿写入及管理
面板，但传输受控；这些不是实际 SQL、native IPC 或用户原 App 验收。

## 2026-10-05 认知应用安装的本机重试标识

GUI 安装与精确定义登记的独立准备层已实现：Core 同步解析完整参数，
以中心、Human、窗口和完整请求 SHA-256 固定原 commandId。沿原本机
偏好存储只保存指纹和命令 ID，不复制声明、HTML、权限或凭据，不提交
网络请求。损坏 JSON、存储失败、未持久化的窗口身份与取消均阻止准备；
headless 安装保持原无 commandId 契约。真实 ACK 只清除仍匹配原 ID 的
记录，失败、结果未知和关闭保留它，重新选择文件也不自动安装。

Root 正式三文件 39/39，required PostgreSQL 入口，零失败、取消或跳过；
全工程类型检查和五文件专项格式检查通过。日志
`/tmp/morphz-cognitive-installation-ROOT-ACCEPTED-oct05.log`、
`/tmp/morphz-cognitive-manager-ROOT-TYPES-FIRST-oct05.log` 和
`/tmp/morphz-cognitive-installation-ROOT-FORMAT-oct05.log`。
新重试测试使用实际生产 bundle、独立窗口 VM、真实 WebCrypto 和受控
本机存储；覆盖冷重开、身份／窗口隔离、原始 HTML 指纹、取消、存储损坏、
配额失败及清理时的原 ID 比对。此 leaf 没有实际 SQL 或 native IPC 操作，
required PostgreSQL 入口不被混报为数据库安装验收。

本阶段仅提交安装重试准备层，不证明工作台组合已完成。管理面板的写入
等待与权限刷新卸载衔接、跨面板未知连接恢复仍在验证；Dock／输入目标、
作者 GUI 和用户原 App 跨宿主验收仍待完成。没有改用户窗口、资料、凭据、
Session 或在途工作。

## 2026-10-05 认知应用管理操作的客户端生命周期

生产 `useWorkspace` 已提供本人定义预览、安装／登记、数据访问权限、
连接和连接状态五个 typed 管理端口，借用原认证 Client 与刷新 drain。
不新增目录存储、网络路由、renderer 权限权威、轮询或自动授权；Agent
仍使用原业务 adapter，不增加逐任务批准或限制 Agent 创作。

访问范围变化立即取消旧描述读取；中心、Human、认证代次变化、登录、
退出和 React 卸载退休旧操作。本人写入触发的访问刷新不会丢弃真实
ACK；目录刷新失败返回已确认结果及 `refreshed:false`，不重发写入。
显式取消或身份退休不披露迟到结果，也不声称已提交事务被回滚。固定
单次三十秒预算与四个 pending 租约仅约束本地等待，不改变 Host 权限。

Root 正式四十文件 387/387，required PostgreSQL，零失败、取消或跳过；
全工程类型、生产构建及七文件专项格式检查通过。日志
`/tmp/morphz-cognitive-management-ROOT-ACCEPTED-oct05.log` 和
`/tmp/morphz-cognitive-management-ROOT-ACCEPTED-TYPES-oct05.log`，构建日志
`/tmp/morphz-cognitive-management-ROOT-ACCEPTED-BUILD-oct05.log`。
其中新管理 UNIT 十七项，实际 Chromium StrictMode 挂载二十项（含
父测试），沿生产 owner、五公共方法和受控 logical Desktop transport；
覆盖本人写入中的权限刷新、401／403、身份与卸载退休、ACK 后刷新
失败和迟到隔离，验证既存本地草稿原始字节不变、显式写入不重发及
五点二秒闲置无新请求。原目录十二项挂载仍全部通过。同组旧传输回归
实际运行隔离双 SQL／HPA，但新挂载证据不是 SQL、native IPC、工作台
管理卡片或用户原 App 验收。

首轮相邻 owner 检查的三项失败保留于
`/tmp/morphz-cognitive-management-ROOT-ADJACENT-FIRST-oct05.log`；
修正管理工厂的构造位置后全部通过，没有放宽原邻接约束。阶段只交付
管理操作数据层，工作台消费者、Dock／输入目标和作者 GUI 仍待接通，
未改变用户窗口、资料、凭据、Session 或在途工作。

## 2026-10-05 本人认知应用目录的客户端接入

十方法 typed facade 已接到原 `PlatformClient` 的认证 logical caller；
本人版本和连接目录沿既有导航读取、缓存与刷新 owner 发布，不新增
HTTP 依赖、renderer 数据库、第二份目录或轮询。两个分页流必须完整
结束，不能把短页当 EOF；完整图标及 UTF-8 元数据保留，超过明确加载
预算时整次失败，不偷偷截断。无界面定义不转成 UI-only 包或空窗口。

访问范围、身份或窗口生命周期失效时取消旧读取并清空受保护目录；
并行域失败也取消尚未结束的目录请求。迟到结果不能重新发布，既有
草稿、原件、历史、审批和在途写入不被清理。历史守门夹具现明确区分
固定历史和当前认知捕获模板；旧归档、哈希、完整算法与拒绝反例保持。

Root 正式三十七文件 348/348，required PostgreSQL，零失败、取消或
跳过；全工程类型及专项格式检查通过。日志
`/tmp/morphz-cognitive-catalog-ROOT-ACCEPTED-oct05.log` 和
`/tmp/morphz-cognitive-catalog-ROOT-ACCEPTED-TYPES-oct05.log`。
目录传输测试实际经过隔离 SQLite／PostgreSQL、IdentityCenter／HPA
和 Local／HTTP／Remote。十二项 owner 挂载测试运行真实 Chromium
StrictMode 和生产 React owner，但 logical transport 受控；不是作者
网络或用户原 App 验收。先前联合回归的十五项旧检查失败记录保留，
本次全部通过，不删断言或以环境能力跳过。

该阶段交付目录数据层，不等于工作台管理、Dock／Launcher 和输入框
选择已经可用。这些真实消费者、作者 GUI 与原 App 跨宿主验收仍待
接通；本阶段不修改用户资料、凭据、Session 或原窗口的 UI。

## 2026-10-05 本人认知应用登记与管理后端

已提交 `d1b54ad8`。Platform v12 新增本人精确定义登记关系，不复制作者
正文或界面字节，不改首 installer，也不以自动 grant 代替本人接入。
Human 的登记与预览走既有 `cognitive-apps.install/describe` 严格分支；
管理目录可保留未授权和已停用事实，原业务发现与调用仍核 active grant、
实际项目与本人连接，Agent 没有取得安装或授权管理能力。

登记、持久回执和真实新增的 access revision 同事务；重复命令不通知或
重新授权。v11→v12 只回填真实首次安装者与既有 grant，冻结历史 DDL/hash，
旧数据、UI 字节 owner 与命令事实保持。目录按完整 UTF-8 条目分页，原图
不截断或省略；两个 continuation 共用两流位置，已结束的流不重新开始。
完整接口、预算与生命周期见[第三方接入契约](./42-third-party-cognitive-app-contract.md)。

Root 独立正式三十七文件 621/621，required PostgreSQL／Runtime，零失败、
取消与跳过；全工程类型及专项格式检查通过。日志
`/tmp/morphz-cognitive-registration-ROOT-ACCEPTED-oct05.log` 和
`/tmp/morphz-cognitive-registration-ROOT-ACCEPTED-TYPES-oct05.log`。
六项新公开入口测试实际使用 IdentityCenter／HPA、SQLite／PostgreSQL、
Local／HTTP／Remote，连接 setup 为明确受控夹具。实际 Rust 回归保留
既有 IO10／11／12 输入、补充、精确原件和终态回执链；新认知 Runtime
中心是隔离 SQLite，模型受控、付费请求零，不混报为原 App 或作者网络验收。

首次扩大联合回归为 615 通过、6 失败，日志
`/tmp/morphz-cognitive-registration-ROOT-FROZEN-oct05.log`。六项旧窗口
夹具在认知声明登记后才调用已禁止的 UI-only 开窗入口；现改为真实历史
顺序，保留原 bind／convert、CAS、回执及并发断言，不放宽生产权限。
管理前端、输入框的显式应用选择、作者 GUI 与原 App 跨宿主验收仍待完成；
本阶段没有改用户窗口、资料、凭据、Session 或在途工作。

## 2026-10-05 第三方认知原件与补充执行来源

独立原件引用沿 Human 输入、不可变 Host 投递、canonical IO10、实际
accepted Session Event、Agent read-input 和公开历史贯通。引用保留作者
的 opaque objectId／versionRef，不借用内置数值版本、不替换为目录新头，
也不凭引用自动激活 Harness。新补充从真实活动 continuation 继承原引用，
仍在同一 Thread 执行；完成后同命令恢复原回执，不新增执行或作者命令。
发送仅复核当前元数据授权，不为准入额外读取作者正文。数据模型、语义
迁移与重试边界见 [原件输入来源](./43-cognitive-app-input-provenance.md)。

Root 独立正式十二文件 96/96，required PostgreSQL／Runtime，零失败、
取消与跳过；全工程类型检查通过。日志
`/tmp/morphz-cognitive-input-ROOT-ACCEPTED-oct05.log` 和
`/tmp/morphz-cognitive-input-ROOT-TYPES-oct05.log`。新实际 Rust 用独立
npm-packed 作者 SQLite，先写 V1 再写 V2，实际输入、精确读取、补充与
历史始终引用 V1；只有两次作者写入、两个 accepted inputs、一个 completed
Thread、四次受控模型 HTTP，付费请求为零。旧格式描述选择的实际 Runtime
拒绝 IO10，不静默降级、无 Thread 或模型请求。双 SQL 元数据准入另验
撤权、保存方／目录错配、冷重开、旧载体兼容和输入快照。

Host transport 格式 19→20 仅作防旧读器误投递的语义 fence，旧请求、
指纹与状态逐字节保留。显式历史 smoke 从固定真实 Git revision 归档，
不在默认 CI 依赖完整 Git 历史、不抓网络或默默跳过。此阶段未接用户
真实资料，也不证明前端历史 parser、GUI 原件打开或未发送草稿已经接通。
Root 显式历史验收 1/1、零跳过，日志
`/tmp/morphz-cognitive-input-ROOT-HISTORICAL-oct05.log`，不混入上述 96 项。

## 2026-10-05 Browser 路由隐藏与恢复

接线复审复现了两叶组合缺陷：暂时隐藏时，路由的 active 守门阻止当前
metadata 授权，通道因此永久退休。现将 metadata 生命周期授权与操作
准入分开；隐藏仍核真实窗口／绑定／许可，但任何业务操作必须 active。
受控真实 channel／router 组合验证隐藏无 invoke、显示保留同一 channel
并可 ready；不是 mounted DOM 或原 App 验收。独立正式五文件 55/55、
required PostgreSQL、零失败／取消／跳过及全工程类型检查通过，日志
`/tmp/morphz-cognitive-router-HIDE-ROOT-ACCEPTED-oct05.log` 和
`/tmp/morphz-cognitive-router-HIDE-ROOT-types-oct05.log`。首次失败保留于
`/tmp/morphz-cognitive-router-HIDE-FIRST-RED-oct05.log`，未弱化业务授权。

## 2026-10-05 第三方认知应用认证界面资源

同一 bound view 的原 HTML 已沿 Local、HTTP／Remote 和 Electron 内嵌
资源通道接通。新固定 GET／HEAD 入口复用本人 session、当前许可／连接
及窗口双修订，发送既有完整 CSP／Permissions-Policy；不建 Desktop
HTTP server，不用 srcdoc、不改安装字节。fatal UTF-8、原 BOM、精确
1,000,000 字节上限及 SHA 保持；HEAD 同样过实际授权门但无正文。

Root 复核六路径与冻结指纹，独立正式十五文件 166/166，required
PostgreSQL，零失败／取消／跳过；全工程类型检查通过。日志
`/tmp/morphz-cognitive-view-resource-ROOT-ACCEPTED-oct05.log` 和
`/tmp/morphz-cognitive-view-resource-ROOT-types-oct05.log`。新增四十项
中三十四项实际运行隔离双 SQL、HPA、Store 与各传输端口；六项为
受控 Response／stream UNIT。撤权、退出、关闭、重绑及连接关闭的
held-byte 结果均不披露；迟到 fetch 和永不结束的 cancel 均清理请求槽。
四份旧生产文件只插入，原资源路径与完整安全策略未改。早期缺入口和
夹具失败均保留于 `/tmp/morphz-cognitive-view-resource-c2b.kBnmxC/`。
这不证明 mounted iframe、真实浏览器 CSP、原生硬件或原 App 验收；
生产 DOM、目录与原导航／草稿 owner 接线仍待完成，用户资料未修改。

## 2026-10-05 第三方认知应用 Browser 八方法路由

新增独立路由，固定同一真实窗口的定义、authority、项目和本人连接，
不允许作者消息改绑目标。八方法沿已有 Human 业务与窗口公共服务；
操作前后都核当前 UI read 的双修订、许可和连接，迟到正文不返回。
状态与恢复只查原命令，不再次 invoke；保存使用原 CAS 回执和原 state，
不能以稍后的最新窗口冒充保存结果。打开原件和准备未发送草稿由可信
owner 端口承接，guest 不能制造内容 ID、提交输入或调用 Agent 工具。

Root 独立正式五文件 54/54，required PostgreSQL，零失败／取消／跳过，
日志 `/tmp/morphz-cognitive-router-ROOT-ACCEPTED-oct05.log`；全工程类型
检查通过，日志 `/tmp/morphz-cognitive-router-ROOT-types-CLEAN-oct05.log`。
新增十四项中十二项为受控业务／owner／channel UNIT，两项实际运行
隔离 SQLite／PostgreSQL、原 Human 窗口和真实保存／撤权链；其中导航
与草稿 owner 的回包仍受控，不称真实导航或原 App 验收。独立只读复审
通过，最终返回门的撤权／abort 和 own save 的 channel 更新均有见证。
生产 DOM consumer、资源载体、实际 owner 接线仍待完成，用户 UI 未改。

## 2026-10-05 第三方认知应用：有限 Browser Host channel leaf

新增独立叶模块，仅管理一个 opaque 文档的既定 Browser SDK 八方法通道。
严格核消息 source／origin／channel，同步解析并快照，最多十六个 pending；
初始化和操作共用原三十秒预算，timer 与 monotonic 发布门并行。重绑、
身份失效、第二次 document load 退休通道，取消或超时不证明写回滚、不
自动重发。错误只给有限 code 和原命令 ID，不披露私有原因或采用伪 ID。

初始化等待中上下文改变必须重新授权，不能核 C1 却发 C2；保存导航后
核精确原 CAS 回执，推进自己的上下文并拒绝其他旧修订 pending。隐藏
与外部修订变化也清除旧请求，迟到私有结果不能发给新的文档或作用范围。
共享业务／窗口授权、资源载体和导航仍由实际 adapter 提供，不把 wire
Schema 或同步 current callback 当成真实权限验证。

十八项新测试明确为 controlled Window／authority ports UNIT。正式合并
既有 Browser SDK／包消费回归为三文件 29/29，零失败／取消／跳过，日志
`/tmp/morphz-cognitive-channel-ROOT-COMBINED-ACCEPTED-oct05.log`；同代码
全工程类型检查通过，日志
`/tmp/morphz-cognitive-SOURCES-ROOT-types-ACCEPTED-oct05.log`。
独立只读复审提出的初始化竞态、own save 旧请求和 monotonic 边界已补
测试与修正，旧 SDK 八方法未改。该 leaf 尚无生产 consumer，不称实际
iframe／Host／原 App 已接通；第二次 load 退休也不证明阻止网络自导航。

## 2026-10-05 第三方认知应用：真实后台事项与 infer 来源闭环

隔离实际 Rust 测试经原 Human HTTP 创建事项，实际 Agent `work-task.start`
提交准入，原共享 Host dispatcher 投递 Runtime Schedule。后台 Thread
及真实 `eval`／`infer` 子求值各写一份作者自管 SQLite 原件；infer BODY
明确同一 create 意图，未用目录读取伪装写授权或绕过实际来源守门。

两份作者 Actor 和 Platform admission 均保留 `task-run`、原 session／
schedule／event 与非空 sourceInputId。原输入独立锚定到真实普通 Thread
的 Session-Client Event、client_message_id 和 typed session_io.input_id。
infer 的实际 infer_request 固定父来源，子 physical Job 与 Host 稳定
commandId 精确一致，不能只用父字段或模型 marker 冒充子执行。
三个实际 Thread 均在清理之前 completed；作者只有两个命令／原件，
真实 child physical write 恰一次。模型七次 HTTP 请求都到本地受控
第二跳，付费请求为零；这不是原用户 App 或生产 Provider 验收。

Root 全文复核唯一新增测试和三个既有文件有限 delta，冻结 SHA 匹配，
独立正式四文件 21/21，required PostgreSQL／Runtime 和三个准确 opt-in
显式启用，零失败／取消／跳过；旧实际输入链、Profile 与严格 skip 防线
同时通过。日志 `/tmp/morphz-cognitive-SOURCES-ROOT-ACCEPTED-oct05.log`；
全工程类型检查通过，日志
`/tmp/morphz-cognitive-SOURCES-ROOT-types-ACCEPTED-oct05.log`。

测试夹具仅增加显式 dispatcher 启动和隔离 evalCallableTools 配置，省略
时原行为不变。Production 模型、来源守门和 Runtime 无改动；认知中心
为隔离 SQLite，PostgreSQL 在同组旧实际 Profile 集成运行。早期 infer
夹具的 typed JSON／监督 parent 假设错误保留于
`/tmp/morphz-cognitive-SOURCES-INFER-*.log`，未称生产 bug 或弱化断言。
GUI、未知回执的实际 Runtime 场景和原 App 仍单独验收。

## 2026-10-05 第三方认知应用：独立 Human 窗口公共入口

六个 `cognitive-app-views.*` logical 方法使用独立固定映射，公开到同一
Application／Local／HTTP／Remote 与 typed renderer client。窗口 facade
在同一个 domains Host 取得显式、同一 Platform 的 presentation ports，
沿原 pending／关闭生命周期；业务十方法与作者 Browser 八方法不变。
入参在任何身份／SQL await 前快照，实际 HPA 与回包身份继续复核；
失败、取消、代次切换保留原有效 commandId，不重发或把取消当回滚。

UI read 通过真实原包 Store 和授权门，独立 8 MiB JSON carrier 不挤掉
原 1,000,000 UTF-8 字节 HTML；按 chunk 限界、fatal UTF-8、固定 JSON
类型及读取中代次／abort 检查。不新增 Desktop HTTP 或资源／iframe 路由。

Root 全文复核十四路径及冻结指纹，独立正式十三文件回归 176/176，
required PostgreSQL，零失败／取消／跳过；全工程类型检查通过。日志
`/tmp/morphz-cognitive-view-ROOT-C2A-FROZEN-oct05.log` 和
`/tmp/morphz-cognitive-C2A-ROOT-types-ACCEPTED-oct05.log`。独立源码保护
检查确认三十份既有完整文件与六段成熟代码未变，原业务十方法、SDK、
旧窗口／资源和既有测试未删除或弱化。

新三十六项中，二十八项实际运行隔离双 SQL、IdentityCenter／HPA、
Local／HTTP／Remote 和 Managed UI Store；八项明确为 preload-shaped
及 Response stream UNIT，不冒称原生 Electron 验收。连接 setup proof
是明确夹具，不是作者网络验证。早期真实缺入口 RED、后续流夹具的路径
与预取错误保留在 `/tmp/morphz-cognitive-view-c2a.xg3M8p/`。
认证资源、实际 iframe 和原 App 接线仍待完成，用户视觉与资料未修改。

## 2026-10-05 第三方认知应用：真实 Rust Agent 输入链与启动接线

Desktop 初始／后绑定及 Web RuntimeAgentTools 注入同一既有认知业务
Service，不重建网关或修改当前窗口。新增隔离集成实际运行 canonical
Rust binary、原 HTTP Application／Human 入口、真实 Runtime source
verifier、Host 工具和仓库外 tgz 安装的独立作者 Service／SQLite。
一次真实 input 的七个连续工具步骤覆盖目录、精确定义、写、目录读、
精确原件读、状态及旧回执恢复。只解析当次最新物理工具输出，不回退旧
成功；作者绑定、Platform admission 和 Runtime 原输入 Event 交叉一致。
最后等待实际 Thread `completed`，不是在 held 中关进程当作整轮成功。

最终实际认知链 8 次模型 HTTP 请求、0 次上游付费请求，作者账本 1 个
命令、1 份原件，状态／恢复没有重执行。正式四文件独立回归 21/21，
required PostgreSQL／Runtime、两个准确 opt-in 显式开启，零失败／取消／
跳过；旧 Profile 实际 Rust、启动装配及严格 skip 防线同时通过。日志
`/tmp/morphz-cognitive-actual-RUST-ROOT-ACCEPTED-FINAL-oct05.log`。
同代码全工程类型检查通过，日志
`/tmp/morphz-cognitive-actual-RUST-ROOT-TYPES-ACCEPTED-FROZEN-oct05.log`。
独立只读复审无阻塞，原 Profile 默认夹具／返回接口未改，清理只针对
本测试的临时文件和子进程。Root 自有夹具中曾有 options shadow、工具
输出 envelope、对象 ref 额外字段和 Event／input ID 混用，真实失败日志
全保留在 `/tmp/morphz-cognitive-actual-RUST-*.log`，未弱化生产授权。

模型响应受控，不是付费模型或原 App 验收；新实际 Runtime 认知中心为
SQLite，PostgreSQL 在同组旧 Profile 与此前双后端 adapter 回归实际运行。
真实 task-run、infer、丢回执 Runtime 与 GUI／原窗口仍单独验收，本阶段
不宣称生态目标完成。未接触用户真实账号、原件、草稿或运行中 Runtime。

## 2026-10-05 第三方认知应用：有限 Agent adapter

六个 adapter 复用同一业务 Service：list、describe、invoke、read-object、
status、recover。模型不能提供身份、项目、来源、凭据、安装／本人许可
或新写命令 ID；Host 从实际 ToolJob 派生新写 ID，只读不建命令。原件
保留 opaque 版本；状态／恢复只核旧事实，不重新 invoke。实际来源类型
核验在固定剧本守门之前，冲突拒绝，缺少旧 scope 类型也不能绕过守门。
认知 ingress 在 await 前快照，有界纯 JSON，不执行 getter／toJSON；
不把新 wire 预算套到旧合法文档载体。安全失败保留原命令 ID，包括
实际 Desktop 私有 IPC，错误不披露连接／凭据或已读私有正文。

Root 全文复核六路径与冻结指纹，独立正式八文件 82/82，required
PostgreSQL、Runtime 且显式启用旧 Profile 实际 Runtime 集成，零失败／
取消／跳过。日志 `/tmp/morphz-agent-cognitive-ROOT-FROZEN-oct05.log`。
全工程类型检查通过，日志
`/tmp/morphz-agent-cognitive-ROOT-TYPES-FROZEN-oct05.log`。

新 31 项覆盖 Core UNIT、独立 packed 作者真实 SQLite、Platform 双
SQL、真实 HTTP／私有 IPC、原回执重放、断响应恢复、撤权不披露、实际
固定剧本与后台准入；Thread／Event／Schedule 来源读取仍为明确夹具。
旧 Profile 单独通过实际 Rust 21 次受控模型请求，不调用付费上游。
真实首 RED、入口 getter／长度 RED 及新夹具实参错误均保留。新增说明
曾超过 Rust 的既有 16,000 UTF-8 字节上限，已压缩重复说明到
15,610／15,682；新测试要求不超过 15,800，不放宽 Runtime 校验。
本阶段不把受控来源测试称作新认知实际 Rust 或原 App 验收；真实启动
装配和原件链在下一独立提交，不修改用户资料或视觉。

## 2026-10-05 第三方认知应用：Human 窗口生命周期 facade

新增独立六方法 facade：launch、bind、metadata read、UI read、save、
close。复用既有 Platform 窗口和实际 UiPackageService／Managed Store，
不新增业务目录、表、调度器或作者协议。输入在身份／SQL await 前同步
限界并快照；mutation 保留原命令回执和窗口／绑定双 CAS，不假充最新
窗口。metadata 可读不代表 frame 有权执行，读取 HTML 仍验证当前本人
许可／连接、完整原包字节及读取前后的身份／项目权限。

Root 全文复核五条新增路径并比对冻结指纹，独立正式七文件 86/86，
required PostgreSQL 实际执行，零失败／取消／跳过；全工程类型检查
通过。日志 `/tmp/morphz-cognitive-view-ROOT-COMBINED-FINAL-oct05.log`
和 `/tmp/morphz-cognitive-view-ROOT-TYPES-FINAL-oct05.log`。此前真实
缺模块及调用形状／夹具 schema 错误保留在
`/tmp/morphz-cognitive-view-c1.2KO1V2/`，旧测试断言未删除或弱化。

新增十项为明确 Core UNIT，二十项在实际隔离 SQLite／PostgreSQL 和
原界面包 Store 上执行，覆盖重开、并发 CAS、原回执重放、撤权后元数据
与 UI 权限分离、读取中撤权、字节损坏、精确 opaque 引用与 1MB HTML。
身份和连接描述端口为明确夹具，不是作者网络、模型或原 App 验收。
公开 ingress、iframe channel 和导航／草稿／Runtime 引用链仍待接入；
这一提交不称可选 GUI 或生态目标已完成，不改生产视觉及真实资料。

## 2026-10-05 第三方认知应用：Renderer 传输保留原命令事实

实际 renderer adapter 在 native invoke 前同步使用 Core 严格 DTO 做独立
快照，不执行 getter／toJSON；认知调用的拒绝、取消、身份代次变化、IPC
和 Web 网络错误均保留调用方原有效 commandId，不采用回包中的异 ID，
不自动重发。失联时 cancel 本身失败也不泄露私有 IPC 错误、不证明回滚。
只有认知方法走新处理，非认知错误／取消与订阅行为不变，视觉未改。

首 RED 11 项全失败；额外 native cancel 异常一项 RED 保留于
`/tmp/morphz-cognitive-renderer-transport.5ktgtc/`。Root 全文审阅生产
delta 和新增测试，正式七文件独立回归 94/94，required PostgreSQL 实际
执行，零失败／取消／跳过；全工程类型检查通过。日志
`/tmp/morphz-cognitive-renderer-ROOT-FROZEN-oct05.log` 与
`/tmp/morphz-cognitive-renderer-ROOT-TYPES-oct05.log`。

新增 12 项为明确 preload／fetch UNIT 及实际 Local／Application／HPA
加完整 FakeService 的传输组合，不能代替新认知 GUI 或原 App 验收。
组合旧套件还覆盖真实 packed 作者／双 SQL 公共链和 React 浏览器身份。
订阅段与已接受 HEAD 的 5,937 字节相同；未改真实资料、账号或运行中的
App。下一阶段继续实际 Agent 与可选 GUI，不称生态闭环完成。

## 2026-10-05 Agent 接入前置：后台事项来源不按 inputId 猜测

Runtime authority callback 显式传递已经核验的 `input`／`task-run` 类型，
domains scope 直接采用它。实际后台准入可以保留非空 `sourceInputId`，
该关联不把后台事项变成原聊天或授予固定剧本流程权限。普通聊天的固定
生成守门、后台应用窗口限制、原项目／输入和实时身份核验均保持。

新夹具在实际 SQLite／PostgreSQL 和 Script Studio 准备原件上复现：
旧实现将此事项误归为聊天，普通目录读取被不相干的固定剧本流程拒绝。
首 RED 六项全失败、零跳过，日志
`/tmp/morphz-agent-sourcekind-FIRST-RED-20261005.log`。Thread／Schedule
读取是明确受控 Runtime 证据，不是实际 Rust／模型或原 App 验收。
仅两处旧 scope 全对象断言增加真实 kind，其他旧值和守门断言未弱化。
Root 全文复核四条路径，独立正式五文件 47/47，required PostgreSQL
实际执行，零失败／取消／跳过；全工程类型检查通过。日志
`/tmp/morphz-agent-sourcekind-ROOT-FROZEN-oct05.log` 与
`/tmp/morphz-agent-sourcekind-ROOT-TYPES-oct05.log`。认知 Agent adapter
留下一独立阶段，不把来源修复当作该适配或真实 Agent 已验收。

## 2026-10-05 第三方认知应用：Desktop／Web 启动装配

两个启动入口把同一 `domains.cognitiveApps` 交给 Application，不新增
本地 HTTP 或另一份 Service。仅接受可信进程环境中的明确绝对路径
`MORPHZ_APP_COGNITIVE_BINDINGS_FILE`，空／未设不创建配置；私有文件、
凭据和 egress 校验仍归既有 resolver。项目 `.env` 白名单未扩展，不能
通过它注入此路径或应用凭据。原登录、团队身份防降级与资料路径不变。

Root 与独立 reviewer 全文核四条接线／测试路径。Root 正式四文件
16/16、零失败／取消／跳过，日志
`/tmp/morphz-cognitive-launcher-ROOT-FROZEN-oct05.log`；此前真实缺接线
首 RED 0 通过／1 失败保存于
`/tmp/morphz-cognitive-launcher-ROOT-FIRST-RED-oct05.log`。同当前代码
全工程类型检查通过，见公开链的 Root 类型日志。

新夹具是实际隔离 embedded Application／domains／HPA／SQLite：没有
Runtime 或接入配置也能安装 headless 定义、授权、列目录，同中心重开
仍保留目录及定义 SHA。目录比较不是 SQL 行 ID／时间逐字保全证明，
也不是 Web main 实际启动、作者网络、原生 IPC 或原 App 验收。
Agent 工具及 GUI channel 仍在接入，未改用户真实配置或重启原应用。

## 2026-10-05 第三方认知应用：公开 Application／Local／HTTP／Remote 入口

十个 logical `cognitive-apps.*` 方法与固定 POST 路由已登记，同一个
ApplicationSession 先同步捕获严格 DTO，再通过当前 Human session／HPA
调用同一 Service。HTTP 沿原 cookie、Origin、CSRF；只开放固定白名单，
拒绝 Host-only 方法、GET、额外 query、非法 UTF-8 与超限 body。
Local／HTTP／Remote 先 guard 再序列化，不执行参数 getter／toJSON；
取消、网络失败、身份变更与服务拒绝保留原有效 commandId，不自动重发。

真实公共测试复现已签发 Local session 撤销被错误分类为 503（应 403）。
仅该 session 的 live assertActive 将 AuthenticationRequired 转 forbidden，
初始匿名 bootstrap 仍 401；作者已 committed 的事实不因拒绝披露而删除。
首 RED 保留于 `/tmp/morphz-cognitive-public-ingress.0WinFx/FIRST-REQUIRED.log`
及 `/tmp/morphz-cognitive-app-ingress.Y8ggbS/LIVE-SESSION-FIRST-RED.log`。

Root 全文复核公开生产 delta、新测试及原测试保全，独立正式八文件
110/110，required PostgreSQL 实际执行，零失败／取消／跳过；日志
`/tmp/morphz-cognitive-public-pipeline-ROOT-FROZEN-oct05.log`。全工程类型
检查通过，日志 `/tmp/morphz-cognitive-public-pipeline-ROOT-TYPES-oct05.log`。
12 项公开传输测试为明确 FakeService 单元；另 8 项实际公共集成覆盖双
后端、真实同一中心 UUID／Identity／HPA／cookie、十 API、独立 packed
作者 SQLite、原件回读、断响应后双侧冷恢复及撤销，未改旧安全断言。

这不是 renderer／原生窗口、真实 Runtime Agent 或生产 TLS 验收。
实际 renderer 桥的错误 ID／取消／代次传播留独立阶段；启动器配置、
GUI channel 与 Agent 接线尚未整体完成。没有改 UI 外观或真实业务资料。

## 2026-10-05 第三方认知应用：共享宿主与事件恢复生命周期

同一 domains Host 在实际 Platform／可选 UI Store 就绪后组装一个私有
连接解析器、Gateway、Service 与恢复协调器。无私有接入配置仍可管理
定义／许可和补投已知 committed 目录；不会凭空生成连接文件或凭据。
Runtime 校验取当前已绑定的实际实例，不捕获启动时的候选 Runtime。

恢复只核原命令回执，不重新 invoke。启动、接入成功、真实数据库变更
触发有限恢复；没有页面轮询或周期 SQL 读取。网络每轮最多 8 项、并发
2 项，目录最多 4 页／每页 32 项、轮次 10 秒预算；已开始的原子事务
仍须完成，期限不等于可强制回滚。关闭先拒绝新调用／取消网络，再等
协调器和在途存储处理结束，最后关闭数据库；未知结果保留原 commandId。

Root 全文复核五条生产／测试路径，独立正式五文件 30/30，required
PostgreSQL 实际执行，零失败／取消／跳过；日志
`/tmp/morphz-cognitive-host-ROOT-FROZEN-oct05.log`。Host 9 项包含实际
双后端、独立 packed 作者 SQLite、响应丢失后冷重开及关闭链；Recovery
3 项是明确 FakePort 单元证据，不称实际空闲 SQL trace 验收。Root 当前
全工程类型检查通过，日志 `/tmp/morphz-cognitive-host-ROOT-TYPES-oct05.log`。
原 domains 文件仅 16 行装配新增，未夹带无关整文件格式修改。

公共 ingress 新增的两项真实会话撤销分类 RED 另案修正／复验，不把本
阶段绿灯称为公共入口整体通过。启动器配置、实际 Agent、GUI channel
与原 App 仍待接线／验收；未改真实配置、资料或运行中的 App。

## 2026-10-05 第三方认知应用：共享 DTO、薄 Service 与当前 caller 披露

新增十项固定共享方法与严格公开 DTO，复用同一实际 Store／Gateway／可选
UiPackageService。可信身份另由 ingress 传入，JSON 不接受身份、来源、地址、
凭据、Host proof 或 caller 时间；元数据与确切 Schema 发现分开。read 显式
null 命令，副作用保留原 ID；历史事实不先要求当前 grant。GUI 安装有独立
8 MiB 转义 carrier，原定义／HTML／其他 wire 预算不放宽。

Store 新的 Host-private 披露组合门复用旧 inspect 的同一 policy／事务，
区分旧 admission.actor 与本次实际 caller。写／恢复交付前再核当前来源和
固定事实；Human 可读自己的旧 Agent 命令，但等待期间身份／来源漂移不
披露正文，不抹去作者真实 commit。observed commit 与实际持久状态分开，
并发精确终态可收敛旧 unconfirmed／存储待补标记，不制造正文或交付 ID。

Root 全文核生产链与所有新增测试，独立正式六文件 157/157，另披露门五
文件回归 150/150；均实际 SQLite／PostgreSQL、零失败／取消／跳过，数字
存在重叠不相加。日志 `/tmp/morphz-cognitive-facade-ROOT-FINAL-oct05.log`
与 `/tmp/morphz-cognitive-disclosure-ROOT-FROZEN-oct05.log`。Root 本阶段
严格 scoped 类型与独立 SDK 构建通过；当时全工程类型检查仍有其他 owner
在途 Host／公开路由测试的诊断，不冒称全局通过。

Service 45 项中 15 项明确 FakePort 单元、30 项实际独立 packed 作者进程／
真实作者 SQLite／Platform 双后端结果（含 8 子用例），真实 commit 后断
响应／冷重开、撤权和 Managed Store 百万字节 GUI 均有证人；Runtime
ingress verifier 仍是明确 fixture，不是真实模型／Runtime／原 App 验收。
Service 缺模块首 RED 与 stale-unconfirmed 首 RED 分别见
`/tmp/morphz-cognitive-service.BTRH1y/FIRST-RED-required.log` 与
`/tmp/morphz-cognitive-service.BTRH1y/UNCONFIRMED-FIRST-RED.log`；Store
披露门首 RED 0 通过／6 失败，见
`/tmp/morphz-command-disclosure-stage.Lkj2Vv/FIRST-RED.log`。
公共 Application／Local／HTTP、Host 生命周期、实际 Agent／GUI 和原 App
接线仍在进行；本阶段不改变现有 UI、真实配置、资料或运行中的 App。

## 2026-10-05 第三方认知应用：响应后的读取披露门

内部 Gateway 的 operation read／exact object read 在作者响应完整校验后、
返回前，再经实际 Store 核当前许可、项目成员、连接和真实身份／来源，
并比较原固定保存方与精确请求；等待期间撤权或来源改变不披露旧正文，
不重发读取，也不把拒绝披露说成作者事务回滚。默认不暗中固定 mutable
grant／connection revision；只有 caller 显式 CAS 才拒绝有效授权下的修订
漂移。副作用账本、写回执和恢复流程未改。

Root 与独立 reviewer 全文核新增 delta，Root 正式四文件 138/138、实际
SQLite／PostgreSQL、零失败／跳过／取消；日志
`/tmp/morphz-cognitive-gateway-disclosure-ROOT-FROZEN-oct05.log`。
新增 28 项真实独立 packed 作者 HTTP 响应暂停证人：完整私有正文已实际
读取后改变授权，20 项拒绝、4 项无 CAS 的同精确身份仍有效、4 项显式 CAS
拒绝修订漂移；真实历史版本未 fallback 为当前版本。完整 Gateway 首次
RED 34 通过／26 失败，随后 60/60；身份 ingress 仍是明确隔离 verifier
fixture，不称原 Runtime／App 验收。并行 Service 测试还在开发，未称当时
全工程类型门通过；本阶段路径无类型错误。

## 2026-10-05 第三方认知应用：窗口生命周期与精确界面读取

实际 Store 复用既有 view／binding／UI 安装关系，提供独立 launch、bind、
read、save／close 与精确界面读取门；双 CAS 固定窗口和保存方，切换保存方
原子清空导航，旧请求不改绑新目标。导航只保存有界原件／opaque 版本与
视图标识，不保存正文或草稿。原命令重放返回固定三字段原回执，不制造当前
窗口状态；撤销许可后可关闭自己的窗口，但不能继续读取界面或保存导航。
旧 UI-only 修改不能越过真实绑定锁。无 GUI 的真实 schema discovery 不
以界面或连接为前提，仍核本人许可、项目和 Human／Agent 持久来源。

UiPackageService 的新 purpose-specific 读取临时能力固定真实窗口、
binding、Store 原件和字节修订；实际读取前后再核当前授权，并验证精确
SHA／元数据／fatal UTF-8。获权 B 能读取 A 安装的精确 cognitive GUI，
不放宽旧 installedBy-only read、不复制字节、不暴露安装者、地址或凭据。
私有读取能力成功、失败均回收。

Root 全文审查新增生产链和测试，独立 reviewer 复核字节授权时点；Root
正式十八文件 396/396，实际 SQLite／PostgreSQL、零失败／跳过／取消。
日志 `/tmp/morphz-cognitive-ui-view-stage-ROOT-FROZEN-oct05.log`。
其中 10 项使用真实 Managed Store／持久字节；另外 28 项是实际 Platform
关系与明确 Runtime authority／UI 字节行 fixture，不称真实 Runtime 验收。
缺端口首次 RED 0 通过／4 失败；字节 Service 首次 RED 0 通过／8 失败，
分别见 `/tmp/morphz-platform-ui-view-stage.vlqXNl/FIRST-RED.log` 与
`/tmp/morphz-cognitive-ui-view-service-ROOT-FIRST-RED-oct05.log`。
本阶段文件无类型错误；并行共享 Service 测试仍在开发中，未把当时全工程
typecheck 计为通过。实际 Client channel／渲染、公共入口和原 App 仍未接线。

## 2026-10-05 第三方认知应用：独立 Browser SDK 与有界消息协议

独立 SDK 新增公开 browser 入口及纯消息协议，固定 opaque origin／parent
source／channel、精确 authority／view binding、16 项 pending 与绝对 30 秒
期限；导航保留原样 opaque 版本，不传正文／身份／地址／凭据。退休旧 channel
会拒绝迟到响应并清理监听；重复 ready 的同一完整 schema 不因对象键顺序
不同而退休。公开请求先做纯 JSON guard 与独立快照，不调用 caller getter。

Root 独立正式四文件 53/53、零跳过，Standalone SDK 构建通过；实际离线
tarball consumer 与 Chromium opaque 沙箱使用打包后的公开入口。日志
`/tmp/morphz-cognitive-browser-ROOT-FINAL-oct05.log` 与
`/tmp/morphz-cognitive-browser-ROOT-BUILD-oct05.log`。未发布 npm；Browser
消息测试不替代真实 Host 授权或原窗口验收，宿主接线仍在进行。

## 2026-10-05 第三方认知应用：实际 GUI 字节安装与精确定义

可信 UiPackageService 现安装并读回实际 Managed Store HTML 版本，检查
精确 SHA／长度／MIME／fatal UTF-8，生成不可复制、仅进程内的冻结证明。
registry 在同 q 再核真实 UI 安装者、声明 SHA 与全部 Store 版本引用；
结构相似、序列化、Proxy、跨本人、元数据漂移及同版本改写均拒绝。
旧 UI-only installedBy 读取未放宽。定义失败可留下已验证不可变 UI-only
包，但不创建 grant／连接／窗口；原命令重试复用同一字节。

Root 与独立 reviewer 全文核过生产链及分层证人；Root 正式十一文件
260/260、实际 SQLite／PostgreSQL、零失败／跳过／取消，完整 typecheck
通过，冻结后最终日志 `/tmp/morphz-cognitive-ui-install-ROOT-FROZEN-oct05.log`。
其中 8 项实际 UiPackageService／Managed Store，另 28 项 Platform
安装门禁使用明确字节＋实际 UI 安装行 fixture；不混称物理字节证据。
Root 的嵌套 Schema 修改实际首 RED 为 6 通过／2 失败，日志
`/tmp/morphz-cognitive-ui-nested-schema-ROOT-FIRST-RED-oct05.log`；Store
同类 headless／GUI 首 RED 24 通过／4 失败，日志
`/tmp/morphz-platform-gui-install-stage.ebJRXq/NESTED-SCHEMA-FIRST-RED.log`。
两入口现同步捕获整个 bounded canonical 声明，包括 Schema 子树，
不改公共 SDK 语义、不接受异步期间 caller 的新声明。

这只完成 Host 安装链。其他获权用户的 purpose-specific 字节读取、
view／binding、沙箱消息生命周期与真实 Application／Runtime／原窗口
接线仍未完成；没有改变现有 UI 外观、资料或运行中的 App。

## 2026-10-05 第三方认知应用：真实独立服务网关

新增 Host 内部网关，组合私有 purpose-bound 连接、实际 Store 权限／首次
发送 fence、固定网络协议与原件目录。首次副作用先受理再只发送一次；
未知结果只核旧回执，不重新 invoke。read 无命令账本；精确原件单独门禁。
回执 binding／语义 SHA／终态冲突严格核验；业务输出 Schema 错误仍保留
真实 committed，存储失败的 observedCommitted 与最后持久状态分开表示。
异步准备后的真实 actor／source／保存方漂移在发网络前拒绝。

Root 全文审查生产源码与 30 项分层测试后，独立正式七文件回归 131/131、
零失败／跳过／取消；日志
`/tmp/morphz-cognitive-gateway-ROOT-PACK-FINAL-oct05.log`。
其中网关 16 项为明确 FakePort 单元证据，14 项实际运行离线打包 SDK、
独立作者进程与其 SQLite 原件，并经实际 Platform SQLite／PostgreSQL。
实际 commit 后外部代理断响应、双侧冷重开、旧来源与撤权恢复、终态冲突
均保留真实持久事实。Runtime ingress 身份校验仍为明确隔离 fixture，
不是实际 Runtime 或原 App 验收。
共享 Application 的公开方法／HTTP／Desktop IPC／AgentTools、可选 GUI
及事件恢复生命周期尚未登记，不能把内部网关称为产品闭环已经完成。

## 2026-10-05 第三方认知应用：实际 Store 原件读取与目录通知

Host-only 投影入口现组合真实 ledger／catalog／delivery receipt／outbox，
同 q 完成 projected 标记与一次导航通知；空摘要或同版本交付也通知，
幂等重放不重复通知。实际导航写入后故障会回滚全部目录和交付状态。
精确原件读取另走真实身份／来源／项目／目录／当前许可门禁，不捏造一个
invoke 操作；保留历史 opaque versionRef，由作者服务证明该版本实际存在，
不替换成目录当前版本。同步捕获目标及原件引用，异步调用中的 caller 修改
不能漂移读取目标。撤权后的旧提交可补目录，不因此取得新的读取权限。

Root 全文审查两端口与全部新增测试后，独立正式重跑 12 文件 282/282，
实际 SQLite／PostgreSQL、零失败／跳过／取消；日志
`/tmp/morphz-cognitive-platform-object-ROOT-FINAL-oct05.log`。
本阶段只接通 Store 组合；网络 Gateway、公共宿主入口、GUI 和实际 Runtime
／原用户 App 闭环仍在进行，不将上述测试数冒称整项目标完成。

## 2026-10-05 第三方认知应用：实际 Store 命令组合与退役保护

Store 现组合实际 Human／Agent 的副作用受理、仅一次首次发送 fence、本人
旧事实检查、Host-only 回执恢复／保存／未知状态／有界分页，以及已知未发
命令的显式取消。语义 SHA 来自固定参数、资源、来源和保存方，逐字节等同
公开 SDK；不信 caller hash，不保存参数／正文，不借新许可改绑旧命令。
同 q 保持 project／member → command → registry → 排序资源锁；Runtime
身份 I/O 在 SQL 前。连接停用不需要凭据，未知命令不自动重发。
项目归档／删除的 begin 和 complete 均拦开放命令与 committed／pending
目录；终态拒绝可释放保护，不靠超时伪造取消。

新增 28 项实际 Store 双后端证人。Root 全部代码／测试审查后独立重跑两组
正式回归 254/254、243/243，均真实 SQLite／PostgreSQL、零失败／跳过／
取消；完整 typecheck、strict scoped 类型、新测试格式与 diff 通过。日志
`/tmp/morphz-cognitive-platform-command-ROOT-BROAD-oct05.log` 和
`/tmp/morphz-cognitive-platform-command-ROOT-FINAL-oct05.log`。
参数引用漂移先实际 RED 26 通过／2 失败；现入口同步捕获脱离 caller 的
有界参数／资源／标识快照，真实 SQL await 中修改原对象不改变命令，合法
NUL／surrogate 业务正文保留。首 RED 日志
`/tmp/morphz-platform-command-stage.UfFneP/PARAMETER-SNAPSHOT-FIRST-RED.log`。
网络 Gateway、Store 目录通知接线、独立精确对象读取、GUI 和真实 Runtime
／原 App 验收仍未完成；上述通过数不代表它们已交付。

## 2026-10-05 第三方认知应用：持久提交事实的目录投影

新增同 q 的内部投影器，只读取 ledger 已核 committed／pending 原摘要，
同事务写既有 `content_entries`、真实原件交付 receipt／outbox，最后标记
projected。不保存参数、业务 result 或正文；确定性标识碰撞精确拒绝。
目录同版本保留人工标题／修订，但仍留下本次真实交付来源；不同版本只在
原 resource baseline 精确匹配时更新，不比较 opaque 版本大小或提交时间。
跨项目、kind 变化、deleted、目录漂移和原保存方路由变化均不覆盖。
停用／撤权后只能补原持久提交事实，不能获得新的调用权限。

Root 独立通读源码与全部测试，并正式重跑投影器＋registry＋commands
124/124、SQLite／PostgreSQL 实际执行、零失败／跳过／取消。
实际 SQL final-mark 故障前已有两份目录、receipt、outbox，冷重开确认全部
回滚，原命令仍 committed／pending；不是仅断言函数存在。日志
`/tmp/morphz-cognitive-projection-ROOT-FINAL-oct05.log`，strict scoped 类型、
格式／diff 通过。Store 通知、退休 guard 和网络 Gateway 尚须接线，
本阶段不宣称客户端或原窗口已完成。

## 2026-10-05 第三方认知应用：独立作者原件服务

新增 `examples/cognitive-notes`，单独进程只依赖打包后的公开 SDK，自管
SQLite 原件／不可变版本／账户 ACL／原子命令回执；不导入 Host、Platform、
Runtime 或 UI 内部模块。cold restart 不重新 seed 或恢复已停用许可。
实际 HTTP 断响应后核原回执、同 ID 异内容拒绝、旧版本精确读、跨项目隔离、
损坏库拒绝和业务 JSON 保留均有隔离进程测试；测试没有继承宿主私有环境。

联调审查实际发现 Host 的 `application/json; charset=utf-8` 被示例拒绝：
Root 首 RED 9 通过／1 失败，413 与预期 200 不符，日志
`/tmp/morphz-cognitive-author-header-ROOT-FIRST-RED-oct05.log`。现严格支持
UTF-8 JSON；其他 charset／参数／编码仍拒绝。Root 正式示例＋独立 SDK
打包组合 12/12、零失败／跳过／取消，strict scoped 类型、格式／diff 通过，
日志 `/tmp/morphz-cognitive-author-charset-ROOT-FINAL-oct05.log`。
实际 Node 为 25.8.1，不宣称最低 Node、生产 TLS、宿主已接通、真实 Runtime
或原用户 App 已验收。这里只提交作者示例，不修改业务库或运行中应用。

## 2026-10-05 第三方认知应用：内部组合锁与停用管理

内部 ledger 现公开既有同 q 的 command identity／row 锁给 Store 组合，
维持 project／member → command → registry → 排序目录锁的顺序，不是新增
调用者权限。新增独立 pending-projection 检查，不改变开放命令的既有语义。
Host-only 本人连接管理可读取固定 alias／保存方，即使连接、grant 或实例
已停用；这仅用于管理，实际业务和回执仍通过各自的 active-purpose gate，
不要求用户先找回网络凭据才能停用连接。

Root 正式双后端 registry／commands 87/87、零失败／跳过／取消，strict
scoped 类型、格式及 diff 检查通过。新增管理门禁与协调端口的缺口 RED
分别为 44 通过／2 失败、39 通过／2 失败，均保留；最终日志
`/tmp/morphz-cognitive-coordination-ROOT-FINAL-oct05.log`。
完整 Store 命令组合和退休守门仍在实现，不凭内部检查函数存在称已接通。

## 2026-10-05 第三方认知应用：私有配置也遵守身份载体校验

Root 新增反例实际复现私有 resolver 会接受 protocol／SQL 禁止的 NUL 或
未配对 surrogate issuer／保存方标识，并进入凭据读取。首 RED 18 项中
15 通过／3 失败，日志
`/tmp/morphz-cognitive-bindings-portable-ROOT-FIRST-RED-oct05.log`。
配置和实际 tuple 现复用 SDK portable guard，包括非选中条目的完整配置
校验；坏身份在任何凭据读取前安全拒绝。正常 Unicode、换行、tab 与空格
保持原样，私有诊断仍不含路径、alias、凭据或 cause。

Root 正式重跑 bindings／transport／纯协议／wire 75/75、零失败／跳过／
取消，新增文件格式、strict scoped 类型及 diff 检查通过。最终日志
`/tmp/morphz-cognitive-bindings-portable-ROOT-FINAL-oct05.log`。
本项只修配置契约一致性，不宣称公共 TLS 或共享网关已完成。

## 2026-10-05 第三方认知应用：真实 Platform 身份和逐资源权限

PlatformStore 现用既有 capabilities 解析实际 Human／Agent 与发起 Human，
在 SQL 之前完成身份 I/O；同一 q 内复用原成员、持久输入范围、Agent 成员、
项目写 fence 与真实目录权限。task-run 即使保留非空 sourceInputId 也不降级
为 input；真实 prepared 准入失效时拒绝，不信模型自报 actor 或当前页面。

新增 Human-only 安装／精确版本 grant、Host-only 接入准备／已核连接端口、
本人目录和操作解析；Host proof 是可信内部参数，尚未公开到任何 transport。
操作效果、范围、输入 Schema 来自已安装固定定义；每一个资源核实际
project／app／instance、可用性与写基线。授权锁使用稳定排序副本，实际
resources 原顺序不变。只读历史许可不证明作者真的保存该历史版本。
变化时使用既有 access navigation 通知，no-op 安装不加修订，无新增轮询。

Root 审查完整 Store diff／新权限测试，并独立组合重跑 242/242，SQLite
和 PostgreSQL 实际执行、零失败／跳过／取消；新增权限 22 项，含实际 Store
task-run 准入、回调不在事务内、撤权和旧授权行为回归。完整类型检查及
diff 检查通过，日志 `/tmp/morphz-cognitive-stage-types-ROOT-oct05.log`。
首次 producer fixture 清理未释放连接导致 RED 被中断的日志保留，不称完整
RED 套通过。只使用隔离数据库；未启动／改动原 App 或真实业务资料。
这些解析结果只是当前策略快照，后续 admission／dispatch 必须再核，
还未交付网络网关、命令／目录／退休组合、GUI 或真实 Runtime 调用。

## 2026-10-05 第三方认知应用：持久命令事实与发送 fence

Platform 内部 commands 模块现保存副作用调用的实际来源、精确定义、保存方、
本人连接／许可修订、project、operation、资源及 requestHash。相同 commandId
必须所有不可变字段相同；已受理命令在撤权、重开数据库后仍保留原事实，
但 admitted 首次转 dispatching 再核当前精确目标，不等于获得重发许可。
只有确知未发送的 admitted 可取消；dispatching／unknown 不自动再执行。

完整终态回执核原 admission，计算实际 canonical SHA；committed 与独立
目录 pending 状态分开，exact replay 不增加修订，不复制业务 result／正文。
合法 committed 后的业务 output Schema 错误不改写提交事实。目录 ack 必须
与未来 Store 的真实目录写同一 q，本模块测试的组合回滚不是目录已接通证据。
恢复分页限 32，不出版 private alias、参数、地址或凭据。

Root 独立组合回归 242/242，其中命令模块 41 项，双后端真实执行、零跳过。
新增 operationId portable guard 的首次 RED（39 通过／2 失败）与 SQL raw
TEXT 损失、64 KiB 摘要预算诊断均保留，不删除失败断言。完整类型检查、
新增文件格式和 diff 检查通过。主日志同下段注册表。这里仅交付内部账本，
实际权限／目录／退役组合、共享网关与网络恢复仍未完成，不称真实 Runtime
Agent 或用户当前窗口已验收。

## 2026-10-05 第三方认知应用：同一事务注册表

Platform 内部 registry 现维护不可变 headless 定义、本人精确版本许可、
固定保存方、本人连接、CAS 与独立 keyset 分页；复用既有安装身份和数据
实例，不自开数据库连接。定义使用实际 canonical bytes／SHA，旧同版内容
冲突拒绝；本人未同意的安装不进入个人许可目录，安装本身不生成 grant。
这里尚不是完整工作台安装管理入口。

同一 connection 的保存方和 Host alias 都不可变。地址／issuer 改动必须
新建连接；同一保存方复用原 instance，旧连接仍可解析其原 alias 核旧回执，
不会把旧 admission 改送新地址。凭据轮换保留 alias；停用和恢复使用本人
revision CAS。公开 DTO 不选出 alias。原件身份复用 portable guard，不 trim
正常 Unicode、换行和空格。非 null GUI 仍拒绝，不能凭旧窗口冒称已核字节。

Root 独立组合重跑注册表、命令账本、真实 Platform 权限、迁移、旧关系／
Runtime 来源及 SDK 10 文件共 242/242；SQLite／PostgreSQL 均实际执行，
零失败／跳过／取消。注册表自身 44 项。日志
`/tmp/morphz-cognitive-registry-commands-platform-ROOT-CORRECTED-oct05.log`；
首选测试名错误被 runner 拒绝的日志另留，不计为测试通过。
新增模块／测试格式检查通过。本段只交付 q-scoped 注册表；命令组合、
共享 Host 接线、网络认证、实际 Agent 与原 App 仍另阶段验收。

## 2026-10-05 第三方认知应用：实际独立 SDK 包

纯协议现在形成实验 ESM／TypeScript 作者包
`@morphz/cognitive-app-sdk@0.1.0`，主入口及 protocol／domain-wire 子入口。
唯一运行依赖固定 Zod 4.5.4，独立严格构建与 prepack 只读取作者包内三份
源码；tarball 白名单 9 个文件含 JS／d.ts、清单、说明和完整 Apache-2.0
许可证，不包含 Host、源码、测试、source maps、环境或私有实现。
`private: true` 防误发布；已实现本地打包／消费，没有发布 npm 或推送。

Root 正式独立重跑 package／纯协议／wire 44/44、零失败／跳过／取消。
测试在仓库外从作者自有源码真正安装 public 离线依赖、prepack 构建、打包，
再以另一 consumer 安装真实 tgz。安装后的六份 JS／声明逐字节等于被审
构建产物，实际 Node 导入三个入口、严格消费并执行 invoke／read 校验，
额外类型反例确实拒绝 endpoint／伪造来源。测试子进程只继承必要非密钥
环境，使用空 npm config，不读取真实配置或 App；runtime dependency graph
仅 SDK→Zod。补充声明标准库说明后的最终日志为
`/tmp/morphz-cognitive-sdk-package-ROOT-SECOND-FINAL-oct05.log`。

独立构建／声明消费与 strict scoped 类型、格式检查通过；主工程 Store 正在
test-first 接入，不计为本阶段完整项目类型通过。正式 consumer 的标准库
为 ES2023＋DOM、types 空、skipLibCheck false；额外无 DOM 实验缺 Zod
标准 URL 类型并失败，明确保留边界，不冒称所有 tsconfig 均支持。
本阶段不含 browser bridge、共享网关、作者独立 Service 或实际 Agent 验收。

## 2026-10-05 第三方认知应用：可移植身份与业务正文分开

接账模块在真实隔离 SQLite／PostgreSQL 复现 raw TEXT 的身份损失：NUL
在 SQLite 读回截断、PostgreSQL 返回 22021，未配对 UTF-16 surrogate
在两后端被 UTF-8 转换替换为 U+FFFD。JSON 载体的 escaped 原文则都保留。
原始诊断 RED 为 37 项中 35 通过、2 失败，日志
`/tmp/morphz-cognitive-app-commands.sJOJSu/focused-RAW-TEXT-FIRST-RED.log`。

纯 SDK 现提供同一 portable text guard，持久身份、原件版本、回执编号与
目录元数据在进入 raw SQL／UTF-8 载体前拒绝 NUL 或未配对 surrogate。
不 trim、转数值或 Unicode normalize；正常配对 Unicode、换行、tab 和
空格逐字保留。业务 parameters／result、JSON Schema enum／字段名及
第三方正文仍保留原始 JSON 字符串，不把身份限制扩成正文审查。

Root 正式独立重跑纯协议／wire 42/42、零失败／跳过／取消，strict scoped
typecheck 和四文件格式检查通过。所有旧预算与严格断言保留，新增负例
先复现；逐个 UTF-16 单元、有效配对、组合序列、业务 JSON round-trip
均有证人。日志 `/tmp/morphz-cognitive-portable-ROOT-FINAL-oct05.log`。
Host／ledger 还须复用此守卫；本阶段不称实际 Runtime 或作者服务已接通。

## 2026-10-05 第三方认知应用：Host 私有连接解析

本人连接现在可从 Host 操作者指定的私有文件解析，配置仅引用专用
`MORPHZ_APP_COGNITIVE_CREDENTIAL_*` 环境凭据。每次按实际 tenant／本人／
app／service／dataAuthority 精确选取，所有条目先通过校验，再读取选中凭据；
不复用 Runtime token、登录 cookie 或其他人的连接。SQL alias 来自 Host
issuer、实际保存方及 canonical origin 的 hash，凭据轮换不改变 alias；
地址或保存方改变必须另行接入，不能偷偷替换已 admission 的目标。

私有文件限 128 KiB／128 条，POSIX 上必须是当前 UID 的 0600／0400
普通文件。固定 fd、不跟随最终 symlink、不阻塞 FIFO、核读取前后 stat、
fatal UTF-8；Windows 尚未实现等价 ACL 检验，明确拒绝而非绕过权限。
配置无监听或轮询，操作者应以 atomic rename 更换。凭据、URL、环境名
不进入公开 DTO、错误或普通诊断；用途隔离的冻结 handle 只开放 setup
describe、active invoke／object-read 或历史 receipt-read，且已准备请求保留
当时快照。历史地址只用于核回执，不因此取得执行方法。

独立评审另外复现内部结构型假 lease 可取得私有 binding；现以 transport
模块私有 WeakSet 核实际冻结许可，复制、继承或 Proxy 包装均无品牌，先核
同一对象再调用其 post。不是远程作者漏洞或平台权限证明，真实许可仍按
原单次使用／全局并发限制执行；Gateway 必须使用实际 connection key。

Root 独立重跑私有解析与传输 30/30、零失败／跳过／取消，新增文件格式、
strict scoped 与完整类型检查通过。实际网络证据仅隔离 numeric-loopback HTTP 四路径；
还包含两身份拒绝借用、current／retired 路由、权限／字节／条数／坏 UTF-8、
in-place 改动、用途隔离及冷重新解析。日志
`/tmp/morphz-cognitive-bindings-BRAND-ROOT-FINAL-oct05.log`；假 lease 首次
14 通过／1 失败的 RED 另存，不删除反例。本阶段未读取真实
配置或凭据，未操作原 App；resolver 不是授权，Gateway 仍须核 Platform
许可、连接状态／修订和真实来源，完整第三方闭环尚未接通。

## 2026-10-05 第三方认知应用：协议与 ledger 字节边界一致

接账模块复核发现：32 个各自合法的 Unicode 原件引用／摘要仍可能超过
ledger 的总 UTF-8 预算。若先宣称回执完全合法，再为落库截断摘要，会丢掉
目录补偿事实。现在 resources 总 JSON 明确限 32 KiB，committed objects
摘要总 JSON 限 64 KiB，在协议完整性解析时拒绝超限，不截断原件或正文，
也不扩大 SQL 关系。超限的回执不是已核完整 committed；保持未知并修复
服务契约，不能据此补做写入。合法 committed 后的业务 output Schema
错误仍按前阶段保留已提交事实，两种边界不混为一谈。

两项精确 UTF-8 负例先复现，34 项旧测试通过、两新测试失败；补守卫后
分别在 32,768／65,536 bytes 接受，超 1 byte 拒绝并保全输入。已有全部
不可变预算断言只显式增加这两个总预算，没有删除严格比较或 purity 检查。
含 transport 的正式三文件回归 51/51、零失败／跳过／取消，strict scoped
typecheck 与格式检查通过；并行 commands 的 test-first 完整项目类型失败
不计为全局门禁通过。日志 `/tmp/morphz-cognitive-ledger-budget-` 保留
首测试缺 import、真实超限 RED 与预算常量期待尚未同步的中间失败。
本阶段仍是协议／存储契约补强，不是实际应用接通。

## 2026-10-05 第三方认知应用：Host 有界固定传输

Host-private transport 已实现 canonical HTTPS origin 下四个固定根路径，
拒绝 URL userinfo／query／fragment、内网及特殊地址、代理、重定向与压缩；
核所有 DNS 记录并将实际 socket 固定到已检查的 IP／family，同时保留原
hostname／SNI 和 Node 默认 TLS 证书校验。首 v1 的保守公网范围与根路径
是工程边界，不声称支持所有全球可达特殊前缀或任意服务 basepath。
仅 Host 明确配置的 numeric-loopback HTTP 固定端口可作独立本机示例。

全 Host 最多 16／每实际连接 2 个一次性许可，不排队、不重试；网关须先
取许可再 admission，并用 tenant＋真实 connection 身份作 key。完整期限
最多 30 秒，header 8 KiB、wire 512 KiB、fatal UTF-8／有限 JSON；同步
JSON 处理、DNS、发送及响应解释前后均显式核单调 deadline。不能取消的
晚 DNS 保留名额至结束，迟到答案不再连接。错误不包含私有 alias／URL／
凭据／响应正文；请求取消或 HTTP 错误不证明业务回滚。

原 13 加两项同步阻塞负例共 15 个专项，合并纯协议两文件由 Root 正式
重跑 49/49、零失败／跳过／取消；全 typecheck、格式与独立 source 评审
通过。实际 socket 证据是隔离 loopback HTTP 四路径、坏响应／预算／期限、
重复 lease 与 env-proxy 独立子进程；公网 TLS／真实外部账号未实际验收，
不以 DNS helper 或 Node 默认行为冒称已验。Root 原始日志为
`/tmp/morphz-cognitive-transport-ROOT-SECOND-FINAL-oct05.log`，首次缺模块、
错误 IPv6 正例和超时边界检查历史均保留，不改生产策略迁就测试。

传输组件尚未装配进共享 Gateway；没有操作原 App、凭据或业务库。本阶段
不等于第三方应用已接通，后续继续本人 registry、发送 fence 与回执恢复。

## 2026-10-05 第三方认知应用：UI／领域共用首安装身份

真实安装路径首轮在 SQLite 与 PostgreSQL 都复现 UI-first 后注册领域服务
因安装 ID 不同而失败（4 项中 2 项失败）。UI 与外部领域注册现经同一
transaction-scoped helper 取得 tenant/app 的首安装 ID，保留原 ID／时间及
停用状态；不覆盖身份、不自动重新启用。内置应用仍须精确 Host 安装 ID，
既有实例的 app／路由／节点／state 冲突检查，以及原包版本、字节与回执
逻辑不变；领域接入不解锁他人的旧 HTML。

正式五文件回归 91/91，实际隔离 PostgreSQL 与 SQLite、零跳过／失败／
取消；包含两种顺序、并发 UI／领域安装与重放、停用／不可用时两入口
新请求拒绝，原安装者读取、Bob／Agent 拒绝、旧包冷重开、内置／路由冲突。
严格类型与新增文件格式检查通过。首补充反例错误复用同版字节的新命令，
触发既有 immutable Artifact 冲突；改用各自独立版本后通过，未放宽生产
不可变约束，原 RED 保留。日志前缀 `/tmp/morphz-installation-`。

这里只修复既有两条安装路径的身份冲突，不称新 registry、本人 cognitive
grant、领域网关、作者 Service 或实际 Agent 已接通；原 App 与业务资料未改。

## 2026-10-05 第三方认知应用：固定 wire 与语义身份

纯 SDK 模块现有固定 describe／invoke／exact-object-read／receipt-read
请求和响应、实际 Human／input／task-run 来源、精确定义／保存方／项目／
operation／command/hash 绑定。read 与副作用回执分开，committed、rejected、
unknown 字段互斥，not_seen 仅表示未知；已核完整 committed 的事实不因
另行发现业务 output Schema 不合规而变为“没有提交”或允许重新执行。

语义身份使用同一有界 JSON guard 和逐层排序的序列化 bytes，保留数组
顺序、整数键与 `__proto__` 原文；不依赖赋值新对象、locale 或数值转换。
实际 SHA-256 由 Host 计算，不在纯模块伪造认证，亦不称完整 RFC 8785。
wire 为 512 KiB／深度 40／32,768 节点；参数／结果和正文另受各自预算。
网络流式字节限制、认证、到期检查、强制 expected 及业务 Schema 检查仍由
Host 执行，parser 成功不等于授权、真实接收或服务已运行。

原 16 与新增 18 项，正式定向入口及 Root 独立重跑均 34/34、零失败／
跳过／取消；旧协议测试全字节未改。Root 完整项目 typecheck 与五文件格式
检查通过。反例涵盖身份／版本／目的错配、特殊键、有限预算、unsafe JS、
精确版本与恢复来源；独立审查另作六项纯函数诊断，不冒称实际服务验收。
原始 RED／GREEN 保留于 `/tmp/morphz-cognitive-app-domain-wire.12Vaer/`，
Root 日志 `/tmp/morphz-cognitive-wire-ROOT-FINAL-oct05.log`。
本阶段不包含可打包 SDK、Gateway、原应用接入或实际 Agent 调用。

## 2026-10-05 第三方认知应用：双后端 v11 存储迁移

六项关系已加入唯一权威 `storage-model-v1/platform.sql`，生产 schema
由其生成；安装／版本、本人许可、共享数据权威、个人连接、精确窗口绑定
与副作用 admission ledger 复用现有 Platform，不保存作者正文或完整请求。
连接与许可修订号保存为历史快照，撤销不删除已接收命令的来源。
来源约束区分 Human、真实输入与 scheduled task-run（可有或没有输入）；
committed／rejected 必须有相应回执事实，目录投影状态不冒充业务状态。
这些结构约束不代替尚未接通的 Host 授权、服务身份验证或注册业务方法。

冻结旧 v10 真实结构 hash，再在同一事务执行 v9→v10→v11 或 v10→v11；
fresh 初始化为 v11。坏 hash、未来版本、缺表与失败 DDL 拒绝并回滚，
不重建旧表或悄悄改写旧安装 ID。标准定向入口两份原／新增存储测试
84/84 通过，强制 PostgreSQL／Runtime，零失败／跳过／取消；Root 独立
重跑结果相同，`unexpectedSkips=[]`。覆盖 SQLite 与实际隔离 PostgreSQL
的旧安装、内置实例、头像、UI 引用／窗口、目录保全、重开、并发初始化、
复合 FK、typed source、终态证据与撤销后快照，未操作原 App 或业务库。

首轮真实 RED（6 项）和最终源码冻结收据保存于
`/tmp/morphz-cognitive-storage-migration.mtCZCL/`；Root 原始回归日志为
`/tmp/morphz-cognitive-storage-ROOT-FINAL-oct05.log`。本阶段聚焦提交迁移，
不是 registry、受权网关、完整 SDK 或跨宿主闭环交付。其他并行模块的
test-first 中间类型失败另行保留，不解释为 PostgreSQL 不可用。Root 对
本阶段 Store 与两测试及依赖的严格 scoped typecheck 通过；并行 transport
模块未落盘时的完整项目 typecheck 失败不计为全局门禁通过。

## 2026-10-05 第三方认知应用：契约与纯校验第一阶段

[接入契约](./42-third-party-cognitive-app-contract.md) 明确作者 Service 的
原件／事务／备份权威、无 GUI 接入、固定四接口、Human／Agent 共用受权
网关、本人许可与连接、精确版本／窗口绑定、未知结果与回执恢复。六项
Platform 关系复用既有安装、实例及原件目录；第一阶段提交时它们及
v10→v11 迁移仍为实施设计，后续已验证的迁移见上节。已复核旧安装 ID、旧 UI 字节
ownership、scheduled task-run 分类、事务重入与项目退休保护的真实入口。

`packages/cognitive-app-sdk/src/protocol.ts` 只依赖已安装 Zod，提供独立
声明类型、严格有限 JSON Schema、实际值和 opaque 资源引用校验；没有
Host、SQL、Node、browser bridge、网络或凭据依赖，不作安装／授权判断。
拒绝未知关键字、不默认填值／类型转换，并实际检查 UTF-8、有限数字、
循环、getter／toJSON、深度、节点、重复身份与同版 GUI 引用。数值预算是
初始安全边界，不称产品审美或无限数据性能已被验证。

正式定向入口 `npm test -- tests/cognitive-app-protocol.test.ts` 两次冻结
验证均 16/16 通过、零跳过／失败／取消，`unexpectedSkips=[]`；Root 重跑
与类型检查通过。独立审查还补明同次原件 id 唯一及不同版本重复 id 拒绝
断言，最终再验证；协议源码保持冻结。Root 另实际解析
文档 JSON 示例、核输入／结果，并用 27 组文本／对象／数组检查包含中文、
emoji、转义、孤立 surrogate 的序列化 UTF-8 精确边界；没有服务或业务调用。
日志保留于 `/tmp/morphz-cognitive-app-pure-contract.RZd2hW/`，初始缺模块、
旧机械 purity 误匹配和真实超长版本边界的 RED 也未覆盖。

这是契约与纯校验基础，不是已发布／已打包的完整作者 SDK；服务 wire
envelope、受权网关、双后端迁移、optional GUI 与独立 Service／实际 Agent／
跨宿主闭环尚未交付。当前原 App、Runtime、配置和业务资料未因这阶段修改。
下一阶段先实现生产 registry／commands 与共享 gateway，不重建市场或
第二执行器；每个验证完成阶段聚焦本地提交，不自动推送。

## 2026-10-05 同一回复重复展示：修复与最终回归

实际问题是同一 Runtime publication 的公共流前缀与正式终轮分别用
`stream:<attempt>` 和 `publication:<attempt>` 进入历史／实时合并；只按
消息 id 合并会留下两行。已核实际 Runtime 的一次完成、一个 attempt 和
一份正式回复，不将其说成模型调用或执行发生了两次。

历史与主对话现在共用无环境依赖的 publication 对账函数，仅在实际项目、
对话、输入、root 和 publication 身份吻合时，由正式终轮取代其公共前缀。
两边均有 Thread 身份时也必须吻合。相同文字的独立回复、来源不全的消息、
工具与进度保持；不改存活消息的对象、id、首见时间，也不删除数据库记录。

实际 Conversation／StrictMode 挂载回归覆盖终轮、断连、重放、重连、历史
刷新与重新挂载，证明前缀不会复活；独立同文回复仍为两行，最终错误也不
吞掉独立回复。旧历史与游标保持，测试没有业务 POST。聚焦正式回归
54/54 通过，类型检查与 diff 检查通过。

首次完整回归暴露旧历史边界仅允许一个纯函数 import 的真实断言失败，
不是 PostgreSQL 或 Runtime 缺失。边界仅追加这一个精确模块／导出，并
另外约束该函数同步、无 imports／顶层状态／环境与传输依赖；保留原负例，
增加合法局部数据增长正例与依赖／副作用反例，不放宽为任意 core imports。
旧失败日志 `/tmp/morphz-ui-icons-publications-oct05-final-node.log` 保留。

最终按 `npm test` 正式入口强制 PostgreSQL／Runtime，显式启用 nested
activity、Profile、response annotations 与 workspace 集成：2,483 项中
2,479 通过，零失败／取消，`unexpectedSkips=[]`，耗时 296,816.416833ms。
另四项是明确未启用的三个 S3 与一个 native-focus 专项，不计通过。
完整日志 `/tmp/morphz-ui-icons-publications-oct05-final-node-green.log` 保留。

## 2026-10-05 侧栏／图标／回复最终候选：原应用有限验收

新备份包含 12 个各自一致且 integrity／SHA 正常的在线 SQLite snapshot、
7,282 个已核 SHA 的原文件副本；不冒称跨数据库原子快照或活跃 Chromium
profile 停写一致。本轮未重新解码全部隐藏草稿，不将原文件副本说成所有
逻辑存储键前后相等。

仅追加四个冻结 hash assets、原子切换 index，旧 Web 2,710 文件与 Service
438 文件 SHA 保持，旧资产未移除。原 App PID82919 与 Runtime PID68670
及启动时间不变，没有第二 App、Runtime 重启或服务／配置替换。Root 再核
候选全部 209 文件的源／目标 SHA 均吻合。

同一原 App 单次正常 View→Reload；短暂启动卡自行恢复，没有点击重试。
实际 Sources URL 确认 `app-B2UtfaOl.js` 与 `app-DgwvV-98.css` 已载入，
不把磁盘 hash 当作 live response bytes。Launcher 开闭、左右栏显隐通过，
恢复 Human 当前双栏隐藏布局；原可见 ping／pong 各一行、输入空且发送禁用。
没有发送、补充、批准或业务编辑。Root 实际查看 Launcher、双栏及最终正常
原窗截图；不以这一个既有交换证明所有执行完成或新生成的动效均已验证。

本轮使用标准原生 AX 点击，不冒称持续拖动验收。Sources 的 Console 红色
计数 1 保留；本轮未重新读取错误文本，尽管 helper 字节与旧版一致，也不
宣称零 Console 错误。调试面板与 Launcher 已关闭，原窗控制已释放。
私有证据为 `/tmp/morphz-ui-final-original-run.RwYCLp/NATIVE-ACCEPTANCE-RECEIPT.json`。
图标审美仍为候选，待 Human 反馈；这不表示第三方认知应用生态目标已完成。

## 2026-10-05 侧栏表面与应用图标：实现及隔离验证

左右全高侧栏现在消费同一中性外壳底面与分隔线；中央画布、侧栏内控件、
菜单与卡片各自原有底面不变。浏览器、阅读、剧本工作室的工作台、Launcher、
Dock 与标签使用同一份彩色 SVG，只由原容器缩放，移除另画的小尺寸线稿。
原 Dock 的透明按钮、32px 点击区／44px 触控区、拖拽固定、放大与当前态、
原布局和执行消息动效均未改变。作者 PNG 优先与未知应用回退保留。

三色叠放 Launcher 已被用户否决并撤回；现有白色九点阵／蓝紫底面是新的
集合图标候选，不将它或具体色值称为用户认可的审美标准。Root 已查看完整
三栏亮暗页面及应用选择器，检查身份色仅集中于应用图像、侧栏层次与小图
清晰度；这仍不是用户原窗的最终审美认可。最新关于克制 UI 与单色 Dock
的讨论不自动授权再去色或重绘第三方图像。

冻结产物在私有源码副本构建成功，JS `app-B2UtfaOl.js`、CSS
`app-DgwvV-98.css`。图标／三栏／Dock／侧栏材质与主体入口的 40 项真实
浏览器回归全部通过，零失败、跳过、重试与 flaky；Root 独立核报告及
19 份源码／测试／资产 SHA，全部匹配。覆盖四强调色的亮暗、四尺寸相同
原图、作者图像、原草稿／会话、无业务写入、窄窗与无障碍表面。类型检查
与 diff 检查通过。证据保存在
`/tmp/morphz-unified-surfaces-icons-reviewed.0UYWgX/`，不以隔离截图代替原窗验收。

旧主体 Dock 测试仍断言 14px／inset，已先在本轮之前的冻结原产物证明同样
失败，再修正为用户 10 月 4 日已确认的透明 22px 形态；保留原启动、草稿、
会话及业务断言，并增加触控断言。此前失败日志和被否决试案未覆盖。

本轮首次构建误在原 App 引用的工作树 dist 执行，提前改变了磁盘 index；
已向用户说明。旧 208 份带 hash 资产与原 service 校验保持，原 App／Runtime
没有因此重启。随后所有候选构建与浏览器验收均移到私有副本。原 App 后来
自行加载了三应用／侧栏的中间产物；这不等于最终九点阵及重复回复修复已
载入。最终原窗更新、资料保全与有限实机验收另行留证后补记。

## 2026-10-05 本轮前端重构：Human实机反馈与最终完成审计

Human直接回应右栏持续拖动问题：“跟随”。这是实际人工反馈，不是
工具的buttons=0拖动、键盘替代或持续轨迹录像。随后仅两次只读原窗
观察：11:07:05项目页正常、已连接、DevTools关闭，首轮AX未给数字宽度；
11:12:29实际AX右宽340.8555、左宽318，Subject为activity/current-work。
Root已查看当前真实窗口图，保留Human调整后的新宽度，没有恢复旧值。
不把一次数字读数说成两次数字稳定性测量，也不扩大Human原话的承诺。

03:13:09 UTC再核原App82919与Runtime68670的路径和启动时间均未变。
本次没有输入动作、导航、Reload、重启、第二App，没有打开DevTools
或探测storage、修改配置／权限、发送、草稿编辑或新工作。新增0600收据为
`/tmp/morphz-stage60-original-preflight.jbuV1g/native-stage60-human-follow-current-receipt.json`；
旧收据、timeout、锁屏及RED全部保留，原窗控制已释放。

完成判断重新覆盖原目标，不将其缩成最后一个拖动动作：

| 要求                               | 实际完成证据                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 组件化、共享宿主编排               | 实读App／Host的WorkSurface、导航、草稿、发送、Topbar、CreateDialog、builtin adapter与领域controller消费；不是只新增空文件。                                                     |
| state／data／style所有权与重复逻辑 | Client保留唯一身份／撤权／刷新权威，各data family直接消费其owner；共享Thread／Job／Approval与图形有实际复用。Shell／PDF／交流控件保留原级联phase，不加第二store或无行为facade。 |
| 自动约束与等价回归                 | 有限当前owner／消费门禁保留安全反例和实际增长正例；逐阶段原算法、编译与页面证据，以及Topbar12轴／312状态、WindowFrame10轴／57状态严格对照已核。                                 |
| 正式验证及当前产物                 | 正式359文件2,467通过、零失败／取消、4明确专项optout；49ba70d9后只有验收文档变更，应用源码／tests不变。Root重核WindowFrame候选中27份生产源码／已部署Web资产SHA，全部匹配。       |
| 原资料与原App                      | 备份、关键草稿／权限／owner原始组及进程连续性分别留证；同一原App真实载入、菜单／布局／历史／Reader／既有活动验收，加上Human拖动反馈与当前布局旁证。                             |
| 按阶段提交与先前授权推送           | 已验证阶段均聚焦本地提交；目标启动时授权的992d5dec推送由reflog及当前GitHub远端再次核准。未推送后续提交，不把它们称为已发布。                                                    |

独立只读审计未发现本轮还必须增加的实现／验收项。右栏人工验收缺口
已补，本轮既定前端工程目标完成；最后记录按聚焦文档提交收口。
这不等于未来第三方SDK、未采纳视觉探索、全部原生硬件或任意页面／
动效内部插值已验证。三个S3与一个native-focus专项未启用，不计通过；
旧新页面共有的iframe既存RED保留另案，不声称已修复。总storage变化
仍无逐键基线，不将关键组保全说成全部storage未变；本次没有新存储审计。

## 2026-10-05 原 App：最后窗口收尾已完成

00:39:22 UTC 的标准窗口读取只返回 timeout，不把它记成新的锁屏确认、
进程退出或重启理由。只读系统状态随后变化；对同一原App再次正常读取，
08:41:31实际窗口可读且DevTools仍打开。仅一次标准关闭动作之后，
08:41:42实际读取与新截图确认DevTools已关闭，原项目页正常、已连接、
输入收起、左宽318、右栏AX四舍五入365.0742、Subject activity/current-work。
Root已查看这张正常原窗截图，不以旧截图或自动夹具代替。

原App82919与Runtime68670的路径和启动时间仍未变，没有自动解锁、
SDK reset、Reload、重启、第二App、发送、编辑、新建工作或权限修改。
没有重新打开Console做新的storage probe；此前关键原始组与精确偏好
证据保持各自原取证时间，不把关闭DevTools说成又一次完整存储审计。
本次新增私有0600收据为
`/tmp/morphz-stage60-original-preflight.jbuV1g/native-stage60-final-close-receipt.json`，
前轮锁屏、timeout及有限原生矩阵不覆盖。

最后关闭调试面板／最终截图不再是剩余项。当前仅欠右栏真实持续按住
鼠标拖动见证，已释放窗口控制并向Human请求一次实际拖动反馈；标准
工具没有保持按下的move，不以键盘或合成DOM事件冒称通过。整体目标
继续active，不把这次收尾外推为全产品原生／硬件已验收。

## 2026-10-05 前端阶段 61：最终完整 Node 回归

在已提交的 `49ba70d9` 上按正式入口一次运行 `npm test`，强制
`MORPHZ_TEST_REQUIRED_CAPABILITIES=postgres,runtime`，并显式启用
nested activity／Profile／response annotations／workspace 的 Runtime
集成。进程正常退出0；359文件、2,471项中2,467通过，0失败、0取消、
0todo，耗时287,866.870292ms。能力报告 `unexpectedSkips=[]`。

4项未执行均为明确未启用的专项集成：3项S3云对象／备份、1项原生
前后台焦点读回执；不计通过，也不是PostgreSQL或Runtime环境缺失。
完整日志保留在
`/tmp/morphz-navigation-stage61-full-node-first.log`，旧阶段日志与RED
不覆盖。本轮完整回归已完成，不再将其列为剩余项；原App最后关闭
调试面板／最终截图及右栏真实持续拖动见证仍待完成，整体目标保持active。

## 2026-10-05 原 App：阶段 60 实际载入与有限原生验收

在新的私有备份与真实原窗前检之后，仅追加五个冻结 Web assets、原子
切换 index，旧 assets 与 service 保留。Root 独立核12份在线 SQLite
snapshot 的 hash／integrity 与7,284份原始文件复制 hash；活跃 profile
复制不冒称停写一致，也没有跨数据库事务快照。原 App main PID82919、
原 Runtime PID68670及其启动时间保持，没有重启 Runtime或另起手工验收应用。

同一原 App 仅一次正常 View→Reload，实际 Sources／Console 页面引用
确认 `app-BMwOPwmX.js`、`app-CJ1ddL5s.css`，连接正常的原项目页可见。
这是实际载入 URL 与窗口证据，不把磁盘 hash 冒充 live response bytes。
正常窗口最后截图为10月5日08:23:58，Root 已实际查看，不是隔离夹具。

原生坐标验证通过左右栏显隐、右栏键盘调整、现有对象批注菜单开闭、
菜单外画布／输入／导航点击、相邻版本按钮、Launcher、历史显隐与
焦点不重新打开、现有 Reader 前后回跳以及 Subject 既有完成活动详情。
左栏 drag 的最终宽度318→338→318通过，但不称持续按住 move 已证明；
空批注文档只证明开闭／菜单／布局，不称已有批注正文或消息卡路由已验。
没有发送、补充、批准、创建执行、编辑正文或保存配置。

原项目页／左宽318／右宽365.07421875／legacy executionWidth454、
Subject activity/current-work、输入隐藏与未固定已实际恢复。scoped
storage键总数前后均为1,202；1,126原始draft键值、22目录／native权限组、
2窗口owner组及session owner的raw SHA均与前检一致。94份输入草稿记录中
18份语义非空隐藏草稿、2附件、1具名未发送草稿保持，outbox与pending
均为0。总storage SHA已改变；前检没有逐键逻辑基线，不能将其余差异
一概断言只是偏好或声称全部storage不变。原26份LevelDB文件备份仍保留。

右栏真实持续按住拖动未证明：标准Mac工具按下实际命中并成功捕获，
随后却发出buttons=0、capture=false的move；没有可用held-down/move/up
接口。原产物不为工具改写，键盘通过不冒称mouse通过。DevTools唯一
CSP提示来自旧新相同的Zod能力探测，异常已捕获回退；未放宽CSP或清
Console，不把它判成新未捕获异常。末次关闭DevTools的标准动作在
08:26:31明确返回Mac已锁定，因此最后关闭动作／新最终截图仍未完成。
已向Human请求解锁，不改系统设置。右栏真实人工拖动见证也仍待完成。

完整有限收据为
`/tmp/morphz-stage60-original-preflight.jbuV1g/native-stage60-acceptance-receipt.json`，
备份／前检同目录；一次部署收据为
`/tmp/morphz-stage60-original-web-deploy.YDKEEy/APPLY-RECEIPT.json`。
不将本记录称为全产品原生／硬件或整个目标已完成。

## 2026-10-05 前端阶段 61：导航当前合同与历史证明分离

本阶段只改四条测试路径，不改生产、界面、持久键或用户数据。
两个 navigation 当前入口直接检查 raw App／owner／Host，不再依赖
Private→Human→Object→Reference 的历史 inverse 链。原七组完整安全
literal 在固定历史与当前各执行一次；12,999 bytes 的原 ledger SHA
`073b12d55894903b896f11fbfe5332048628372fce6b1e8862c507362dccb9a2`
保持，包括格式化后的原缩进。两个 fixture 的完整历史 prefix、旧 API／
default／inverse 以及 mounted 的 Report 后完整执行尾逐字保留。

当前查找限定实际 module owner／WorkspaceApp 及其真实 import binding：
仍拒绝 owning scope 的重复、嵌套 shadow、移动注册与 orphan，独立且
实际消费的 React feature、default／namespace imports、同名局部方法
和第二个真实 factory alias 可增长。第二 alias 放在原 import 之后的
消费正例覆盖了先前 last-import map 的误拦，历史 lookup 本身不改变。
这只是有限源码合同，不是任意 TypeScript 数据流或安全沙箱证明。

mounted 夹具直接使用生产 CreateDialog 与 private scope factory，九条
原 App bridge 从各自 owning scope 提取，未执行的 private ports 显式
throw。原 StrictMode、身份／CSRF／撤权、晚回执及原七子测试／十场景
的断言、预算和生命周期保持，不借此宣称原 App 或第三方 SDK 验收。

根审与独立冷审发现的两个准备期问题保留：orphan regex 未匹配既有
wrapper 翻译，以及独立第二 import 覆盖原 binding；均修复在测试 current
lane，不修改生产以配合门禁。首轮完整 typecheck 的 TS7022 也保留，
仅为 mounted 容器补既有 `Node` 类型，后续完整 typecheck terminal0。

最终十三个选定文件通过统一 npm test manager 一次运行：**182/182**，
零失败／取消／跳过；required PostgreSQL／Runtime 保持，专用 PostgreSQL
实际启动，unexpectedSkips 为空。四路径格式检查与 diff check 通过。
完整最新 Node 及原 App 最后收口仍须独立记录，不借用阶段 60 的全量
结果宣称本批已全量复验。原窗口已加载阶段 60；本批不需重新安装或 Reload。

冻结四源、完整 patch、两个首轮冷审发现和最终冷审在
`/tmp/morphz-navigation-stage61-preparation.jQAaVn/`。Root 应用后仅类型
注解、保留 ledger 的 formatter 指令及四文件格式化；原历史前缀／
ledger／mounted 执行尾再次逐字核准。实际选定回归日志为
`/tmp/morphz-navigation-stage61-focused-first.log`；整体目标保持 active。

## 2026-10-05 前端阶段 60：窗口布局样式所有权与完整复验

`shell/window-frame-base.css` 和 `window-frame-composition.css` 接管
原 styles／ui 中 **26 条完整规则、83 个声明**；main 保留两个原级联
位置。App／Sidebar／resize shield 的 DOM、状态和实际数据写入不改，
原 CSS 数值、图形、动效及 mac 分支原样保留。混合职责规则仍原位，
原 ui 的空 max560 wrapper 保留；不拆 selector tuple、不加末尾覆盖。

普通 WindowFrame 门禁治理完整 recipe、14 个 retained 职责族、真实
组件／portal／宽度 writer、唯一来源和 runtime phase，并保留删除、重复、
改值／important、顺序、错误 owner 与合法独立 feature 增长反例。Topbar
和 Popup 只在完整校验后交接指定载体，不逆展开 peer 或锁整份 App。
五生产与五门禁路径另经独立审查，当前完整 typecheck／格式检查通过。

冻结 normal build 为 Git `9a10f743` 与仅五生产路径的候选：两边完整
typecheck／Vite／service／prune terminal0。实际完整 compiled CSS 各
2,765 rules；26 个 authored profile 分别独立核原始有序 compiled tuple，
含三个原生产 minifier 自动生成的前缀，共86 declaration leaves。
完整未选有序 raw 树在仅移除所登记 exclusive wrappers 后相等，无通用
归一化或混合规则投影；全部 retained crossings 另保留收据。这不是任意
DOM cascade、原生或审美验收。

原三文件完整交互回归旧／新各 **14/14**，原预算、retry0 和全部断言
保持。最初取证器只认固定端口，漏认五个原夹具的实际临时端口，原
manager／取证 RED 保留；独立冷审计核两 lane 各13个真实 Page 的
完整 index／CSS 响应与冻结构建相等。第14个隔离 Electron case 通过，
但不把其继承浏览器 trace 称为该 Electron Page 或原用户窗口取证。

normal App 完整有限对照旧／新各 **10/10、57 状态**，涵盖四配色／
明暗、实际宽度／窄窗、键盘／真实 pointer capture 和 body portal shield、
模态及 coarse／reduced media。每个实际 Page 的 index／完整 CSS trace
正文、同 Page 的 main JS 正文均匹配本 lane 的构建；全部属性名值、
原始几何、控件／草稿／偏好事实严格相等，无容差、舍入或字段删减。
CSSOM 原始枚举保留，但不比较浏览器不稳定的自定义属性枚举顺序。
有限过渡仅自然结束后采样，不代表160ms内部插值、原生触控或 OS 命中。

首轮候选9/10仍为 RED：首例页面动作和取证已完成，最终 trace 归档
超时，迟生成 ZIP 不补成首次通过；延迟原因未确证。后续完整两 lane
复验未改 spec、预算、附件、时钟或比较器算法。独立比较器首轮 import
错误也保留；仅将 `realpathSync` 从 path 改从 fs 导入的新兄弟执行器
SHA 为 `085ebda84231b77e51449be5b4a4c14ec4e215f8836276be0d655d503623d225`，
实际严格对照 PASS。结果内原冻结比较器指纹不是该修正执行器指纹。

最新统一 Node **359 文件、2,457 项、2,453 通过、零失败／取消，
4 明确未启用**；required PostgreSQL／Runtime、四 Runtime flags 实际
启用，unexpectedSkips 为空。三个 S3 与一个 native-focus 不计为通过，
不是环境丢失。先前 Popup／Profile／头像长超时在本次全量通过，未删
原断言或改预算，不据此假称已确证系统延迟根因。

原 App 已按授权在私有备份后恢复同一路径、profile、center；六业务库
integrity 与121个主键 identity sets 无缺失，独立 Runtime 未停止。
这不证明每个可变字段或在途完成，也未确证此前 generic-storage-error
的具体 RPC 根因。恢复后实际 Sources 为 Brh 构建，本阶段候选原窗
加载及原生命中仍需随后独立验收；整体目标保持 active。

来源在 `/tmp/morphz-window-frame-stage60-preparation.SuiATO/`，候选构建
在 `/tmp/morphz-window-frame-stage60-build.jYMW6e/`，完整 compiled 证明
在 `/tmp/morphz-window-frame-compiled-proof.lGTtIY/`，有限门禁交接在
`/tmp/morphz-window-frame-gate-implementation.uCUsin/`。原14项取证及冷审计
分别在 `/tmp/morphz-window-frame-real-consumers.BKRc70/` 与
`/tmp/morphz-window-frame-original-trace-audit.jrDoA2/`。mounted 首红与
完整复验分别在 `/tmp/morphz-window-frame-mounted-prepared.FlK2el/` 与
`/tmp/morphz-window-frame-mounted-revalidation.hKXCOM/`。统一首红与最终
日志为 `/tmp/morphz-window-frame-stage60-full-node-first.log`、
`/tmp/morphz-window-frame-stage60-full-node-after-css.log`。原窗恢复收据及
备份在 `/tmp/morphz-original-logged-recovery.5UPC1a/`，不将隔离截图冒称原窗。

## 2026-10-05 挂载测试：共用实际 main 样式入口

五份比较当前／固定组件算法的挂载夹具，原来手写旧 CSS 清单，未随
已迁移的 owner 更新。统一全量首轮保留为 RED：2,453 项，2,427 通过、
20 失败、2 取消、4 明确未启用；没有把 PostgreSQL／Runtime 误报为缺失。

新增 test-only `fixtures/current-app-css.ts`：通过 TS AST 读取当前 main
的裸 CSS imports，保持全部声明次序及重复项，不执行 main／App，不排序、
不加末尾覆盖。create-dialog、exchange-reference-preparation、
execution-inspection、job-presentation、object-annotations 五夹具仅
替换 CSS 入口，原两组件／算法 lane 仍同用当前 CSS。明确固定历史 CSS
oracle、其他夹具、原 actions／assertions／时限及生产实现保持。

实际定向五文件 **46/46**，零失败／取消／跳过；格式化后助手四组
**4/4**、typecheck 与七路径格式检查通过。原完整日志及各次源指纹
在 `/tmp/morphz-current-app-css-fixture-fix.gIQTvA/`。此提交只修测试
接线机制，不宣称全量复验、原 App、真实 Runtime 执行或另外的
Popup／Profile／头像超时已修复。

## 2026-10-05 前端阶段 59：共享顶栏样式所有权与有限等价证明

当前生产候选只改七个 CSS／main 路径：原 styles、ui、visual 的完整
Topbar recipe 分别由 `shell/workspace-topbar-base.css`、
`workspace-topbar-composition.css`、`workspace-topbar-packing.css` 承载，
实际 main 各保留原 phase。原 UI 数值、DOM、图形、动效、portal target、
领域组件、数据／授权、Runtime 和状态算法不变。此阶段完成该有限职责交接，
实际最新候选的完整页面回归已结束。旧采样合同的首轮 RED 保留；新合同的
完整 12 轴／312 状态严格对照及独立收据审计均已通过，不据源码、
门禁或隔离页面宣称原 App／原生外观验收完成。

原不可变清单仍为 65 条／172 声明；最终候选迁移 **64 条／171 声明**，
分族 16／54、42／111、6／6。C11 的混合过滤／count 规则保留在原 ui，
不能让编译合并跨过原 `display:block` 细化。该完整四条 U640 容器的
规则／声明／顺序有有限门禁，含 block→none 和移到 block 之后的负例。
六条 PDF Host packing 只按原宿主职责归入 packing，不迁到 PDF feature。

最新有限门禁九文件 **63/63**；Popup 最后一处仅格式化后单文件
**10/10**。有限借用及旧 owner 的指定 phase 交接必须先核完整 Topbar
载体／保留 tuple，成功才投影一条获准载体；其他改动无豁免。普通入口
不锁整个 App、不用 Git 或跨 peer inverse；实际独立 React／CSS feature
增长与合法别名反例保留。相关完整 typecheck 通过。

两份干净 normal build 分别为实际 Git `66666d53` 与最新 64 条候选，
完整 typecheck／Vite／service／prune terminal0；原 App 构建及进程未改。
根代理另核不可变档案的九份完整源字节与实际 Git 一致、当前七条生产
路径与最新构建源一致；三份原 CSS 仅移除指定完整规则后的整个有序源
AST、comments 和剩余 context 相等，main 全字节只允许三个指定 import。

实际 index 选择的完整 compiled CSS：旧 2,764 rules／11,758 nodes，
新 2,765 rules／11,767 nodes。64 authored 映射为 63 编译边界：61 个
普通完整 recipe 和原连续 C12／C13 的一个完整合并 group，均要求独立
production minifier reference／旧／新三方 raw tuple 完全相等。
C38 是唯一明确非 raw-equal 边界：原连续两个 Library 与 Topbar 的
完整混合 rule，对应新 retained Library 与 selected Topbar 的完整两件；
三个完整独立 minifier reference 全部核准后，才允许旧 remainder 一次
预声明的完整 Library 投影。**不是原始 closure／raw CSS 相等**，不是
删掉混合规则、selector 子集比较或通用归一化。仅此投影后的整个剩余
有序 raw 树相等，其余所有节点／规则／context 均保留。

完整跨越收据与负例保留：C38 的 54 个 retained crossings 包含 53 条
原 UI tail 与一个已披露的 Library self-boundary；原 58 条 tail 中另五条
selected 未被跨越。15 个 padding writer 包括 `.sr-only{padding:0}`，
不能隐去不同值或声称任意多 class 的 DOM 都等价。独立 JSON 审计通过，
这只是当前有限迁移证明，不代替实际 Page CSS 字节、渲染或原生命中。

最新完整统一 Node：**357 文件、2,444 项、2,440 通过、零失败／取消、
4 明确未启用**；required PostgreSQL／Runtime，四个 Runtime flag 实际
启用，unexpectedSkips 为空。三个 S3 与一个 native-focus 不计为通过，
不是环境丢失；真实 Rust 场景使用隔离状态和受控模型响应，不冒充付费
模型或原用户资料。已提交 `220b5c68` 的测试接线单独记录于下方。

实际旧版与最终 64 条候选使用相同最终 spec，完整十文件／38 用例，
各 **37 通过／1 失败**。两边均在新建项目后原第三方 iframe 应继续
连接的原断言失败；这是新增项目被误判为撤权导致界面卸载的旧生产 bug，
不是前置接线问题，也不因旧／新相同而视为通过。没有过滤失败项、重试、
放宽原断言或时限。根代理独立核验 15 个完整 spec 来源、每 lane 的
75 次实际 Page index／CSS 响应字节、全部 38 个 trace，以及 marker
恢复、owned 进程组／临时中心／端口清理。完整 suite 保持 RED；另行
修复仍待用户选择，不混入保持行为不变的重构。

严格 mounted 对照的旧版完整首轮为 **12 例、8 通过／4 超时**，
不是等价验收通过。四个覆盖式右栏轴均在内容创作入口的指针点击被
非模态 inspector 遮挡；原真实 UI 支持的键盘入口用于后续采样准备，
不以 force click、伪造事件或生产变更绕过。该首轮未中断，完整 trace、
未完成状态收据及清理均保留；原更早的带计数导航前置失败也保留。
网络证据校验另有明确接线错误：安装的 Playwright 普通 trace 默认
`omitScripts`，实际 Page 的 index／CSS 正文存在，main JS 响应存在
但正文被省略。后续从同一原 Page 被动读取 `response.body()`，
仍要求实际脚本字节与该 lane 的磁盘构建一致；不以另一条 HTTP GET
替代 Page 加载证明。原附件内联导致 reporter 无文件路径的后续首红也保留。
最终附件按同一 case 的实际 bytes 保存，旧／新各 **12/12**，Page／HTTP
reporter 零错误，原 index／完整 CSS 的 trace 正文与实际 Page 的 main JS
正文均与各 lane 构建相等；原生 App、Runtime 和用户 center 未改。

最终严格对照的完整 **12 轴／156 状态仍为 RED**，第一处为完整 computed
数组中自定义属性的枚举位置不同，不能据两边操作通过宣称等价。另用完全
相同的旧 compiled CSS 在三个独立、已核验的浏览器进程诊断：自定义属性
枚举顺序不同，标准属性顺序／值、按属性名的所有值及原始矩形均相同。
这是有限 CSSOM 诊断，不是 normal App 或原窗验收。完整实际收据的独立
诊断覆盖 6,552 nodes／336 pseudos：所有 6,888 个 computed 数组的
属性名集合、按名值、标准属性顺序以及全部原始几何／控件事实均无差异，
但 **51 状态的实际动画数组仍有差异**，含尚未完成过渡的数量、缩短时长
及插值起始颜色；原采样未记录 effect target／transition property，不能
冒充已定位同一 effect 或已经证明动画相等。当时下一份采样合同仍在设计，
必须保留全部原始枚举及动画证据，不按上述诊断宣称最终对照通过。
没有排序或覆盖原收据，也没有将首轮 RED 改为通过。

根代理另用同一旧 compiled CSS、同一已核验浏览器，在隔离的合成
Inspector-toggle markup 中诊断真实鼠标与 `transitionrun`：两种真实
RAF 间隔后移开，完整时长均 110ms，反向过渡实际缩短为约 37.51ms／
72.59ms；event target／property 和原 effect keyframes 均记录。没有修改
动画时钟、样式或伪造事件。这验证未完成过渡历史会影响时长的机制，
不是 normal App 验收，也不能从旧收据恢复当时缺失的 effect 身份。
新的稳定起点与真实 hover 合同的后续执行单独记录如下。

新的完整 normal-App 合同保留每个 computed 属性名／原值与全原始枚举，
不比较浏览器不稳定的自定义属性枚举位置；几何原值无舍入、容差或字段删减。
每个实际状态先保留并等待原有限过渡自然结束，再真实鼠标悬停，完整记录
同一 effect 的 target／property／timing／keyframes 与控制前事实；1000ms
只表示已结束的 END 采样，不代表内部插值、任意画布或全部原生动效。
旧／新各 **12/12**，**312 状态／7,515,354 属性名值／92 个 controlled effect**
的整个有限 comparand 严格相等，Page／HTTP 零错误且完整 index、CSS 和
同一原 Page 的 JS 实际字节均与冻结构建相等；owned 清理完成。

独立冷审计首次 RED 保留：它的 retained-effect union 漏掉控制前由实际
`getAnimations()` 捕获、但在 END 后合法退出最终 live scan 的完整 refs。
完整原件与 controlled 身份／timing／keyframes 并未丢失；每 lane 的 92
个 effect 均已按原始收据核对，零重复身份／metadata 差异／取消／event error。
只修独立核验逻辑，不改生产、冻结页面入口、实际收据或旧失败结果。根代理
审阅并独立核完整源码唯一 delta 与全绑定后，修正后的冷审计实际执行
**12 轴全部通过**：24 个 Page 的完整 index／CSS／同 Page JS 字节、全部
原始属性枚举与按名值、312 状态的整个 comparand、原件与 controlled
完整 metadata／END、真实指针／焦点／布局及 owned 清理均严格核验。
没有宣称原件所有自然事件已被观察：初始实际 refs 可以先于事件派发被捕获。
旧首红不重写，此结果仍只证明有限 END 采样，不证明内部插值或原生窗口。

证据：不可变来源在 `/tmp/morphz-workspace-topbar-three-phase-preparation.lf6Q36/`；
最终源／门禁／full Node 原始日志在 `/tmp/morphz-workspace-topbar-source-move.sLAIDm/`；
旧／新 normal build 在 `/tmp/morphz-topbar-stage59-baseline.z0VBDQ/` 与
`/tmp/morphz-topbar-stage59-refined.kwALKv/`；完整 compiled 证明及全部
跨越在 `/tmp/morphz-topbar-compiled-proof.4pTt8g/`；最终候选完整页面
及根独立审计在 `/tmp/morphz-topbar64-real-consumers.qQ6Xsh/`。原两个
compiled 首红和 65 条候选均保留，不覆盖为绿。实际 mounted 首红在
`/tmp/morphz-topbar-mounted-strict-file-attachments.YEXNRj/`；相同旧 CSS
诊断在 `/tmp/morphz-topbar-cssom-resolved-browser.rnv3cc/`。
全量实际收据诊断在 `/tmp/morphz-topbar-animation-readonly-taxonomy.Cb1czP/`；
同旧 CSS 反向过渡诊断在 `/tmp/morphz-topbar-old-css-transition-diagnostic.rvdSIx/`。
新稳定／hover 完整收据与首次严格 PASS 在
`/tmp/morphz-topbar-mounted-stable-hover-entry.Y5OJg0/`；独立冷审计首红在
`/tmp/morphz-topbar-stable-motion-independent-audit.Oy0RwN/AUDIT-FIRST.json`。
修正后的独立冷审计完整源码、绑定和首次 PASS 在
`/tmp/morphz-topbar-stable-motion-audit-initialrefs.nycTgp/`。
原 App／原生验收仍独立未完成，整体目标保持 active。

## 2026-10-05 页面回归：显式阅读入口与 PDF 同次采样

仅 `tests/workspace.spec.ts`、`tests/pdf-attachment.spec.ts` 与本记录，
不改生产组件、焦点策略、PDF 生命周期、CSS 或接口。旧／新完整四例
首轮都暴露过测试前置问题：输入聚焦不再自动展开已关闭的交流记录；
PDF 调宽时页节点可能在两次采样之间替换。保留原首红与后续完整失败记录。

Workspace 第三用例沿用现有 `openExchangeReading`，在原收起动作前、
reload 后、Projects 返回及 Tasks 返回四处明确打开阅读区；原区域、
窄屏几何、草稿、键盘与跨页返回断言全部保留。PDF 仍在原 poll 中要求
小于 2px 对齐，准备状态、非零文字／画布尺寸及 width 改为同次 DOM 采样；
原文字／span 数、超过 100px 宽度变化、分页、草稿及不发送／不持久正文
断言不变。没有响应伪造、点击重试、过滤、增加等待或容差调整。

实际旧 `66666d53` 与第一份 Topbar 候选正常构建，使用相同校正 spec，
各 **4/4**，完整两文件、worker1、retry0 和原预算不变。根代理独立核验
每例真实 Page trace 中的 index／完整 CSS 响应字节与各 lane 磁盘资产
一致，marker 恢复、owned 进程组和端口／临时中心清理均通过。当前完整
typecheck 通过。此证据只验证测试接线修正，不代表后续 64 条 Topbar
候选的迁移等价、第三方接入完成或原 App／原生窗口验收。

证据：原完整十文件首红在 `/tmp/morphz-topbar-real-consumers.Owpy5W/`；
两次接线后续首红分别在 `/tmp/morphz-topbar-test-setup-entry.QothK5/`、
`/tmp/morphz-topbar-test-setup-v2-entry.UICy2n/`；最终两 lane 完整四例与
独立字节／生命周期审计在 `/tmp/morphz-topbar-test-setup-v3-entry.jj1ywI/`。
最终 PDF 条件的一行格式化后，在全新
`/tmp/morphz-topbar-test-setup-formatted.fcXjFj/` 复跑并核完整最终 spec
字节，两 lane 仍各 **4/4**，共 20 次实际 Page CSS 响应与清理再次通过。
原应用 iframe 因新增项目误判撤权而卸载，是另一个旧生产 bug，不以
测试修正掩盖；待独立修复授权，不混入保持行为不变的重构。

## 2026-10-05 前端阶段 58：PDF 渲染样式的独立所有权

生产五路径：原 styles 的完整 14 条／51 声明与原 visual 的完整 9 条／
25 声明，分别迁入 `features/pdf/pdf-reading-base.css` 和
`pdf-reading-adaptive.css`，实际 main 保留两个原级联 phase。六条
Topbar／Host packing 仍留在宿主；Reader、ReaderPdf、PdfReader、
AttachmentPreview、ArtifactEditor 的 DOM、PDF.js 生命周期、权限、
查询、原画布／文字层值和交互未改，不把第三方沙箱接入当作内置渲染器。

新有限门禁七组核完整 23／76、唯一实际 bare import、main 与 runtime
phase、原有限 shared-native 细化、Host 保留和合法独立 feature 增长。
旧 frame 十组、controls 九组、exchange 六组仅做严格有限交接：先核
完整双 PDF owner，成功后只投影一条指定载体；失败保留实际未投影流。
原断言与指定负例保留，不使用整 App hash、跨 peer inverse 或无条件
载体忽略。首红包括新规则误判 Host 的 :has 条件、quoted 属性文本及
非唯一反例锚点，均修测试合同，不改生产。独立审查补上属性中的
`::before` 数据不能掩盖真实 PDF subject 的反例。

两份干净 normal build 通过完整 typecheck／Vite／service／prune；
根代理独立比较 index 实际选中的完整 CSS：各 2,764 rules／11,758
nodes，23 个完整 compiled recipe 及完整未选有序树相等，6 条 Host
保留。全部跨越规则／节点记录，不做选择器子集比较或按猜测竞争过滤。
CSS 完整字节不同；这是有限迁移证明，不是 universal cascade、JS、
审美或原 App 验收。

完整统一 Node：356 文件、**2,434 项、2,430 通过／零失败／零取消／
4 明确未启用**，专用 PostgreSQL 实际准备并核验，unexpectedSkips
为空；五个受控模型／隔离状态的真实 Runtime 集成场景通过。三个 S3
与一个 native-focus 是未启用，不计为通过或环境丢失。随后门禁审查
补上有限属性数据反例，最终全 typecheck 与相关五文件 **36/36** 通过。

完整旧／新两文件 PDF 页面回归，经独立 `54420110` 测试接线修正后
各 **2/2**；实际 Page CSS 字节、marker 恢复及 owned 进程／端口清理
有独立收据，原首红不覆盖。三种真实消费者的同 DOM 完整 CSS 切换
现已通过：Reader、附件、历史 PdfReader 的对象／应用／inline 五种
挂载，12 组环境共 **247 个状态、741 次完整快照比较、1,000 次实际
Page CSS 响应**。四 accent／明暗、窄屏、指针及辅助媒体、真实 PDF.js
加载／失败、中文文字层、真实鼠标选区、分页、portal、原 scopedStorage
及无关 render 保留均有实际记录；独立收据审计与当前消费者源码核验通过。

挂载入口的首红包括 CJS／Vite 路径、响应缺 UTF-8 charset、加载路由
清理、原生 details 可见性和遗漏真实 main／object-surface／sidebar
前置，均仅修验证入口。原完整入口还有 180s 取消；隔离诊断证实原
`.app zoom=2` 从打开时就把 modal 高度放大到 1,856px，按钮落在屏幕外，
不是选区把它滚走，也不是此 CSS 迁移产生的新差异。保留该 RED，
200% 轴明确改为 **720×480 CSS 视口／DPR2 的布局代理**，实际 zoom=1；
这不是 Electron／OS 原生缩放验收。其余 12 轴、五挂载、180s 与全部
原断言保留。每状态五次全量 fresh snapshot 和三次严格比较不减，只将
当前普通对象／数组数据域的比较留在浏览器，减少四份重复大树的传输；
无字段过滤、容差或值归一化，差异仍返回完整树。最终约 140s、零取消。

这些是隔离挂载与有限迁移证明：Client 读取／阅读位置回执是受控端口，
不冒充后端授权、真实用户草稿或原 App 验收；生产消费者与样式值未改。
原 App／原生命中验收仍未完成，实际原进程／Runtime 保留且系统仍锁屏。

证据：`/tmp/morphz-pdf-reading-c93283db.Gn6BHd/` 的来源档案、独立
源码证明、全量／有限回归及 typecheck 原始日志；两份 normal build
在 `/tmp/morphz-pdf-stage58-baseline.49GIER/` 与
`/tmp/morphz-pdf-stage58-current.XdUFDV/`；完整 compiled 记录在
`/tmp/morphz-pdf-compiled-proof.3JLGxE/RESULT.json`；完整两文件页面
记录在 `/tmp/morphz-pdf-real-conflict-entry.WSqHVa/`。挂载全部首红保留于
各独立 `/tmp/morphz-pdf-mounted-*/` 与 zoom 诊断收据；完整通过入口为
`/tmp/morphz-pdf-mounted-layout-proxy.ajcGM7/`，完整收据为
`/tmp/morphz-pdf-mounted-layout-proxy-first-receipt.json`，根独立审计入口为
`/tmp/morphz-pdf-final-evidence.lmHJFJ/verify.mjs`。Shell packing
与整体跨页面／原窗验证继续；整体目标 active，不以阶段数量计百分比。

## 2026-10-05 PDF 回归：真实版本冲突的确定性测试接线

仅 `tests/pdf.spec.ts` 与本记录，不改 Reader、存储、SSE 或生产样式。
原完整旧／新两 lane 首轮各 1/2：附件通过，Reader 在等待 409 时超时。
实际 Page 请求表明外部保存后，实时刷新已读到新版 paper；随后选择
paper 可能成为原来的同位置／偏好 no-op，旧用例不保证发出旧版本写入。

现在只暂挂一次真实目标 PDF 的 UI save-position 请求，核其原版本／
位置／偏好，再用原真实 API 提交外部写入，原样继续 UI 请求并等待真实
409。没有伪造响应、改请求、禁用 SSE、删除断言或加大等待；后续完整
画布、中文文字层、窄屏、分页、批注保存及重开断言与第二完整 spec 保留。
两份干净旧／新 build 使用同一校正用例，各 **2/2**，原 30s／5s、
worker1、retry0 不变。真实 Page 均载入其 index 选中的完整 CSS 字节；
两 lane 的 marker 恢复、owned 进程关闭、端口清理均通过。

当前完整 typecheck 与相关五文件统一入口 **36/36** 通过；不是完整
Node 或原 App／原生验收。本修正独立于正在收口的 PDF 样式 owner。
首红留在 `/tmp/morphz-pdf-original-spec-entry.6BdI6y/`；新完整两 lane
及独立 Page 字节／lifecycle 收据在
`/tmp/morphz-pdf-real-conflict-entry.WSqHVa/`。

## 2026-10-05 前端阶段 57：交流控件样式的独立所有权

生产三路径：原 visual 的交流媒体／历史控件完整 **16 条、63 声明**迁入
`features/exchange/exchange-controls.css`；唯一实际 main import 保持在
visual 之后、exchange-layout 之前。原细／粗指针、28／32／44 命中尺寸、
材质、pressed／hover／reserved 状态、未读点、token、motion 与 DOM 不改。
早 phase 的 application Dock 仍由原 owner 拥有，不能把 Dock 与面板控件
混成一种语义或整体后移。原 coarse floating survivor 保留。

新有限门禁九组固定完整原 16／63 recipe、唯一实际 runtime import 与
相对 phase、竞争 writer，并核真实别名／独立 feature 增长及 native
selector／quoted-data 反例。旧 Exchange CSS 六组只交接一条已迁移
writer 的实际物理 owner 与唯一 phase；旧 frame 档案、算法及指定负例
不重算，不采用跨 owner inverse、整 App hash 或一份不断扩大的公共库存。

两个干净 normal build 均通过完整 typecheck、Vite、service 编译及 prune；
候选首轮新增测试的 union flatMap 类型红项保留，改为同义声明计数 reduce，
没有改生产。最终当前源码完整 typecheck、八个相关源码格式及 diff 检查
通过。统一入口四文件 **52/52**；修正当前过时测试后的完整回归 **355 文件、
2,427 项、2,423 通过／零失败／零取消／4 明确未启用**，见下方独立测试
交接记录。实际 Runtime 五个集成场景使用隔离状态与受控模型。

根独立核 actual Git51af 的完整来源，实际 index 选中的两份生产 CSS 各
2,764 rules。全部 16 个完整 compiled recipe 的 selector、context、ordered
declaration／value／important 相等；只移除这 16 件及其独占空 wrapper 后，
完整余下有序流相等。每条跨越的未选 rule 全量保留，没有按“看起来不竞争”
过滤。两份完整 CSS bytes 不同；这不是 universal cascade、JS、审美或原窗证明。

六文件完整旧／新页面的第二轮各 **23/24**；六个 Floating 场景、七个
伸缩场景及原 200% Electron 场景通过，唯一原生前台前置同样失败。完整
case、断言、预算、零 retry 与原始首红保留；没有原始几何附件，不声称
双方逐像素或完整几何值相等。原 App 当前系统锁屏，最终原生命中／焦点／
硬件验收未完成；PDF 与 Shell 剩余样式所有权和整体跨页面验收继续，
目标 active，不把本阶段迁移当成整体完成。

证据：`/tmp/morphz-controls-stage57-baseline.YikRAY/root-normal-build.log`、
`/tmp/morphz-controls-stage57-current.35nZrH/root-normal-build-second.log`；
`/tmp/morphz-exchange-controls-compiled.kvVItU/RESULT.json` 及完整 profiles／
remainder／crossings；`/tmp/morphz-controls-stage57-canonical.T53XHF/` 的
`final-current-typecheck.log`、完整回归和 case 对照；
`/tmp/morphz-controls-stage57-contract-entry.A6JJFE/` 保存两 lane 原始收据。

## 2026-10-05 前端回归：现有 Dock 与输入消费合同的测试交接

仅两个测试及本记录。Floating 原六个完整用例保留，四行预期跟随用户
已确认并在 `570a31d1` 落地的裸 Dock：图形 22px、透明背景、无 inset
阴影；原 32／28／coarse44 命中框、半径、200% multiplier、几何／焦点／
草稿断言与预算不改，没有把生产 UI 改回旧方框。

Submission 的单个当前检查直接复用现成 `verifyRawSubmissionConsumption`，
核实际 raw App 的真实 import／binding、唯一 render 捕获、完整原端口、
顺序与固定 Git9122 两个完整算法。不再为这一个当前用例先逆向恢复 peer
旧 App。原固定算法用例、历史 expansion helper 和全部历史负例字节不变；
没有修改生产发送、应用输入准备或第三方协议。

统一入口四文件 **52/52**，零失败／跳过／取消；统一入口准备并核验了
专用 PostgreSQL，unexpectedSkips 为空。六文件完整旧／新页面对照首轮各
24 项 **17 通过／7 失败**，保留原证据；四行合同交接后的新两 lane 各
**23 通过／1 失败**，所有六个 Floating 场景通过。剩余同一原生前台
焦点检查未通过，系统实际显示锁屏。内部几何断言通过不等于双方全量
原始几何或像素相等；被动 HTTP 字节收据不是 Page 实际加载或原 App 验收。

完整当前 Node 首轮 **2,424 项、2,414 通过／1 失败／9 明确未启用**；
唯一失败为上述当前 Submission 检查仍依赖 compose 的旧 import 位置，
不是 PostgreSQL 缺失。该首红保留；修正后启用原四组 Runtime integration
的完整回归实际结束：355 文件、**2,427 项、2,423 通过／零失败／零取消／
4 明确未启用**，unexpectedSkips 为空。四项是三个 S3 和一个 native-focus，
不是通过或环境故障；Runtime 使用原隔离测试状态与受控模型，不是用户
业务或真实供应商验收。交流控件生产 owner 与整体原 App 验收另记，
目标保持 active。

证据：`/tmp/morphz-controls-stage57-canonical.T53XHF/` 的
`focused-current-handoff.log`、`full-node-first.log`、
`full-node-second-runtime-enabled.log`；
`/tmp/morphz-controls-stage57-entry.Zy6AL5/` 保留原断言首轮；
`/tmp/morphz-controls-stage57-contract-entry.A6JJFE/` 保存第二轮两份报告、
完整合同四行差异、原件字节核对、HTTP 与清理收据。

## 2026-10-05 前端阶段 56：应用输入准备的独立职责

生产两路径：App 的原 `applicationCompose` 完整三分支迁入
`host/application-compose-preparation.ts`，仍在原 render 位置同步构造。
借原 captured render、Client 读取、scoped 草稿 writer、真实 flushSync、
当前工作面／听写 refs 与焦点端口；builtin adapter 和 sandbox Host
消费同一个返回命令。剧本优先、版本／冲突检查、对象 latest updater 的
真实 ACK、普通 captured append、异常与部分写入顺序保持。没有新增
state、effect、请求、发送入口、权限、SDK、DOM、CSS 或领域存储。

统一入口八文件 **62/62**，零失败／跳过／取消。有限实际接线门禁保留
二十个 parse-valid 反例及实际 import／const 别名、独立消费 feature 正例。
纯算法与真实 React StrictMode 挂载保留原 scoped draft writer／storage；
显式固定旧实现对照 **8/8**。首 mounted 红项是普通／剧本同步 ACK 后
立即观察尚未 commit 的 React DOM：现保留完整 `immediateSnapshot`，
仅另等真实 DOM 发布后记录终态，未修改生产调度或对象 flushSync。

原 builtin 门禁仅交接箭头 initializer 为真实工厂调用；两旧测试共四组
导入反例／别名锚点跟随 Prettier 的单行实际导入。首轮未命中锚点的
三失败保留；原断言／规则／二十三 builtin 反例及 Reference 二十六个
历史反例不删。独立完整源码 inverse 核十三份实际原件、完整原三分支
及两个原消费片段；普通 CI 不依赖 Git／临时目录或锁整个当前 App。

干净 Git `728eb101` 原件与仅覆盖批准路径的候选分别正常生产构建通过，
包括完整 typecheck／服务构建；实际入口选中的 CSS 全字节相等。
这不是全页面、第三方 SDK、真实供应商或原 App 原生验收。阶段 55 的
完整回归已结束，见下；阶段 56 后整套复跑、剩余交流控件 owner 及
原 App 最终验收仍待完成，目标保持 active。

证据：`/tmp/morphz-application-compose-preparation.fpz65K/` 的
`root-eight-anchor-handoff.log`、`root-eight-formatted-final.log`、
`root-fixed-current-second.log`、`root-final-source-proof-fourth.json`；
`/tmp/morphz-compose-stage56-baseline.SP8YoW/root-normal-build.log` 与
`/tmp/morphz-compose-stage56-current.azMR0n/root-normal-build.log`。

## 2026-10-05 前端阶段 55：引用命令的真实应用消费链

仅两个测试路径及本记录／架构文档。阶段 54 后完整当前 Node 回归真实结束：
351 文件、2,396 项，2,388 通过／四失败／四明确未启用的集成。四失败均为
Reference 当前检查仍在 App JSX 寻找已经迁入可信 builtin factory 的
`onReadingCompose`／`onComposeIntent`，不是 PostgreSQL 或生产算法缺失。
该完整首红日志保留，没有改生产代码迁就旧物理位置。

当前检查沿实际命令返回符号、真实 runtime factory 值来源、唯一 render
捕获、Host renderer 实际消费与调用，检查 Reader／Script 的两个真实叶子。
旧 direct／无重挂 key 约束跟随实际消费位置；其余引用消费方与原完整规则
不变。只重定向一个当前 wrapper 反例的物理锚点，完整历史段及原 26 个
历史反例字节不变。新增八个 parse-valid 来源／借用反例，真实 import／
local factory／Host JSX／捕获参数别名及实际消费的独立 feature 正例通过。
不复制三个完整 builtin recipe，不锁完整当前 App，不新增跨 owner inverse。

专用统一入口八文件两轮 **81/81**；根统一入口原扩展九文件 **86/86**，
均零失败／跳过／取消。双方完整 typecheck、两测试格式及 diff 检查通过。
首轮五个 TS7 可选 binding name／parameter 窄化错误保留后定向修复。根
独立 actual Git 核五份完整原件，有限逆向还原两份完整旧测试，并确认
App／Host／builtin adapter 全字节未改；这只是迁移来源证明，不是 UI 验收。
根临时源验证器首轮锚点过宽与误用直接测试入口的红日志也保留，分别改用
唯一完整函数锚点及统一能力准备入口；没有声称现有浏览器环境不存在。

完整回归首轮还实际通过五个 Rust integration case：嵌套活动、Profile、
response annotation、V2 缺少 metadata 明确失败，以及 Job 唤醒 Host SSE。
使用隔离测试状态／受控模型，不调用用户业务数据库或冒称真实供应商验收。
三个 S3 和一个 native-focus 是明确未启用，不是通过或环境故障。阶段 55
提交 `728eb101` 后完整统一入口复跑已真实结束：351 文件、2,397 项，
2,393 通过／零失败／零取消／四项上述明确未启用，unexpectedSkips 为空。
剩余生产 compose／exchange 控件 owner 与原 App 最终验收继续，
目标 active；没有将此测试修复称为第三方 SDK 或整体前端重构完成。

证据：`/tmp/morphz-full-stage54-root.QurrEu/full-node-current-7c1aea5a.log`；
`/tmp/morphz-goal-remaining-7c1aea5a.ufBySh/reference-handoff/RESULT.md`；根
`/tmp/morphz-stage55-root.CHSEix/root-nine-canonical.log`、
`root-full-typecheck.log`、`root-reference-source-proof-final.json`。
完整复跑证据为同目录 `root-full-node-728eb101.log` 与
`root-full-node-terminal.json`，不将提交前首红或定向回归冒称整套全绿。

## 2026-10-05 前端阶段 54：通用应用宿主与可信内置接线分离

生产三路径：`ApplicationHost` 保留 catalog、实例 key／hidden、顶栏、
启动／关闭及完整原 sandbox；Browser／Reader／ScriptStudio 的三个
完整 JSX recipe 与 recent route 归 `host/builtin-application-adapters.tsx`。
App 在原 render 中借原 Client／语义端口构造无 hooks／effect 的可信
adapter，Host 消费两个通用端口，不再 import 专业组件或携带专用 props。
完整原三分支 compose 只命名为同一个 callback，仍由 App 拥有，不冒称
下一项 compose preparation owner 已迁入。原 sandbox race 仅一处无用
builtin props 接线更新，原九个场景和断言不变。

内置组合 adapter 不是对外 SDK，也不是第三方权限 gateway。同仓库不代表
业务混层：Morphz 拥有共享宿主，应用拥有领域能力与画布。当前实验 manifest
的 `ui` 必填；已有第三方界面安装和受限消息桥，不是完整的无界面认知应用
定义，安装不自动注册业务服务／Tool／Harness。公开薄型 author SDK 与完整
第三方领域接入尚未交付；本批不改 schema、协议、CSP、权限、CSS、数据、
Runtime 或实际原 App bundle。架构文档第 2.2 节明确这些边界。

根 fresh actual Git `4b783472` 独立核 17 件完整来源、18 个 literal seam、
整个 raw App／Host／race inverse 和四个完整旧 recipe。新 owner 不伪造
整文件 Git 前身；生产仅获准候选与格式变化。普通门禁不锁整页或恢复跨
owner inverse，原 21 个指定反例、两个 mixed-import 反例及五个真实增长
正例通过；全 named type-only import 的首轮误报保留后定向修复。

根 proper 原扩展六文件 **91/91**，零失败／跳过／取消；完整 strict
typecheck 通过，使用实际专用 PostgreSQL。新 A 组核真实元素与 callback
捕获／结果，B 组真实 Host 和三个组件在 StrictMode 下核节点、实际 Browser
输入焦点／值、Reader 已加载 DOM、真实动作、33 源 CSS、四色亮暗／宽窄／
CSS zoom 及运行中的 motion。显式固定旧 recipe 对照 **18/18**，但不是
完整旧 Host。Reader 的测量发布 chronology 不承诺确定：保留全部 raw
ledger／counts，核每条来源及观测边界的完整 key／artifact／revision／focus
序列化投影；`capture` 函数未实测。其他动作／读取／DOM／材质／几何／
motion 全值对比不裁剪。SSR／DTO／类型／两轮 chronology 首红项均保留。

两个全新 normal clean build 成功，实际 main 指向的完整当前 CSS
267,699 字节一致；九个新生成资产一致。三个实际 PDF lazy chunk 不是
原始字节相等，仅四个精确 chunk filename 替换后完整相等，不等同 PDF
实际渲染验收。原 `emptyOutDir:false` 中残留旧文件的比较报告保留并纠正，
不能把它当作当前 lazy graph 相等。

根完整六原 spec、26 项不改断言／预算／筛选／retry 的两 lane，分别
**24 通过／2 失败**，全部 case／错误／位置一致。失败为原
`applications.spec.ts:288` 的项目／刷新后 iframe 失联和
`browser-composer.spec.ts:154` 的原生前台焦点前置；没有新增失败，但
不是全绿或原窗验收。私有 runner 首次物理路径及随后 SIGKILL teardown
红项保留；仅私有 teardown 改为正常 SIGTERM，真实 owned group 停止、
端口空及原 discovery marker 全字节恢复，不杀业务 Runtime 或更换用户
profile／center。完整当前 Node 回归与原 App 最终验收仍待完成，目标 active。

证据：`/tmp/morphz-builtin-integration.zU9j0V/RESULT.md`、
`source-proof-type-import-final.json`、`new-migration-final.log`；根
`/tmp/morphz-builtin-stage54-root.b9AM8H/root-six-proper.log`、
`root-full-typecheck.log`；clean build 的
`/tmp/morphz-builtin-root.RiFwwz/root-clean-build-assets-proof.json`、
`root-clean-lazy-filename-delta.json`；完整页面对照
`/tmp/morphz-builtin-page-entry-rev3.FRDQd4/root-executed-lane-comparison.json`。

## 2026-10-05 前端阶段 53：导航与草稿的当前合同

仅四个测试／档案路径。Workspace content opening 与 Exchange drafts 的
普通检查直接读取当前 App 及各自 owner，核实际来源、值绑定、捕获、注册
顺序和完整自有算法；不再恢复 Private／Human／Object／Reference 历史
页面。独立且实际被 JSX 消费的 React feature、真实 import／const alias
可以演进，不锁整个当前 App 或无关模块清单。

根独立读取 actual Git 核六件完整档案来源、派生的完整 c35 App、原十三个
完整 callback AST 及 201 个内字面量／36 个外参数字面量。旧 Workspace
helper 的完整 24,315 字节 prefix／API／default 不变。五个草稿命令的
完整有限 recipe 均来自实际 Git 原件，包括 discard／restore 的早退和
guard，不用 callee 清单代替全算法。原 69 个反例保留完整历史执行；
67 个交接到当前指定规则，两项无关未消费 inventory 仅属历史。另 16 个
当前来源／phase／镜像／早退反例按指定规则拒绝，完整消费的增长正例通过。

根 proper 原扩展八文件 **109/109**，零失败／跳过／取消，包含真实
StrictMode 创建、私有会话与导航消费；完整 typecheck、来源证明、四路径
严格闭包、格式及 diff 检查通过。首轮当前 D26 漏拒绝与严格类型窄化红项
保留，未归咎 PostgreSQL，未改生产代码或界面迁就门禁。不是完整回归或
原 App 验收；当次原窗检查遇到系统锁屏，代码验证继续，目标 active。

证据：`/tmp/morphz-workspace-draft-governance-capture.hqI76n/` 的
`proper-current-first.log`、`proper-formatted-final.log`、
`classify-current-final.json`、`final-provenance.json`、`scoped-type-second.log`；
根 `/tmp/morphz-c3-root.iVuBuE/` 的 `root-current-neighbors.log`、
`root-full-typecheck.log`、`root-source-provenance.json`。

## 2026-10-05 完整 Node 回归与书签反例生成修复

冻结 `e464367d` 的 proper `npm test` 实际选择全部 350 个测试文件：
2352 项中 **2342 通过、1 失败、9 项显式集成 opt-out**，无取消或
unexpected skip。专用 PostgreSQL 已使用，不把未启用的 Runtime／S3／
native-focus 集成称作环境缺失。完整结果仍是失败，不覆盖此前红记录。

唯一失败发生在书签源码门禁的第三个 Promise 包裹反例：闭合括号的
unchecked replace 假设下一声明紧邻 task owner；合法新增独立 object
owner 后替换零命中，先产生非法源，未进入预期拒绝规则。根核完整诊断
及实际注册，只将该反例改为唯一匹配完整目标注册；不依赖相邻模块，保留
parse 前置、原 `bookmark-direct-registration` 规则和其他全部断言。
生产 Client、书签算法、权限和界面不改。

根 proper 三文件（boundary／pure／Client）**18/18**，零失败／跳过／
取消；当前已有独立 object owner 的实际源通过，Promise 反例合法解析后
按原指定规则拒绝。这是唯一红项的定向复验，不冒充修复后的全量绿灯；
后续生产拆分完成后须重新冻结并跑完整回归。

证据：`/tmp/morphz-subject-schedules-root.udmSl9/full-node-current-e464367d.log`、
`/tmp/morphz-bookmark-mutant-diagnosis.jOeE3i/REPORT.md`、`diagnosis.json`、
根 `root-final-neighbors.log`。

## 2026-10-05 前端阶段 52：弹窗相邻控件 carrier 的当前交接

仅两份 surface 源码门禁。普通检查先核 `ui/controls/surfaces.css` 实际
来源、唯一 bare main 导入及原 material→carrier→visual 相对 phase，
实际 runtime 闭包也核顺序；之后只投影这个已核 carrier 比较原相邻区间。
其他 CSS 不能被略过，carrier 仍受原材质／token／foreign writer 检查。
生产 main、CSS、原十二 callback 的断言、两份不可变档案均不改。

根 fresh actual Git 独立核十二个完整 callback：十一件全字节不变；
唯一 D3 mutant 仅逆两条新增 carrier 路径行即全字节还原。原 114 个
指定反例及规则保留，新增 32 个 parse-valid 来源／入口／顺序绕过反例；
实际相对路径 alias 和真实根 JSX 消费的独立 React／CSS feature 正例通过。
这是有限源码合同，不是任意 CSS 证明或原生行为验收。

根 proper 原扩展七文件 **50/50**，零失败／跳过／取消，包含原 frame、
popup 与共享剧本的实际挂载、原材质／几何／焦点／动效检查。此前同范围
**42 通过／6 失败** 及 fresh e4 的同六红项保留；修的是陈旧入口假设和
一个失效 mutant 接缝，没有改生产样式来迁就测试。冻结 SHA、格式／diff
及最终完整 typecheck 通过。原 App 当次只读截图／AX 已可见，仍为未安装
本批构建的原 bundle；整体全量与原 App 最终验收仍未完成，目标 active。

证据：`/tmp/morphz-surface-carrier-handoff-plan.qcWp5q/RESULT.md`、
`root-final-source-proof.json`，根 `surface-carrier-root-final.log`。

## 2026-10-05 前端阶段 51：创建与私有会话的当前合同

仅五个测试／档案路径。Human creation 与 Private project scope 分别
直接消费 raw-current App 和自己的真实 owner，不再为普通 CI 执行
Object／Human／Reference 的跨 owner inverse。真实 import／const alias、
捕获、注册相对顺序、完整自有算法和消费受有限解析合同约束；完整消费的
独立 React feature 可以增长，不锁当前整份 App 或无关模块清单。

根 fresh actual Git 独立核八件完整历史来源、原十二个完整 callback、
103 个原始字面量，两个旧 helper 的完整 prefix／API／default 不变。
原 28 个反例执行完整旧 checker：25 项同时交接到当前规则，三项仅属
历史整页或无关未消费成员；另八项当前来源／镜像／副作用反例按指定规则
拒绝，四组实际 alias／React 消费正例通过。历史重放不读取 mutable peer
defaults；Reference 只核原两个 pre-preparation 缺席 guard，不夸大范围。

根 proper 原八文件 **84/84**，零失败／跳过／取消；包含创建、私有会话
生命周期与对象评论的实际挂载、原纯算法和相邻门禁。五路径严格类型沿
原政策检查 415 文件闭包、格式／diff／冻结 SHA 通过。此前 checker／parser
实现错误保留红记录，不归咎 PostgreSQL；proper 入口使用已验证专用连接。
不改生产、UI 或存储，不是整应用／Runtime／原 App 验收。Workspace／Draft
尚有两条当前历史恢复边，下一批交接；整体目标 active。

证据：`/tmp/morphz-human-private-governance-plan.bMK0eN/RESULT.md`、
`CLASS28.md`、`provenance-root-final.json`／`classification-root-final.json`／
`strict-root-final.log`，根 `human-private-root-final.log`。

## 2026-10-05 前端阶段 50：共享对象语义图形

原完整七类 `ObjectIcon`／`kindLabel` 归中性 `ui/ObjectIcon.tsx`，五类
页面直接消费同一 owner；ArtifactEditor 保留原同 binding 兼容出口。
不新增 DOM、状态、effect、调用方回退或样式。根 fresh actual Git 独立
核五件完整页面的精确 forward／inverse、新模块原完整声明和 36 件
未改邻居。当前门禁只约束实际来源、七处图形消费、六处标签读取与有限
调用方条件，不把整页 hash 或跨 owner inverse 链带入普通 CI。

根最终 proper 当前两文件 **7/7**；原宿主 **22/22** 与其余原七邻居
**60/60** 分批串行，合计原十文件范围 **89/89**，零失败／跳过。此前
同范围 TS7 EPIPE／spawn EAGAIN 红记录保留，不以资源原因推断产品正确。
显式旧新迁移另 **7/7**：实际 StrictMode、当前 main CSS 图、八个主题／
宽度组合各 35 个图形，完整 SVG／几何／颜色／描边／动效记录直接相等，
无归一化。原 eyebrow 隐藏和 delivery 18px 保留，不能把 size16 属性
误报成所有位置的实际尺寸。不是五页整页或原 App 验收。

最终 full typecheck／build、九路径格式与 diff 检查通过。根仅修正新
历史测试 fixture 的 classic／automatic JSX 共用 React 绑定，原声明
字节不变，并重新核来源、当前与迁移证据。构建未安装到原 App；原 App／
Runtime 未重启，整体回归与原生验收仍未完成，目标 active。

证据：`/tmp/morphz-object-icon-shared.yLA13Z/RESULT.md`、
`source-proof.json`、`root-final-ledgers.json`，根
`object-icon-root-final-current.log`／`object-icon-root-final-migration.log`／
`object-icon-root-host-serial.log`／`object-icon-root-final-neighbors.log`。

## 2026-10-04 前端阶段 49：弹窗 frame 入口与相邻 writer 交接

仅改一个源码门禁，不改生产 CSS、main、DOM 或不可变 c525 档案。
两条原 shared action rule 的当前物理 owner 明确为
`ui/controls/surfaces.css`；旧 visual 残留仍被拒绝。三个已批准 control
carrier 在 main 和真实 runtime 模块闭包中逐一核唯一来源与原相对 phase，
只投影这三个 carrier 后继续验证原 frame 槽，不跳过任意新增 CSS。
原 30 rules／107 声明、三个 Dialog carrier、两邻 tuple 和原值保持。

根 fresh actual Git 独立核原九个 callback：七件完整字节相同；相邻
callback 仅逆两个物理路径字符串即全字节还原；合法增长 callback 仅
移除八个新增 statement 即全字节还原。原 43 个指定反例保留，另加
21 个当前遗漏／重复／顺序／入口绕过反例；实际同源路径 alias 和根
JSX 消费的独立 React／CSS module 正例通过。均是有限解析／来源合同，
不声称任意 CSS／TS 定理或真实组件挂载。

根 proper 五文件 **36/36**，零失败／跳过，含原 frame／popup 挂载和
共享剧本测试；agent 唯一门禁 **10/10**、完整类型／格式通过。根另扩
七文件为 **42 通过／6 失败**；两份相邻 surface 门禁在 fresh e4 全件
也复现 **6 通过／6 失败**，均为旧入口 phase 或已不存在的 mutant
接缝，并非这批 frame 或共享组件回归。保留全部失败与原断言，下一批
分别交接，不能把当前定向绿灯冒充整个门禁／全量／原 App 验收。

证据：`/tmp/morphz-dialog-frame-gate-plan.yI0Qs0/RESULT.md` 与独立
actual Git callback／fixture proof；根 `dialog-frame-root-owned-final.log`
和 `dialog-frame-root-final.log`；旧两 gate 在 fresh e4 保留档案运行。
原 App／Runtime 未重启，整体目标 active。

## 2026-10-04 前端阶段 48：对象评论与主体检查的当前合同

本批仅四个测试／档案路径，不改生产或界面。对象评论的当前检查直接
消费实际 App、三个完整自有算法、Client／Object data owner 及两条原
失效效果；主体检查直接核实际 annotation hook 的来源、捕获和原顺序。
两个当前入口不再恢复其他 owner 的旧 inline effect，不锁整份 App。
旧 helper 的完整 prefix、三个原 API／default／body 都保持原字节，
供尚未交接的历史借用者使用，不悄悄改变它们的语义。

原十个完整 callback、216 个原始字面量与 fresh actual Git 独立核对。
原 54 个反例完整历史重放：52 项同时属于当前合同；未消费的 alias
次数和无关整份 App hash 两项仅保留历史，不冒充当前安全检查。新增
14 个当前来源／捕获反例按指定规则拒绝；实际 import／const alias 和
完整消费的独立 React 生命周期通过。根发现的独立新 useEffect import
误报已在当前有限消费范围内修正，历史依赖规则未放宽；修前红记录保留。

根 proper 八文件回归 **69/69**，零失败／跳过／取消，含真实 React
挂载及 actual Client HTTP／SQLite 邻接，不等于整应用或原生验收。
根独立复跑十二件完整 actual Git 原件、派生完整 Subject App、十个
callback／54 反例与全原 R4 verifier；三个旧 API 和四件冻结 SHA 核对
通过。四 roots 沿原严格类型政策及 412 依赖文件检查、格式／diff 通过。
Reference 的档案仅走其原 pre-Stage30 early-return，不声称全 peer
执行。剩余 Human／Private、Workspace／Draft 当前入口仍须交接；
整体全量、原 App／硬件和既有另案问题保持未完成，目标 active。

证据：`/tmp/morphz-object-governance.wVLU2f/RESULT.md`、
`CLASSIFICATION-54.md`、根 `object-governance-root-final.log`／
`scoped-type-root.log` 及独立 actual Git／原反例重放。

## 2026-10-04 前端阶段 47：共享剧本弹窗与状态词表

原完整 `StudioDialog` 归 `features/script/StudioDialog.tsx`，七处原表单
直接消费同一组件。四种状态的原中文词表归 core presentation，Studio、
Editor 和 Navigation 直接消费；两个原公开名称保留同 binding 兼容出口，
Editor 到父页面的 runtime 循环边改为原有类型的 type-only 引用。
没有新增包装、样式、状态政策、冻结对象、请求或生命周期。原四 props、
ref／useModal 顺序、原生节点、取消后关闭、标题与 children 都不改。

根 fresh actual Git `e4fdd2ce` 核四完整原件、完整 Dialog、两原词表及七个
consumer header；完整 forward／inverse 及小固定档案核对通过。普通 CI
只约束原小组件、真实模块／value phase 与消费，不锁完整页面源码。
二十一项 parse-valid 反例及实际 import／const alias、独立 React 消费
正例通过。词表仍是原普通 `export const` 对象，不与 Job 状态混并。

根 proper 六文件定向回归 **64/64**、零失败／跳过；agent 五文件
**58/58**，新两文件 **7/7**。原完整 Studio、Editor、Navigation、Library
挂载及 dialog-frame／Host 测试保留；七个表单有完整来源接线合同，不把
新的受控 children 测试说成七项完整业务流程全部运行。显式既有历史
Studio 对照另为 **13/13**、123 组完整原始观察一致；其旧件来自
`13dbe571`，不冒称是新造的 e4 旧 renderer。原 CSS、DOM、焦点与草稿
保持。根完整类型检查、正式 build exit 0；构建未装入原 App。

根另在 fresh e4 整件档案复现原弹窗样式门禁 **5 通过／4 失败**，与
当前原门禁相同；原因是阶段 42 已迁公共按钮 recipe 后，其旧物理路径
和入口槽未交接。保留失败与原断言，正由独立 test-only 批次治理，不在
这批共享组件里修改 UI 或吞掉失败。原 App／Runtime 不重启；整体全量、
原 App／硬件验收和其余已登记边界仍在收尾，目标 active。

证据：`/tmp/morphz-script-shared-production.oTuyDU/RESULT.md`、
`source-proof.json`、小档案独立核对，根 `script-shared-root-final.log`／
`script-shared-root-migration.log`；旧门禁基线在
`/tmp/morphz-dialog-frame-root.PlQxB5/application`。

## 2026-10-04 前端阶段 46：完整操作提交的独立数据 owner

Client 的非输入 durable delivery 现归 `data/operation-delivery.ts`。
完整 execute、可能已提交的错误分类及唯一 Unsent 错误类从实际
`618fc8b9` 原件迁移；五个借用端口的构造无读取或副作用，公开
execute 直接交付真实方法引用。Client 保留完整域分发、身份／权限、
protected projection 退休、refresh 及独立 local input 权威。
record-input 的五个捕获实参和同步交接不变；四字段 SHA、完整 pending
命令／实例、旧作用域、存储／发送／清理／刷新顺序及异常边界均不改。
没有新增状态、锁、轮询、请求、epoch 政策、DOM、CSS、图标或动效。

新增当前受控、实际 Client HTTP／SQLite 及有限消费合同；固定实际 Git
六个完整可执行算法仅供明确迁移对照，不锁普通 CI 的整个 Client。
三个旧位置门禁仅交接真实 owner 邻接、第四个 local input 消费和
同一个 exported Unsent constructor；原反例与指定拒绝规则保留。
根独立来源探针确实发现正确但未消费的 import 加同名 foreign 值会
误接受，修复只限有限门禁，三个原红项现按 actual symbol 精确拒绝；
合法 import／const alias 与完整独立 feature 增长仍通过。

根本轮 actual Git 全件正逆来源证明、六段完整 raw／元数据、四个
门禁完整差异及十六个邻接原件核对 exit 0。proper `npm test` 六文件
**28/28**，显式旧新完整账本对照 **6/6**，均零失败／跳过；agent
最终同组加原邻接行为测试 **82/82**。根完整类型检查与正式
`npm run build` exit 0；构建保留旧内容寻址资产，没有清空运行窗口
可能尚需的 lazy chunks。不能把受控端口、真实 HTTP／隔离 SQLite
或构建成功等同真实 Runtime、物理存储／硬件或原 App 验收。

根完整旧新七份原页面用例各 **17 通过／1 失败**：共同既有红项为
创建项目卸载原 iframe。原句柄断言、trace 和失败保留；只读诊断已
定位通知端过宽的 accessChanged 分类，等待单独修复授权，不在此
纯架构迁移中改业务／撤权行为。原 App 保持运行，本阶段未重启它
或 Runtime，也未将新的构建装入原 App；整个目标仍 active。

证据：`/tmp/morphz-operation-delivery-production.r8fqdZ/R5-FINAL-RESULT.md`、
`frozen-source-final.json`，根 `r5-root-final.log`／`r5-root-migration.log`、
`/tmp/morphz-operation-root-origin.6KFOzJ/root-final-probe.json`、
`/tmp/morphz-operation-pages-root.vkR5Vc/root-comparison-proof.json`。

## 2026-10-04 前端阶段 45：导航的当前权限与消费合同

本阶段只改导航消费测试、两个借用 helper 与独立历史档案，不改生产、
界面或业务。普通当前检查直接读实际 App／Host／navigation owner，核
实际模块与 runtime／type phase、捕获身份／授权／lifetime、原 prepared
Promise／caller catch／finally、稳定 pane／portal 及真实 Subject／Read／
Input 消费。不再以整个当前 App／Host hash、全局 JSX／hook 数量或
其它 owner 的 inverse 作为导航当前工程门禁。

actual Git 2cf／cb 十份完整原件及 4e32 原门禁独立固定。原十四组测试、
一百零四个字面反例、正例、固定原 metrics 和拒绝规则保留为明确历史
证明；九十三个危险 recipe 在 raw-current 中解析并命中指定规则。
其余十一项是独立空 hook、未消费值或无关文案等旧全文约束，仅保留
历史，不声称一百零四项全部是当前合同。另加十一项真实镜像、生命周期
副作用与 wrong-module／unused-correct-import 来源反例；实际消费的
独立 React feature／state／effect 和真实 import／const alias 正例通过。
这是解析源码合同，不冒称挂载执行、权限运行证明或原生验收。

根独立重核十份档案与 actual Git、六个完整旧 API、原字面账本和分类，
另从实际 Git 独立重放核对落盘十四回调的完整语法、二百六十四个原
字面值及一百零四条操作链；此来源记录器不冒充行为测试。
并复跑四个错误模块同名值反例：scopedStorage、interfacePreferences、
contentVisits、React 均按实际来源拒绝。agent 修前误接受红证据保留；
根两次来源探针均在已修后为绿，不虚构根发现新的红项。根 proper
`npm test` 三文件 **32/32**、零失败／跳过；四获准路径及依赖沿原严格
类型策略检查通过。旧 helper 的默认语义与原对等调用保留，没有偷偷
把历史 inverse API 改成当前 verifier。

证据：`/tmp/morphz-navigation-governance.cKlwmu/RESULT.md`、
`CLASSIFICATION-104.md`、根 `r-gov-b-root-final.log` 与
`/tmp/morphz-navigation-root-audit.1yyug4/final-probe.json`。
其它 peer 的旧全文／inverse 链、R5、最终全量和整体原生验收仍在收尾。
同期 R5 原完整页面旧／新各 17 通过、1 失败；共同红项是创建项目触发
既有应用 iframe 重挂载，保留原断言，未把它算通过或混入本阶段修复。
原 Morphz 窗口本轮再读实际截图可见，对话／输入／活动保留；未重启
App／Runtime 或重建用户数据。目标 active，不称整体工程已完成。

## 2026-10-04 前端阶段 44：引用与评论的有限当前工程门禁

本阶段只改五份测试／helper 与一份独立历史档案，不改生产、界面或业务。
引用 owner 的普通当前检查直接读取真实 App／owner：核八个完整命令、
两个原 hook、实际 runtime import／const alias 来源、原注册相对阶段、
捕获 scope／草稿／焦点 writer、返回值与真实 JSX／Provider 消费。不再
以当前整件 App hash、全局 hook／JSX 数量或跨 owner inverse 限制演进。
独立、实际有 JSX 消费的 React feature／state／effect 正例通过；这是
解析源码的消费证明，不冒称已挂载运行或原 App 验收。

actual Git b5／9122／75／9708 的完整原件和原二十六反例独立固定，
历史检查仍保留原全文 metrics、完整 callback 字节及精确拒绝规则。
原十八命令测试组与十四个反例保留；当前危险反例按有限语义交接。
合法且实际消费的别名、独立域的 factory／React 增长不再作为当前违规；
这些明确政策差异与二十六项交接逐项记录，没有用历史 PASS 代替当前证明。

根独立发现并保留四个真正误接受的来源反例：错误模块的同名 controller／
draft factory，以及正确返回方法闲置但 JSX 使用同名 foreign callback。
修后按真实 symbol 来源拒绝全部四项，而非仅按 exportedName 归一化。
根重新核 actual Git 完整档案、六十二／七个旧 helper 声明、原完整二十六
callback、十七个完整命令测试文本，均保留；独立 proper `npm test`
三文件 **34/34**，零失败／跳过。含未改准备行为文件的 agent 四文件
**43/43**；根六路径及依赖的原严格类型策略检查通过。同期完整全局
类型检查仍碰到 R5 测试编辑中诊断，最终全量须待全部 owner 冻结再执行。

证据：`/tmp/morphz-reference-governance.AFT21B/RESULT.md`、
`/tmp/morphz-reference-root-audit.6Gm0c7/first-probe.json` 与
`final-probe.json`、根 `r-gov-a-root-final.log`。未启动服务、请求模型、
重启原 App／Runtime 或修改用户数据。其它 whole-App／inverse 链、R5
真实请求及整体原生验收仍在收尾；目标 active，不称整体工程已完成。

## 2026-10-04 前端阶段 43：对象评论与关联的完整数据操作

`data/object-interactions.ts` 拥有原两个完整读取算法与 annotate／link
写入叶子；Client 在原 bookmark→object→task 顺序唯一构造，公开直接
方法，原 dispatch 分支直接调用叶子。借同一 current／platform ref、
捕获 source、receipt closure 与 UnsentOperationError constructor；不新增
请求、cache、effect、storage 或刷新权威。批注保留 100 页／100 条、
ordinal schema、short-page／游标／溢出策略和原 signal；关系仍直接借
Platform 的独立分页。原版本、引文、page、返回 Objects ID 与回执不混用。

根独立核 actual Git `57e7d4ce` 的完整 63,185-byte Client、九个完整
算法／分支及十四个邻居；整件 forward／inverse 和新 owner 迁移证明通过。
完整固定旧件另由 fresh Git 捕获核验；旧三个批注测试仅交接物理 query
来源／直接 alias／原分页反例，原 metadata、其它负例、state／effect、
DOM、焦点、迟到和 geometry／motion 断言均保留。没有新增跨 owner inverse；
原批注 whole-App 门禁的历史治理债务仍在，另行收尾。

根对最终冻结十一份源独立 proper `npm test` **31/31**，零失败／跳过；
含有限门禁 11、受控行为 6、真实 Client→HTTP→SQLite 4、原挂载 10。
显式完整旧／新算法对照 **6/6**。24 个合法源反例命中指定规则，实际
import／const／schema 别名和消费的独立 Client state／effect／cleanup
增长正例通过，不锁整件当前 Client 或无关清理。

真实私有 HTTP／SQL 覆盖非 head catalogID、历史 v1、101 条批注两页、
关联独立读取、提交后丢回执、SSR 冷重挂载原整件 pending／ID 重试及
单次 SQL mutation／receipt、Human 隔离、同 token 实时撤权、切换身份
后的旧 200 被实际 epoch408 拒收。Map-backed Storage 是完整 Storage API
合同，不冒称浏览器磁盘持久化；受控 Runtime 未启动。已存 Objects PDF
种子覆盖原版本／page1 批注，不冒称 Human PDF 导入或文件字节验收。
非法 page999 的原 domain Error→HTTP500 公共提示保持，未混入修复。

六份完整原页面 spec 冻结旧／新各 **21/21**，标题／预算不变；每边
104 个实际入口资源响应、208 emitted 原件、零跳过／重试及自有生命周期
核验通过。首轮候选唯一红是私有文档迟到测试静态根仍读 normal dist；
业务断言已通过，仅校准私有 webRoot 后重跑完整两边，保留初始红证据。
正常完整 build 通过并仅刷新原 Morphz；实际打开已有 v2 文档及批注栏，
正文和真实空态可见，再恢复原对话、活动页签与两侧栏。103 历史消息、
输入和 Dock 保留，没有写业务对象、发送模型请求或重启 Runtime。

最终冻结 R4 类型／格式检查通过；根后续全局类型检查遇到另行编辑中的
门禁 helper AST 类型错误，不将中间快照称为全量通过。须待所有 owner
冻结后重新执行完整类型／默认全量与原生／硬件验收。证据：
`/tmp/morphz-object-interactions-production.Mm6vqZ`、
`/tmp/morphz-object-pages-http-root.TaEmCB`、
`/tmp/morphz-subject-schedules-root.udmSl9/r4-independent-corrected-final.log`、
`/tmp/morphz-original-ui-recovery.q72TCn/original-r4-conversation-restored.jpeg`。
R5、有限门禁治理和整体验收继续；目标 active，不宣称架构整体完成。

## 2026-10-04 前端阶段 42：公共控件 role 的真实样式所有权

原跨三份大 CSS 的完整公共控件规则归 `ui/controls`，四载体分别保留
base 16／53、adaptive 4／5、metrics 3／5、surfaces 8／22，合计 31 条
规则／85 声明；Browser 原完整输入 recipe 独立归 feature（1／6）。
物理分载体只为保留原实际 cascade 槽：App closure、base、styles、adaptive、
Browser、dialog-frame、metrics、ui、popup、workflow、dialog-surface、
surfaces、visual-system。没有新 layer、wrapper、token、尺寸、材质、颜色、
图形、动效或交互；Browser font12 仍在 coarse common16 之后，workspace
与 document.body 两种原 portal 仍保留。不是移到末尾覆盖旧规则。

根 actual Git `57e7d4ce` 34 份完整原源／九路径迁移正逆证明通过；隔离
全部 208 份旧 renderer，仅覆盖 R1 九路径，write:false 编译每边 208 资源。
完整 2,764 个 selector／context／有序声明 tuple 多重集合相等，未迁移
2,733 个规则的完整顺序相等。32 个源 recipe 在两边均有 31 个 compiled
存活者：Vite 原样消除前层 placeholder opacity.85，源 fallback 并未删。
八份 JS 仅生成的依赖资源文件名不同；不宣称整个 raw JS／CSS SHA 相同。

普通有限门禁与真实组件挂载 root proper `npm test` **4/4**，零跳过；
真实 BrowserHost／Bookmark modal、CreateDialog、ArtifactEditor、表格和
ComposerToolButtons 在 12 配置执行 178 阶段，含四强调色明暗、窄屏、
coarse、减少动态、高对比、200% CSS zoom 和 body fallback。显式旧／新
root **1/1**，356 阶段所有 computed paint／geometry／原生属性／动作、
请求 ledger 相等，178 图像对本轮 raw RGBA 完全相同。agent 最终同字节
独立轮为 174 对相同、四对 RGB 1-LSB 差异；有限原 paint comparator 全
通过，原结果并存，不挑选一轮冒充任意原生 compositor 的严格像素定理。
七个明确语法反例和真实 import／合法 feature refinement 正例均保留。

完整五份现行页面 spec 冻结旧／新各 **24/24**，原标题／预算不改，
每边 216 个实际入口资源响应及 208 emitted 原件核验通过。正常完整
build 已加载同一个原 Morphz 窗口，原对话、输入、裸彩图 Dock 及活动栏
可见。按真实截图坐标点左／右顶栏控件，各自收起再恢复，原生可拖动区
没有吞掉按钮；103 历史消息仍在、未发送草稿不变，未采集硬件或启动工作。
这不替代整体原生／硬件、所有页面原窗审美及最终默认全量验收。

原 styles 五条 product-bridge 一行格式是既有唯一 formatter 警告，完整
原字节已独立核对，不批量重排无关旧 CSS；其余八生产及三新测试格式通过。
证据：`/tmp/morphz-control-role-production.GCG8s3`、
`/tmp/morphz-controls-pages.SvVuOG`、
`/tmp/morphz-subject-schedules-root.udmSl9/r1-independent-frozen-*`、
`/tmp/morphz-original-ui-recovery.q72TCn`。Runtime／业务资料未重启或变更；
R4／R5、旧门禁治理及整体验收继续，目标 active。

## 2026-10-04 前端阶段 41：主体日程完整读取生命周期

`features/subject/useSubjectSchedules.ts` 唯一拥有原日程检查器的状态、
显式刷新、受限读取、取消及质量生命周期。借当前 render 的 Client
boot／online／refresh 和三方法 logical gateway，不新增 transport、订阅、
轮询、超时、cache 或任务控制。原 identity／attempt／online／connected
四依赖、navigation → captured refresh → list 顺序、50 条清单、至多 16
快照及四请求串行批次、错误原子拒绝和 abort guard 保留。renderer 只消费
七个只读事实及 refresh 动作；原图形、DOM、文案、CSS 和精确源跳转不变。

根独立核 actual Git `57e7d4ce` 的完整 8,520-byte SubjectSchedules 原件、
11 个完整 prelude 和两个来源动作；批准的正向迁移／整件逆证明通过。
普通 CI 用有限当前 owner／实际 import、gateway、直接消费和 source scope
门禁，不锁整个 App／Client／renderer，也不新增跨 owner inverse。20 个
明确语法反例和真实别名、独立 type／export／无关 JSX 正例通过。

根 proper `npm test` 新 controller／门禁及原 sidebar model **22/22**，
零失败或跳过；显式实际旧件对照 **8/8**，127 次完整 DOM／ARIA／焦点、
scope、错误、请求与生命周期观察逐项相等。受控 logical Desktop bridge
只用于隔离挂载，不冒充 HTTP ACL、物理 Runtime 或原生硬件证明。

完整三个现行页面 spec 的冻结旧／新版本各 **17/17**，原标题和预算不改，
每边 176 个实际入口 HTTP 资源响应及 208 份 emitted 资源核验通过。首轮
八红均为私有 Project fixture 静态根仍指 normal dist；业务断言已通过，
只校准私有静态资源根后重新跑完整两边，保留初始红日志，不改生产页面。
证据：`/tmp/morphz-subject-schedules-root.udmSl9`、
`/tmp/morphz-subject-schedules-controller.dFJ72T`、
`/tmp/morphz-subject-schedules-pages-final.vWVmxL`。

正常完整类型／Web／Service 构建通过。同一个原 Morphz 窗口只刷新 UI，
103 条历史消息、原输入、Dock 和右侧栏仍可见；实际打开定时任务并点击
刷新，按钮按原策略读取时禁用、完成后恢复，已有等待触发项仍在，再恢复
原活动页签。未发送消息、修改业务对象或重启 Runtime。原窗证据在
`/tmp/morphz-original-ui-recovery.q72TCn`；这不是整体原生／硬件验收，
也不是退出清理缺陷已修复。R1／R4／R5、旧门禁治理及整体验收继续，
目标保持 active；本批后新增代码的默认全量尚须收尾后重新执行。

## 2026-10-04 前端阶段 40：完整个人书签数据操作

`data/bookmark-interactions.ts` 拥有原完整 list／durable command family。
Client 在 reader 与 task owner 之间唯一同步构造，直接公开原两方法；借原
identity ref、logical call 和 saved-input scope。原能力／身份检查、8 秒读取、
schema、operation hash、完整稳定 pending command 和不同错误清理政策
不变。构造无 I/O；没有新 cache、effect、store、请求、refresh 或 LLM 调用。
Browser／Bookmark UI、图形、DOM、CSS、model、HTTP 与原领域权限不迁移。

根独立核 actual Git `2877c03d` 的完整 65,127-byte Client 原件及十个邻居，
两完整算法原字节迁入，全部 approved forward／inverse 恢复通过。208 份
当前 renderer 源仅 Client 和新 owner 改变。正常完整 build 的全部 208 份
当前 emitted 资源与独立候选相等，完整 CSS／preload 与旧版相同；主 JS
实现迁移后的字节不同。Vite 原配置刻意保留旧 content-addressed chunks，
支持原运行窗口的迟到 lazy import，未删除既有资源；不把包含历史 chunks
的整个 dist 目录人口当成这次 emitted 清单。

默认当前行为与真实 Client HTTP／私有 SQLite **12/12**；显式迁移对照
**12/12**，完整旧／新 observation 相等。包含 CRUD、非首项 URL、53 条
分页、冷重开、真提交后的丢回执／重挂载、完整稳定重试、两 Human 隔离、
撤权、真 409／400、本机清理失败及身份切换后的旧 200 被 408 拒收。
受控 gateway 的旧特征只在显式迁移执行，不冒充真实 Runtime／原生验收。

最终有限门禁加行为／Client 的 proper `npm test` **18/18**，无跳过；
31 个合法语法反例须命中指定规则，六种真实别名／独立增长正例仍可通过。
根审查发现早版把整个 protected-clear 锁住，合法其它 cache/state 清理
产生真红；收窄为 borrowed current 的同步、无条件 null，保留身份恢复／
早退／条件写／错 ref 反例，不锁其它 owner。原 clear raw 只归历史档案。
首轮全量恰读到门禁修正中间版本，该一项红日志保留；最终全量改为执行
前后完整源码快照核验，不把编辑中的测试版本当作终态。

最终默认全量选择 335 份测试、2,247 项：**2,238 通过、零失败／取消／
todo**；九项为明确未启用的 S3 三、Runtime 五、native-focus 一，无未知
跳过。PostgreSQL 必需并实际执行，不是环境缺失；1,054 份生产／测试／
支撑源执行前后相等，自有测试进程正常 exit 0。

完整四份现行页面回归旧／新各 **16/16**，每边核 76 个实际 HTTP 入口
资源响应，零跳过／重试；原旧入口的三红与首次校准一红另在独立测试修正
提交 `388b0f38` 记录，不改生产 UI 掩盖失败。类型、正常完整构建和七份
本次代码／测试格式检查通过。根证据
`/tmp/morphz-bookmark-interactions-root.SpANNk` 与
`/tmp/morphz-bookmark-pages-final.5yxlrA`；自有 Host 已关闭，发现 marker
恢复，未修改用户内容／输入或重启后台 Runtime。

本阶段不是原 App 整体原生／硬件验收，也不是退出清理根因修复。原窗口
已另行恢复并实际检查；剩余 R1／R3／R4／R5、有限治理与整体验收继续，
目标保持 active。

## 2026-10-04 独立校准：既有 workflow 页面回归

书签 data owner 的旧／新完整四 spec 对照首先均为 **13 通过、3 失败**。
三个相同红项来自 workflow 的旧入口／职责假设：附加文件现在是共享输入
菜单中的持久选项，焦点不应重开已关闭历史，阅读材质由 conversation 而非
未绘制的外层 frame 承载。没有以新 UI 行为覆盖旧回归，也没有修生产页面。

只校准 `workflow-ux.spec.ts` 的前三例：先沿真实添加菜单打开附件选择；
失焦、选中与取消仍检查原稿、禁用／恢复和附件，并新增同一输入 DOM 的
mount 见证；五次切页仍检查唯一共享触发器和持久附件选项；两种外观下
明确检查焦点不展开历史，再显式打开并核阅读层原材质、文字 opacity、
全历史与输入高度。后面三例完整原字节、原六标题与全部预算不变。

首次校准仍有 **15 通过、1 失败**：菜单关闭后，定位器的父 group 未包含
隐藏节点。保留该日志，仅给父 group 补同一 includeHidden 查询，未删除
选择期间禁用断言。最终完整四 spec 的旧／新各 **16/16**，无跳过或重试。
其它三份 spec、48 份 fixture、80 份支撑 helper 均核实际 Git 原字节，
每项核实际页面加载的冻结 HTML／主 JS／CSS／preload；原红与中间红仍保留。
自有 Host 已关闭，发现 marker 恢复，未操作用户资料或后台 Runtime。

根证据 `/tmp/morphz-bookmark-pages-final.5yxlrA`；原红证据
`/tmp/morphz-bookmark-interactions-root.SpANNk`，首次校准红项证据
`/tmp/morphz-bookmark-pages-contract.eiHcH5`。这是一项独立测试契约修正，
不等于整个前端目标完成或原 App 的 native picker／焦点验收。

## 2026-10-04 原 Morphz 窗口恢复：退出清理挂起

Human 再次反馈无法看到 UI。根检查原安装应用 `ai.morphz.desktop`：
PID 35371 自 10 月 3 日 20:44 启动，界面 renderer 已退出，主进程仍在。
本轮实际三秒 sample 显示主线程停在 Node FreeEnvironment → RunCleanup →
CleanupHandles → uv_run／kevent；不是 PostgreSQL 不存在、锁屏，或把界面
源文件缺失当原因。AX 请求超时、应用实例仍存，与无法重新打开窗口一致。
这证明退出清理挂起，不证明具体哪个 native handle 是根因；该 PID 启动后
才提交的修复也不能声称已经由它加载。

Human 明确批准先备份，再仅强制结束卡住的桌面进程。根用既有 Node SQLite
online backup 机制保存十一份当前中心库与一份 Runtime 库，逐份完整性检查；
同时保存原配置、附件／对象文件、工作目录及桌面存储。停止后 7,178 个桌面
文件逐字节复核。未删除／重置资料、切换 profile／中心、构建新包或终止
后台 Runtime；首次系统 SQLite CLI 的只读 WAL 打开失败保留，不把它说成
源数据缺失，后续 Node 只读 online 快照完整通过。

只结束批准的原 PID 35371，其原两个 helper 随父关闭；原安装应用正常重开为
PID 40290，同一 `morphz://app/`、中心与桌面目录。原阅读书库、两份既有读物
及原打开应用恢复，实际点击侧栏开关响应并恢复原隐藏偏好。保存真实原窗
截图和 AX，而非隔离测试截图。后台 Runtime PID 68670／18089 从前到后相同，
未重启／停止或重发用户输入。

原中心十一库的 163 表作只读完整比较：162 表一致，唯一变化是重开后更新的
`runtime_state` 运行状态投影；不把后台运行快照说成不可变。Schema 全部一致，
没有输入、对象、Session 或身份表差异。证据和私有备份位于
`/tmp/morphz-original-ui-recovery.q72TCn`。本条只确认原窗口恢复及实际开关响应，
不等于退出挂起根因已经修复、书签候选版已打包，或整个前端目标原 App
验收完成；退出机制只读调查及剩余重构继续。

## 2026-10-04 独立修复：Web 收藏的精确 URL 筛选

Human 明确批准另行修复、独立提交。真实 `HttpApplicationClient` 已发送 `url`，
但 HTTP GET `/api/bookmarks` 漏传给已有领域查询；两条收藏时，查询较旧 URL
可能返回另一条较新的记录。Desktop logical API 与 BrowserStore 原筛选正确。
服务端仅补传原 `url` 参数，继续使用既有校验、身份、查询和数据模型；
不改页面、UI／动效、Runtime、数据库 schema、权限或重试政策。

新增原 Host 测试中的真实 HTTP 对照：选列表非首项 URL，不依赖时间戳不相等；
完整结果与 logical API 深等，未知 URL 返回空列表，非法 URL 仍返回 400。
修复前 proper `npm test` 真红项及独立 HTTP／SQLite 复现保留，修复后五份
完整相关测试 **18/18**，零跳过，PostgreSQL 必需且实际执行。

完整原 `bookmarks.spec.ts` 三项 **3/3**、零重试／跳过；原断言和预算未改。
旧页面入口硬编码 Chrome 而本机已安装测试 Chromium，首次浏览器启动失败
原日志保留；私有运行配置直接解析并使用该已安装浏览器，没有安装浏览器、
改断言、注入样式或操作用户 App。其第三例原有模拟查询不作为真实 HTTP
筛选证据；真实筛选由上述 Host 回归验证。

最终默认 `npm test` 选择 332 份源、2,229 项，**2,220 通过、零失败／取消／
todo**；九项明确未启用（S3 三、Runtime 五、原生焦点一），无未知跳过，
PostgreSQL 实际执行。根完整构建、类型与本次新增代码格式检查通过；HTTP
原有无关格式问题保留，不在本项重排。全部 207 份 renderer
源及 208 份 emitted 资源保持阶段 39 候选原字节。自有测试 Host 已关闭，
私有页面运行的 discovery marker 恢复；没有修改用户资料、草稿、业务数据库、
日常 Runtime 或原 App。根证据 `/tmp/morphz-bookmark-http-url-root.aPgHaT`。
本项不是收藏数据 owner 重构，也不是整体前端目标或原 App 验收完成。

## 2026-10-04 前端阶段 39：完整剧本工作室生命周期

`features/script/useScriptStudioWorkspace.ts` 现拥有 ScriptStudio 原完整
工作室生命周期与语义动作。原 70 个前置语句、40 次 state／ref／effect／
读取注册及其顺序保留；renderer 在原首个注册位置调用一次无条件 hook，
直接消费 59 个只读事实、DOM attachment refs 和命令，不暴露内部 writer bag。
原 18 个完整箭头动作直接命名，22 个 JSX 入口及一个内嵌入口接线；
六个行级组合仍归 renderer，四个表单和真实子组件未改。

完整保存、选择、异步读取、目录偏好、显式历史／审阅、导出和原生交接归同一
feature owner；捕获 Client、scopedStorage、原 await／void／return、
flushSync、错误／取消／焦点及 60 秒 URL 回收政策保留。只增加静态类型
见证和所有权边界，没有新 state、effect、store、请求、权限、轮询或模型调用。
这不是对创作流程、素材授权或 Runtime 的另一次行为变更。

根独立核对 actual Git `13dbe571` 的完整 60,684-byte 原件：70 个完整
语句原字节、40 次注册、18 个完整动作、59 个返回成员、全部消费入口及
七个邻接 owner 保留，完整 forward／inverse 与历史组件原件还原通过。
207 份 renderer 源、208 份 emitted 资源冻结；正常完整构建与候选所有
产物一致。完整 CSS／preload 与旧版字节相同，主 JS 实现迁移后的字节不相同。

六份完整原剧本 spec 旧／新各 **27/27**，零重试／跳过；原断言、身份、
预算及支撑 helper 不变。每边核 164 个实际资源响应。其中 22 项加载
真实 App HTTP 入口，四项是原真实 Editor 挂载，一项是原隔离内嵌 Electron；
后两种不冒称加载了 App HTTP bundle。自有测试 Host 已关闭、discovery
恢复，未操作业务数据库、日常 Runtime 或用户 App。

完整真实 ScriptStudio、Library、Navigation、Editor、四表单、原 modal／
读取 hook 的当前 StrictMode 挂载 **13/13**，117 份完整观察；根独立显式
历史／当前挂载 **13/13**，123 对完整报告 deepEqual，包括自然 DOM ID／
ARIA、焦点／选区、表单、精确 command／callback／存储及资源清理。
受控 Client／native 端口不是真实 HTTP／SQL、OS 焦点或选择器验收。
首次红项是新测试的名称、原异步读取／焦点及未观察初始 mount 时机假设；
原失败日志保留。修正仅限新测试，不删除 ID／ARIA／焦点字段来绕过比较。

有限当前门禁 **6/6**，包含 27 个解析有效的负例与五种合法正例，约束真实
import 来源、完整原职责及实际消费，不固定整个未来组件／owner 哈希或逆迁移链。
根新增门禁与挂载 **19/19**、五份完整原相邻回归 **51/51**，均零跳过。
最终默认 `npm test` 选择 332 份源、2,229 项，**2,220 通过、零失败／取消／
todo**；九项明确未启用（S3 三、Runtime 五、原生焦点一），无未知跳过，
PostgreSQL 必需且实际执行。完整类型、格式与 diff 检查通过。

根证据 `/tmp/morphz-script-workspace-pages.jNuuaT`；完整原生产来源
`/tmp/morphz-script-workspace-production.PJOXWo`、有限门禁
`/tmp/morphz-script-workspace-boundary.IKr3Wh`、完整挂载
`/tmp/morphz-script-workspace-mounted.al8C2N`。公共控件、剩余数据／日程
边界、测试治理、全产品等价回归及原 App 验收继续；这一批不是整体完成。

## 2026-10-04 前端阶段 38：完整 Reader 数据操作与有限旧门禁

`data/reader-interactions.ts` 现拥有原文件导入、OCR 和持久阅读命令的完整
三套生命周期。Client 在原读取 owner 后直接登记一次，借用原 identity
ref、applicationCall 与 mutation confirmation，三个公开方法原样别名。
构造无 I/O／订阅；没有新 store、请求、模型调用、轮询或展示改动。

导入仍在内容目录确认后才清除稳定 command ID；两次摘要计算和文件读取
后的身份检查、35 秒信号及确认失败重试保留。OCR 借调用者 signal 和身份
代际，不新增超时。阅读命令仍为 12 秒，明确 4xx（408 除外）与不确定
失败的不同 pending 清理政策；不混入导入刷新或新的完成后 guard。
Reader 画布、分页、位置队列和 OCR 控件未改，不把 data owner 当页面 controller。

根独立复跑 actual Git `21cb34dc` 的完整 68,796-byte Client 来源、完整
三算法原字节及 owner／Client forward／inverse。六个邻接权威／消费方
原字节保留。206 份候选 renderer 源、208 份 emitted 资源冻结；正常
完整构建与候选入口／所有产物一致，完整 CSS／preload 与旧版字节相同，
不伪称实现迁移后的主 JS 字节未变。

四份完整原 Reader 页面 spec 旧／新各 **19/19**，零重试／跳过；断言、
身份和预算保留。每边核 168 个实际 HTTP HTML／入口资产响应，完整 SHA
正确。页面对照时核 71 份原 spec／fixture 及另 75 份支撑 helper；随后
仅四份旧架构门禁与其明确 helper 按下述有限治理调整，原页面 spec 与
Reader 支撑 helper 保持不变。自有 Host 已关闭，discovery 恢复；没有
用户 App、日常 Runtime、业务数据库或模型操作。

根原相邻测试加新有限门禁 **73/73**，新 family 当前 **19/19**，零跳过，
各组范围有重叠，不合并冒称独立覆盖总数。七组 owner 行为显式完整
旧／新对照 **7/7**，完整返回观察深等；五组实际 Client 通过真实独立
HTTP／SQLite 验证导入原字节、目录确认、稳定重试、CAS、私有数据及撤权。
服务端已提交但回执被延迟时切换 Human，旧 HTTP 回应按原 transport
抛精确 408，新的 snapshot 不发布旧结果；原 Human 重试同 ID，实际
回执／事件表仍一行。受控桌面 OCR bridge 的代际取消仍为 AbortError，
不借重构统一两个既有合同。原 OCR 控件挂载 **3/3**，不冒称硬件 OCR。

execution、local-input-delivery、task-interactions 与 script publication
四份旧门禁解除全文 Client hash／跨 owner inverse 链。完整旧算法、
历史 provenance 及所有原负例保留；原先隐含的 identity／approval 清理
由 fresh Git 完整有限 clear 和 refs 明确接手，真实消费／端口／确认
规则保留。独立 feature、类型／export、真实 import alias 正例通过，
不增加 Reader inverse，也不宣称任意 TS 绑定／权限已形式证明。

新增测试的六个类型错误、原真实端点 201／撤权隐私 404 的 fixture
假设错误及旧门禁首次 **9 通过／4 失败** 均保留 RED。修正只限对应
新测试／明确旧门禁责任，没有放宽端点断言、改生产行为或隐藏失败。
四份旧门禁最终 **18/18**、零跳过，另经只读独立复跑和完整原负例 AST
核对；原九 task 负例及各域原完整反例表／顺序保留。

最终冻结后的根默认 `npm test`：330 份源、2,210 项，**2,201 通过、
零失败／取消／todo**。九项是明确未启用的可选能力（S3 三项、Runtime
五项、原生焦点一项），无未知跳过；PostgreSQL 必需并实际执行。
根完整类型检查、十五份生产／测试 TS 文件格式和 diff 检查通过。
最终完整正常构建及候选全部编译产物／入口交接独立核对通过；
这批不替代原窗验收。

根证据 `/tmp/morphz-reader-interactions-root.YTiVro`；生产来源
`/tmp/morphz-reader-interactions-production.UuTrpQ`，新行为／真实 Client
`/tmp/morphz-reader-interactions.ym6f3r`，新有限门禁
`/tmp/morphz-reader-interactions-boundary.fXnLIY`，旧门禁治理
`/tmp/morphz-reader-legacy-governance.BhGpMD`。原 App 验收、ScriptStudio
完整工作室及其余架构边界继续；这批不是整体目标完成。

## 2026-10-04 前端阶段 37：完整事项执行面板控制器

`features/tasks/useTaskRunPanel.tsx` 现拥有 TaskRunPanel 的完整 scoped 观察、
处理结果读取、状态／资格、执行操作、检查器状态及主／次菜单 recipe。
单个无条件 hook 在原首个注册位置接线；原两 refs、六 states、两 observed
hooks 的顺序保留，非事项仍在全部注册后返回 null。公开十八个展示事实／
recipe 和五个语义动作；pending、writers、perform 及内部派生不暴露。

读取仍借原 `api.current` 最新 Client，动作和操作后的额外 refresh 仍捕获
原 render Client。原同步 pending、await／catch／finally、引用去重、六字段
scope、错误优先级和各用途资格不变；没有新 scope 重置、store、请求、
轮询、guard 或模型调用。`run!`／参数类型与 readonly 返回仅静态见证。

ArtifactEditor 详情独立观察、TaskList compact 消费原父层批量观察，未强并。
原 core／Client／data／observer 保持权威。renderer 原 props／默认值、
Human 回应、依赖导航、检查器组合及完整 DOM／CSS／图标／布局／动效保留。

根独立读并复跑 actual Git `d93326c0` 的完整 13,034-byte 原件证明：原
7,008-byte 算法逐字相等，五个 JSX 箭头仅直接命名／静态类型见证；完整
owner／renderer forward 与整件 inverse 通过，六个邻接权威／消费者未改。
候选 205 份 renderer 源、208 份 emitted 资源冻结；根正常完整构建与候选
全部产物／入口一致，完整 CSS／preload 原字节相同，不伪称主 JS 未变。

四份完整原页面测试旧／新各 **21/21**，零重试／跳过；实际身份、断言、
预算与原 fixtures 保留。每边核 140 个实际 HTTP HTML／入口资产响应，
全部 200 且 SHA 正确；69 份原 spec／fixture、另 73 份支撑 helper 与
actual Git 原文核对（两集合部分重叠，非 142 个独立来源）。自有 Host
进程已关闭、原 fixture 端口空闲及 discovery 恢复，未操作业务数据库／
用户 App／日常 Runtime。六份原相邻回归根 **42/42**，零跳过。

完整真实 TaskRunPanel 的普通当前 StrictMode 挂载 **12/12**；根独立
显式完整旧／新挂载 **13/13**，零跳过，每步完整 DOM／端口观察严格深等。
覆盖真实读取、主／次菜单、控制 payload、停止／撤回／暂停／恢复、同步
去重、刷新等待、错误、Client 捕获、Human latest dirty-tail、六 scope、
实际 popover／检查器／结果打开及卸载；旧晚动作特征仅显式迁移对照。
普通 CSS 动效未禁用，测试有限推进真实 timing；受控端口、虚拟重试时间
和 DOM 焦点不冒称 HTTP 权限、物理 Runtime、OS 命中或原 App 验收。
三轮 fixture／断言 RED 保留，仅修测试；没有用 React 错误清空 DOM
冒充合法非事项 null，也不以 StrictMode 单次读取假设修改生产。

根最终有限门禁 **9/9**，39 个指定可解析反例按精确规则拒绝，真实别名、
静态类型及独立 React／领域增量正例通过；从 actual Git 独立核 42 段
完整原语句与五个完整动作箭头。普通 CI 不锁完整组件／Client／App，
也不把有限 value alias 检查说成通用 TS 绑定／纯度证明。

最终冻结源后的根默认 `npm test`：327 份源、2,186 项，**2,177 通过、
零失败／取消／todo**。九项为明确未启用的可选能力（S3 三项、Runtime
五项、原生焦点一项），无未知跳过；PostgreSQL 为必需能力并实际执行。
根最终类型检查、六份所有权内 TS 文件格式、完整正常构建及编译交接核对
通过；原构建警告保留，不冒称原 App／原生硬件或整体目标已完成。

根证据 `/tmp/morphz-task-run-root.moRQvb`，生产证明
`/tmp/morphz-task-run-controller-production.0lzulR`，完整挂载与原件
`/tmp/morphz-task-run-mounted.NBQw2x`，有限门禁／RED
`/tmp/morphz-task-run-boundary.5e0g3P`。原 App 最终验收与其余边界继续。

## 2026-10-04 前端阶段 36：完整对话阅读视口生命周期

`features/exchange/useConversationViewport.ts` 现拥有原 scoped 阅读位置恢复、
跟随／返回最新、前插历史锚点、可见已读、引用定位／历史补读及焦点交接。
Conversation 在原 timeline 前登记 state，在原 read／content version 后登记
effects；原九 refs、三 states、四 layout／一 passive effect 的顺序及依赖保留。
两个 hook 用模块私有 Symbol 交接，不向 renderer 公开内部 writer bag。

App 仍拥有同一位置 Map 与工作面 key；消息／筛选／回执计算、取消及整个展示树
仍归 Conversation。数据／历史 owner 仍负责实际范围、授权、分页与发布；借用
原 render Client 和原 setter，不克隆成 store，不新增查询、订阅、轮询或模型请求。
原 ExchangePosition type re-export 保留，原 CSS、图标、DOM、布局及动效未改。

根从 actual Git `29863c3f` 核完整原组件 49,917 bytes 和 25 段固定原 recipe，
两份生产源完整 forward／inverse 证明通过。其余 202 份 renderer 原源完整
字节不变；候选 204 份源与每边 208 份 emitted 资源均在页面期间冻结。
正常完整 build 与候选产物一致，完整 CSS／preload 原字节相同；主 JS 因真实
controller 迁移变化，不冒称其原始 SHA 相同。

五份完整原 spec 共 23 项，旧／新各 **23/23、零重试／跳过**；逐项身份、标题及
原断言／预算保留。每边核 152 个实际 HTTP HTML／三入口资源响应，全部 200
且完整 SHA 正确。五 spec、63 历史 fixture 及原支撑源未改；没有 Origin／Host／
body／权限映射或 fake fetch。自有 Host 已退出、原端口空闲、discovery marker
恢复；用户原 App、日常 Runtime、业务 PostgreSQL 与用户数据未操作。

当前完整 StrictMode Conversation 挂载 **8/8**；根显式 actual Git 完整旧组件
与当前对照 **17/17**，均零跳过，观察记录严格深等。实测同 Map／DOM、阅读／
前插 BCR、真实 Range、焦点交接、异步历史、失败、marker 与卸载 cleanup。
visibility／hasFocus 和 ResizeObserver 明确受控，不冒称 OS foreground；marker
到期实测不单独证明计时下界，原 2200ms 参数由固定源和门禁另证。同 ID 流式
由原页面覆盖，局部 prop scope 切换不冒称完整 App 导航或原窗验收。

旧 read-receipts 门禁仅将三条 visibility／focus／modal 守门移交到直接消费的
controller，并增加真实接缝检查；根逆回得到完整旧测试字节，其余断言不变。
五份相邻 Node 回归 **59/59、零跳过**。永久门禁只约束真实 import／借用端口、
注册阶段、完整原阅读算法和直接 DOM 消费，不锁完整当前组件／App／Client。
独立复核发现保留正确 unused import 后替换实际函数、重赋借用对象及假 setter
的五处门禁漏检；原 RED 保留。现按真正被调用的 value symbol／module、原
Map／Client 参数未重赋及真实 React setter 窄修；根最终有限门禁 **10/10**，
44 个指定可解析反例和合法独立 feature／React／utility／setter aliases 均通过。
不是全文件禁用同名 export／赋值或任意 TS 绑定安全证明；未变原 25 段旧源。

最终冻结门禁后的根默认 `npm test`：325 份源、2,165 项，**2,156 通过、
零失败／取消／todo**。九项为明确未启用的可选能力（S3 三项、Runtime
五项、原生焦点一项），无未知跳过；PostgreSQL 为必需能力并实际执行。
修复前的首次全量结果单独保留，不代替这轮最终证据。根独立类型检查、
七份所有权内 TS 文件格式、完整正常构建及编译产物交接校验通过；原构建
警告保留，不冒称原 App／原生硬件验收。

根证据在 `/tmp/morphz-conversation-viewport-root.2l9yAK`，生产来源与完整迁移
证明在 `/tmp/morphz-conversation-viewport-production.hB0U2H`，有限门禁／RED 在
`/tmp/morphz-conversation-viewport-boundary.fbAYsB`，完整挂载／独立旧源在
`/tmp/morphz-conversation-viewport-mounted.AEXqTD`。整体迁移仍未完成；完整
Task feature、其余数据／presentation／role 与历史门禁治理及原 App 验收继续。

## 2026-10-04 前端阶段 35：完整原生弹窗 frame／字段控件职责

公共 frame／字段控件现归 `ui/dialog-frame.css`，main 在 styles 与 ui
之间唯一导入。三份原 CSS 的 30 条规则／107 项有序声明完整迁移，
包括 27 条公共 recipe 和三条必要 cascade 邻居。原 fallback 与最终
几何、header／title／footer、文档草稿共享顶栏、字段／控件／焦点、
窄屏与粗指针保留；Library／Install 顶底栏、Connection 居中宽度
保留原顺序。Search、领域宽度、primitive、材质、token、DOM、
`useModal` 和动效不混迁，没有新状态、请求、LLM 或视觉数值。

根从实际 Git `c525d217` 核完整原源码、批准逆展开和 30 条固定 tuple；
205 份 renderer 原源中 201 份整字节不变，另四份仅批准 CSS 删除／
唯一入口增量，新 owner 单列。实际编译的 30 条原 recipe 保持顺序；
其余 2735 条完整上下文／有序声明在一处确切等值宽度 token 的压缩器
合并展开后完全相同。不是任意 selector／cascade 等价定理。

独立新旧编译资源图共 13 份：四份 JS 仅实际依赖文件名重链接，
精确有限引用映射后全文相同；preload 和其余非 CSS 资源整字节相同，
HTML 仅实际入口引用变化。不能将原始四份 JS SHA 称为相同；CSS
差异由上述完整编译 recipe 另证，不能通过 hash 归一吞掉。

长期有限门禁九组检查公共 role、两个明确邻居 writer 和实际 runtime
入口；不锁完整 renderer 或 118 条领域库存。合法独立 feature CSS、
primitive、注释、type import 与无关 JSX 可演进。旧 surface 门禁的
两份完整几何和原反例按实际 owner 交接，原材质／token／入口／截图
守门均保留。根独立逆回四个批准测试接缝，得到完整原测试字节；
旧历史 fixture 未改。新门禁、旧 surface、popup 与交流门禁合计
27/27、零跳过；原解析／reset shorthand 和复合根漏检 RED 均保留。

当前完整 React 挂载与显式历史 CSS 比较各 9/9、零跳过，实挂
16 个原生节点（15 个 create）和两个非模态负例，实际字段库存、
模态焦点／选择恢复、失败保留草稿、长内容滚动、workspace resize、
粗指针与 reduced-motion 均验证。四强调色×明暗、窄窗与 CSS zoom
矩阵不是所有消费者的笛卡尔积，更不等于 OS／原 App 验收。单列
dormant Library footer 探针不是第十七个产品消费方。当前默认测试
不读 Git／临时目录；严格旧新对照仅显式迁移开关启用。

十四份完整原页面共 93 项，冻结旧版／新版各 **87 通过、6 失败、
零跳过／重试**。原身份、标题、逐项结果和六项完整规范化失败指纹
一致，没有新差异；不能写成 93 项全绿。原 iframe 接续、剧本目录焦点、
窄窗密钥按钮、旧分类预期和两项已撤下独立转写入口的失败保留，后续
未到达的断言也不冒领通过。106 份原 spec／历史夹具完整字节不变。
每边 92 个 HTTP 场景核 592 条实际 HTML／入口资源响应，全部 200
且完整 SHA 正确；一个隔离 Electron 场景只核 normal build 文件，
不宣称其有 HTTP 资产证据或等于用户原窗口。

原端口自有 Host 的 PID／父子关系和退出均核验；候选 wrapper 退出后
由 bounded manager 确认已结束的自有资源并恢复原 discovery marker。
旧版首次 marker 未恢复的 RED 与根随后明确验证的恢复仍单列保留，
不追写为正常 cleanup。错误中心名、候选资源名假设、重复 HTML 写入
与漏传 lane 的准备 RED 都未计为有效 93 项，不因观察超时重启测试。
没有改原 Origin／Host／URL／body、权限、spec 断言或预算，也无 fetch／
dispatcher 映射。用户原 App、业务 PostgreSQL 与日常 Runtime 未改。

最终冻结代码的默认无参数 `npm test` 实际选择 **323** 份测试源：
**2147 项，2138 通过、零失败／取消**，另有 **9** 项确切专项未启用
（S3 三项、Runtime 五项、原生焦点一项），无未知跳过；PostgreSQL
始终必需，原 151 项分支实际执行。完整 build（含全类型检查）、
本批格式与差异检查通过；styles 原 product-bridge 格式差异逐字与
实际旧源相同，未混入全文件格式化，原分包大小警告保留。

根证据在 `/tmp/morphz-dialog-frame-root.fDaXC6`：默认全量、27 项有限
门禁、9 项严格旧新挂载、最终 build 和源／编译／资产／原页面 proof
各有独立日志。生产源及完整 tuple 证据在
`/tmp/morphz-dialog-frame-owner.rd2g1A`，有限门禁与旧测试交接在
`/tmp/morphz-dialog-frame-boundary.wzMWA9`，挂载／实际 Git 来源在
`/tmp/morphz-dialog-frame-mounted.xAAWCU`，完整 93 项旧新审计在
`/tmp/morphz-dialog-frame-page-audit.FjN8is/RESULT.md`。本批按十二条
明确路径提交，不额外推送。整体目标保持 active；剩余完整 feature、
数据／presentation／role 与历史门禁治理和原 App 验收仍须继续。

## 2026-10-04 前端阶段 34：完整 Thread collection 展示职责

`execution-activity.ts` 承接原输入关联分支与范围概览两种完整投影，
真实 `Conversation` 与 `ExecutionSidebar` 直接消费。输入按原身份、
执行 kind／open、online 短路与 running／unknown／paused 优先级处理；
范围概览沿原授权范围、实际父子关系和日期分组，以活动根而非 Thread
数计数。范围计数文案在原 `threadSummary` 后单独消费，保持原两阶段
属性读取顺序。不可用／截断零计数不宣称空闲，截断正计数仍称“至少”。

本批只改三份生产源的完整算法及直接消费接缝，无新 JSX、CSS、图形、
动效、hook、store、查询、Client／Runtime 协议或模型调用。两种用途
各自的政策不强并；列表选择、精确补充、停止与原详情控制不移交。

根独立从实际 Git `a1acc677` 复核十三条完整原声明、原 owner 算法和
三份完整源的批准逆展开；其余 **202** 份 renderer 源完整字节不变，
全部 **205** 份 renderer 与单列 Vite 配置在旧新 build／页面期间冻结。
完整原 CSS 与 preload 字节相同。这个一次性历史证明不成为普通 CI
锁住整份 renderer／App／Client 的长期 hash 或跨 owner inverse 链。

四份完整原页面 spec 的 **11** 项，冻结旧版／新版各 **11/11**，
无 retry／skip；每边核 **44** 份实际 HTTP HTML／三入口资产。七份
spec／fixture 保持实际 Git 原字节，原 URL／Host／Origin／body 和
同源权限检查未改，无 fetch／dispatcher 映射。最初随机端口却保留原
Origin 导致 baseline 十一项 403 的 RED 保留；最后使用确认为空闲的
原 fixture 端口和两份隔离中心复跑，两个自有 Host 均已退出并释放端口。

根通过默认 `npm test` 复跑八份未改相邻 Node 回归：**46/46、零跳过**。
最终有限消费门禁 **12/12、零跳过**，覆盖完整算法、真实 core 类型
来源与符号、直接消费、读取阶段和下游事实绑定。五十二个指定可解析
反例保留原算法／hash；合法无关 JSX／CSS／type import／pure 增量、
真实 value／type import aliases、名为 process 的局部纯数据参数及
process／globalThis 局部 readonly 数组的普通 map 投影通过。
检查器初稿把属性名当局部变量、误拒合法同名参数与数组调用的 RED 已保留并修正；
这不是任意 JS 纯度或通用 AST 安全证明，不锁整份当前 renderer。

当前行为与显式
`MORPHZ_TEST_THREAD_COLLECTION_MIGRATION_EQUIVALENCE=1` 各 **12/12、零跳过**。
其中为九个纯算法／来源／读取顺序测试、一组完整 StrictMode 浏览器挂载
及其两个真实 SSR 子组，不是十二个独立浏览器场景。完整 Conversation
的无输入 Reply 对 online getter 短路、真实 Sidebar 根计数、当前／全部
切换、同 ID 节点及外部焦点、缓存未知／截断零计数、Enter 精确范围、
真实补充 generation、停止 revision 和过期进度退休均实际断言；原 stream／
snapshot 端口调用走受控夹具，未产生业务 API 或模型请求。

测试初稿的显式 undefined 默认值、排序、getter spread 和缺 Client 端口
问题，以及把具名 Thread 误指向同一输入导致 running 正确胜 paused 的
RED 全部保留。最终夹具使用真实第二输入来源，不向生产增加 scope
过滤或削掉暂停断言。独立实际 Git 证明固定十三段 raw 与三份完整旧
recipe；普通 CI 不调用 Git／读取临时目录，严格旧算法比较仅由显式开关启用。

最终冻结代码的完整 build（含全类型检查）、格式与差异检查均通过，
原分包大小警告保留。默认全量实际选择 **321** 份测试源：**2126** 项，
**2117** 通过、零失败／取消，另有 **9** 项确切未启用专项（S3 三项、
Runtime 五项、原生焦点一项），无意外跳过；PostgreSQL 为必需能力，
原漏跑的 151 项实际执行。前两轮全量在最后两次门禁窄修复前冻结，
日志另存，不冒充最终门禁源码验收。原 App、真实 Runtime 执行、权限／
事务、硬件与原生焦点并不由这批隔离展示测试证明。

已核证据：`/tmp/morphz-thread-collection-root.SEeZWk` 的
`root-original-eight.log`、`root-finite-final.log`、`root-default-full.log`、
`root-build-final.log` 与最终 `root-proof.json`；独立三源／实际 Git 原声明证明在
`/tmp/morphz-thread-collection-production.jDxECn`；完整页面、
HTTP／源码／生命周期 audit 在 `/tmp/morphz-thread-collection-matrix.s9sL06`。
有限门禁／RED 在 `/tmp/morphz-thread-collection-boundary.dHAXqi`，
行为／旧算法独立证明／夹具 RED 在 `/tmp/morphz-thread-collection-behavior.XCCzO8`。
本批按上述冻结源码与八条明确路径做 focused local commit，不额外推送。
整体前端目标保持 active；其余 role／样式所有权、查询治理及原 App
最终验收尚未完成，不能以本阶段测试替代。

## 2026-10-04 测试入口：默认 PostgreSQL 与精确覆盖门禁

之前全量报告中的 160 项跳过并不表示本机没有 PostgreSQL：逐项源码
复核确认，151 项是测试调用漏传连接，另有 S3 三项、Runtime 五项和
原生焦点一项未启用。本机已有 PostgreSQL 服务仍在运行，没有停止、
替换或写入用户业务数据库。

`npm test` 现在直接消费 `scripts/run-tests.mjs`。未提供测试 URL 时，
入口用已有工具准备随机 loopback 端口、0700 临时目录、专用 role／库，
核对服务目录与角色后才建立测试库，并实际执行 SQL 验证。显式测试 URL
保留并先执行连接验证；准备器不替换、写入或关闭那个已有服务。缺工具、
空配置和连接失败必须报错，不降级为 SQLite-only，不猜测 5432 的用户库。
测试子进程禁用项目 `.env`；成功、失败和中断只清理本轮自有资源。
POSIX 进程组先结束再关闭自建 PostgreSQL，无法确认结束时保留资源并报错。

覆盖 reporter 消费完整 Node 事件流，输出选择范围、实际计数以及每项
未启用的专项。PostgreSQL 始终必需；未知跳过、已准备或声明必需的能力
仍跳过，均使测试失败。例外限定确切文件／用例／条件，不采用标题正则
或允许跳过数量。CI 准备 PostgreSQL 与浏览器，云存储通道明确要求
`postgres,s3`，Runtime 通道为原四文件启用四个开关并要求
`postgres,runtime`，不再用整个跨平台套件“零跳过”的错误总量判定。
这些是 CI 源改动，本轮没有推送或远端 CI 运行证据。

根独立普通 `npm test` 未手动传数据库 URL：**2102 项，2093 通过，
零失败／取消，9 项明确专项未启用**。原 151 项 PostgreSQL 分支实际执行，
没有数据库跳过或未知跳过。相同默认入口的机制回归 **34/34、零跳过**，
覆盖真实 SQL、显式 URL 不变、准备失败、子测试失败、未知跳过、SIGINT／
SIGTERM 下抗 TERM worker 的实际 PID 退出与临时目录清理。真实 Node
默认 reporter 入口、package 的真实默认命令也有回归，不能只有未消费 helper。
准备脚本继承 Node 内部 worker 标记导致空跑、普通函数 reporter 被 Node
误识别的两轮真实 RED 均保留并已修复，不只凭纯 helper 测试宣称入口可用。

另以必需 Runtime 能力运行四份原文件：**12/12、零跳过**，五项 opt-in
真实 Rust 合同已执行；模型只用本机合成 provider，不连接用户 Runtime
或付费模型。完整 build／类型及本批源格式检查通过。S3 三项与原生焦点
一项仍未在本轮执行；Windows 子进程清理、启动过程的中断和远端 CI
不冒充已全面验收。本批不改变 UI，也不代表整个前端重构或原 App 验收完成。

根日志：`/tmp/morphz-test-entry-root.RDJpqm` 的
`root-default-full.log`、`root-mechanism-final.log`、
`root-runtime-required.log`、build／类型检查；机制与初轮 RED 证据在
`/tmp/morphz-test-postgres-entry.lFMQkS`，独立能力门禁／实际 reporter
回归及只读审查在 `/tmp/morphz-execution-inspection-validation.BJRLLZ`。

后续独立审计发现例外按 basename 识别会让另一位置的同名文件借用
允许跳过条目，实际反例复现后以 `777f1d73` 修正为本 checkout 的完整
规范化路径、精确标题和选择范围。原十四个条件条目未放宽；nested／
其他 workspace／逃逸路径不能借用。新增合同在旧实现 18 通过／5 失败，
修复后根经默认入口独立复跑三份机制源 **37/37、零跳过**，原真实 SQL、
失败与信号清理断言仍在。根日志在阶段 35 的
`root-capability-path-focused.log`，独立审计在
`/tmp/morphz-test-runner-audit.FDkDwo/default-entry-current-777f1d73.md`。
直接 Node 与独立 `test:*` 专项仍不是这个完整入口；不能以其绿色或
专项跳过宣称全量能力已验收。没有新增推送或远端 CI 运行证据。

## 2026-10-04 前端阶段 33：执行详情完整 feature 生命周期

`features/execution/useExecutionInspection.ts` 接收原 Client、scope、
dialog ref 和 embedded 四个借用值，拥有原状态、最新 API ref、scope
投影、完整读取观察、模态注册、scope 退休、控制／结果读取和成果链接
投影。`ExecutionDialog` 在原位置直接消费六个事实与三个动作；原第一个
dialog ref、完整 DOM、keys、Job／Thread 展示、审批控制与打开／关闭
动作仍留在 renderer。原三条真实消费路径不改。不是新 broker、store、
审批 ledger、查询／Runtime 协议或 UI 模型调用。

根独立实际 Git `114960d1` 证明两份生产源的完整正向迁移／逆向恢复；
固定旧档案的原组件、十五条完整生命周期语句及四份借用 helper 原字节
另行核对。静态展开后的 **17** 个 primitive 注册顺序／依赖与原源相同，
不冒充运行时 hook 计数。可执行完整旧 Dialog、完整旧 controller recipe
及九份源码来源、十二个原片段从实际 Git 独立捕获，不用新版当旧版 oracle。
全部 **200** 份其余 renderer source 完整字节相等，**202** 份 renderer
source 在 build／挂载期间冻结，完整原 CSS 和 preload 字节不改；正常
完整 build 的三入口资产与实际加载的冻结新版资产一致。

六份完整原执行页面的 **19** 项与完整原事项 spec 中两个精确原生 dialog
场景，冻结旧版／新版各 **21/21**，无 retry／skip。每边核对 **69** 份
实际 HTTP 入口资产；七份完整 spec、三份私有 fixture 均保持实际 Git
原字节，无旧入口校准。覆盖读取顺序、原动效、审批、父子 Thread、事项
事件观察、注解、真实来源和完整结果。不是原 App 窗口验收。

根独立八份相邻原回归 **54/54**；新有限门禁 **16/16**，原四十个
指定可解析负例保留，并补充七个实际符号／环境初始化／同步声明负例。
真实 React helper import alias、纯增量、无关 JSX／CSS／注释合法；
不增加当前 App／Client／完整 renderer hash 或跨 owner inverse 链。
测试草案漏检借用值、环境初始化和 async／generator，并误拒 helper alias
的 RED 独立复核后修正；生产、旧档案和行为测试字节未改变。

默认当前契约与显式
`MORPHZ_TEST_EXECUTION_INSPECTION_MIGRATION_EQUIVALENCE=1` 各 **12/12**，
无 skip；每轮为三个 Node 测试、八个实质挂载组及一个父测试，不是十二个
独立浏览器场景。实际 React StrictMode、原观察器和原生 HTML dialog 验证
layout 在 passive read 前、held invalidation／abort／dirty-tail、健康空闲
零轮询、失败退避／恢复、最新 Client 与捕获 scope、退休／迟到／卸载、
完整 control finally 不等待刷新、结果读取不刷新、当前 render 的成果链接、
稳定 keyed details／焦点／选择／resize 和同 key 离线控制语义。
原 ABA／单 busy 并发与离线 Job-stop 特征仅作显式迁移比较，不写成长期
必须保留的缺陷。受控端口不等于真实 ACL／事务／Runtime／原生 macOS。
回调事件筛选、测试 getter 类型及档案 import 定位准备错误的 RED 均保留，
没有为测试改生产行为或削掉旧动作断言。

初轮全量 Node **2067 项：1904 通过、160 能力跳过、3 失败**，三个
失败均为既有 Thread 图形门禁把完整详情 hook 摘要锁在 renderer，及
退休负例仍定位旧源。当前图形事实／heading／span 树的原摘要不变，
生命周期由真正的 inspection owner 检查；完整原 hook 摘要另作固定历史
证明，原 `[observationScope]` 退休负例由实际 owner 的指定规则承接。
没有把失败略过或更新为新版摘要。独立复核后的图形／生命周期联合门禁
**20/20**；根最终全量 Node **2068 项：1908 通过、160 能力跳过、
零失败／取消**，完整初轮 RED 保留。

根最终完整 build／类型及八条源路径格式、完整差异检查通过；本批生产与
自动验证完成，做 focused local commit，不代表原 App 验收。整体目标仍 active；
Thread collection 展示、其余 role／样式归属、查询合同与旧门禁治理、
跨页综合及原 App 原生验收仍未完成。原 App 仍卡退出清理；强制退出
待用户确认，不重置 profile／中心、不重启 Runtime。本批未额外推送。

根证据：`/tmp/morphz-execution-inspection-root.MmOF6j` 的 manifest、
旧新原页面／HTTP audit、完整源逆证明、固定档案证明、相邻／finite、
mounted 两模式、最终 build／Node／format 与 source freeze；初轮失败
保留在 `root-node-final.log`，最终全量为 `root-node-after-glyph-repair.log`，
八条验证源和正常 build 冻结证明为 `root-final-stage-proof.json`。
生产、门禁、行为证据分别在
`/tmp/morphz-execution-inspection-production.VPMBkj`、
`/tmp/morphz-execution-inspection-boundary.0TUdV4` 和
`/tmp/morphz-execution-inspection-validation.BJRLLZ`。

## 2026-10-04 前端阶段 32：完整工具步骤的只读展示责任

既有 `execution-presentation.ts` 新增两个纯入口：实时工具消息的
`liveToolPresentation`，以及持久 Job 快照的
`executionSnapshotJobPresentation`。原 JSON parse／catch、十二实时
状态、title／detail fallback，及停止请求只覆盖三种活动状态的规则
完整迁入；原四导出算法与返回形状逐字保留。`Conversation.ToolMessage`
和 `ExecutionDialog` 的真实 Job 行直接消费各自入口。实时生成参数不
等于完成，实时审批／unknown 与快照审批／lost 不强并。typed 注解仍
限定确切 Job，结果 prose 仍要求真实 `result_event_id`，不解析原参数
或邻近步骤冒充注解。没有 JSX、IO、额外 state／effect／请求或模型调用。
原 DOM、图标、CSS、keys、原始技术信息、结果与审批控制不改。

根独立实际 Git `08215636` 证明：三份完整生产源只通过批准的
import／完整算法／展示绑定接缝正向迁移与逆向恢复，原四算法 raw
相等。固定旧档案的 **18** 个原片段、词表和 **10** 份完整源码来源
重新读取 Git 核对；可执行完整旧 PURE／ToolMessage／ExecutionDialog
仅重定位 import 或改导出名即可逐字恢复，两个有限旧 adapter 也与
原完整表达式相等。**198** 份其余 renderer source 完整字节不变。
全部 **201** 份 renderer source 和八条生产／新测试路径在根最终
build 与挂载期间保持冻结；实际正常 build 的三入口资产与冻结新版
页面加载的资产 SHA 一致，完整原 CSS 和 preload 字节相等。

六份完整原页面在冻结旧版／新版各 **19/19**，无 retry／skip；
每边核对 **57** 份实际 HTTP 入口资产，完整 spec 与两份私有 fixture
均保持实际 Git 原字节，无旧入口校准。覆盖真实活动详情、原动效、
审批、父子 Thread、事项事件观察、注解和可核对的完整结果。
根独立纯算法与七份原相邻回归 **42/42**，明确使用已有浏览器能力；
有限门禁 **10/10**，含 **34** 个可解析指定规则负例及合法无关
JSX／CSS／注释／type import／pure export／直接 alias 正例。
普通 CI 不锁相邻整文件，未增加跨 owner inverse 或旧门禁适配。

根独立真实 SSR／React StrictMode 挂载：默认当前契约与显式
`MORPHZ_TEST_JOB_PRESENTATION_MIGRATION_EQUIVALENCE=1` 各 **14/14**，
无 skip；每轮为七个纯测试、六个实质 SSR／浏览器组及一个父测试，
不是十四个独立浏览器场景。完整旧新 DOM、动作、原详情节点／展开／
焦点、Job 更新、读取错误、scope／CSRF 退休、迟到结果与控制反馈、
卸载和原生 HTML dialog 焦点一致。实际 styles／动画未关闭，但本批
不声称 geometry／逐帧 pixel 或原 App 验收；Client 是受控端口，不
冒称真实权限、事务或 Runtime 执行。SSR React runtime、测试 JSON／
词表和门禁括号识别等准备错误的 RED 保留，均未改生产或旧断言。
另实际观察到旧字典的 `toString` 原型键会返回函数，两版本相同；
此次未混入修复，也未把该旧缺陷写成普通 CI 必须保留的契约。

根最终完整 build／类型、八条源路径格式与差异检查通过；全量 Node
**2039 项：1879 通过、160 能力跳过、零失败／取消**。本批生产与
自动验证完成，整体目标仍 active，没有额外推送。详情的完整读取／
控制 feature controller 仅有下一批方案，尚未实施；其余领域展示、
控件／样式、历史门禁治理、全产品与原 App 验收仍未完成。
原 App 仍卡退出清理，强制退出待用户确认，不重置 profile／中心或
重启 Runtime。

根证据：`/tmp/morphz-job-presentation-root.rsUJ0Z` 的 manifest、
旧新完整页面／HTTP audit、原源逆证明、固定可执行旧源码证明、
focused／boundary、mounted 两模式、最终 build／Node／format 与
`root-final-source-build-proof.json`。生产、门禁、挂载证据分别在
`/tmp/morphz-job-presentation-production.IyZHIi`、
`/tmp/morphz-job-presentation-boundary.Y22TtL` 和
`/tmp/morphz-job-presentation-validation.8Ggug2`；均保留初轮 RED。

## 2026-10-04 前端阶段 31：非模态浮层表面的唯一样式责任

`ui/popup-surface.css` 现承接原五份 CSS 中七条表面规则的 **28** 项
声明，保留完整原值、权重、声明顺序和 fallback，不只复制最后获胜值。
真实入口在 `ui.css` 后唯一导入；原 workflow／dialog／visual 相对顺序
不变。Launcher 的强选择器仍为 20px，普通 app 菜单仍为 10px，非 app
主题 fallback 仍为 12px，选文工具栏仍为 8px。选文是 body portal，
其裸选择器未收窄到 `.app`。这些是原值迁移，不是新审美规范。
原 `ComposerOptions` 的 25 个静态 JSX 消费点分布于 18 个模块，
并不代表同时挂载 25 个菜单。原组件、DOM、状态、焦点、尺寸、子项
hover、动画、token 与辅助模式仍归各自 owner，不新增包装或请求。

根独立实际 Git `9708abbd` 证明：五个完整 CSS 仅逆回批准删除项，
main 仅撤回唯一 import 后均逐字恢复原文件；新 owner 精确等于原七条
tuple。**194** 份其余 renderer source 完整 Git 字节未变。实际旧新
编译 CSS 中，选定表面的属性值及同属性序列保持，选文 border →
border-color 顺序保持，其余 **2752** 条编译规则的上下文、选择器和
有序声明相等。相邻两条选文规则被原编译器合并为六条；不将这一有限
证明称为任意 CSS cascade 定理。根最终 build 的三份实际入口资产
与冻结新版页面测试加载的资产 SHA 完全一致。

十份完整相关页面在冻结原版／新版各 **52/52**，无 retry／skip；
每边核对 **231** 份实际 HTTP 入口资产，完整 spec 与私有 fixture
源码相同。原独立 Dock 组件回归另为 **27/27**，不混入完整 App
资产审计。三个旧 spec 只校准已撤菜单入口、工作台恢复 Browser 时的
返回路径，以及无通知场景的明确前置范围，保留原材质、焦点、空间、
选文、来源和草稿断言；完整 source inverse 与原测试／断言预算核对
通过，已独立提交 `34631d98`。初轮重复资产探针、私有服务静态目录、
共享中心通知与 guest fallback 前提错误的 RED 保留，不冒称生产缺陷。

新增八项有限 CSS／真实入口门禁及十项旧样式回归通过；加九项引用
纯回归的根组合为 **27/27**。新规则具有 53 个可解析负例，并允许
无关 module、feature、子控件合法演进。固定迁移 provenance 与当前
职责约束分开：相邻整文件旧源检查只在独立迁移证明执行，不锁普通 CI。
原阶段 30 相邻旧源误锁也已单独修正并提交 `739656bf`，原算法与安全
反例不删。这只是部分测试治理收口，旧跨 owner inverse 链仍待继续。

根独立真实 React 挂载：普通 current-only 与显式
`MORPHZ_TEST_POPUP_MIGRATION_EQUIVALENCE=1` 各 **10/10**，无 skip；
八场景组覆盖原 native popover、Appearance／Profile／Scope、实际
Launcher、SelectionActions／Provider body portal、关闭／焦点／命中、
引用版本、卸载清理及非 app／复合 fallback。四色×明暗×宽窄×CSS
zoom 1／2 共 **32** 有效组合、三种真实表面共 **96** 次捕获；完整
DOM、材料、0.01px 几何和动作结果旧新精确相等。普通动效未关闭，
先捕获真实子项 `menu-content-reveal` 的 180ms timing／keyframes，
再等待有限动画结束。有效 media、native datasets、guest fallback 与
触摸单独验证，不当作原生系统辅助偏好或 guest 合成器验收。

根最终完整 build／类型、指定十条路径格式与差异检查通过。原
`styles.css` 的既有 product-bridge 格式警告未借此整文件重排，原段
完整字节已对照。全量 Node **2015 项：1855 通过、160 能力跳过、
零失败／取消**；新增挂载显式使用已有 headless Chromium。受控回调
不冒称真实 Launcher 事务、HTTP ACL、逐帧像素、OS zoom 或原 App。

本批生产与自动验证已完成；整体目标保持 active，没有额外推送。
原 App 仍卡退出清理，强制退出待用户确认，不重置 profile／中心或
重启 Runtime。其余完整查询生命周期、五领域展示、控件／样式责任、
长期门禁治理、全产品与原窗验收仍未完成。

根证据：`/tmp/morphz-popup-surface-root.R9WKkQ` 的 manifest、完整旧新
页面／HTTP audit、page-equivalence、source／compiled／boundary proofs、
calibration inverse、独立 Dock、focused、mounted 两模式、最终 build／
Node／format，以及 `root-final-source-build-mounted-proof.json`。
生产证明在 `/tmp/morphz-popup-surface-production.KMurRw`，门禁在
`/tmp/morphz-popup-surface-boundary.H8qk8y`，挂载及独立 actual Git
runtime-only CSS 顺序重算在 `/tmp/morphz-popup-surface-mounted.aEdW2o`。
旧 26 CSS 的完整字节与顺序分别核对，新顺序仅新增唯一 popup slot。

## 2026-10-04 前端阶段 30：完整搜索／选文／评论准备与 reveal 生命周期

现有 `host/exchange-reference-commands.ts` 持有原搜索选文、现件选区、
逐段评论更新和评论焦点的四个完整算法，以及分别原位注册的 quote
state／退休 effect。App 的四个实际消费者直接借返回方法；既有四个
引用回访／内容／阅读／意图准备方法逐字保留。搜索仍捕获原草稿，按
原 generation、目标 conversationKey 和条件焦点接续；现件选区只清
原 taskResult／intent；评论仍 functional merge 最新草稿，并保留原
expression return 与 preventScroll 焦点。没有额外 guard 或 async 包装。
原稳定 React setter、只随 conversationId 的 reveal 退休、两个不同
rAF 端口和全部原注册顺序保持。scope／权限、草稿持久化、实际导航与
DOM writer 留在原宿主，不新增 store、缓存、订阅、请求、DOM、CSS
或模型调用。SearchDocuments、Provider、SelectionActions、Reader 和
ArtifactEditor 的已有完整生命周期不重复迁移。

根独立实际 Git `75ba44c0` 源证明：只逆掉批准的 import、注册、factory
与四个消费接缝，完整 App 恢复原 **113,015 字节**，完整 owner 恢复原
**8,263 字节**；原四方法 raw 全等。独立旧 fixture 的 **13** 个整文件、
**13** 个 raw span、四个完整可执行原回调和两个注册均与实际 Git 相等。
两份生产源和三个新行为测试冻结 SHA 复核，**198** 份既有 renderer
source 未改；实际 Client、Platform、原组件、持久化 tests 与相关 helpers
保持原整文件，唯一旧页面入口校准另有完整字节撤销证明。

七份完整原页面在冻结旧版／新版编译 App 各 **30/30**，零重试／skip；
每边逐例核实 **117** 份实际 HTTP 入口资产，CSS／preload 字节相等。
覆盖全文搜索、最近打开、持久化内容索引、确切历史选文、评论／引用
来源回跳、草稿恢复与 Session 隔离、失败重试／回执去重、触摸、窄窗
和明暗主题。初轮旧版 **29 通过／1 失败** 是旧测试点击已不存在的
工作空间选项。只校准到内容库的「其他内容创作」与原 Escape 焦点；
原「资料导入与来源」「打开文件」不得出现、搜索、选区和空间预算
断言均保留。旧校准单项和两份完整最终页面均通过，校准已独立提交
`98ad08a5`，不是为迁移恢复撤下的 UI。相关四份原 Node 持久化／搜索
回归为 **17 通过、2 PostgreSQL 能力跳过、零失败／取消**，不把纯
PDF 页投影或未运行的 PostgreSQL 算成实际存储证明。

根独立新命令／门禁及旧引用消费回归 **39/39**，无 skip；独立相邻
完整回归 **53/53**，原断言、hash、计数和指定反例保留。五份旧测试
或 helper 只加有限入口 inverse；旧四方法动态测试先检查实际有序八
方法，再借原四个同一函数引用，新增三个端口为禁止调用的窄 mock。
仅撤掉这些批准接缝后，五整文件恢复实际 Git 字节。初轮旧 inventory／
返回键、跨 owner 前置见证抢先拒绝和旧 raw-target 不存在的 RED 保留；
新门禁只治理自身 consumer，旧合法 import alias 和 clone／wrapper
安全反例仍由旧特定规则拒绝，不用 parser 错或更新历史 hash 求绿。

根独立实际 React StrictMode 挂载 **9/9**（父测试＋八场景组），无 skip。
真实 scoped storage、SearchDocuments、TextQuoteProvider、ArtifactEditor、
SelectionActions 和原 hooks 验证 stable setter、原位注册、范围退休、
捕获与 functional 草稿、受控迟到导航、原生 HTML dialog 关闭、portal、
原历史 revision／page、焦点与 textarea 选区、取消／卸载。业务读取
与导航是受控端口，不冒称实际 ACL、Runtime 或完整事务回执。
**48** 组 Search 几何／动效记录覆盖真实四 accent、明暗、宽中窄窗及
CSS zoom 1／2；0.01px 几何、原 DOM／material 和 timing／keyframes
旧新精确相等，没有关闭动效。原 search 的 180ms reveal 和 110ms
主题过渡保留；不是逐帧像素或原生 OS 缩放证明。48 组的 Provider
quote geometry 为 null，不宣称全主题 Provider 空间覆盖。**24** 个
zoom 2 场景保留旧、新共同的搜索溢出（窄窗 workspace 200px／search
696px），未借重构改 CSS 或把共同问题写成空间验收成功。

根最终完整 build／类型、格式／差异检查通过；全量 Node **1997 项：
1837 通过、160 能力跳过、零失败／取消**。新增挂载显式执行现有
headless Chromium。首轮完整 build 的新 helper 类型收窄错误保留，
准确修窄后第二轮 build 通过；没有生产类型或布局变更。

本批生产与自动验证已完成，整体目标仍 active，没有额外推送。原 App
仍卡在退出清理，强制退出待用户确认；不重置 profile／中心，不重启
Runtime。原窗、硬件、系统命中与全产品验收未完成。另已核实普通 CI
仍混合当前职责约束和历史整文件迁移证明，跨 owner inverse 链的长期
治理必须继续，不能把这一批新增门禁数量说成整体工程已收口。

根证据：`/tmp/morphz-reference-preparation-root.Gfgapr` 的冻结 manifest、
两份完整最终页面／HTTP audit、page-equivalence、root-input-source-proof、
root-production-source-proof-final、root-fixed-source-proof、
root-boundary-final-actual-git-proof、root-mounted-final 和最终 Node／
build logs。生产源证明在
`/tmp/morphz-reference-preparation-production.CfJ7ap`，独立旧源与挂载在
`/tmp/morphz-reference-preparation-validation.vzHjhU`，门禁及五旧文件
撤销证明在 `/tmp/morphz-reference-preparation-boundary.sNnpL8`。
未应用的 popup 样式方案与测试治理审查只用于定位后续工作，不是
已实现的生产 owner 或已批准的视觉规范。

## 2026-10-04 前端阶段 29：对象批注完整功能模块

`features/content/ObjectAnnotations.tsx` 持有原两 state、完整读取／取消
effect、ID 限定的 items 投影和完整 InspectorPanel 树；App 在原位置
直接消费三导出，保存回执继续借原稳定 React setter。五个原依赖、
隐藏时保留结果、AbortController 成功／失败守门和原错误文字不变。
原 Client／Platform 查询、分页、授权与 workspace change 权威未动；
原 SubjectInspector 显隐、InspectorPanel 宽度／焦点／Escape 未动。
作者仅借原当前 render state；历史 revision／page、顺序和原文本仍保留。
没有新 DOM、CSS、state 镜像、缓存、订阅、请求、权限或模型调用。

根重跑实际 Git `9c6b8dd1` 源证明：逆掉三个批准接缝及唯一 import、
恢复两处原 import bindings 后，完整 App 恢复原 **115,483 字节**。
完整原 state／effect／projection
逐字保留；panel 只映射 authorName 与 focusOnMount 两原表达式。
完整 Client、PlatformClient、InspectorPanel、layout、submission owner
及四份完整原页面测试和六份相关 fixture／helper 均与实际 Git 相等。
固定旧挂载 fixture 的六整文件元数据、十一 span、完整可执行原 hook／
投影／panel 亦经根独立实际 Git 核验，不用候选生成旧 oracle。

冻结旧新完整编译 App，四份完整原页面测试各 **15/15**，零重试／
skip，原完整源码／断言／预算不变。每边逐例核验 **54** 份实际 HTTP
入口资产，**198** 份既有 renderer source 与实际 Git 相同；CSS／preload
字节相等。覆盖真实批注事务、重开恢复、保存时无 Runtime delivery、
外部 Objects 提交经真实 SSE 重读且保留未发送草稿，以及主体／批注
显隐、调宽、焦点、原生拖动区 CSS 和截图／听写相邻路径。
该通知 fixture 使用独立实际 Runtime／Host／SQL，模型请求为零；
其他页的合成执行状态和媒体端口不冒称实际 Runtime 执行或硬件采集。

另跑原三份持久化／Host／Objects Node 回归，**33 通过、3 PostgreSQL
能力跳过、零失败／取消**。它证明相应实际 SQLite／Host 合同，不把
未运行的 PostgreSQL 或受控 React query 说成真实 Client 权限证明。

固定旧源与真实新 feature 的 React StrictMode 挂载 **10/10**，无 skip；
八组生命周期／交互覆盖五依赖、稳定回执 setter、隐藏保留、迟到取消、
错误／重试、完整 DOM／原文、焦点／草稿与键盘／指针调宽。
**48** 组四主题、明暗、宽中窄窗与 CSS zoom 1／2 比较完整 snapshot；
实际祖先层级及宽窗／窄窗／zoom 有效宽度均核验。几何按 0.01px
精度精确相等，不冒称像素截图。实际 panel animation name 为 none；
主题切换的 110ms CSS transitions 原 timing／keyframes 对照保留，
没有关闭动效或放宽误差。受控 query 只证明 React 生命周期与呈现，
不代替上面实际页面的 HTTP／持久化权限或完整保存回执。

新有限消费门禁及两份相邻原回归经根重跑 **16/16**，无 skip；独立
十份相邻 Node 回归 **79/79**。两个旧测试入口仅新增精确 inverse
消费接缝，撤掉后全文恢复实际 Git；原 hash／计数／断言／指定负例
不改。门禁遍历器漏检 type-only 反例、旧入口反例被新规则提前拦截
的两次真实 RED 与窄修证据保留，均未修改生产算法或删除负例。
根最终完整 build／类型、格式／差异检查通过；全量 Node **1970 项：
1810 通过、160 能力跳过、零失败／取消**。显式使用现有 headless
Chromium，新增真实挂载确实执行；能力跳过不计通过。

本阶段完成生产迁移与自动验证，整体目标仍 active，没有额外推送。
原 App 仍卡在退出清理，强制退出待用户确认；Runtime 不重启，
profile／中心不重置。原窗、硬件、系统命中和整体目标保持未完成，
不以本批普通自动浏览器、源码证明或 CSS zoom 替代这些验收。

根证据：`/tmp/morphz-object-annotations-root.mF8t3x` 的 manifest、
两份完整页面报告／HTTP audit、page-equivalence、root-input-source-proof
与 root-original-spans、root-fixed-source-proof、root-boundary-actual-git-proof
和最终 Node／build／format logs；生产源证明在
`/tmp/morphz-object-annotations-production.75z3xx`，独立挂载在
`/tmp/morphz-object-annotations-review.aLONrE`，有限门禁在
`/tmp/morphz-object-annotations-boundary.xI0bZL`。

## 2026-10-04 前端阶段 28：完整 Human 文档／项目创建 feature

`features/creation/CreateDialog.tsx` 持有原完整创建组件，App 保留两个
原消费点及选择／导航／prepared continuation。只有唯一 runtime import、
完整原函数迁出和五个不再使用的 import bindings 删除；组件仅增加 export
和原 Client execute 的 type-only Pick。七个 props、两个完整 JSX 消费及
十个注册顺序保留，无新 DOM／CSS、hook、store、请求、订阅或授权。

原 scopedStorage 在组件内只捕获一次，document 缓存仍每 render 读取，
project 不读写文档草稿。文档按原 project key 重挂，项目表单没有新增 key；
busy 时字段仍可编辑，不把迟到回执重定向到新项目／Client。保留 prepare
在 try 之前、清稿失败不重复创建、prepared 回调即使卸载仍执行，以及
onCreated／错误／busy 的原 alive 守门。文档标题仍只 portal 到真实
WorkspaceTopbar detail slot，空 slot 不新增 fallback；项目继续 useModal。

根独立 actual Git `778e6b93` 证明：仅逆掉批准接缝后，完整 App 逐字
恢复原 **120,474 字节**；完整函数、两消费点／guards、原 Client 存储
reexport 及定义等值。旧 private-scope fixture 仅加一个 import 和 inverse
首行；独立逆掉后全文恢复原 **33,527 字节**，旧 hash／计数／断言与
指定负例未改。新有限门禁及七份相邻原回归 **69/69**，无 skip；门禁
不是任意 AST／依赖定理，不用受控挂载代替实际 Client 或原窗验收。

冻结普通旧新编译的五份完整原页面测试各 **18/18**，零重试／skip；
每边逐例核验 **114** 份真实 HTTP 入口资产，**197** 份既有 renderer
源码未动，CSS／preload 字节一致。覆盖真实 Platform／HTTP 手写创建、
内容归属、首发／重试、目录授权、切换／恢复／引用及项目管理和几何。
另外两份完整原弹窗／触屏／顶栏页面各 **3/3**，每边核验 **9** 份
实际 HTTP 入口资产，原断言、预算和完整源码相同，零重试／skip。

固定完整旧组件与实际新 feature 的真实 React StrictMode／Storage／
useModal／WorkspaceTopbar 对照 **11/11**，无 skip；execute／prepare
和回调为受控端口，另由上述完整 App 页面验证实际事务。**64** 组四主题、
明暗、1440／760 窗口与 CSS zoom 1／2 精确 snapshot 包含原祖先层级，
对各 branch／主题明确验证中心区域宽窗大于窄窗及 zoom 后的有效宽度。
原弹窗的实际入场 animation name／timing／keyframes 在结束前对照，
真实 animation.finished 后才比较终态几何，不关闭动效或增加容差。
首轮入场采样差异及误占侧栏 280px 的中间 fixture 证据保留，后者不作为
窄窗覆盖证据；最终真实中心宽度为 1160／480，zoom 2 为 880／200。
根最终完整生产 build／类型、格式／差异检查通过。全量 Node
**1954 项：1794 通过、160 能力跳过、零失败／取消**；显式使用现有
headless Chromium，新增实际挂载及原可运行浏览器检查确实执行。
能力跳过不计通过，自动回归不代表全产品或原生验收完成。

原 App 仍卡在原生退出清理，正常退出信号未恢复；强制退出另待用户确认。
Runtime 不重启，profile／中心不重置；自动浏览器与 CSS zoom 不能替代
原窗、硬件或系统命中验收。剩余批注、部分搜索引用、更多控件／样式、
领域查询治理和整体验收继续推进，目标保持 active，本阶段没有额外推送。

根证据：`/tmp/morphz-human-creation-root.9z4pzG` 的冻结 manifest、两份
完整页面报告／HTTP audit、`page-equivalence.json` 及 root actual Git proof；
生产源证明在 `/tmp/morphz-human-creation-production.dIZDHR`，实际
挂载在 `/tmp/morphz-human-creation-review.xE5xhR`，有限门禁及旧入口
逐字证明在 `/tmp/morphz-human-creation-boundary.w9iJ6J`。失败与修订
证据保留，不以删除旧断言、放宽几何误差或能力跳过制造通过。

## 2026-10-04 前端阶段 27：私有项目／会话范围的完整控制器

`host/private-project-conversation-scope.ts` 承接原七个语义动作、两个纯
投影、一个 content scope state 与两个生命周期 effects。侧栏、项目目录、
顶栏、内容范围、引用命令和创建回执共用同一 owner；原草稿存储／ID／
部分写失败仍归已有 draft owner，导航／偏好和授权仍借原 Host 端口。
没有新增 store、ref、持久键、网络请求、订阅或执行入口。

三个 hook 分别在 App 原 slot 注册，不以早期综合 hook 改变生命周期。
唯一 inert action factory 在原引用 factory 之前，七个返回方法直接消费，
避免原 hoisted declaration 改 const alias 后的 TDZ。Launcher 保留原 raw
content setter，不误换成同时清对象／推进导航的语义动作。
项目显式点击仍回默认会话；命名会话、未发送草稿、实际对象所属项目和
启动记录继续分开。创建回执只借原 Host continuation，不迁旧私有焦点／
草稿／弹层 writer 到身份稳定树。

根与独立 actual Git `c35b9fde` 源码对照：七动作只有原导航 isCurrent
绑定映射，两投影及三个原 hook／effect body 和 deps 相同；全 **88** 个
注册顺序、**199** 个完整 JSX 及其余 **133** 个完整 statement／顺序保持。
普通冻结旧新编译的五份完整原页面用例各 **18/18**，零重试／skip，每边
核验 **114** 份实际 HTTP 入口资产；**196** 份既有 renderer 源码不变，
CSS／preload 字节相等。覆盖真实 Platform／HTTP 草稿首发与重试、目录
授权、跨项目搜索选择、恢复／刷新、引用、对象阅读和项目管理／几何。

新增实际 owner **12 项**行为及 **1 项**真实 React StrictMode 旧新生命周期
通过；后者使用实际 Host／草稿 hooks 和浏览器 scoped storage，外部 Client／
授权仍受控，不冒充 Platform／原生验收。新有限消费及相邻门禁 **48/48**；
根独立证明仅逆掉批准接缝后，完整 App 逐字恢复实际 Git `c35b9fde` 的
**125,134 字节**，四个旧测试入口撤掉新增包装也逐字恢复其实际旧文件。

根首轮全量 **1937 项：1776 通过、160 能力跳过、1 失败**；失败是旧发送
测试的直接源码入口仍要求已随原投影迁出的 `discussionId` import。保留红日志，
入口先验证本次真实 owner 再有限逆展开；原 import shape、算法、计数、断言
及指定负例未改，独立实际 Git 全文件证明与根 **21/21** 回归通过。
第二轮全量 **1937 项：1777 通过、160 能力跳过、零失败／取消**。
本轮显式使用现有 headless Chromium 能力，新增实际挂载及原有可运行浏览器
检查确实执行；其他能力跳过不计通过。完整生产 build／类型及格式／差异检查
通过。有限源码证明、自动浏览器回归不等于任意依赖定理或整体验收完成。
原 App 仍卡退出清理，Runtime 未重启，用户 profile／中心未重置；原窗
验收和手写创建／批注／搜索引用、更多控件／样式责任仍未完成，目标保持 active。

根证据：`/tmp/morphz-project-scope-root.UGT1u5` 的冻结 manifest、两边
完整页面报告／HTTP audit、`page-equivalence.json` 与 root source proof；
独立生产源证明在 `/tmp/morphz-private-project-scope-production.AIBKOB`，
实际 owner／React 生命周期在 `/tmp/morphz-private-project-scope.2JCNkL`；
有限消费与四旧入口实际 Git 对照在 `/tmp/morphz-private-scope-boundary.Qk9PCL`。
根完整构建、首轮红及第二轮全量、完整 App／第四入口逆展开证明均保留在根证据目录。

## 2026-10-04 前端阶段 26：显式内容打开归入唯一导航 owner

App 原 `openUser`／`openReading` 两个完整算法迁入既有
`createWorkspaceNavigationCommands`，不再由 App 复制目录读取与导航分支。
原十个构造端口与注册位置不变；Client 窄类型新增原 boot、contentCatalog
及 resolveCatalogContent。只有五个已有绑定映射、两个直接消费别名及
原 type import 删除，无新 hook、store、请求、effect、订阅或 await。

保留 render 捕获与当前授权 witness 的区别，以及原两阶段读取／守门：
剧本快路返回原下层 Promise；User 普通打开仍 void、Reading 等待下层；
原 null／错误提示、网站意图与读取 ID、迟到成功／失败语义都保留。
下层对象／剧本命令及其确切授权／目录版本检查没有改写。

根与独立证明逆掉批准接缝后，App 与导航 owner 全字节恢复实际 Git
`2cf6a3f2`。独立固定原算法的 **15 项**行为对照，以及有限真实导入、
别名、完整构造参数、注册和上下游消费门禁均通过；旧算法／断言不改。
有限源码门禁不是任意依赖定理或真实权限／原窗验收。

剧本同步旧缺陷另以 `e80e5bdf` 修复。普通、未插桩的冻结旧新编译都含
同一修复，只替换旧导航两源；同六份完整原页面用例各 **26/26**，每边
核验 **93 份**实际 HTTP 入口资产，CSS／preload 字节一致，零重试／skip。
根完整 build／类型检查及 **1876 项 Node：1705 通过、171 原能力跳过、
零失败／取消**。这不是未修复旧版本的行为等价或原 App 已恢复的证明。

证据：`/tmp/morphz-open-navigation-root.ndQoxp/source-proof.json`、
`/tmp/morphz-script-sync-root.97ESaS` 的冻结 manifest、页面对照及最终
全量／类型日志。主页面／项目私有范围、页面／overlay 组合、更多公共
控件／样式与整体真实原窗复验仍未完成；目标继续 active，没有额外推送。

## 2026-10-04 剧本打开修复：已确认目录同步与有界引用保留

阶段 26 页面复验发现剧本目录／条目请求都成功，却在启动编辑器前被确切
目录版本守门拒绝。冻结旧新编译的受控次序测试证明：迟到目录发布时两边
都为 **5 通过、1 失败**，预期版本 2 而 Boot 仍为 1；先发布目录时两边
均 **6/6**。完整相关编译算法对照也一致，不能归因为导航迁移或直接删除
权限／版本守门。证据保留在 `/tmp/morphz-script-open-order.JAoF32`。

本次是独立正确性修复，不冒充纯等价迁移。`content-reads` 通过显式 typed
端口同步发布已授权 scriptLibrary；Client 对七项元数据及顺序比较，先更新
current 再发布 React。刷新在原最终权限／目录检查之后先检查 epoch／范围，
若原 cache 对象的 value 被点读推进，通过已有 drain 重读，不能先写旧确认
或 Boot。无需新 store、持久键、轮询、模型请求或放宽授权。

冷剧本确认引用沿既有 cache 提供：去重、排除 head，最多 150；活跃对象仍
优先，确认引用在原 200 项共享读取预算内保序取尾。200 是引用读取预算，
不是最终目录全局上限。等值重新确认仅对可用非 head 剧本提升缓存原件到
引用尾部；已在尾部且全部非 head 引用不超过 150 时仍免重建。超过预算
沿原最后 149 项＋确认原件算法收敛；普通内容／head 的原等值规则不变。
没有写最近访问或偏好，也不采纳四字段匹配之外的传入变动。

真实 Client／HTTP／SQLite 覆盖同步版本、旧刷新迟到、held body 冷目录等
**8/8**；独立真实 owner／SQLite 三项也通过，保留 61 个活跃占位＋150
引用再确认、真实编辑器补入第 151 个剧本再关闭重开两份原红证据。查询
四项新增 SQLite 包含撤权／缺项、无新增原件读取及多轮预算；原 PostgreSQL
能力跳过不计通过。内置目录／剧本列表读独立授权目录、按更新时间排序，
不直接显示这个引用数组；不宣称任意第三方画布的引用顺序完全不变。

根冻结编译使用相同修复，仅旧导航两源取实际 Git `2cf6a3f2`；旧／新六份
完整页面用例各 **26/26**，零重试／skip，每边实际 HTTP 核验 **93 份**
入口资源，CSS／preload 字节相等。所有原页面断言及输入／fixture 哈希相同。
完整生产 build／类型检查通过。全量 Node 首轮 **1871 项：1697 通过、
171 原能力跳过、3 失败**，仅旧完整 Client 逆迁移门禁不认识本次明确修复；
其旧算法／hash／断言保留，不将这一轮称为全绿。新增有限逆变换只移除
本次批准接缝，逐字恢复实际 Git `b20d4acd` 的 66,858 字节 Client；
直接调用及两个原 owner 展开后的重复逆变换均安全。两个旧入口仅新增
导入与入口调用，七字段、捕获和最终权限→epoch／范围→CAS→确认顺序
均受精确负例约束；未批准变化仍交原门禁拒绝。独立复核新旧门禁 **14/14**。
根第二次全量 **1876 项：1705 通过、171 原能力跳过、零失败／取消**，
最终完整类型检查通过。原 App 退出清理仍未恢复，不以隔离页面替代原窗验收。

根证据：`/tmp/morphz-script-sync-root.97ESaS` 的冻结 manifest、build、
`fixed-page-equivalence.json`、HTTP audit、两轮全量日志；有限逆变换证明在
`/tmp/morphz-script-publication-inverse.0cGYIu`。独立原红／修复
记录在 `/tmp/morphz-content-budget-review.0x1cRq`，查询证明在
`/tmp/morphz-confirmed-script-query.R40mjo`，owner 及有限负例在
`/tmp/morphz-script-tail-confirmation.0UseXd`。

## 2026-10-04 工作流回归维护：显式阅读／媒体入口与批注模式定位

`workflow-details.spec.ts` 的原批注模式定位同时命中提示与次要按钮，
随后原测试又假定聚焦输入自动展开交流历史；截图项没有打开现有媒体菜单。
本次仅限定 `.annotation-mode` 原提示、使用既有 `openExchangeReading` 和
`openComposerMedia` 显式入口。保存批注、真实 Platform 回读、零 Agent
投递、全文历史切换、截图本机保存／刷新恢复、内容计数及听写停采断言未删改；
不改生产 UI、恢复已撤入口或延长原预算。

固定阶段 25 编译和阶段 26 未提交编译沿同一当前测试各 **3/3 通过**，
零重试／skip；每边逐例核验三份实际 HTTP 入口资产完整 SHA。
精确逆掉四个测试接缝后，全文与实际 Git `2cf6a3f2` 相等：原 SHA
`f5d1709e3b22f3080fc0b4a7f1eddf8d51e52bab922bd91e3e5eaddfbb4f5e9c`，
当前 SHA `8ca32edf179b6dbf0c3a1ded2856bdb6e4dfc4005583b934b5f5c4098177234b`。
证据在 `/tmp/morphz-open-navigation-root.ndQoxp` 的
`workflow-entry-proof.json`、两份 `*-workflow-explicit-entry` 报告及 HTTP audit。
这仅关闭相应旧测试入口缺口；剧本版本同步缺陷另行修复，原 App 与整体架构
验收仍未完成，不能据这三项测试宣布目标完成。

## 2026-10-04 前端阶段 25：原生弹层表面的唯一样式责任与有限门禁

`ui/dialog-surface.css` 承接原 styles／ui／visual 的 **8 条规则、18 项
声明**，main 在 workflow→该 owner→visual 间唯一导入。选择器、root
上下文、值、声明／fallback 顺序与 important 全保留，不只搬最后获胜值。
文字、几何、子控件、motion、token 与辅助策略留原 owner；原 native
dialog／`useModal` 和实际消费 JSX 均未改，不另加表面包装或新数值规范。
进行中截图的透明／无 blur backdrop 保留 workflow 的强选择器例外。

根与独立环境分别对实际 Git `d6555b2a` 验证完整原文减法／逆迁移：三个
原 CSS 余项所有字节与相对顺序、workflow 全文未动，main 仅加唯一 import；
新八条完整 tuple 与原文相等。独立复核旧新实际编译的八组属性及捕获
prefixed／standard blur 均相等；生产冻结后编译，最终 source SHA 与独立
固定证据一致。
新 gate 用固定原 tuple 约束实际单入口、余项、token 与有限直接竞争者；
登记十九种实际 native 类、shorthand／longhand、escaped／class 属性、
is／where 和保守隐式 subject，同时保留 footer／input／伪元素的合法边界。
初版专属变体漏检与中间版 lookalike class 误报的红证据保留；修复后根
新／原交流 CSS 门禁 **10/10**，新门禁含 **60 个合法解析且按指定规则
拒绝的反例**。这不是任意 CSS cascade 定理或全产品依赖约束。

冻结旧新编译的十二份真实页面测试使用相同输入／fixture，仅切 private
static-root。截图已迁移入口的独立修复为 `a7bef2d1`，旧断言／预算／图片
保留。每边 **37 项：35 通过、2 项相同旧入口超时**，零重试／skip；
两项均在已撤独立转写／工作空间菜单，不冒充 37/37，也不恢复旧入口或
换听写场景凑绿。逐例三份实际 HTTP 资产完整 SHA，每边核验 **135 份**；
同一 source／fixture SHA、实际结果与有限接缝逐例比较一致。设置／项目
八主题、触屏／窄窗、焦点／选区／草稿、真实 native 执行审批及失败记录、
搜索／附件／截图／捕获例外、透明与对比度原断言均沿原真实消费者。

另用实际编译 CSS 的隔离 Chromium native dialog 固定组合做 **174 组**
完整 computed style／几何对照，**51 组**截图像素 SHA 一致；涵盖 app／
非 app／复合 fallback、八主题、两宽度、系统与显式 native 辅助属性、
browser guest 材质、capture 及 CSS zoom。媒体条件用实际 matchMedia
核验，并断言辅助／捕获 blur 关闭。一轮测量在截图前 detach CDP，导致
媒体恢复触发额外转场像素差异；修正隔离测量生命周期后重新全跑，未改
生产或弱化像素／样式断言。此对照不是原 App、原生网页叠层、macOS
截图选择器、真实 Electron zoom 或 Runtime 成功验收。

新入口 `app-Z8kWApC2.js` SHA 为
`44059ca4a6b2d2ed07d62262d314316ae92a6a68a29d8ff22d9aeffdd8fd844b`；
CSS `app-C9EoVA8G.css` SHA 为
`8dbe27c1cb2ead35ed001803da0a5ded94be6ccb75fb568576d06c6146ae505c`。
preload 原字节保持；index 可达七份 JS 仅按真实构建资产文件名映射逆掉
hash 后全文相等，三个模块 raw 字节也相等。未把 dist 保留的历史资源
当作当前加载模块或另改用户窗口缓存。

完整 build／最终类型检查通过，原分包大小警告保留；新增／其余变更
路径格式检查通过，styles.css 的唯一 product-bridge 格式警告与实际
旧 Git 完全同段／同字节，未混入无关重排。根全量 Node checkpoint
**1836 项：1665 通过、171 明确能力跳过，零失败／取消**；skip 不计
原生、浏览器或外部能力验收。原 App 退出清理卡死及其精确恢复授权仍未
解决，Runtime、profile、center、用户数据未重启或重置。主页面／overlay
编排、其他控件／样式 owner 与整体架构目标仍须继续，目标保持 active。

根证据：`/tmp/morphz-dialog-surface-root.wiC7F7` 的 `build.log`、
`full-node.log`、`owner-gates-final-root.log`、旧新页面报告／HTTP audit、
`page-equivalence.json`、`computed-equivalence/report.json`、
`computed-equivalence-session-stable.log`、`javascript-equivalence.json`。
独立固定 tuple／源码逆迁移与门禁红绿记录在
`/tmp/morphz-dialog-surface-owner.gu13I8`，只读二审与可重跑原文证明在
`/tmp/morphz-dialog-surface-independent.xwX95h`。未额外推送或创建第二个 App。

## 2026-10-04 截图布局回归：跟随已迁移的真实输入菜单入口

阶段 25 的冻结旧编译页对照先得到 **30 项：28 通过、2 个旧入口超时**。
`dialog-layout.spec.ts` 首项仍直接点击关闭菜单内的“截图输入”；能力未撤销，
已由 `MessageAttachments` 收纳进“添加输入内容”。本次仅补既有
`openComposerMedia` import，并在每轮截图点击前打开真实菜单。四种图片、
原 45s 预算、尺寸／比例／焦点／窄窗布局、草稿及确认前零上传断言均未改。

修正后冻结旧编译同场景 **1/1**，零重试，三份实际 HTTP 资产完整 SHA
核验通过。根与独立复核仅逆掉新 import／菜单打开调用后，完整测试与
实际 Git `d6555b2a` 逐字节相等，SHA 均为
`497654b036503188b397b743472f843eca8809024d5f8b49f8c2b3f544364ce9`；
修正后 SHA 为 `95e08f971cdc1dbdf3bffb2f327567d031e01415ec47a73eff752b310f4c1abf`。
这不是改生产布局来迎合旧测试，也不是修改断言或延长超时。

第二项独立“录音转文字”及其工作空间菜单已由实际 Git `36975394` 撤出
主体侧栏，符合设计记录；现有行内听写不是同一能力，不能替换成它凑绿。
该整段测试保持原字节，原超时保留为测试维护缺口，不计通过。同轮额外
搜索用例的末尾也仍寻找已撤菜单；其原断言保持并单独记录，不混算为
样式迁移回归。生产截图、听写、数据与权限未因本修复改变。

证据：`/tmp/morphz-dialog-surface-root.wiC7F7` 的 `dialog-baseline.log`、
`dialog-baseline-capture-menu-report.json` 与 HTTP audit；新旧表面迁移另列
阶段 25，原 App 验收不由隔离页面代替。

## 2026-10-04 草稿架构门禁：补齐运算符与函数声明见证

在阶段 24 提交 `c2f3128b` 后，只读复核发现旧 draft 门禁接受六个
合法解析的变种：两个私有 draft guard 的 `!` 改 `+`、两个函数改 async、
setDraft 改 generator，以及 createConversation 的 `!pending` 改 `+pending`。
根环境直接读取实际 Git `c2f3128b` 的门禁独立复现六项均被放行；这只
证明这一有限源规则漏检，不声称其他门禁、类型或运行行为都接受变种。

修复仅在 `exchange-draft-boundary.test.ts`：syntax 明确保留 prefix
operator，guarded declaration 同时比较 modifiers、asterisk、名称、类型
参数、参数和返回类型，不再只比较 body／parameters。六个新反例先验证
唯一真实函数与唯一替换、合法解析，再各自要求命中原指定规则。原七项
先绿、新六项先红的证据保留；修复后根相邻 draft／submission／navigation
合同 **41/41**，独立七份相邻合同 **71/71**，均无跳过；完整类型和限定
格式检查通过。原 oracle 模板逐字节未改，根 SHA 为
`8b56c20a79617a4600c4538221e3b20956fba5ac257a88899bf726af718754d5`；
App 与 draft owner 的实际生产字节仍等于该 Git。没有 UI、权限或运行
算法变更，也没有以更新旧基准来消除失败。

独立先红／修复证据：`/tmp/morphz-draft-gate-prefix.0iWWv3`。这不是全部
JavaScript 语义检查或完整架构门禁；跨层依赖、全产品样式／role 所有权
仍未完成，不能将局部测试通过视为整个前端目标完成。

## 2026-10-04 前端阶段 24：执行查询、控制与共享审批记录所有权

`data/execution-interactions.ts` 完整拥有原 `cancelInput`、执行 snapshot／
result、control 与 `approvalSubmitted` 五算法。真实 Client 在原本机投递
owner 之后唯一构造，直接公开五方法；原审批 Set、反馈 state、current ref
的注册及身份／刷新权威仍在 Client。构造只借原引用和逻辑请求，不读状态、
发请求或建立缓存；两个审批页面、消息与活动停止入口均沿原 Client 消费，
没有 JSX、DOM、样式、图标、动效或新的请求策略。

审批 key 仍为原 CSRF／approval ID／fingerprint，先登记、增加反馈代次，
再发原请求。失败和未知回执也不解除重复提交保护；新 fingerprint 是另一
次明确决定，普通 Thread／Job 控制不登记审批。原登出不清 Set，空身份
getter、重复 current 读取、counter 失败的部分副作用保持。取消沿原 8s
请求，只有成功才等待刷新；snapshot 的 caller signal／12s 组合、result
schema 和原 transport 代次检查不统一重写或补充新守门。

固定实际 Git `51f9101e` 的五完整原函数。根与独立复核各自确认原 oracle、
新 owner raw 字节与实际 Git 一致；严格核对唯一导入／构造、准确 borrowed
ports、原 hooks 与五直接消费后逆展开，完整 Client 逐字节恢复原版，SHA
同为 `effed98cb46cd9ab9ed968a1877ba3c363c2496ab6ca87bd243bd2034225c679`。
旧 local-input 与 Task 门禁只增加这一 seam 的严格逆展开；反向移除后
全文与原 Git 相同，原摘要、规则、数量和反例不改，原 local helper 及
content／Reader／script 三门禁不动。新行为／消费与相邻合同 **45/45**，
30 个合法解析反例均按对应规则拒绝；有限源门禁不冒称 Runtime 执行。

根算法与原执行／审批测试 **27/27**，含另建的实际 Client **3/3**：SSR
建立真实 refs／方法，原 HTTP／SQLite 登录校验精确查询／停止路径与
控制载荷，审批失败后的跨入口防重复、新指纹，以及新登录不能接收旧
身份响应。隔离 Host 未配置 Runtime，实际拒绝为 **503**，不生成批准、
停止或模型成功回执。首轮新测试错误假设 null query 字段为空串，按原
HTTP serializer 的省略合同校准新断言；2/3 红项保留，生产未为测试修改。

四份字节不变的原生产页面测试在冻结旧／新编译各 **11/11**，零重试，
逐例实际 HTTP 三资源、每边共 33 份核验完整 SHA。跨工作面审批、未知
回执锁定、真实 scope、并发单项停止、结果和正序读取、四主题及运行中
消息 perimeter／reduced-motion 的原断言保留。新入口 `app-CMwVSuhb.js`
SHA 为 `a2f78e353dccbb8f66d1402fc5c84665dc251bae4a80ce0a64df1b777963a80f`；
CSS／preload 与旧编译逐字节一致，私有编译前后冻结源 SHA 相同。
完整 build／类型／限定格式通过，原分包尺寸警告未通过改阈值掩盖。
根全量 Node checkpoint 为 **1826 项：1655 通过、171 明确能力跳过、
零失败／取消**；跳过不视为原生、浏览器或外部能力已经验收。

根证据：`/tmp/morphz-execution-root.M439st` 的 `root-git-proof.log`、
`execution-focused-root.log`、`execution-source-before/after.sha256`、
`execution-frozen-build.log`、`execution-full-build.log`、
`execution-full-node.log` 及旧新页面报告／audit。
固定旧算法在 `/tmp/morphz-execution-interactions.OgxdeL`，实际消费门禁
和独立字节对照在 `/tmp/morphz-execution-consumption.jZc4OB`。原 App 的
退出清理卡死未解决，恢复仍待已提出的精确进程操作授权；Runtime、数据
及 profile 未重启或重置。本批不是原窗、完整查询层或整体架构验收。

## 2026-10-04 前端阶段 23：本机输入投递与确认的完整所有权

`data/local-input-delivery.ts` 完整拥有本机消息的保存、发送中投影、冻结
投递、重试及历史确认。真实 Client 直接消费四处 seam，保留原发送 Map、
身份 refs 的注册位置、共享 scope、scopedStorage 初始化、非输入命令与
刷新权威；构造只借原 refs／逻辑请求和 lazy storage，没有请求、state、
effect、订阅、缓存或第二份 store。公开 dispatch 是直接别名，record
准备同步返回原 submit Promise，不加 await。UI、DOM、CSS、图标与动效
未改，也不自动重放本机待发记录。

原算法先保存冻结载荷、登记 pending、发布和 staged，再在原微任务里
投递；重试沿用 ID、时间和原 payload。不同身份隔离，旧结果不发布到新
Boot。早期读取与发布时的 fresh read 仍分开，只有同 ID、principal、
actant 的权威历史记录能够移除本机项。原磁盘／callback 失败、partial
removal、try/finally 位置和同 key pending 顺序保持，未另加修复或守门。

固定实际 Git `32c52210` 的五完整函数和两个原块。根环境与独立只读复核
分别核对 raw 字节，并严格检查真实 Client 的唯一导入／构造、原 refs、
同步分支、两个刷新 seam 和直接公开消费后，只逆展开本迁移：完整旧
Client 与还原字节相等，SHA 均为
`5ef656793c9f70eada0bfc4eb0dcfc54ae4efab2d25eca6fd8d7dbdcdb2c3128`。
旧 Task 门禁仅新增 import 和严格展开；反向移除后全文与原 Git 相同，
原摘要、规则、反例不改，其他三个相邻读取门禁字节未动。

新旧算法双 lane 19 项、有限实际消费／反例 3 项通过；结合旧 local-saved
和相邻读取共 **37/37**。根真实 Client 另 **3/3**：SSR 建立实际 refs／
方法，不运行 React effects；真实隔离 HTTP／SQLite 登录与读回核对保存
不发送、重开不重放、staged 与冻结请求，以及登出／新登录后旧响应丢弃。
Host 未配置 Runtime，原 POST 实际返回 **503**；这证明请求与失败保留，
不证明 Agent／模型成功执行。fixture 登录映射和预期错误的初期红项保留。

相同六份原生产页面文件，冻结旧编译与本次新编译各 **28/28**，零重试。
原乐观保存、首发幂等、失败重试、补充冻结回执、发送手势和会话隔离
断言不改；八个旧准备问题独立校准，见下节。每边实际 HTTP 资源各
132 份核对完整 SHA。候选为 `app-DeA0tkPM.js`，JS SHA 为
`7b79552695b1374b4e8d31543796b18b1ba0f21440a96d93c1291a0e38f1c032`；
CSS／preload 与旧编译逐字节相同，私有编译前后源 SHA 相同。完整
build／类型与限定格式通过，原分包警告保持，没有调整阈值。
根全量 Node checkpoint 为 **1806 项：1635 通过、171 明确能力跳过、
零失败／取消**；跳过不视为原生、浏览器或外部能力已经验收。

根证据：`/tmp/morphz-local-input-root.rzLAQ5` 的 `root-git-proof.log`、
`delivery-focused-root.log`、`delivery-source-before/after.sha256`、
`delivery-frozen-build.log`、`delivery-full-build.log`、`delivery-full-node.log` 和旧新页面报告／
audit。固定算法及失败记录在 `/tmp/morphz-local-input-delivery.boIEJv`；
有限实际消费和独立 Git 证据在 `/tmp/morphz-local-input-consumption.5UR3Vh`。
双 lane 的新测试曾被两个 Date 输入差 1ms 影响，现固定输入而不改
断言；生产未为测试改变。原 App 仍待已提问的精确进程恢复授权，
Runtime、profile、center 与数据未重启或重置。本阶段不是整层查询、
宿主拆分、原生或整体架构验收完成。

## 2026-10-04 本机消息回归：显式阅读与合成事件准备

本机投递重构前，冻结实际 Git `32c52210` 的旧生产编译，六份原页面
测试首次为 **20/28**。八个红项均在 `message-retry`：旧准备仍依赖输入
获焦自动展开历史，或只改变模拟变量却不通知其合成事件流。前者已被
用户明确关闭，后者不应靠恢复生产轮询掩盖；并非工作空间归属错误。

现在只在测试准备中使用既有 `openExchangeReading` 显式阅读，模拟失败
调用既有 `presentation.refresh()` 并等待通知。原八项断言、预算、标题
及生产实现不改。相同六份测试在原编译上 **28/28**，零重试；逐例实际
HTTP 静态资源共 132 份核对完整 SHA。旧失败、trace 与 negative audit
独立保留，不能冒称原首次基线已通过或重构后的对应行为已验证。

证据：`/tmp/morphz-local-input-root.rzLAQ5` 的 `delivery-baseline` 报告、
`delivery-baseline-negative-audit.json`、`delivery-current-baseline` 报告
及 `delivery-current-baseline-audit.json`。本条是回归准备的有限校准，
不增加请求、轮询或模型调用，也不是原 App／原生验收。

## 2026-10-04 前端阶段 22：发送与补充的完整宿主命令所有权

`host/exchange-submission-commands.ts` 完整拥有原 `send` 和 `supplement`。
真实 App 直接消费两别名，保留原准备锁／错误／reveal state 与 refs 的
注册位置及全部 effects；只借原 render 事实、Client／Profile、writer 和
inspector／exchange 动作，不新增 store、cache、mirror、请求或权限。
构造在 startup return 及主体 inspector 别名初始化之后、所有消费者
之前；原 hoisted `send` 延迟使用的 `openCollaboration` 不能提前借用。
补充的 rAF／preventScroll focus 仍是 App 原样提供的 lazy DOM 端口。

准入、浅捕获、follow-up 规范化、Profile 准备、四分支协议与准备锁顺序
不变。staged 投递已消费旧稿并释放准备锁，后续旧失败／settled 不得清除
下一条草稿或解锁另一份请求；反馈仍按原 key／会话归属。补充保留原
principal／actant 检查、执行分支 title／60 字 label、未知回执冻结字节，
overlay 关闭与显示输入／延迟焦点顺序，不触发另一份执行。

两完整声明固定于实际 Git `9122ad28`。根环境独立核验声明原始字节，并
在严格核对实际 App 导入／捕获／别名、完整 owner 算法及构造之后，只逆
展开这个迁移 seam：完整旧 App 树为 **15924 nodes**，旧与还原 SHA 同为
`d4dc62a3f401d714eb43b547cdd3c736ea191cf7e521e4ffe03784cb5fb51f65`。
两个旧 whole-tree 门禁各仅增加 import 和严格展开，原摘要／数量没改；
原协议门禁保留所有规则，将原八个回调反例定位到真实新 owner。
独立只读复核没有发现生产缺陷或门禁放宽。新 15 个命令／有限消费合同
与既有门禁／协议合计 **80/80**；受控端口不等同 React 调度、HTTP 授权、
实际模型或用户窗口证明。新测试中途的 symbol／type-only import 与反例
定位误判已修正，失败记录保留，不修改生产迎合预期。

相同六份原生产页面测试，固定旧编译与本次新编译各 **28/28**。普通／
并发快捷键、首发幂等、会话草稿／引用隔离、补充冻结回执、停止／等待、
听写许可和迟到结果保留；原断言、预算及零重试不改，每例实际收到的
静态资产核对完整 SHA。候选入口为 `app-haUAvumG.js`，JS SHA 为
`7b487b81fe6edade0229168da9315edfc58f8d20dcf7d2fb395d25fcc1c831f2`；
CSS 与 preload 逐字节保持旧值。私有编译前后源 SHA 相同，完整生产
build／类型检查通过，原分包尺寸警告仍记录，未通过调整阈值掩盖。
根环境全量 Node checkpoint 为 **1781 项：1610 通过、171 明确能力
跳过、零失败／取消**；跳过不冒称原生、浏览器或外部能力已经验收。

根证据：`/tmp/morphz-submission-task-root.IE1FTB` 的
`submission-git-root-proof.log`、`submission-source-before/after.sha256`、
`submission-frozen-build.log`、`submission-full-build.log`、
`submission-full-node.log` 和
`submission-current-baseline/submission-candidate` 报告及 `*-audit.json`。
固定源、80 项合同和精确格式证据在
`/tmp/morphz-exchange-submission-owner.ZnTkGS`。最初旧编译探针误包含
不加载 App 的独立 hook 夹具与已撤回的独立转写入口，原失败单独保留；
最终对照仅排除该转写用例，六份原文件 SHA 完全相同，不冒称它已修复。

原 App 的已收尾进程仍待用户批准精确终止以恢复，同一 Runtime、数据与
profile／center 未重启或重置；本批不是原生验收或整体架构迁移完成。

## 2026-10-04 前端阶段 21：事项交互读取与投影所有权

`data/task-interactions.ts` 完整拥有原 `verifyArtifact`、`taskRuntime`
和 `taskResponses`，其中 Runtime 方法保留原 snapshot／control 两条路径。
真实 Client 唯一构造并直接公开原三个方法；原按事项的读取代次 refs、
hooks 注册、身份／撤权清理、refresh 和 `retainTaskRuntimeProjections`
仍在 Client。构造只借原 refs、transport 与 `setBoot`，不读状态、发请求、
订阅或建立第二份缓存；成功投影仍先写 `current.current`，再发布 React。

各查询的合同没有被统一：跨页通知的 taskHead 保留 8s 与前后身份核对；
snapshot／control 保留 12s、schema／abort 顺序、observer 与同事项代次守门，
迟到响应仍返回真实 view，但不能覆盖新的 Boot／事项绑定，finally 只清自身
代次；回应仍沿原授权来源分页与作者映射，不新增 post-await guard。
事项列表、详情和 Schedules 的不同 observation 策略未强行合并；
此阶段不改变控制权限、持久调度或 Runtime 执行能力。

实际 Git `9122ad28` 的三个完整算法固定为独立 oracle；有限门禁同时检查
完整方法、无构造副作用、实际 Client 消费及逆变后的完整旧 Client 字节。
根环境新门禁／等价矩阵、真实 Client HTTP／SQLite 和原投影测试合计
**28/28** 通过。真实 Client 测试使用 SSR 建立原 refs／方法，不运行 React
effects，真实登录、成员权限、事项和持久回应来自隔离 Host；已撤权的三个
读取均被服务拒绝，旧授权响应在真实目录版本刷新后不能覆盖新投影。
当前隔离 Host 没有 Runtime／模型，control 的原 POST 返回 **503 拒绝**；
这证明原路由、载荷及错误保留，不证明真实 pause／stop 成功。

根环境冻结阶段 20 的真实编译入口为旧版本，单独编译 Task 阶段后 source
SHA 前后完全相同。相同四份原页面测试在旧／新资产上各 **14/14**：
事件失效、失败重试、健康 idle 无周期请求、迟到终态、事项完整正文、
历史版本与持久完成／撤销均保留；每例收到的三个 HTTP 静态资产核验完整
SHA。新 JS 为 `app-6ASXkn6s.js`，CSS 与 preload 逐字节保持旧值。
完整类型检查、该批格式和差异检查通过。测试准备与 URL／body 误判的
首次失败日志保留，修正仅在新测试，不修改生产来迎合预期。

证据：`/tmp/morphz-submission-task-root.IE1FTB` 的 `task-frozen-tests.log`、
`typecheck-current.log`、`task-source-before/after.sha256`、
`task-frozen-build.log`、`tasks-current-baseline/tasks-candidate` 报告及
`*-audit.json`；独立源核验与相邻读取回归在
`/tmp/morphz-task-interactions.qQWsBI`。最初把 standalone Markdown 夹具
混入编译 App 资产探针的四项失败单独保留：该夹具不加载 App 入口，
不能冒称编译页面对照；最终四份 App 用例未改断言或预算。

原 Morphz 仍在同一已收尾进程的 Electron 退出清理阶段，独立 Runtime
和 profile／center 未重启或重置；终止该精确 App 进程的已有问题尚待用户
答复。本阶段不是原 App 验收、全查询层或整体前端迁移完成。

## 2026-10-04 前端阶段 20：引用、内容继续处理与显式意图的命令所有权

`host/exchange-reference-commands.ts` 完整拥有四个原命令：引用回跳、
内容继续处理、旧 Reader 兼容准备与显式意图。真实 App 在原引用命令
位置，每 render 唯一构造并直接消费四个原名称；借原 state／Client、
私有 origin、导航代次、草稿 writer、DOM 选区与焦点端口。不新增 state、
store、订阅、effect、请求、memo 或 latest-value 镜像；各分支原 guards、
schema、版本、等待与局部写入顺序不统一改写。Provider 当前 textQuotes
写入、ReadingContext、剧本域 compose／iframe ACK 保留原 owner。

固定四份完整声明与实际 Git `39cf13cf`、`b5f698dd` 原文本逐字节相等，
新 owner 只明示 DOM 端口及无运行语义的 Reading 类型两项适配。真实
导入／唯一直接注册／精确捕获／原消费者／原构造与直接 return 的有限
门禁通过；捕获克隆、公开 async wrapper、隐藏／重复／改位注册、原
消费后的 JSX 和生命周期变异均按具体规则拒绝。新算法／消费 21/21，
结合已有 App／Host 门禁根 35/35；两份旧完整树与摘要不重算。最初
测试反例误击重名字段／错误拒绝原因的失败保留，只校准反例发生位置。

固定旧编译与最终新编译的七份现行页面各 26/26，原精确来源、跨页面
评论／草稿／Session、编辑原文不写回、v3 未发草稿不重绑 v4 及迟到
请求归属断言保留；明确测试入口／Host 修订另记下节。逐例审计三份
实际 HTTP 资产，最终 App SHA 为
`c56d4c9784fe65fd086e06083d53ec9142d1897bc9f9d39af1c738287f949be3`。
新 JS SHA 为 `09438baaf43ad64affed193945c91b3dca19d1b455971bd6f2648670d71b3eaf`；
CSS／preload 与独立红色修复后旧编译逐字节相等，不能称相对未修复
色彩也不变。完整 build、类型、限定格式与差异检查通过；全量 Node
checkpoint 为 1743 项，1572 通过、171 明确能力跳过、零失败／取消。
颜色的浏览器能力跳过另有指定实际浏览器的 12/12 证明，不把 skips 算成功。

根证据在 `/tmp/morphz-exchange-input-owner-root.1ZYkPK`，独立 Git／
完整实际接线与失败证据在 `/tmp/morphz-exchange-reference-consumption.FkXFTv`。
Reader 的旧 onCompose 虽保持传递，真实 UI 仍走 textQuotes.comment，
不能将兼容端口测试说成该入口实际调用。script／web／surface 回跳及
迟到身份／授权变化目前只是完整原算法和受控端口证明，不冒称本组
真实页面／guest／权限已验收。原 App／Electron／原生最终验收未完成；
完整查询层、跨领域 presentation、全产品样式／role 与宿主拆分仍继续。

## 2026-10-04 引用／内容回归：现行输入关联与真实 Host 能力

字节不变的七份原页面文件在引用迁移前后编译各 23/26：三项
`content-workflow` 都先找已折叠的 `.composer-meta .context-chip`。
现只核实际非展开入口 `.composer-scope-label` 可见，以及原精确项目／
`v1`／`v3` 的 title 和 aria-label；不接受最新 `v4` 代替旧草稿关联。
这三处反向恢复与实际 Git `b5f698dd` 原全文字节一致，旧失败保留。

只校准定位后，旧编译 25/26：首例用未配置 Runtime 的公共测试中心，
却只在 runtime-navigation／history JSON 中模拟 configured，真正命令
准备读原 Boot 后只保存，不触发原 messages 断言。现在仅首例借已有
project-conversation-fixture 的已配置、停止派发 Host，用页面真实
origin／cookie 获取 Client。原路由模拟、迟到 gate／finally、202 ACK、
请求项目／会话／正文／意图／附件和 A／B／全目录草稿断言全部保留。
另外两例的 Host 未改。独立有限逆变并统一机械对象换行后，与 Git 原
文件全文相等；两份既有 Host 夹具字节不变，不生成模型回复。

旧 input-tools 负例的全局 drafts 替换在新接线后误击 reference factory。
只将两个替换字符串限定为原 `drafts…currentContext` 连续位置；旧门禁
算法、固定摘要、拒绝规则和断言不变，独立逆变全文与 Git 原字节一致。
旧失败另存，限定后原 14 项门禁通过。

最终同一格式化源码的七份页面文件在固定旧／新编译各 26/26，逐例
核三份 HTTP 资产与完整 SHA，零重试／flaky／skip。spec SHA 为
`352cebb9735eda24bee8db235b84986f8c5936c0fde881244cf96ee1c65de2ea`。
证据在 `/tmp/morphz-exchange-input-owner-root.1ZYkPK` 的
`reference-old`、`reference-original-candidate`、`reference-calibrated-baseline`
及最终 `reference-formatted-*` 报告。额外 Electron 用例明确不纳入本
headless 矩阵；此处是真实隔离 Host／HTTP／领域存储的准备与受控 ACK，
不证明被拦截发送的服务端持久化、真实 LLM／Session 或用户原 App。

## 2026-10-04 独立缺陷修复：恢复录音停止按钮的红色提示

用户另行授权恢复停止提示，不作为外观不变重构的隐含修改。只将
`workflow.css` 的录音规则从已不存在的 `.composer-media-tools` 改为
真实 `.composer-action-trailing` 直接按钮；原明／暗红色值不变。
App／Client、DOM、图标、尺寸、间距、草稿、焦点和录音行为未修改。

阶段 18／19 的固定旧／新媒体组合均为 27/28，同一原听写红色断言失败；
保留两边原红项。修复后，六份现行媒体文件完整组合 28/28，原听写断言
未改，逐例核三份实际 HTTP 资产；两条已撤下的独立转写用例仍明确不纳入。
实际 StrictMode ComposerActionBar 配完整生产 CSS 的新回归 12/12：
四种 accent × 明／暗、录音／停止后的恢复、无旁路红色泄漏、ARIA、
焦点、32px 按钮／16px 图标及原 coarse pointer 44px 点击范围。
挂载 fixture 的麦克风 JSX 与真实 App AST 一致，不替换领域组件。
全量类型、限定格式、差异检查及冻结编译通过。

单行 selector 反向修复后与 Git `39cf13cf` 原 workflow 全字节一致。
修复冻结 JS SHA 为
`0ba86a23fbac2a0edc96a0754d739bd8df93e47015e5416afdc3d1b36467a10a`，
CSS SHA 为 `e6b379574f4d92d9365df6784204f9fce42a567e640908fb2d1aae3585828fd4`，
preload 原字节不变。证据在 `/tmp/morphz-dictation-recording-color.3XXvwe`
及 `/tmp/morphz-exchange-input-owner-root.1ZYkPK/media-color-fixed-candidate*`。
编译页面中的采集／ASR／截图仍是受控端口，不冒称原生权限、真实硬件、
供应商或原 App 最终验收通过；整体架构目标继续。

## 2026-10-04 前端阶段 19：Reader 四查询的完整算法所有权

`data/reader-reads.ts` 完整拥有 `readReading`、`readingContents`、
`readingState` 和 `readingMarks`，真实 Client 直接公开同一 owner 方法。
借原 current／protectedReadGeneration refs 与 applicationCall；构造
无读取、缓存、发布、订阅或新状态。目录、原文、状态与分页标注的不同
取消／身份检查／schema 顺序全部保留，不用统一 wrapper 改变原合同。
OCR、Reader 写命令、import、授权清理、refresh 和 Boot 发布仍在原 owner。

固定 `39cf13cf` 原 Client SHA 为
`74888eb42c5ca575eee39c8064b9e9f9821ba8f6225957101065bf6822d691eb`。
独立 Git 证明四个原函数文本及 AST 与新 owner 完全一致；固定 oracle
不依赖新函数，CI 不调用 Git。新有限接线门禁、合法反例、实际 Client
HTTP／SQLite、三份字节不变的原 Reader 回归和相邻 content／script-editor
旧门禁共 59 项，57 通过、2 PostgreSQL 能力跳过、零失败／取消。

最初相邻 script-editor 反例测试全局替换第一个 applicationCall 端口，
新 Reader factory 位于其前方时误改 Reader，旧失败另存。最终仅将
inert Reader factory 放到 script-editor 后方，不改算法或旧测试；
独立 proof 核最初与最终冻结的唯一差别就是声明位置。最终 Client SHA 为
`21c02ad3c622262f768fda0a0022e6acccf811d42a43f507cfa2c4f620d8e505`，
owner SHA 为 `8c37baa1b9a065f2db879276da0f1bd7c1e44ac8749921340b21d0b1ee4d9d7a`。

四份原 Reader 页面文件在阶段 17 旧编译与最终输入／Reader 候选各
19/19；真实导入、标注／位置、迟到撤权、PDF、百万字与无隐式模型输入
原断言保持，逐例审计三份 HTTP 资产。另含导航各 53/53，媒体各 27/28
同一旧视觉红项；冻结 JS／CSS、全量 1719 项 checkpoint 与能力边界见
阶段 18。新的编译候选同时含两批迁移，不冒称 Reader 单独 bundle。
根证据在 `/tmp/morphz-exchange-input-owner-root.1ZYkPK`，独立最终
证明在 `/tmp/morphz-reader-reads-final.bWnbLc`，旧红项留在
`/tmp/morphz-reader-reads-proof.w4CI4s`。类型、限定格式与差异检查通过；
原 App／Electron IPC／原生权限最终验收仍未完成，不称完整 query facade
或整体前端架构目标已完成。

## 2026-10-04 前端阶段 18：输入工具状态、生命周期与命令实际消费

`host/use-exchange-input-tools.ts` 现由真实 App 消费，不是未接线 helper。
三组原 state/ref 在原位置注册；关闭语音命令在 startup return／键盘
effect 前，完整媒体命令在原 contextTitle 后。12 个原附件、麦克风、
目录、语音和截图 callback 使用同一命令 owner；原 JSX、条件、key/ref、
禁用、焦点、草稿写入、项目与导航归属不变。采集／ASR、上传与目录授权
仍归原领域组件／Client，不新增 store、权限镜像、effect 或网络请求。

实际接线发现原 Preferences 的 `artifactRevision` 是 `number | null`，
修复 owner 和固定旧适配端口的一行类型声明，不复制／转换原 prefs。
固定旧 21 处算法／初始化与 Git 对照保持，完整 App／Host JSX、81 处
React 注册与 16 个 effects 的旧摘要不重算。有限门禁分别检查实际导入、
原 render capture、直接消费、early/late 顺序及无条件注册；独立复核
曾发现条件分支／隐藏函数包住退休 hook 的合法反例可放行，现已按直接
宿主语句规则拒绝，保留反例，不用 parse error 充当拒绝证据。

根最终输入／实际接线组合 34/34；实际 React StrictMode 挂载 1/1，
覆盖原状态和语音／截图组件、有效 PNG 解码、合成采集及控制端口。
此前固定 Git／独立适配复核和根检查日志分别保留。冻结输入／Reader
checkpoint 的全量 Node 为 1719 项，1549 通过、170 明确能力跳过，
零失败／取消；完整 build、类型、限定格式及差异检查通过。

固定阶段 17 编译旧版与最终输入／Reader 候选的页面对照各为：导航 53/53、
Reader 19/19；媒体在仅校准截图菜单入口后，各为 27/28，同一原听写
红色停止提示失败，未改原听写断言。两条明确撤下的独立转写用例不纳入
此现行入口矩阵，保留原用例，不恢复 UI、不称其能力已验收。媒体采集、
截图和 guest bridge 是受控端口，不能据此声称系统权限／硬件／供应商通过。

页面逐例核三份实际 HTTP 资产及完整 SHA；旧 JS 为
`46e1568adc6eb59a6207959f73e1cc19093dc31ce08e9b9016a5bf75869c62a3`，
新 JS 为 `44f29131c9d1c182d19de94f10482788a414e37e4bcf839ba6c1d2cb59bb5283`。
CSS 仍为 `6b1af0246ec4f33cf7cf5de0e3fb00d4cb9158e16d257d5fbc390293feb2027d`，
preload 仍为原字节。新冻结资产同时含 Reader 迁移，不能称输入单独 bundle。
根证据在 `/tmp/morphz-exchange-input-owner-root.1ZYkPK`，输入独立接线
复核在 `/tmp/morphz-input-tools-consumption.SX5G2V`。用户已另行授权恢复
听写红色提示，作为后续独立缺陷修复，不混入此不变迁移。原 App 的
定点退出恢复与最终原生验收仍未完成，整体前端目标继续。

## 2026-10-04 截图回归：使用已确认的输入添加入口

字节未变的 `capture.spec.ts` 在固定阶段 17 编译旧版及最初输入／Reader
候选上都因未打开“添加输入内容”菜单而找不到截图按钮，原失败报告保留。
测试现只补原 `openComposerMedia` 入口，并将取消焦点核为常驻 `+`：
原 `MessageAttachments` 明确先聚焦这个按钮，再开启截图面板。独立复核
确认反向移除 11 处菜单打开、4 处焦点目标及 helper import 后，测试与
Git `39cf13cf` 原文件逐字节相等；原预算、modifier、草稿、保存、上传、
对象关联、遮罩、guest、重选与失败断言未改，不恢复撤下的 UI。

同一校准文件在旧版 10/10，新最终媒体组合内截图 10/10，逐例核实际
HTTP 三份资产及完整 SHA。测试文件 SHA 为
`edfc536b5063fbf4fa90669a14eaecf32409add9ac3298efd862c1ca87cf8df3`。
证据在 `/tmp/morphz-exchange-input-owner-root.1ZYkPK` 的
`capture-original-*-browser-fixed`、`capture-calibrated-baseline` 和
`media-final-candidate` 报告；错误 Chrome 路径导致的首次启动失败另存，
不算产品失败。测试用受控桌面截图／guest bridge，不能替代实际 macOS
选区、系统权限或原 App 验收。完整媒体组合尚各有一项相同听写视觉红项，
不据这项入口校准称全媒体或整体前端验收通过。

## 2026-10-04 前端阶段 17：导航生命周期与回执的宿主所有权

`host/use-workspace-navigation-host.ts` 成为 preferences、recent-content 和
navigation 注册的唯一 owner。原键、初始化、偏好合并、原 state/ref 与 trail
算法保留；只捕获 center／principal／CSRF 三个身份原语，不保留保护 Boot、
正文、草稿、目录权限或 pending 请求。同身份刷新清空保护投影时仍卸载
完整私有工作树，Host 本身可以接续已发起的导航；登出、身份／CSRF 更换、
Host 卸载及 StrictMode 退休代次都使旧回调失效。

两个实际零 DOM sibling 在 private child 之前提交 Host／origin layout lease；
不在 render 写 active、不增包装 DOM、延迟 effect 或 insertion effect。
普通 private 草稿、焦点、弹窗和提示回调不能移接新树。导航的 mandatory
continuation 按当前授权投影核项目、原件／确切版本与应用实例，并在真实
函数 updater 执行时再核 lifetime／目的地；没有仅测试使用的 fallback。
新建项目只接续原 default-conversation 位置，不自动创建 Session 或迁走草稿。

根最终导航／门禁／实际 React／图片边界组合 106/106，零跳过、失败和取消；
全量 Node checkpoint 为 1672 项，1502 通过、170 明确跳过、零失败／取消。
浏览器可用性、PostgreSQL 与原生能力的跳过仍是能力边界，不称全部集成通过。
完整构建、类型、限定文件格式和差异检查通过。

独立复核发现上传后使用 navigation generation 作为图片创建准入，会在
普通换页时取消已经明确选择的原项目创作。本轮修正为 upload 后仅核原
private origin；原 Client／服务继续核写入授权，创建后才用 generation 抑制
迟到打开。真实生产函数、固定旧函数与修复前反例的控制端口回归 9/9；
这不是 HTTP 上传字节、原生选择器或服务权限证明。

固定 Git 的原导航／draft／prepared oracle 和 `cb7246a2` App／Host
DOM、hook、effect 摘要不重算。新 Host／origin 身份、schema/defaults、
inert 构造、两阶段 updater、实际 Lifetime import→JSX symbol、唯一 state
及返回端口单独严格核后才允许旧树有限展开。再审曾发现六个合法反例被
旧版门禁接受，已补各自具体拒绝规则，不以 missing target／parse error
冒充拒绝。真实 App 边界函数挂载包含 child-layout、同身份 clear、身份
ABA 与放弃 Suspense render；其 private WorkspaceApp／Client 为控制端口，
不能独立当作完整生产 App 或权限验收。

完整编译 App＋真实 Client／隔离 HTTP／SQLite 的跨页面矩阵最终 53/53，
零失败、跳过和 flaky。固定旧 53 项为 52/53，原创建项目后无 heading
的失败保留；同一最终校准导航用例在旧版仍失败。校准只替换撤下的
`.context-chip`：保存后核当前关联的确切标题，同时在已保存消息中核 v1
引用，原正文、页面、草稿、Session、预算仍在。曾错误套用未发草稿的
v1 scope 造成的中间红项及 trace 也保留；不改生产去迎合该错误假设。
此无 Runtime fixture 的消息是本机“已保存／未发送”，不冒称 Host 投递。

另一个字节不变的原剧本归属用例，旧 Host 为“全部剧本”失败，新最终
Host 1/1，通过新项目标题、两部剧本、原件／未保存草稿、刷新恢复和
无多余 Session／输入的原断言。逐例核真实 HTTP 三份资产 200 和完整 SHA，
最终 JS 为 `46e1568adc6eb59a6207959f73e1cc19093dc31ce08e9b9016a5bf75869c62a3`；
CSS 仍为 `6b1af0246ec4f33cf7cf5de0e3fb00d4cb9158e16d257d5fbc390293feb2027d`，
preload 也保持旧字节。私有 fixture 仅替换 webRoot，不替换 API／领域模型。
首次矩阵的可变私有资产／source-only topbar 观察配置错误报告另存，不算旧新证明。

根的构建、专项／全量日志、固定旧新报告、逐例真实资产审计与失败 trace
在 `/tmp/morphz-navigation-host-root.1fJOBs`，最终编译／矩阵用 `upload-fix`
命名；门禁最初冻结与再审、图片固定 Git 证明分别保留独立目录。Topbar
5/5 是实际隔离组件和 CSS zoom，不冒充原生桌面缩放；本轮未改变 UI 图标、
布局、动效或视觉规范。原 App 仍待定点退出恢复授权，没有开第二个人工
App／profile／center，也没有终止独立 Runtime。输入工具新 owner 尚未
接线，不混入本阶段提交；其余宿主、数据展示、共享组件及样式迁移继续。

## 2026-10-04 内容目录回归：核对已撤入口与现行输入关联

固定旧／新内容读取 Host 的最初结果仍各为 6/8；原报告及失败 trace
保留，不追写为成功。源码与现行规范核实 `36975394` 撤下工作空间菜单，
`acf76a53` 又明确撤下最后的当前理解入口并要求不迁到别处。此次测试
校准核三种旧控件／面板连隐藏节点也不存在，保留原件、草稿、四类原记录
及 delivery 不变的原断言；不恢复 UI，不以直调 API 冒充旧面板可读验收。
底层理解版本、授权 API 与原数据仍保留。

另一项只将已失效的 `.context-chip` 定位改为现行 `a4018e48` 的输入
关联语义标签，限定原 AI 输入区与确切标题／v1；原 focus、正文、引用版本、
草稿恢复、不创建 Session／不发送及返回视图断言、预算不变。两项不是
新读取 owner 引入的产品缺陷，也不借测试校准改变生产行为。

校准后同三份原页面用例在两份冻结编译 HTTP／SQLite Host 各 8/8，
零跳过、失败和 flaky。逐例核实际收到的三份资产 HTTP 200 及完整 SHA；
旧 JS 为 `789a59a5aac3335bf44c2bf86f57c1243e4d180631232c81ead913e7dd1dd566`，
新 JS 为 `0ddb3b0a81085e07cedddcaefc3178bdd37807ba5c0a14ee536cf3c5ddfe7898`；
CSS／preload 仍为原字节。校准内容 spec SHA 为
`19d33a8ba45d49cff7a49fa4b8e745b4b1c87c64ab0290107247a22b4cb2a462`。
证据在 `/tmp/morphz-content-owner-host.QIqQq8` 的 `baseline-fixed`／
`candidate-fixed` 日志、完整报告与逐例资产附件；最初 6/8 另存。
此对照冻结在导航生命周期新接线前，不证明后续导航修复、原 App 或
整产品已验收；整体架构目标继续，未推送新提交。

## 2026-10-04 前端阶段 16：授权内容读取 family 的单一 owner

`data/content-reads.ts` 实际承载目录分页／计数、当前理解读取、目录记忆、
原件解析和确切目录项解析六个原算法。Client 借出原 platform、current、
protected read generation 与目录缓存 ref；初始化、身份与撤权清理、refresh
和投影发布权威仍留 Client。构造无 I/O／effect／订阅，公开 getter 直接
引用 owner，剧本读取也消费同一个同步 remember 方法，不保留第二套算法。

原目录 live read、历史版本合并、事项 fallback、404 的不同守门、缓存
原序与 149 条非 head 尾部、15s deadline 和一／两次 refresh 顺序保留。
三处原件发布仍同步先写 current 再提交 React；不新增 await、去重请求、
共享 broker、偏好键或 renderer 权限权威。普通三种查询也不被偷偷加上
与原实现不同的身份策略。这是完整六方法读取 family，不是整个查询层。

固定 Git `84de08bb` 六函数 oracle 与合法解析的 30 个有限反例核实际导入、
borrowed ports、唯一消费、无副作用构造、同步发布及原初始化／清理。
根独立相关测试 26/26，包含真实 Client＋隔离 HTTP／SQLite 的 head／历史
正文、版本 union、较新目录后的迟到正文及同 CSRF 撤权拒绝。SSR 仅用于
初始化真实 Client refs／方法，不当作挂载 UI 或原 App 证明。
根全量 Node checkpoint 为 1630 项：1463 通过、167 明确跳过、零失败／
取消；包含浏览器可用性和原生焦点能力边界，不能声称全部集成通过。
完整构建、类型、这六文件格式与差异检查通过。

固定旧／新编译 HTTP Host 三份原页面用例各 6/8，保留两项相同红项：
旧测试仍点击已撤下的「工作空间选项／当前理解」入口，以及等待不再
被当前 ComposerScope 消费的 `.context-chip`。没有删除原数据／版本／
草稿／无发送断言，没有为变绿恢复旧 UI 或增加等待预算。后者的现行
语义定位与前者的不可达入口分别继续审计；本批不能称页面矩阵全绿。
每例真实响应核三份资产 HTTP 200 和各自冻结 SHA；新旧 CSS 仍完全同字节，
SHA256 为 `6b1af0246ec4f33cf7cf5de0e3fb00d4cb9158e16d257d5fbc390293feb2027d`。

根构建、全量及相关日志、两份完整报告与失败 trace 保存在
`/tmp/morphz-content-owner-host.QIqQq8`。这批只迁读取算法，没有 JSX、图形、
布局、动效或原生权限变更；有限等价证据不代表整产品与原 App 验收。
原 App 仍待定点退出恢复授权；导航接续、其余宿主／领域呈现／组件及样式
迁移保持目标进行中，未重启独立 Runtime 或推送新提交。

## 2026-10-04 前端阶段 15：交流读取范围与已读回执 owner

`conversation-read.ts` 统一输入归属及对应交付筛选；App 的局部提示与整段
回执仍是两个范围，未聚焦时保持原消息数组引用。Conversation 明确使用
原始的始终 filter 策略，保留局部／全部历史、分组、时间排序及
`items.flatMap` 回执顺序，不把提示范围冒充已经读到的内容。

`host/use-exchange-read-receipts.ts` 承载原惰性初始化、稳定 acknowledgement
及两个提交 effects；三个调用仍位于 App 原注册位置。合法存储不读 Boot，
缺失／损坏存储仍初始化完整 Boot 的消息、文档与剧本交付。原存储键、
捕获身份范围、functional updater、effect 顺序／依赖和失败提示保留，
没有增加缓存、监听、请求、状态副本或客户端执行事实。

固定 Git 4ce98b64 oracle、真实消费的有限门禁及相关读取测试通过；门禁
保留此前 cb7246a2 JSX／lifecycle 基线，仅核准后展开这三个 owner 调用。
21 个合法解析反例检查假绑定、镜像、错误存储、聚焦 Bootstrap、错误依赖
及新增 lifecycle。固定旧新编译 HTTP／SQLite Host 四份用例各 25/25，
实际响应逐用例核 JS／CSS／preload；原 CSS SHA256 仍为
`6b1af0246ec4f33cf7cf5de0e3fb00d4cb9158e16d257d5fbc390293feb2027d`。
此批不修改原 JSX、图形、动效或样式，有限对照不代表全产品验收。

实际 React StrictMode 挂载使用内存展示事实与真实浏览器存储，核完整
初始化、稳定回调、发布别名、dialog／scroll／历史范围及卸载清理的旧新
完整事件对照。默认主用例不依赖原生前后台激活；独立能力测试保留原
失焦／可见性／后台未读／返回已读断言，以 `MORPHZ_TEST_NATIVE_FOCUS=1`
明确启用。根环境三次真实失败／超时均保留，不能声称该原生分支通过。
默认挂载中的焦点模拟也不等于用户 App 的原生焦点验收。
根最终相关用例 33 项：32 通过、上述原生能力 1 项明确跳过，零失败／取消。

证据在 `/tmp/morphz-exchange-read-host.1WSe7v` 与
`/tmp/morphz-exchange-read-owner.xCPhQG`。完整构建、类型、格式及差异检查
通过；原 App 仍卡在退出清理，等待定点恢复授权，独立 Runtime 未终止。
项目关联接续缺陷及其余读取／命令、领域展示、组件和样式 owner 继续推进；
没有把本批提交称为整个前端重构或原窗验收完成。

## 2026-10-04 对话回归：沿用已确认的浮动应用 Dock 入口

对话常驻输入用例仍悬停已撤回的「输入工具」group；现有生产入口是独立
`.application-dock`。仅更新该悬停定位，后续控件不存在、常驻输入、Escape、
快捷键、草稿、刷新及窄窗几何断言不变，不修改生产界面或等待预算。

固定旧版与未读拆分候选各跑四份原页面用例 25/25，逐用例核实际 HTTP
JS／CSS／preload 字节；主服务和项目用例的独立 Host 均指向各自冻结资产。
早期探针注册顺序及项目夹具静态根遗漏造成的观测失败保留，未记为产品
通过或失败。证据在 `/tmp/morphz-exchange-read-host.1WSe7v` 的
`baseline-fixed-root-report.json`／`candidate-fixed-root-report.json`。
这只是旧测试入口迁移，不代表未读重构、整产品或原 App 验收完成。

## 2026-10-04 剧本目录回归：跟随已确认的 Agent 创作合同

旧目录场景仍期待「生成前需确认」，与用户已经取消的 Agent 创作限制
冲突。仅把该展示期待改为现有「不影响先写正文」，另核实际资料来源与
使用说明入口；后续上下文新建条目、键盘确认／取消、正文、草稿、目录
折叠及刷新持久断言不变。没有恢复许可开关，也没有修改生产行为。

完整编译 Host 的目录场景、资料说明独立持久化和准备失败保留三项 3/3，
沿用隔离实际 Platform／SQLite。证据在
`/tmp/morphz-script-creation-contract.hqnSPA`。此项只修旧测试合同；
另一个项目归属成功后页面未接续的真实问题仍在排查，整体目标及原 App
最终验收保持未完成。

## 2026-10-04 剧本文稿保存：完整生命周期的焦点恢复

独立于查询重构与 Dock 视觉变更，`ScriptStudioEditor.save` 仅增加八行：
保存开始时捕获实际触发所在 `.script-editor` 与原焦点，在命令、编辑模型
及精确正文读取、清洁草稿持久化全部结束后，再用既有 `scriptFocusReturn`
恢复。原 `run` 的早 RAF 留在原位，helper 继续保护新焦点、卸载、inert
及打开模态，不全页搜索另一编辑器，不改 DOM、hooks、样式、查询、权限
或命令。成功后原 Save 已 disabled 时回原 anchor；读取失败仍保留草稿
及可用原 Save；用户已经移到可用较新控件时不抢焦点。

诊断使用固定旧／候选 HTTP 资产和同一原断言，焦点事件证明旧失败不是
窗口失焦：早 RAF 先恢复 Save，随后清洁草稿禁用同一按钮，focusout 到
body。真实 StrictMode Editor 的可控延迟末次读取四例 4/4；固定旧 Editor
以完全相同断言测试 3/4，唯一红准确复现这一竞态。夹具模拟 run/read
端口，不代表实际 Runtime／模型或原窗；最初的旧模块别名装载错误另存，
不计为产品缺陷复现。

完整候选构建后，原 674／1584 两场景四轮共 8/8，断言与 5 秒预算原样；
五份原剧本页面回归为 20/22，剩余项目关联与撤回创作限制的旧期望正在
分别排查，未把综合矩阵说成全绿。typecheck／build／格式／差异检查
通过，没有把失败修改为不再检查焦点。

证据在 `/tmp/morphz-script-focus-causal.rUm6w3`；冻结候选
`fix-candidate-web` 包含已核查询拆分与 Dock，其 JS `app-BlOPPzCv.js`
SHA256 `60ce6cba24e6f7f9903d4b516323274b4fe5bf81602b8d1eea72d00ec2b0d098`。
原 App 正常退出资源已收尾，但原生清理卡住，正等待有针对性的退出恢复
授权；当前原窗不能据此称为已验收，整体前端目标保持进行中。

## 2026-10-04 Dock 裸图标：用户授权的独立视觉调整（原窗待恢复）

仅 Dock 内部改为透明按钮与 22px 图形，移除常态／悬停／选中／按下的
矩形底座，当前应用用 3px 小圆点表示。原按钮 32px、粗指针 44px，分组
位置、手势／放大算法、应用及 Launcher 彩色身份和右侧面板按钮不变。
22×1.38 的峰值绘制为 30.36px；滚动区域的 4px 纵向绘制留白以负 margin
抵消，原按钮与分组矩形不变，末端插入标记补偿后仍是原 24px。图形不
参与扩展命中，不以放大后的绘制区域替代点击区。这是用户明确要求的
视觉变化，不混入“当前 UI 不变”的架构证明，也不是全产品新尺寸规范。

真实生产 Dock 组件与 source CSS 的隔离挂载 27/27，原 23 项保留；补充
明暗透明状态、原几何／边缘命中、放大至少 1.3、滚动两端不裁切、原
插入坐标、空／紧凑／触控、减少动态和真正 SVG／PNG 节点引用身份。
原 Node 手势／偏好 9/9；完整编译 Host 的拖拽／边界五项 5/5、应用图标／
输入布局／错误布局十六项 16/16。包含原四色亮暗身份、键盘、刷新草稿、
窄窗／触控／200% CSS zoom；CSS zoom 不等于原生系统缩放验收。

首轮图标两项红明确仍断言 Dock 14px；仅三处 Dock 图形期望按授权改为
22，原 32px 命中、非 Dock 图形及其余身份／草稿／零写入断言保留。
旧红、trace 与后续十六项通过分目录保留，不放宽颜色或画面比较来掩盖
变化。实际组件明暗截图已人工检查，不能拿它替代完整原 App 画面。

构建及类型通过，只有原 OpenCV／大 chunk 提示。组件证据分别在
`/tmp/morphz-dock-bare-icons.610BU4`、
`/tmp/morphz-dock-node-identity.pgXLLm`，Host 证据在
`/tmp/morphz-script-editor-query-owner.C44S7d/dock-host-*` 与
`dock-surfaces-*`。原 App 的启动／原生退出清理问题正单独恢复，尚未
在该原窗确认裸图标；独立 Runtime、profile、center、数据和在途工作
没有因此被替换。

## 2026-10-04 前端重构第十四阶段：剧本编辑读取与缓存 owner（原窗验收待恢复）

`data/script-editor-reads.ts` 实际承接十二个剧本编辑读取／同步 getter、
版本标题读取、目录分页回调和原缓存的插入、FIFO 淘汰与清理。Client
保留原两个 Map ref 的初始化位置、完整身份／代次检查及真实 Platform
来源，向 render-local 的惰性 typed factory 借出 ref 与语义端口；三个原
授权清理位置同步调用同一 `clear`。公开 API 直接返回 owner 方法，没有
新增 Promise wrapper、effect、订阅、请求、存储或全局状态。Client 从
3003 行变为 2673 行；行数不是该阶段的完成标准。

固定真实 Git `4ce98b64` 的十二方法及完整 session guard 经独立 AST
核对，包含 unary／binary 标量运算符。原 64／512 FIFO 上限、空标题
cache hit、暖读取仍 resolve／head 的顺序、解析后才检查、manifest 子
读取各自 capture session、early-null 分支及同步 getter 零 I/O 保留。
有限门禁 2/2、42 个独立解析反例；只接受指定 AssertionError，不把
parser 或程序错误计为规则拒绝，不锁整个 Client 文件。

读取行为及既有 reader 20/20；真实 React SSR Client＋隔离 HTTP／SQLite
五项，固定旧 Client 与候选均 5/5。覆盖实际缓存／请求序列、登入退出、
同 CSRF 下撤权与再授权，以及已返回 200 的迟到版本解析。SSR 没有运行
挂载 effects，不能据此声称完整宿主生命周期通过。

实际保存的旧编译包与阶段十四候选的 opt-in Host 对照，1440px 明暗两例
共十二对阶段通过；old/old 两例先校准。概览、导出标题、当前正文、历史
v1、未保存草稿与检查页严格核文字、值、图标、computed 样式／几何与焦点
标签，原生产快照前后相同、零输入／剧本内容写入。Host 原 app-view 导航
写入另行披露。保留 raw PNG，沿用有 AA 盲区及一阶 RGB 校准的有限 paint
oracle，不宣称 raw RGBA 全同、所有窗口或原生 App 已验收。

阶段十四候选 JS `app-BZX3UW9i.js` SHA256 为
`3bc96b3d32990ade2eb2fef619be106f1de725939506494cb6e3e36baf6a8a83`；
CSS／preload helper 与真实旧包字节相同。各对照实际核 HTTP 200 及响应
SHA，不以磁盘包代替页面加载。冻结时全量 Node 为 1592 项：1427 通过、
165 条可选集成跳过、零失败；typecheck／build／格式检查通过，跳过项
不是 Runtime、模型或原生验收。证据与失败报告分开保留于
`/tmp/morphz-script-editor-query-owner.C44S7d`。

五份原剧本页面回归旧版 17/22、新版 18/22；不能把综合矩阵称为全绿。
共同失败包含项目关联与已撤回创作限制的旧期望；焦点红项的位置会变化。
独立固定资产重复验证已在旧版同一保存断言复现：早 RAF 恢复 Save，随后
清洁草稿使同按钮 disabled，焦点回到 body，原 anchor 一直可用且窗口未
失焦。该保存生命周期缺陷另行修复，不修改旧断言来接受重构。

原 Morphz 本轮已可操作，不再以历史锁屏当作当前理由。其后实际原窗进入
启动读取错误页；正常退出时已关闭中心 DB／Host／TCP，进程采样停在
Node 原生 Environment 清理。初始 storage_error 尚未归因，未清库、缓存、
配置或重启独立 Runtime。已请求有针对性的 App 退出恢复授权，原窗验收
及整体前端目标仍未完成。用户另行要求的 Dock 裸图标不混入本阶段不变
CSS 的对照证明。

## 2026-10-04 前端重构第十三阶段：主体检查器状态、现场记忆与动作 owner

`host/use-subject-inspector.ts` 实际承接 all-work／execution／summary／
mobile collaboration 状态、按工作现场的详情 Map、原记忆 layout effect、
五个纯派生值及完整打开／关闭／分类／Logo／原消息详情／返回／范围／
批注切换动作。四组 hooks 与记忆提交留在原相对位置；不是只抽取 JSX，
也不新增全局 store、storage key、请求、效果或领域授权。App 减少 83 行，
仍负责唯一 prefs writer、真实批注读取及 DOM 焦点，导航／输入的原清理
消费同一 owner 的 typed setter。

close 仍在 startup return 前可用，关闭后由 App 同步端口最后安排原 RAF
焦点回退。活动总览先 prefer 再 keep-open，消息详情先 keep-open 再 prefer；
原功能 updater、scope 对象和 setter identity、捕获的 prefs／Client、非
活动分类保留详情、all-work 保留、异步历史回执及错误语义均不强行统一。
没有趁重构给旧 history completion 添加新 navigation／身份 guard。

初版纯派生抽取使 TypeScript 丢失 collaborationVisible 对 artifact 存在的
关联证明，暴露三处旧批注表达式 nullable 错误。修正仅在原派生 seam 保留
`!!artifact` 类型见证；完整原逻辑仍由 owner 计算，批注 JSX／读取和消息
分支不改。不是可选链化错误来掩盖新路径。

根线程从真实 Git `85a50934` 独立核对渲染 AST：除六个已验证的命令消费
seams，整个主 return JSX 相同。新编译 CSS SHA256 仍为
`552d58cb432d3559ca7b754f8839ca2e9305c2ce726543970e6005c25841f3d9`。
旧编译 Host 七文件 **30/30**，新编译同一组原断言 **30/30**；实际 HTTP
入口资产响应 200／SHA 已核对，不以磁盘包替代浏览器加载证据。

固定旧 oracle 的 17 个实体、四状态初始化、Map 与记忆 effect／deps 经
Git 独立实核；额外标量核验纳入 prefix／postfix operator，避免把不是
`forEachChild` 子节点的逻辑运算符遗漏。行为对照 **21/21**，含 640 组
展示组合、setter／scope identity、真假／缺失／null／undefined 快照、
同步 throw／异步错误、原 Promise 顺序和迟到来源。真实隔离 StrictMode
挂载 **1/1**，核初始值、稳定 ref／setter、A/B 现场记忆和执行／摘要／
批注优先级、关闭恢复、无关重绘、真实 unmount／remount，零 fetch/XHR。
独立完整生产 AST 展开后 81 个 hooks／effects 注册顺序、24 个未迁移本地
函数及原 RAF 焦点语句相同；不是以单个动作 trace 代替 React 生命周期。

新增 opt-in `subject-inspector-equivalence.spec.ts` 消费保存的旧编译包与
实际候选 manifest。四个有限明暗／1440 与 390 窗口组合，每组总览、详情、
关闭重开、返回及四分类共七阶段，**4/4，28 对阶段**通过；old/old 先校准
4/4。computed 几何／paint declarations、图标、选择、正文、草稿及原
input DOM identity 严格相同，零发送／应用写入，实际 input／delivery 与
会话目录前后相同。PNG 保留原图与 raw 差异诊断，沿用有 AA 盲区及一阶
RGB 校准的有限 oracle，不能宣称 raw RGBA 全同或完整平台／原生矩阵。
受控部分仅为已完成 Runtime 活动呈现，身份／导航仍为隔离真实 Platform；
没有模型请求、伪造实际执行回执或更改生产 motion。

截图写入探针经独立复核扩到全部非 GET/HEAD 的 Platform／input 请求，
包含真实 app-views launch／save／close；这暴露原 Host bootstrap 的一次
personal-space ensure。测试单独严格核这条原初始化回执，信息栏操作区间
仍须零写入，不把初始化 API 从探针隐藏。原 narrow-probe 通过与完整探针
暴露初始化的四红报告保留，修正后的完整探针四例全部通过。异常时嵌套
finally 关闭浏览器 context，不静默吞掉读取或测试失败。

主体门禁四项、原交流控制门禁四项及原导航消费门禁八项，在冻结后全量
检查中通过。新增 32 个主体反例、三个记忆提交反例及 15 个导航消费反例；
原反例保留。反例先独立解析，只接受指定规则的 AssertionError，标量
operator 也纳入比较。旧导航基准的 196 JSX／14 roots、81 hooks／16
effects 与摘要不变；仅展开真实 import-bound owner，并归一六个已核消费
seams，不用新摘要接受漂移。

首轮全量为 1565 项、五失败，分别为尚未适配迁移的两个旧导航消费检查、
记忆 effect 表达式比较、TypeScript 7 的属性签名 API 名称及 null 回执修正
期间的固定 fixture 摘要。原红报告保留；修正实际绑定／AST 比较、兼容
API 和冻结摘要后重跑，没有删除断言、刷新旧基准或隐藏异常。最终全量
**1570 项：1405 通过、165 条可选集成跳过、零失败**，70.6 秒。跳过包含
一条本机默认 Chromium 缺失的新增挂载测试；已另用实际安装的浏览器执行
该项并通过，不能将跳过项称为 Runtime、模型或原生验收通过。

最终 typecheck／build、受影响文件格式及空白检查通过。最终磁盘资产
再次与已实读 HTTP 的对照 manifest 核同，新 JS `app-C3_7G4YY.js` SHA256
`d892c329627e19446ace0292364e47ad824e8a6de9caee0d11fc0b2b9aedf1c1`；
CSS 与 preload helper 字节保持旧编译包不变。构建只保留原 OpenCV 外部化
及大 chunk 提示，不以源码／静态包或全量 Node 代替实际窗口验收。

源码与资产证据、原回归／校准／候选画面 reports 分开保留于
`/tmp/morphz-subject-inspector-owner.1kGG4B`。原 App 本轮只读 computer-use
确认仍被系统锁屏拦住；未重启 Runtime、换 profile／center、修改锁屏设置
或解锁。原窗口及整体架构目标尚未完成。

## 2026-10-04 前端重构第十二阶段：交流 frame 样式唯一 owner

`exchange-layout.css` 实际承接原 56 条规则／144 项声明（包括已迁的 23 项
伸缩几何），统一画布避让、阅读／输入排列、控制区与 Dock 外部锚点、断点
和伸缩命中几何。选定声明的值、important、条件及实际旧编译相对顺序均
保留。Dock 内部显隐／8px 悬停桥／拖拽／放大、材质／运动、通知、截图及
基础控件仍归原 owner；没有修改 JSX、hook、state、effect、协议或入口。

根线程直接读取 `b9906e0c` Git，独立核对固定 56／144 tuple、36 条保留
规则及五份旧源码 SHA；另对四来源完整 PostCSS 语义树做批准减法核对，
所有其余规则／条件／声明及顺序不变，main.tsx 字节相同。长期门禁只治理
有限 frame／已知例外及实际入口，不锁四份 CSS 全源，也允许消息与 Dock
无关后代演进。六项门禁通过，原 33 条负例保留，加 32 条，合计 65；违规
反例只接受 AssertionError，不把 parser／程序异常当成拒绝成功。

旧生产 JS／CSS 的原七文件 26 项为 25 通过、1 个系统前台窗口前置失败；
原 Dock 两类挂载合计 29/29。新真实 Host 合并矩阵 61 项为 60 通过、同一
原生前置失败；原 55 项逐项身份／结果匹配，新增六项自然活动波形、四主题
明暗消息按压／悬停与主体图形运动回归通过。没有删除或弱化原断言／预算，
原生红项尚未到实际 guest 输入交互，不能称 E2E 全绿。

新增 opt-in compiled Host 对照消费保留旧资产与实际 HTTP 新资产，不是
用新组件生成假旧 oracle。合成数据仅为消息，没有模型请求；检查草稿、
input／delivery 权威前后相同、零发送／应用写入、原节点与滚动 identity、
几何／绘制 computed 值、canvas clearance、真实命中及实际响应 SHA。
代表场景含桌面／窄屏／coarse、项目／工作台／对话、长消息／草稿及明暗，
不是全排列或原生 zoom。760×540 的 200% CSS zoom 另标已知旧限制，
只核对原裁切／遮挡事实，不 force click 或把它称为可用性通过。

首轮 raw RGBA 零差检查失败；相同旧 JS／CSS 的 old/old 六例也有四例
同样失败，边缘出现一阶 RGB 量化与 AA 栅格波动。有限动画完成、持续动画
暂停就绪及两帧后仍复现。新图像 oracle 明确使用原 PNG 的 AA 分类及同
alpha／每 RGB 通道至多 1 LSB 的量化校准，原始截图／差异摘要均保留；
非 AA 其他差异、尺寸和 alpha 变化仍拒绝。校准不能代替固定源码与严格
computed 检查，更不能声称所有真实边缘变化必拒或 raw RGBA 全同。
内部 comparator 依赖固定 Playwright 1.63.0，升级须重核，不进入生产。
原生 resize 先完成再施 fixture CSS zoom，避免旧 sidebar 的 innerWidth／
root.clientWidth 测量交错；不改 sidebar、min-height 或原生产 motion。

最终真实旧新对照 **14/14**，零跳过／重试：12 项支持场景加两项明确的旧
限制比较，64 对阶段截图与严格 snapshot。九项图像合同测试通过，包含
实色两阶／十阶、alpha、尺寸、1px 平移拒绝及 AA 盲区；另证明预归一邻域
会改变 AA 分类，因此生产测试 helper 始终先比较未修改原 PNG。
最终全量 Node **1541 项：1377 通过、164 条原有可选集成跳过、零失败**，
69.7 秒；跳过项不是 Runtime、模型或原生通过证明。typecheck／build、
受影响文件格式及空白检查通过，仅保留原大 chunk 提示。最后构建 HTML
及三份入口资产与对照 manifest 的字节再次核同，每个渲染场景实读响应
200／SHA，而不是只检查磁盘包。新 JS `app-BpOObY8v.js` SHA256
`703fcfb3094e95372764c7a84b448a5fa6a89cece9df5958d4df478917ac351a`；
新 CSS `app-B_zOsesV.css` SHA256
`552d58cb432d3559ca7b754f8839ca2e9305c2ce726543970e6005c25841f3d9`。
初轮失败、同资产诊断、旧／新回归、校准前后与最终 traces／报告分别保留，
不覆盖旧红项或以最终通过抹掉测量边界。

证据独立保留于 `/tmp/morphz-exchange-frame-owner.huXprX`。原 App 只读
复验仍为系统锁屏，没有解锁、改设置、替换 profile 或重启用户 Runtime；
原窗口验收与整体架构目标尚未完成，本批不是新视觉规范。

## 2026-10-04 前端重构第十一阶段：Thread 状态图形共享组件

`ExecutionStatusIcon.tsx` 实际接管活动列表与执行详情两处重复的图形映射。
消费方保留原状态事实、查询、标签及外层 span；静态尺寸仍为列表 19／详情
18，运行仍是原 `RunningActivityIcon` 的 24×24 双路径。缺省详情仍为
CircleHelp。没有新增 DOM 包装、state、effect、请求、存储、CSS 或 LLM 调用。
Task／Job／消息 delivery 的权威与显示合同不同，本批没有强并为通用状态。

独立 oracle 固定 `14ae1de6` 的两个 map、两个 ternary 和运行图形；根线程
另从 Git 读取旧实现，完整 AST 核验两个生产组件，仅归一批准的 map／内层
glyph，包含原 hook、Job 正文／控制及 JSX 的其余函数均相同。固定 oracle
的两个 map／ternary 与运行函数也逐项实核。不是让新算法验证自身。

三项 SSR／结构对照涵盖七状态及缺省、两个静态尺寸和原可访问属性；一项
真实 Chrome StrictMode 挂载比较旧／新外层节点、SVG／路径 identity，涵盖
无关重绘、同状态／尺寸变化、状态切换及卸载，无 eager fetch／XHR。
三项有限 AST 门禁校验真实 import binding／尺寸／原有限树及 hook 参数，
包含 17 个只接受 AssertionError 的定向违规反例。根线程合并 **7/7**，零
跳过；挂载 fixture 本身不加载执行 CSS，动画依据另见实际 Host 回归。

首轮旧 JS 原九文件 29 项为 26 通过、3 失败：一项仍找“执行目标”旧称呼，
两项直接点击按确认设计隐藏的消息 footer。仅改术语与真实 card hover
前置，原断言／预算保留，以 `263f41bd` 独立提交。旧 JS 再跑 28/29，
暴露暗色切换后约 59ms 就取色、尚未完成 110ms 颜色过渡的旧测量问题。
将 footer 既有有限 CSSTransition settling 原样共享给颜色用例，既不等待
持续光效、不固定 sleep，也不降低 4.5 门槛；独立提交 `7d407d17`。
外置 footer 的祖先背景合成测量仍有局限，不宣称本批解决全部色彩 oracle。

校准后再次消费保留的原生产 JS，而非重建假旧实现：隔离测试入口仅替换
index 的脚本引用，每项记录实际加载的旧 JS 200 及完整 SHA256。原九文件
**29/29** 通过；最终新 JS 同一 29 项逐项标题／结果匹配，另加原 Dock
23 项及 footer 9 项，合并 **61/61**，104.3 秒，零跳过／重试。
实际 Host 动画回归覆盖自然浏览器连续帧与减少动态；相关 Dock 25 项含
原 Host 两项，仍保持排序／拖入／拖出／取消、刷新、触控／键盘和悬停放大。

最终全量 Node **1530 项：1366 通过、164 条可选集成跳过、零失败**，67.8 秒。
其中新增挂载在默认全量中跳过，已由上述安装浏览器的 7/7 单独实际执行；
其他跳过不作真实 Runtime／模型或原生证据。typecheck／build、受影响源码
格式和空白检查通过，保留原大 chunk 提示。新页面 HTTP 核对 HTML／JS／CSS
均 200；`app-pazy4bUJ.js` SHA256
`ce03c5e8f250f913b1ef6746e7d32f6030a6939a9f2ab553126282b29228a38b`。
CSS 仍 `app-Bl-K6QYD.css`，字节摘要仍
`0a46e4301841e99b7c688123e4a07ff83e8ebd6b33918325331294aaad442648`。
原、新、交互及最终 traces／报告使用独立目录保留；测试服务正常关闭后
第二次 HTTP 检查拒连不算资产通过，使用此前成功 HTTP 记录及最终字节核验。
证据 `/tmp/morphz-execution-state-owner.UwWvkR`。

原 App 只读检查仍为系统锁屏，最终原窗口验收未完成；没有解锁、改锁屏
设置、换 profile 或重启用户 Runtime。整体架构目标仍继续。查询审计发现
Task batch、目录分页、Profile 已有共享 owner，不为形式整齐再造 broker；
下一真实边界是补齐交流 frame 的现有样式 owner，不是新增审美规范。

## 2026-10-04 前端重构第十阶段：应用导航与实例切换 owner

在已有 `host/use-workspace-navigation.ts` 内继续迁移 App 六个入口：Reader
书库、剧本库、内容、Browser、激活与普通导航；ApplicationHost 的启动与
关闭邻居决策也消费同一 typed actions。不是另添 hook、全局 store、effect、
持久键或协议。App 保留唯一 prefs writer；Host 保留原本地启动锁、busy、
await／catch／finally。同步 prepared operation 返回原 execute Promise，
同步 commit 不插入额外 await；关闭仍用原 render 捕获的列表，下一项→上一项→null。

各分支原代次／错误语义保留，不借重构修复迟到行为：Dock 建新 intent，
Launcher 保留 render 捕获代次；Reader 清空后使用调用时 current 激活；
Browser 使用捕获的 `client.boot`，第二次 await 后仍无额外 generation guard。
本批未迁 `openUser`／`openReading` 的上游授权读取／意图 adapter，不称导航
整体完成。没有 UI、CSS、图标、布局或动效变更，不新增 LLM 请求。

独立旧实现 oracle 固定 `cb7246a2` 的 App 六函数及 Host 两函数，生产算法不
作为 oracle。根线程完整 AST 逐函数实核相等；CI 固定完整语法摘要，不依赖
历史 Git。临时摘要生成器首版曾因 forEachChild 返回 push 的数值只遍历首项，
已改为 void 回调并重新核验全部子节点，不采用首版摘要。25 项旧实现对照、
原导航单元与门禁 25 项均通过，保留原零构造读取／写入断言；原 Promise 引用、
首个 reaction 内激活／报错→finally→外部 observer 均有明确时序断言。

六项实际消费门禁另含 32 个仅接受 AssertionError 的违规反例，核对真实
App import→owner actions→typed Host port，原局部等待／清理、捕获实例和
prepared 原 Promise；固定旧 JSX／React hook／effects 完整树一致。它只
归一批准的两个 Host props，不是视觉证明。原工作面门禁也随消费迁移：
exchangeKey 必须仍直接读同一派生值，或由一个真实导航 owner 接收同一
workSurface；缺 owner、另一 scope、复制对象、shadow、重复 owner 及复制
key 均拒绝，原其他投影和所有旧反例保留。根线程合并相关单元／门禁 **61/61**。

首次全量 Node 1516 项因上述旧工作面消费门禁得到 1352 通过、1 失败、
163 跳过；没有用无意义的 unused 读取恢复门禁。迁移合同及反例校准后，
最终全量 **1523 项：1360 通过、163 条现有可选集成跳过、零失败**，69.8 秒。
跳过项不作真实 Runtime、模型或原生通过证明。根线程最终 typecheck／build、
受影响源码格式和空白检查通过；build 保留原大 chunk 提示，没有新构建错误。

原 reader 用例在收起记录时直接点击历史引用，迁移前真实失败。只补既有
显式阅读入口，原断言与预算保留，独立测试提交 `e78fe64e`。校准后同一旧
JS 与新 JS 的原 14 文件 43 项均为 **41 通过、2 失败**，逐项身份及结果相等，
零跳过／重试。失败仍是项目创建误触权限失效导致 iframe 卸载，以及隔离
Electron 未获得前台焦点；后者尚未到实际网页交互。没有删除 iframe 断言、
补点项目或绕过真正撤权保护，不能称 E2E 全绿或原生验收完成。

新的原生产 Host Dock 两项及真实生产 Dock 隔离挂载 23 项，完整 **25/25**，
14.9 秒，零跳过／重试；覆盖拖入、拖出、排序、取消、原点击、刷新与 scope、
键盘、触控、缩放及减少动态。只因用户此前明确要求才有 Dock 交互增强，本
阶段不再改变它。真实 Sandbox compose 挂载回归 **10/10**，零跳过；仅更新
新 typed Host 端口夹具，原断言／读回调／拒绝／身份与迟到范围保护均保留。

实际新页面 HTTP 核对 HTML、JS／CSS 均 200：`app-Ctge3DoT.js`，SHA256
`263d615a35ffe0d1e850e89beef148c88b95cef1255729ea86e038c9c2c0066f`；
CSS 仍 `app-Bl-K6QYD.css`，SHA256
`0a46e4301841e99b7c688123e4a07ff83e8ebd6b33918325331294aaad442648`。
证据 `/tmp/morphz-application-navigation-owner.B45r1q`，旧／新／Dock traces
使用独立目录保留。最初未校准 43 项的完整日志及 report 保留，其 traces 后被
独立 reader 运行清理，不能声称该初轮全部 traces 仍在。

原 App 最终复验尚未完成；自动化是原 test-server 的隔离 Host 与真实组件，
不是付费模型或用户窗口验收。未更换用户 profile、重启用户 Runtime 或修改
锁屏设置。项目新增权限失效修复仍待范围确认；整体架构目标继续。

## 2026-10-04 前端重构第九阶段：会话历史查询唯一 owner

`data/conversation-history.ts` 实际接管原 Client 的范围选择、历史缓存和
单一分页 promise，以及 workspace view 的 head 复用和 timeline 合并。
Client 持有一个稳定实例，原三个命令与 refresh 提交／授权清理直接消费；
workspace view 仍解析授权范围，只调用 owner 的 head 策略，旧 export 保留
re-export 兼容。不是另添 wrapper、并存 store 或全量查询 facade；不声称
请求数降低。该模块没有构造副作用、React、DOM、storage、HTTP／IPC 或订阅。

原 CSRF、epoch、scope 对象 identity、catalogVersion 及最终导航版本检查
仍留 Client。清理同步撤下投影，不取消或重置原在途分页；cache 对象、身份
和 scope 守门阻止迟到页面恢复。缓存命中同步返回原对象，没有新增 await。
更早消息仍先等 refresh，最多四个不可见窗口共享 15s；引用回溯仍不增加
此等待，最多 200 页、每页独立 15s。原游标／stale 检查次序、部分提交、
错误文案、消息／input 重叠判定和多 review 输出身份均保留，没有 UI／CSS
变化、轮询、新存储键、授权／协议或 LLM 请求。

18 项新增对照测试使用固定 `9ea571d0` 的旧函数主体，根线程独立核对七段
源实现，仅归一 import 路径／空白，oracle 不调用新 owner。相关 70 项单元
测试通过。独立审查另外运行 18 组时序、48 组 head、120 组合并；这些有限
情形不是完整 React／权限证明。两项 AST 门禁含 14 个违规反例，只治理本
owner 的已知依赖和直接副作用，不是安全沙箱或全产品门禁。

根线程最终全量 Node 1491 项：1328 通过、163 条现有可选集成跳过、零失败，
67.6 秒。跳过项不是本轮真实 Runtime、模型或原生能力通过证明。

原六文件 31 项首次在未迁移 JS 上真实得到 22/31；七个未读测试仍假定焦点
自动打开关闭历史，另外两个 fixture 改版本却未发失效事件。仅补真实显式
阅读／既有 foreground wake 前置，原 70 条 expect 和等待预算保留，校准以
独立测试提交 `c986fffd` 保存。校准后同一旧 JS 31/31，新 JS 31/31，后者
38.1 秒、零跳过／重试。不是通过恢复已撤回的自动展开或加入轮询换绿。

新 JS 的原 21 文件 84 项跨页面矩阵 **81 通过、3 失败**，零跳过／重试；
与迁移前最终矩阵保留相同三个红项及原断言：applications 的 iframe 连续性、
navigation 的项目自动进入、shell 的项目标题。项目新增误触 accessChanged
的问题仍待此前提出的修复范围确认，未绕过撤权保护；不能称 E2E 全绿。

根线程最终 build／typecheck、受影响源码格式及空白检查通过。实际 HTML、
JS／CSS 响应核对：`app-ZrFEj5mM.js`，SHA256
`457f0117886216b504d6deea7fa480f751b28e1ff3971f83e01e8e1b33e48887`；
CSS 仍 `app-Bl-K6QYD.css`，SHA256
`0a46e4301841e99b7c688123e4a07ff83e8ebd6b33918325331294aaad442648`。
根线程原日志／traces：`/tmp/morphz-conversation-history-owner.WIENvK`；独立
review：`/tmp/morphz-history-independent-audit.laXqGE/REVIEW.md`。自动化使用
原 test-server 的隔离临时 Host，不是付费模型、原窗口或整个目标验收。
原 Mac 只读检查仍锁屏，最终原 App 复验未完成；未换用户 profile、改锁屏
设置或重启用户 Runtime。整体架构目标继续，完整导航、跨领域呈现及其他
查询／样式／组件边界尚待迁移。

## 2026-10-04 现有回归契约校准：保留真实红项

发送／顶栏阶段已提交 `d45cf84d`；未知补充回执另以 `28cecd4a` 修复。本批
只校准测试的实际入口和已确认产品合同，不改变生产 UI、CSS、授权或投递。
固定旧 renderer 的首次失败与后续实测证据保留，不以“旧测试”笼统解释红项。

- supplement 先 hover 实际消息操作区，再普通点击；查看使用确切卡片及
  input／Thread 来源。Session 原读取、授权和不改补充目标断言保留；模型
  description 改为当前“用于后续新输入，不改变已提交工作”，不恢复发送后清空选择。
- 浏览器 offline 标记及断开的事件提示流并不等于 Host RPC 已不可用。测试
  等待原 foreground reconcile 的 bootstrap HTTP 实际失败，再检查原禁发、
  输入法、键盘及草稿断言；不伪造成功或改变 Desktop bridge 的可用性规则。
- 普通画布焦点测试先选择工作台的真实“应用启动台”。共享临时 Host 会保留
  内容应用的原文，工作台导航与 immersive 返回都不能冒充该前置；新增实际
  应用标题断言，原 scope=0、Tab、焦点、弹窗、草稿及历史全部检查保留。
- 应用测试先显式进入交流阅读态再收起，shell 搜索限定真实可见侧栏入口，
  typed fixture Client 使用本页面身份／Host。没有补点项目、删除 iframe
  连续性或标题断言来绕过创建后的真实问题。
- Profile CAS 测试先截住已发出且 expectedRevision=1 的原 UI POST，再由
  独立真实 writer 提交 revision=2，放行未改写的 POST，获得真实 409。
  原丢回执／同 command 重试／草稿／持久化及 receipt 数量检查保留；不是伪造冲突。
- 剧本移除意图改走现有“输入关联”菜单；已撤回的 Agent 创作开关不重新
  建立。创建默认的 legacy false 是兼容资料，不是权限。资料来源说明另以
  保存／版本／作者／历史／刷新且零新输入、会话的完整用例验证；原准备、
  候选、全文、版本冲突、Human 审阅、锁稿、Word 导出断言保留。

最终实际生产资源仍为 `app-DhicvD4e.js`／`app-Bl-K6QYD.css`，摘要见下节。
正常原 `test-server.mjs` 的 21 文件 84 项矩阵一次完整 **81 通过、3 失败**，
107.1 秒、零跳过／重试；不能称 E2E 全绿。三个红项是 applications 的原
iframe 连续性，以及 navigation／shell 创建项目后的自动进入／标题；此前
固定旧 renderer 也真实复现，未以改断言算修好。另一次把随机 Host 用于仍含
固定 fixture 入口的矩阵得到 63/84，是测试环境误配，原日志保留但不算产品
结果；正常 Host 的第一轮 80/84 及焦点前置诊断也保留。

已经查明项目新增引发 `workspaceChangeVersion.accessVersion` 改变，workspace
推送被标为 accessChanged；Client 清权限投影并 setBoot(null)，卸载页面，
打断原创建回调和已挂应用。identity／CSRF 和实际 access revision 不变，
POST 成功且项目真实持久化；不能把它说成项目没保存或正常留在工作台。
这涉及权限失效合同，不在“外观及交互不变”重构中悄悄绕过撤权守门；已单独
向用户提出修复范围选择，尚未改生产。真正撤权的即时保护必须保留。

相同最终资产的原 Profile 五项完整 5/5，真实 SQL／Rust Runtime、确定性
本机 provider；私有 Host 的等价剧本选定六项 6/6，全部原 test body 与 helper
只归一私有 fixture discovery 后匹配。11 个 test page 的实际 HTML／JS／CSS
响应核对通过。不是全剧本原 spec、付费模型或 Electron 验收；Electron 旧
菜单入口仅静态校准，本轮未运行。typecheck、受影响格式及空白检查通过。

根线程完整原日志与 traces：`/tmp/morphz-existing-regression-contracts.5Ne96P`；
Profile／剧本最终复验：`/tmp/morphz-final-Dhicv-fixtures-20261004.GhMyhK/RESULT.md`；
固定旧 renderer 后续问题对照：`/tmp/morphz-shell-contract.okrEDB/REVIEW.md`；
焦点只读因果审查：`/tmp/morphz-mixed-focus-audit.TisJng/REVIEW.md`。
原 Mac 本轮只读检查仍锁屏，最终原 App 复验未完成；所有隔离 fixture 已收尾，
未换用户 profile、改锁屏设置或重启用户 Runtime。整体前端目标仍未完成。

## 2026-10-04 未知补充回执：刷新重试沿用原命令

恢复当前真实补充入口后，旧完整回归继续暴露一个生产问题：Client 首发保存的
operation 补入 `dispatchMode: parallel`，补充编辑器保留的 pending operation
却省略该字段。刷新后双方精确比较失败，原命令未被核对，草稿仍冻结。
原红记录及两份本机存储诊断保留，不将它归成旧按钮定位错误。

`local-saved-inputs.ts` 的 `matchSavedInputOperation` 只认可双方均为 supplement、
候选省略 dispatchMode、已保存值为 parallel 的这一处差异；严格 schema 后
仍比较全部字段，相等才返回原 saved operation。Client 沿原身份范围与
commandId 找原 entry，原发送函数、首发默认、权限检查、重试 ID 和冻结载荷
不改。显式不同 mode、正文、来源、模型、授权或代次变化仍拒绝；普通及旧无
mode 记录不获得新默认。matcher 不写存储，原发送流程仍正常更新 submission
状态，不能将此描述为整个 outbox 从此不变。

三项新增单元测试含实际保存／刷新与 14 个 schema 合法的字段变化负例。
相关 62 项 Node 回归通过；全量 Node 1471 项中 1308 通过、163 条现有可选
集成跳过、零失败。独立只读字段挑战和原发送函数字节对照未发现阻断。
原五项查看／补充／已结束／未知回执／Session 权限测试在实际新 bundle
完整 5/5 通过、零跳过／重试；未知回执原 requests 数量、同 command 与整份
request deepEqual 断言保留。活动查看改走确切消息卡片，补充先真实 hover，
不强制点击隐藏按钮或伪造旧执行面板。

最终 typecheck／build／受影响格式及空白检查通过；实际 HTML 和 JS／CSS
响应核对为 `app-DhicvD4e.js`，SHA256
`7b791f63d9874f81387025db8360e363e264917cdf500d243dc2194a9cd56492`；
CSS 仍 `app-Bl-K6QYD.css`，原摘要不变。独立验证见
`/tmp/morphz-exchange-entry-fixed.uD1K8c/REVIEW.md`；根线程原输出见
`/tmp/morphz-existing-regression-contracts.5Ne96P`。这是实际生产 renderer 配合
受控回执的回归，不是付费模型、原 Mac 窗口或整个前端目标完成证明。

## 2026-10-04 前端重构第八阶段：发送协议与共享顶栏

`host/submit-exchange-draft.ts` 实际接管原阅读／目录／选区／附件检查及四个
互斥发送分支。普通输入仍 Profile flush→身份复核→当前工作面复核→构造载荷；
定向补充仍先保存原 command ID／operation，再沿用原工作来源投递。Client 的
typed gateway、outbox、权限及首发事务不改；App 保留准备锁、原 key 的草稿
消费、staged 迟到失败保护、错误分类与焦点。receipt/catch/finally 反馈在原
execute continuation 内同步调用，不加重试、全局状态、网络或 LLM 请求。
阅读类型迁入纯 `reading-context-model.ts`，原组件 re-export 且 JSX 不变。

`shell/WorkspaceTopbar.tsx` 是一个原生 header 的生产 owner，接受有限只读
事实及语义动作。App 原三个 target state／setter 原位且原样直传；三个 div
常驻，仅 hidden 切换，不重建 portal container、不加 key、包装或样式。原项目
菜单留原分支／节点位置；领域应用仍拥有自己的工具栏、画布和正文状态。
这是两个实际接入的边界，不是已完成整个 App／Exchange／查询层迁移。

固定 `55988f3a` 的真实 send handler 与当前源码隔离执行，35 情形的载荷、
草稿变化及回调顺序完全一致；该对照不是 React／Host／原窗证明。实际新 owner
43 项逻辑与 5 项有限 AST 门禁通过，30 个指定违规反例被拒；顶栏 4 项包括
固定旧 markup 126 种分支／属性情形及真实 App import／三 setter 门禁，8 个
合法语法违规反例保留。相关新旧 Node 合跑 67/67。隔离实际 React 顶栏挂载
5/5：节点／值／焦点、portal 清理、四色明暗／宽窄、CSS 200%、粗指针和减少
动态；不是 Electron／OS 200% 或原生命中验收。

七套原 Host 草稿／焦点／首发／目录回归未修改，全新临时 Host 一次 31/31，
48.4 秒、零跳过／重试。另扩展原 21 文件 84 项矩阵，73 通过、11 失败，未
删除断言或算成全绿。旧固定 JS 的独立实测已复现断线发送仍 enabled、旧模型
description、未 hover 的补充入口及旧活动按钮等首次失败；focus 单项旧版 fresh
与当前完整 fresh 31 项均通过，仅在混跑复现，尚未单独证明其共享 Host 隔离
原因。其余首次失败仍单独核验，不据此宣称所有失败都已定位或修好。

实际 UI／HTTP／SQLite Host／Rust Runtime Profile 回归 4/5：新输入即时绑定、
关闭省略及旧 Thread 固定版本通过；CAS 冲突用例等待 409 超时，保留红记录。
provider 是确定性本机夹具，不是付费模型。选定剧本路径 2/4：目录与焦点通过；
旧移除意图入口及已撤回的 Agent 创作权限表单阻止另外两项到达发送断言，未
把它们冒称真实生成验证。新增模块不通过这些旧入口恢复已撤回界面。

冻结最终生产及测试后，完整 Node 1468 项：1305 通过、163 条现有可选集成
跳过、零失败；build/typecheck、受影响源码格式与空白检查通过。最终 JS
`app-Bvd6t3qX.js`；CSS 仍 `app-Bl-K6QYD.css`，SHA256
`0a46e4301841e99b7c688123e4a07ff83e8ebd6b33918325331294aaad442648`。
收尾曾发现新顶栏门禁漏检自闭合旧 header，已补门禁且保留负例与原红输出；
浏览器初轮缺 Chrome 亦保留，改用既有 Playwright binary，不改产品或断言。
主线程完整证据 `/tmp/morphz-submission-topbar-verification.wTUEdY`；顶栏隔离
记录 `/tmp/morphz-workspace-topbar-20261004.1KZb9u`；固定旧 bundle 首次失败
对照 `/tmp/morphz-submission-old-bundle.MjQh1p`。

原 Mac 本轮只读检查仍锁屏，原 App 最终复验未完成；未换 profile、改锁屏
设置或重启用户 Runtime。上述源码／自动验证不替代原窗及整个目标验收。

## 2026-10-04 前端重构第七阶段：草稿生命周期唯一 owner

`host/exchange-drafts.ts` 实际拥有输入、尚未首发的命名会话、丢弃会话三份
旧本机记录与创建／退休／丢弃／恢复／functional 输入写入五个命令。
三个无 effect state hook 保留 App 原初始化位置；原权威 conversation 退休
effect 仍在原位置及原依赖。App 保留发送中 guard、已保存但未投递输入判断、
听写打断、发送冻结与成功后的导航，不把未发送草稿暴露给 Agent。

创建读当前 ref，丢弃／恢复读原 render snapshot；持久会话查找只在本地未命中
时求值。原 inputs 保存失败仍本地发布、create persist→ref→state、退休
ref→state→persist、丢弃与恢复各自不同的三写顺序及 try 内导航保留。
每第 1／2／3 步失败均保留原部分 localStorage 前缀与提示；不是新事务或回滚。
不增持久键、全局 store、网络、Session、授权或模型请求。专业应用正文草稿
及手动新文档草稿仍属原领域，本批没有宣称整体 Exchange／发送已拆完。

冻结 `a5278c21` 对照：221 个 JSX raw source 节点、setDraft／updateDraft／
hasConversationDraft／send／supplement 五个保留处理器完全一致；16 个原
effect 中只有原位置的退休 body 迁到命令。所有 CSS 不改，产物仍为原
`app-Bl-K6QYD.css`；生产 JS 为 `app-Bkw1VkRR.js`。这证明源码边界，不冒充
原窗口像素、焦点或动效验收。

16 项生产命令逻辑回归、6 项有限 AST 门禁通过，36 个违规反例被指定规则
拒绝；门禁仅治理这批实际导入、三个原 key、hook 位置、writer／ref 及失败／
导航 seam，不是任意 JS 纯度或全 App 权限证明。实际 React 挂载 4/4：
原三 key／重 render 零 I/O、同 tick 稳定 ID／ref、functional 最新输入、
真实 localStorage／sessionStorage 的中心／身份 keyed remount 与双窗口恢复、
StrictMode 零自发写入。该 fixture 不挂业务 Host，不证明真实登录撤权或 Runtime。

七套现有 Host 浏览器回归完全未修改，31/31、34.2 秒、零跳过／重试：
首发失败及稳定 ID 重试、迟到回执不抢导航、丢弃／恢复／刷新、跨会话正文与引用、
模型／effort、目录授权、原显隐／焦点／几何。隔离 queued ingress 保留；
Runtime dispatch 停止，受控模型目录不冒充真实模型执行。
冻结最终源后的全量 Node 1416 项中 1253 通过、163 条现有可选集成跳过、
零失败；最终 typecheck 与受影响源码格式检查通过。新增门禁收尾出现的未使用
import／精确 allowlist 误伤均在测试内修正，未改变生产或删除违规反例。
完整输出、源码对照、构建与最终检查见
`/tmp/morphz-exchange-draft-verification.MOk4t6`。

查询收敛另做只读审计与实际隔离消费者测量，发现 TaskList／Schedules 的同 ID
读取具有不同 deadline／retry／失效／发布合同。两自然路径各 2 GET，最多约
0.3ms browser pending 重叠，未实证候选 2→1；实际快照 run0，资格与连接受控，
不是 Runtime 工作收益。285 行候选没有加入生产，见
`/tmp/morphz-natural-task-reads-20261004.mZNMJA/RESULT.md`。
既有对话流／概览共享继续复用，不把 raw wrapper 或候选审计称为完整 facade。

原 Mac 只读检查仍锁屏，最终原 App 验收未完成；未换 profile、重启 Runtime
或改锁屏设置。本阶段与整个前端目标的未完成范围分别保留。

## 2026-10-04 检查器回归接回当前实际界面

本批只更新 `inspector.spec.ts`：真实对象创建及原文回读后显式刷新其受控 workspace
事件夹具；种对象先进入实际应用 Host，恢复 Browser 则走真实返回入口，不重置数据库。
原批注菜单、48／52px 标题、356／300px 调宽、340px overlay、639px 画布、
键盘／焦点、两工作面的准确执行详情和各自草稿保留。设定页的唯一自定义讲话风格
textarea 是实际 ProfileEditor，不是第二输入框；该页严格限定这一项，其余页面
仍要求 textarea 为零，所有检查器均禁止 AI 输入及 composer。

已撤回的理解入口不伪造恢复；主体 tab 本来是全局选择，两个现场的执行详情恢复
不能冒称所有 tab 按现场隔离。显式打开批注也不证明通用右栏开关恢复批注选择。
六项实际回归全部通过，属于同一次 60/60 完整相关矩阵；没有 skip、重试或延长
timeout，没有生产界面变更。独立只读审查、冻结负基线及原红输出保留，见
`/tmp/morphz-control-legacy-baseline.ohSJ7t/test-migration-freeze.md` 与
`/tmp/morphz-control-owner-verification.LhN5kb`。当前原 App 最终复验仍待解锁，
不把这些隔离测试称为整个前端架构完成。

## 2026-10-04 收起 Dock 的键盘 Launcher 与真实底栏回归

收起输入后，原生 popover 转移焦点会使交流祖先不再匹配 `:focus-within`；
菜单虽已打开且非 inert，却继承隐藏状态。独立隔离 Host 的原样／临时选择器／
撤回三次因果检查复现，几何不变。生产只在原显示规则加
`.application-dock-slot:has(.application-dock-menu:popover-open)`，不新增状态、
包装、尺寸或动效。永久回归检查实际 Enter、菜单焦点／原生打开状态、Esc 返回、
草稿及画布不动；五项 composer-layout 契约改为当前真实底栏与菜单入口。

冻结构建 `app-BZ2_5hyB.js` 的 typecheck／build 通过；相关 Node 19/19、
完整相关浏览器矩阵 60/60，均零跳过／自动重试。包含独立生产 Dock 手势 23 项、
真实临时 Host 拖入／排序／拖出、八种主题及隔离生产 Electron 的实际 200% zoom。
原先复用诊断 Host 的矩阵因恢复 Browser 而在启动台前置失败并中断，原红记录保留；
最终矩阵按项目正常流程创建新临时 Host，一次完整运行 57.2 秒退出 0，自动收尾。
输出 `/tmp/morphz-control-owner-verification.LhN5kb/dock-fresh-final.log`；
因果诊断 `/tmp/morphz-collapsed-dock-diagnostic.0W58qj/review.md`。

测试不引入新的审美或触控宽度：原三常驻图标仍 44×44，执行设置原为可收缩摘要，
窄触控 Browser 状态实测 23×44，仍实际 tap／Esc 可达；现有媒体／次级菜单最小
32px。另记录既有连接提示与设置在该状态重叠 12px，未借本批改变已确认布局，
不把有限四按钮断言称为全底栏无重叠。原 App 最终实机复验仍待解锁；隔离夹具
及此前原窗记录不替代最终原窗或整个前端目标验收。

## 2026-10-04 交流控件回归契约修正

组件重构已提交 `7f1584b7`，本批只修 `composer-tool-state.spec.ts`，
没有生产源码／CSS 改动。记录显隐改为显式按钮操作，保留 focus 不自动展开
负例；28px／13px 交流控件与 32px 紧凑菜单沿用当前实际语义，不借用应用
Dock 的材质。八种主题组合、稳定命中、pressed、hover／键盘、草稿与对比度
保留。对比辅助改为保留 alpha 的祖先背景合成，并用独立透明／半透明反例
验证；它不是屏幕像素取样，不声称模拟 sibling／backdrop blur。

主线程真实跑 3/3 通过、零重试／跳过，包括临时隔离 profile 的生产 Electron
fixture、1380／760px 窗口和实际 200% zoom；24 张主题／尺寸截图中独立查看
宽亮／窄暗两张。首次补测暴露紧凑菜单的局部中性 ink 与 outside-focus 关闭
行为，按原生产源码修正测试后复跑，不修改菜单或放宽等待。
输出见 `/tmp/morphz-control-owner-verification.LhN5kb/tool-state-final.log`。

另以固定旧 JS `app-DASFnNYG.js` 加冻结旧测试真实运行七项失败分类，
七项均同类失败且每项有旧 bundle 实际匹配回执；负基线保留在
`/tmp/morphz-control-legacy-baseline.ohSJ7t`，不是七项“通过”。其余布局／
检查器回归仍在独立修复；原用户 App 的最终复验仍待解锁，上述隔离 fixture
不能替代原窗验收或完整前端目标完成。

## 2026-10-04 前端重构第六阶段：登记图形与透明原生按钮

`design/control-icons.tsx` 登记原有七个 Lucide 构造器与两类控件语义，
`ui/IconButton.tsx` 提供一个透明的原生 button 边界。SidebarToggle、
ComposerToolButtons 和 ExchangeControls 的收起按钮实际消费它；不增加
DOM 包装、默认 class/type/ARIA、SVG 属性、尺寸、材质或业务读取。
原生 props、事件与 React 19 ref 原样转发，未知／prototype 图形及角色错配
拒绝；afterIcon 仅供原未读 span 装饰，不是任意图形的替代入口。

原 key=id??label（包括空 ID）、属性存在性、标签、pressed、未读、disabled、
refs 及 620px 紧凑模式焦点顺序保留。紧凑菜单只将登记 ID 适配回原 ReactNode
接口；ComposerOptions 全部触发器、App、Dock 手势及全部 CSS 不变。不会按
default/custom 图形切换 button renderer，从而丢失原节点与焦点。

新增 Node／SSR／门禁 13/13、零跳过；39 个违规反例拒绝。门禁只治理这批
登记／控件／消费 seam 及确切旧 compact effect，不是任意 React 或全产品证明。
独立固定 `bb8a1f35` 对照 1533 个正向场景与 14 个运行期负例通过；它们是
oracle 场景数，不冒充 CI 用例数或 mounted 验证。另有相关 27 项 Node／门禁
全部通过。真实隔离 React 挂载 5/5、零跳过／重试，验证实际按钮身份、空 ID／
nullish key、对象／cleanup ref、更新后的焦点、621→620→619px 实际 observer、
secondary 卸载与 history/hide 焦点例外及紧凑菜单键盘行为；未挂业务 Host。

冻结生产构建 `app-DnkpJ-BV.js / app-5L3clyL9.css` 的 typecheck／build 通过；
CSS 摘要与前阶段相同。全量 Node 1394 项中 1231 通过、163 条现有可选集成
跳过、零失败。首次门禁红记录保留：TypeScript JSXText.getText 丢前导换行，
现用原 source slice 判断真正格式换行，不改生产或删除反例；修复后重新全量跑。

扩大浏览器矩阵 59 项为 47 通过、12 失败，不能称 E2E 全绿。Dock 拖拽／固定／
放大、交流显隐／焦点／悬浮／伸缩均通过；失败落在 composer-layout、
composer-tool-state 与 inspector 的旧测试。已定位其过时菜单、常驻模型控件、
focus 自动展开记录、inset 材质等假设；另有 seed 夹具的事件刷新前置需核对。
正在独立核对旧构建并修复测试契约，不把所有失败未经验证归为旧测问题，也不
改回用户已确认 UI。完整红／绿输出、两个不同浏览器报告、冻结对照见
`/tmp/morphz-control-owner-verification.LhN5kb`；独立审阅
`/tmp/morphz-control-icon-audit.W7OPQK/review.md`。

本机界面技能只读检查仍确认 Mac 锁屏；原 App 最终坐标命中、焦点、动效及
200% 复验未完成，没有替换 App/profile、重启 Runtime 或改锁屏设置。
本阶段是有限生产组件迁移，不是全产品基础控件、查询层或整体架构完成。

## 2026-10-04 前端重构第五阶段：导航状态、回执与历史的单一所有权

`host/use-workspace-navigation.ts` 将原导航状态与 generation 收到一个无 effect
state hook；四个 render-local 命令集中对象打开、剧本交付、历史往返和 Dock
启动回执。trail／快捷键在原位置的独立 commit hook 注册，保持画布恢复、
title、trail／快捷键、交流焦点的原顺序与依赖。App 保留同一个 prefs state 和
一个偏好 writer，不新增全局 store、第二个 work surface 或持久化键。

迁移保留六字段的存在性判断、四 map merge、历史 raw spread、100 条历史及
前进分支裁剪、权限回读、原错误／finally 差异和对象打开后的更新 epoch。
其他业务入口仍留 App，只作批准的 generation owner 机械替换；不是借重构
补修未复现的旧竞态。发送、草稿、命令 identity、Session、权限和 UI 图形不改，
JSX 仅 Dock 的原 onLaunch 改为等价命名回调，ref／key／DOM／CSS 保持。

导航相关 8 文件 Node／门禁回归 76/76、零跳过；新增有限 AST 约束有 33 个
违规反例，检查实际导入、唯一 owner／writer、state→resolver 与原 effect seam，
不是全 App 静态语义证明。固定 `ebda0f03` 的独立源码／纯逻辑对照通过：221 个
JSX 节点、15 个状态／ref 声明、37 个保留处理器、14 个保留 effects；44 偏好、
8 trail-record 和 19 命令场景共 71 条 trace，以及 140 步历史均与旧实现一致。
SSR 仅验证初始 owner 隔离，不冒充 mounted React effect 验证。

冻结构建 `app-DASFnNYG.js / app-5L3clyL9.css` 的 typecheck／build 通过，CSS
摘要与第三／第四阶段一致。13 套实际 Host 浏览器回归 44/44，零跳过／重试，
覆盖迟到启动／关闭回执、返回原件、剧本交付、独立草稿、目录授权、Dock 手势、
交流显隐／焦点／伸缩、消息操作、回应等待及父子活动。同版含同期 SQLite 修复
的全量 Node 1381 项中 1218 通过、163 条现有可选集成跳过、零失败。
原始构建／单元／浏览器／oracle 输出：
`/tmp/morphz-navigation-owner-verification.Nu3QDS`；独立对照说明
`/tmp/morphz-navigation-oracle.FJkaSS/report.md`。

本轮本机界面检查仍确认原 Mac 锁屏，未操作锁屏设置、替换 App／profile 或
重启 Runtime；原窗口最终焦点、滚动、几何与动效复验仍未完成。自动回归不作为
原窗验收，也不宣称整体架构已完成；query facade、role 型基础组件与跨领域
presentation 仍在后续迁移范围。

## 2026-10-04 SQLite 变化通知：双通道与注册空窗校准

修复真实跨进程通知漏报类别：目录监听注册成功但没有任何回调，提交已经落库，
原 3 秒提示断言仍超时。自然失败的只读诊断记录了完整事务与零回调；未将其
归因于模型、轮询间隔或尚未证实的 Node 版本差异。

`commit-notifications.ts` 保留目录监听，并订阅确切 DB／WAL／journal 文件；
实际事件共用原 20ms 合并校验，注册成功与错误恢复各校准一次。缺席侧车不启动
定时发现；只有真实订阅错误沿用 500ms 恢复。旧 inode／订阅实例的迟到回调和
error 不得关闭新实例，close 取消全部监听、待校验与重连。无健康空闲 SQL 或
文件扫描轮询，不改变数据库、公共 API、内存来源、PG 或 ready 语义。

17 项专项中 16 通过、1 项现有 PG 集成跳过；连续 24 轮、最多 4 并行均相同，
原真实跨进程案例仍保留 3 秒、未提交／rollback 无提示和最终 `[2]` 断言。
新增强制目录静默的 WAL／DELETE 实测使用真实文件事件与子进程事务；受控
事件／计时另验证静默零 SQL、侧车及 DB 替换、注册空窗、错误恢复与关闭。
相关 workspace change／ready cancellation 12 项中 10 通过、2 PG 集成跳过。
原始逐轮输出与冻结 SHA：`/tmp/morphz-storage-dual-channel-20261004.mRHrlT`。

同期冻结导航迁移与本修复的完整工作树 typecheck／build 通过，全量 Node
1381 项中 1218 通过、163 条现有可选集成跳过、零失败；原始输出
`/tmp/morphz-navigation-owner-verification.Nu3QDS/full-unit.log`。不以强制静默
成功证明所有文件监听都可靠：修复后未再次捕获天然失声并恢复的同轮 trace；
通知仍仅是失效提示，启动、重连与唤醒须读取权威版本。

## 2026-10-04 前端重构第四阶段：回应等待的共享事实投影

`conversation-presentation.ts` 的纯 `isPendingResponse` 统一消息与 Logo 共用的
首字前等待事实；确切输入归属、可见消息／实时流、输出及审批的选取仍由各自
消费方负责。消息取消后仍保留“停止待确认”，Logo 则沿用自己的取消排除；
断线、工具执行、长期等待和补充送达不混成同一种运行状态。不生成回复、活动、
摘要或新模型请求，不更改查询、处理器、JSX、CSS、焦点或业务权限。

相关 9 套 Node／SSR 回归 51/51，零跳过；新增测试包括 2,168 组事实对照两份
旧谓词的 4,336 次等价断言和 38 次真实 Conversation SSR。固定基线对照保持
106 个 JSX 元素、24 处 hook 和 8 个其他函数原文一致；静态证据不替代交互验收。
冻结构建 `app-C60dMc2z.js / app-5L3clyL9.css` 的 typecheck／build 通过，CSS
摘要与第三阶段一致；实际 Host、消息、首字、取消、补充、父子活动、Logo 和动效
浏览器 31/31，零跳过／重试。证据 `/tmp/morphz-response-facts-final.Jprj29`。

首轮浏览器有两项旧前置失败：delivery 夹具仍寻找已移除的伪活动行，以及未悬停
直接点击隐藏操作；复跑又定位到聚焦输入后错误假定历史自动展开。测试改走真实
消息操作、悬停和显式查看记录，保留并发停止、迟到回复、失败重试和草稿断言，
不改回旧生产行为。最终两套 8/8 后，再完整重跑上述 31 项一次通过。

同版全量 Node 尚非绿色：1347 项中 1183 通过、163 条现有可选集成跳过，
1 条新增 SQLite 健康闲置断言失败；真实文件事件晚到与静默期验证的前置正在
单独修正，不能宣称已查清此前 3 秒提交提示超时。原 App 最终复验仍待系统解锁；
本阶段自动验证不作为全产品架构或原窗最终实机验收完成。

## 2026-10-03 前端重构第三阶段：交流伸缩的样式所有权

仅将伸缩手柄、标记位置、标题顶部留量与拖动命中层的原 23 项几何／命中声明
移入 `exchange-layout.css`，由 `main.tsx` 在原视觉层之后、inspector 之前唯一加载。
原 9 项绘制／反馈声明、所有选择器、值与条件保持；没有新增 layer 或移动整段
交流样式。实际共享焦点规则仍产生 +2px offset，不趁迁移改成局部 -2px。

`exchange-css-ownership.test.ts` 用 CSS／TypeScript AST 核对原声明重组、已知
竞争规则与唯一加载入口，25 个 CSS 和 8 个入口违规反例均拒绝；无关旧领域允许。
门禁只治理这一段具名边界及字面量入口，不声称证明任意 selector／动态路径的语义，
也不把其他交流几何或全产品样式称为已经归一。PostCSS 8.5.28 改为显式开发依赖，
原 378 个锁定包未升级。

冻结构建 `app-bCl_EPCZ.js / app-5L3clyL9.css` typecheck／build 通过，仍有原
OpenCV 浏览器兼容和大 chunk 提示。门禁 4/4，实际 Host 与生产 controller 浏览器
回归 59/59，另原焦点回归 5/5，均零跳过／重试；证据
`/tmp/morphz-css-owner-regression.b94mYA`。同版本全量 Node 1337 项中
1173 通过、163 条现有可选集成跳过、1 条跨进程 SQLite 变化通知等待超时。
该文件单独复跑 3 通过、1 条 PG 跳过，原因仍在调查，不能把全量报成通过。

原 App 最终刷新及原生手柄命中复验尚未完成，因系统锁屏；本阶段不操作锁屏设置。
自动回归与原窗实机验收分开记录，当前全部迁移仍未完成，不新增审美数值标准。

## 2026-10-03 Input Dock 自定义与彩色 Launcher

用户明确要求的交互扩展，不属于“视觉不变”的架构搬迁：鼠标可在 Dock 内排序，
从 Launcher 拖入固定，拖出取消固定（不卸载应用）。完整偏好仍由原
`onPinned` 保存，当前目录不可见／旧确切版本的固定项保留；预览不写偏好，成功
一次提交。Esc、失焦、捕获丢失、目录变化、收窄、卸载与窗口外释放均取消。
拖动结束抑制误启动；源图标淡化、插入位和移除提示使用真实本地手势状态。

悬停仅轻量放大图形，不改变原 32／14 按钮和图形布局、插入坐标或命中区域，
相邻图形连续减弱；菜单／拖动及系统或本地“减少动态”停止放大。键盘 Alt＋左右
排序、Delete 取消固定并恢复 Launcher 焦点；触控保留原直接图钉操作，不要求拖拽。
Launcher 与工作台标题的“返回应用启动台”共用彩色集合符号，复用蓝／金／紫的
应用身份调色，第四模块用产品强调色；工作台导航自身仍是工作空间图标。

最终 Dock 构建 `app-DSEHgY0n.js / app-x4uJ4C8D.css` typecheck／build 通过。
实际 Host 页面与原范围、草稿、浮层、尺寸、四主题亮暗和动效回归 44/44，独立挂载
生产 Dock 的手势／键盘／触控／缩放／动态辅助设置 23/23，均零跳过／重试。窗口
外坐标与 12px 容差相交时仍不提交的左右两端 Dock／Launcher 反例已修复并覆盖。
证据 `/tmp/morphz-dock-regression.W42rkn` 与
`/tmp/morphz-dock-gesture-verification.6YLpf8`。实际 Host 拖动中无 API 写入，刷新
仅原有幂等 personal spaces ensure；会话、应用实例和草稿不变。

同一原 App 已加载彩色入口与拖拽版，鼠标和键盘排序实见生效、焦点保留，并恢复
原“阅读／剧本／浏览器”顺序，未发送或启动应用；最后的窗口外保护补丁未能再
刷新原窗，因系统锁屏，不改变锁屏设置。此边缘补丁由最终自动回归验证，不把夹具
或此前原窗当成最终所有行为的实机验收，也不宣称已取得用户审美确认。

## 2026-10-03 前端重构第二阶段：交流布局意图与焦点控制器

`host/use-exchange-controller.ts` 集中交流显隐、固定、临时伸缩预览及待执行的
输入／会话／发送后焦点意图。它投影原工作面与偏好，未建立第二份持久化状态。
导航、草稿、发送协议、DOM 几何及查询仍由原 owner 管理；焦点 layout effects
保留在原 canvas／trail 恢复之后、inspector 之前的执行位置。

本阶段 App JSX、ref、key、键盘与草稿代码等价；原 350 个元素、12 个 ref、
15 个 key 的结构核对不替代真实交互验证。原 CI 发现纯 Node 投影／依赖边界门禁，
另有标准 Playwright 挂载生产 hook，验证跨工作面、陈旧请求、ABA 导航、StrictMode、
发送锁及焦点顺序；不将可选浏览器跳过伪装成 unit 通过。

当前 build 通过；相关 unit 56/56、交流／Dock／范围／动效浏览器回归 42/42、
控制器挂载与原焦点回归 20/20 均零跳过／重试。证据
`/tmp/morphz-launcher-controller-verification.E6kwq5` 与
`/tmp/morphz-exchange-controller-focus.bf2mHX`。这版 bundle 同时包含独立图标与
剧本修正，不能把那些视觉或业务改动称为本次等价重构。

同一原 App 正常刷新后保留原对话，空输入聚焦、Launcher 打开及 Escape 关闭正常；
未发送、改资料或重启 Runtime。此现场检查不等于所有范围的原窗实机验收。
整体重构仍在进行，命令编排、查询与样式所有权等尚未完成。

## 2026-10-03 执行消息的悬停操作与正文活动捷径

按用户反馈，气泡外“补充／执行状态”沿用原 footer，仅在消息悬停或键盘焦点
进入时显示；触控直接显示。原几何与命中大小不变，不因显隐撑高正文，保留原环绕
执行动效，不另加重复运行提示动画。仅原 footer 的两像素间隙有透明鼠标桥，移动
到操作不会闪退；不把整个消息列变成透明命中区域。

点击具有有效活跃执行来源的消息正文，复用 `onInspect(inputId)` 打开该输入对应
活动，不选择补充目标、不发送、不更改草稿或执行范围。完成、断线或不可读时不
提供新捷径。嵌套按钮、链接、可编辑控件、引用 UI／全文／评论与文本选区保持
原交互；`data-quote-ignore` 与 `data-quote-ui` 都明确排除冒泡快捷打开。键盘仍
使用原可聚焦查看按钮，消息 article 不改为包含嵌套按钮的另一 button。

当前最终 bundle 的三套消息／执行完整回归 15/15、零跳过／重试通过，证据
`/tmp/morphz-message-card-regression.mK6e5q`；保留四主题亮暗、六尺寸／200%、
确切补充分支与未知回执保护，新增真实鼠标跨隙、Tab、触控、两条 input 独立活动、
实际引用全文／评论／复制／拖选以及隐藏时逐帧动画仍推进。build／typecheck 通过。

同一原 App 正常刷新加载了这版前端；用户截图中原任务此时已结束，因此不为手动
验收另发模型任务或伪造运行状态。原窗执行动效恢复已在此前真实在途输入验证；
本轮运行态点击／悬停边缘由隔离夹具验证，不能称为新的原窗运行态实机验收。

## 2026-10-03 独立应用图标：共享身份、不同颜色与光学版本

按用户明确要求，仅浏览器、阅读、剧本工作室使用自己的蓝／暖金／紫色身份，
不跟随全产品强调色变成同一种颜色。`application-identity.ts` 登记身份与调色；
`ApplicationIcon` 为 Launcher／工作台提供完整 SVG 图标，为 Dock／标签提供
另绘的小尺寸符号；两处复用同一组件，不再由 Dock 导入另一 feature 的宿主内部。
授权应用作者自带 `iconImage` 优先；未知／sandbox 应用保留原语义图标，不冒用内置
身份。不改原入口、名称、图标盒／按钮大小、排列、固定逻辑或安装／启动协议。

原倾斜经纬球版本已在原 App 显示，但用户反馈浏览器图形过密／不好看，本轮再改为
简化的指南针，Dock 符号同步；阅读和剧本工作室保持。此反馈说明功能通过不等于
审美认可，不能把配色或图形记录为全产品已验证的视觉标准。

最终版本 build／typecheck 通过，图标 unit 5/5、浏览器 2/2、零跳过；实际设置
四主题亮暗、54／66 图标盒及 32／14 Dock、SVG paint ID 隔离、键盘固定／解除、
Escape、刷新原稿均通过，未新增消息／Session／应用启动命令；sessions、appViews、
outbox 保持。夹具证据 `/tmp/morphz-application-icons-compass.ZZ8m0h`。
通过 Computer Use 正常刷新同一原 App，在用户当前工作台实见最终指南针与另外
两个图标；截图 `/tmp/morphz-application-icons-compass-original-workbench-20261003.jpg`。
未启动应用、发送、改用户资料或重启 Runtime。原窗只核当前深色，其他主题是隔离
自动验证；本轮局部应用身份不作为整体架构或产品审美验收完成。

## 2026-10-03 前端重构首阶段：工作面解析的单一所有权

将 App 内导航空间、实际内容 owner、应用确切版本、默认／命名会话、未发首稿、
目录授权范围及交流／草稿 key 的原推导集中到 `host/work-surface.ts`。模块纯读取，
不持有第二份 state、不查询或写入服务；原 nullish 回退、对象／实例优先级与引用
归属保留。App 使用一次 resolver 和同一草稿 adapter；本阶段不改 JSX、发送函数、
持久化格式、Session、权限或布局。后续用户明确要求的图标与消息操作是独立变更。

WorkSurface 31 项、边界门禁 4 项及既有草稿 5 项共 40/40 通过，typecheck 通过。
AST 门禁仅约束首个已迁移边界，验证允许的依赖、普通数据结构的副作用／输入写入
及 App 的唯一推导入口，包含 29 个模型违规、9 个消费端违规和合法计算反例；
它不是任意 JavaScript 程序的纯度证明。门禁由原 `npm test`／CI 自动发现。

冻结旧／新生产 bundle，以相同隔离夹具验证范围、命名会话、草稿、交流伸缩、
浮层位置及动效，均 37/37、零跳过／重试；另两套逐帧动效各 3/3 通过。
证据 `/tmp/morphz-frontend-baseline.LonU5S`、
`/tmp/morphz-new-bundle-evidence.gB9yAz`。测试同时纠正旧选择器、聚焦自动展开的
过期前置和夹具首读竞争；附件伸缩增加上传已完成的可见前置，原 250 高度记忆、
范围与草稿结果断言不变，旧／新分别复验。没有为绿色结果放宽实际业务断言。

同一原 Morphz App 正常刷新后仍显示原会话、事项、项目、原输入与工作台入口；
未新建业务对象、发送或重启 Runtime。原窗只核当前现场，不等于所有主题／工作面
完成实机验收。整体重构仍未完成：交流 controller、导航与命令编排、状态展示、
查询及样式所有权尚需逐阶段实施并分别验收，不能把本阶段称为整个架构交付。

## 2026-10-03 恢复已确认的执行消息环绕动效

用户反馈执行中消息不再出现原环绕光效。确定回归来自 `371c7e5c` 在 `ui.css`
新增的覆盖：将 `execution.css` 中仍存在的原环绕层设为 `content:none`、
`animation:none`，并撤掉原光晕。本轮只移除这些覆盖，恢复原配方；脚注中真实执行
状态、补充入口、右栏导航、气泡几何与执行判定均不改，不新设计另一套动效。

更新原错误的 no-halo 回归，冻结旧构建准确 RED（content 应为 `""`，实际 `none`），
证据 `/tmp/morphz-execution-halo-red`。当前 build／typecheck 通过，完整
`execution-experience.spec.ts` 4/4 通过、零跳过，证据
`/tmp/morphz-halo-green.uxvyNn`；检查实际帧间角度推进、不拦截点击、气泡高度不变、
真实运行状态、完成／取消／断线／不可用时撤下，以及系统／应用减少动态效果。

通过 Computer Use 正常刷新同一原 Morphz App 前端，在用户原有正在执行的消息上
实见恢复后的环绕光效，原会话和内容仍在；未发送测试输入、改资料或重启 Runtime。
原窗对照 `/tmp/morphz-halo-original-before-20261003.jpg`、
`/tmp/morphz-halo-original-after-20261003.jpg`。自动测试使用隔离夹具；不以夹具
截图冒充原窗。原窗只验证当前深色，其他状态与减少动态效果由自动回归覆盖。

## 2026-10-03 撤回未验证视觉规范与工程状态澄清

按用户要求，本轮未经审美验证的全产品视觉规范已撤出正式入口，原稿改名为明确
撤回的历史探索材料；其中数值、MUST／SHOULD 等不产生后续实现约束。现行已确认
交互、生产 UI、Profile、草稿及 Runtime 不变。前端工程提案解除对该视觉稿的依赖，
仍单独保留为待评审方案，不将格式、链接或图示检查冒充架构落地或审美验证。

当前前端已有 Web／Desktop 共享 UI、逻辑业务传输、Session 流与事件读取基础；
本轮整体工程设计只完成源码审计及迁移提案，尚未完成宿主编排拆分、交流几何的
单一所有权收敛、角色型共享控件或新 CI 门禁。本次只调整文档与仓库协作要求，
没有实施以上重构；后续完成项需要生产改动、自动回归及原 App 验证分别记录。

## 2026-10-03 主窗口空白恢复与启动兜底

原窗口实查停在 `morphz://app/__desktop_restore`，不是 UI 资源丢失；偏好恢复
回执已写入，旧进程却没有保留正式入口的失败日志。原 `createWindow` 的函数体回归
复现两项确定缺陷：入口加载失败仍显示迁移空页，及旧窗口异步恢复错误操作新窗口。
这证明源码路径有缺陷，不证明本次最初触发错误就是 `ERR_ABORTED`。

现在每次创建固定自己的 Window／Browser，await 后核当前身份与销毁状态；重复创建
共享同一启动 Promise，activate 不提前显示迁移页。正式入口成功且可信后仅清理
该主 frame 的导航历史；失败则载入同 origin 的无脚本恢复页，提供真实主入口链接，
先清理迁移历史再显示。IPC 白名单未扩大，profile／原 storage／guest 历史未清除。
新失败日志只记录受限启动阶段、限长且去 URL 登录／查询信息的错误及时间，不作为
通用业务日志或通用秘密脱敏机制。

同一原 App 在正常退出及 SIGTERM 无效后，采样显示 Node `FreeEnvironment →
RunCleanup → CleanupHandles` 卡住；该旧进程已无业务数据库或工具 socket。
只强制结束原桌面 PID 20613，以原包／原 profile 重开，20:45 实见原事项、项目及
历史活动，主入口 `morphz://app/`；新主进程 35371，外部 Runtime 68670 及启动时间
保持，未重启它、重放输入或创建测试业务对象。偏好恢复记录为 restored=0、
ownerRestored=true。原窗口截图：
`/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/com.openai.sky.CUAService/Morphz Screenshot 2026-10-03 at 8.45.03 PM.jpeg`。

启动／恢复／安全／开发配置定向回归 19/19 通过、零跳过，typecheck 通过。
本轮修复启动失败空白兜底与窗口竞争并恢复原 UI；Node 退出清理为何卡住、最初
正式入口为何未正常停留仍没有足够日志定位，不宣称这些根因已经彻底修复。

## 2026-10-03 阅读按钮组半透明材质修正

按用户截图，仅当前交流／完整记录展开时，右上角交流按钮组使用既有
`--surface-popover` 中性半透明表面（约 95%）和 `--popup-blur` 磨砂；图标仍完全不透明。
不增加内距、描边、阴影、整行底板或布局高度，未改位置、尺寸、DOM 与状态；
仅输入状态仍透明并保持与中间 Dock 底边对齐。现有系统减少透明度、增强对比度和
原生网页画布的共享材质回退自动生效，使用实底、无模糊。

新回归在旧生产准确 RED：期望半透明背景，实际完全透明。测试本身随后修正两项
兼容假设：新版 Chromium 不支持的 WebKit 别名不作为有效 computed 属性；浏览器
宿主既有沉浸布局使用自身几何基线，不与普通工作区强行比较绝对位置。标准模糊、
材料回退、原尺寸／命中／相对位置门禁均保留。最终 build／typecheck 与两完整定向
套件 13/13 通过、零跳过，输出 `/tmp/morphz-reading-controls-material-green-v3`；
旧生产 RED `/tmp/morphz-reading-controls-material-red`，构建
`/tmp/morphz-reading-controls-material-build.log`。

Computer Use 在同一原 Morphz App 真实长正文上复现并验证叠字处图标可辨；正常刷新
前端后回到原事项页，展开阅读检查材质，收起阅读检查透明悬浮状态。原窗截图
`/tmp/morphz-reading-controls-material-original-reading-before.jpg`、
`/tmp/morphz-reading-controls-material-original-reading-after.jpg`、
`/tmp/morphz-reading-controls-material-original-input-after.jpg`。
恢复原事项页、右侧活动栏、项目折叠与隐藏输入；未发送、改稿、改资料或重启 Runtime。
原窗只验收当前深色表现；明暗及辅助功能回退由隔离回归验证，不作为更改系统设置的证明。

## 2026-10-03 局部动作与中间应用 Dock 底边对齐试用

按用户纠正，仅输入时右侧交流按钮与中间 Dock 的按钮底边对齐，不是移到输入底栏。
生产样式只把输入态控件离输入卡片的间距从 10 改为 8 CSS px；中间 Dock 32px／14px、
局部动作 28px／13px、透明材质、阅读展开时右上角与触控 44px 均保持，未改消息／输入衔接。
对应两份回归改为真实按钮底边与双 8px 间距；原尺寸、材质、实际命中、无碰撞、稳定节点、
零额外高度与草稿／零发送守门保留。

默认 Chrome 通道因机器没有 Google Chrome 在启动时失败，不计业务 RED；使用既有缓存
Chromium 与既有隔离配置后，旧生产准确复现 Expected 8／Received 10，证据
`/tmp/morphz-dock-bottom-align-red-geometry`。修正后 build／typecheck 与两完整定向套件
12/12 通过、零跳过，含宽窄、CSS 200%、粗指针、菜单／焦点与阅读伸缩，输出
`/tmp/morphz-dock-bottom-align-green`；构建 `/tmp/morphz-dock-bottom-align-build.log`。
Computer Use 正常刷新同一原 App 前端，实看仅输入效果及展开阅读后仍在右上角；
通过可访问操作打开／收起记录，未把坐标点击当作本轮原生命中证明。截图
`/tmp/morphz-dock-bottom-align-original-input.jpg`、
`/tmp/morphz-dock-bottom-align-original-reading.jpg`。恢复原事项页、右栏与隐藏输入，
未发送、改稿、改资料或重启 Runtime。

## 2026-10-03 应用入口与交流动作分层，聚焦尊重记录显隐

按用户进一步确认，中间应用 Dock 保留原 32px 点击区、14px 图形和既有按钮材质；
右侧交流局部动作使用 28px 点击区、13px 图形，默认透明、无常驻描边／阴影，悬停与
选中使用中性平面底色，保留键盘可见焦点。仅输入时 Dock 距输入 8px，右侧距输入
10px，以图形中心线对齐而非底边；触控双方均为 44×44px、8px 间距。阅读展开后右侧
仍在右上角。记录入口由时钟改为文字对话气泡，不批量缩小中间导航或底栏工具。

实际聚焦 RED 证明 textarea onFocus 会强制展开 recent。移除该副作用，隐藏重开仅进入
input，原 input／recent／history 均保留；显式发送与迟到回执规则不变。沿用已有工作范围
客户端偏好，不增加状态、存储模型、后台轮询或模型请求。

原生 200% 回归发现工作区错误提示覆盖右上角操作。阅读可见时将同一真实提示放入原
Conversation 安全区；没有提示不产生占位或额外面板兄弟节点。长正文独立滚动、关闭按钮
常驻，关闭前转交焦点避免误收起。自动高度真实 RED 又证明百分比限高使 oversized sticky
向上挤入控件区；仅提示存在时观察原阅读内容盒，以布局 CSS 像素扣除 padding／margin，
不设置阅读外尺寸或改写高度偏好，卸载清理 observer。自动高度仍随内容适配；显式调整过的
阅读高度保持原值。

最终 build／typecheck、定向 Web／真实 Electron 回归 39/39、相关单元 13/13 通过，零跳过。
输出 `/tmp/morphz-composer-semantic-accepted-final`，构建
`/tmp/morphz-composer-semantic-final-build.log`。覆盖宽窄布局、实际图形中心线、透明／选中
材质、触控 44px、键盘焦点、仅输入刷新／工作范围隔离、显式伸缩、草稿与零发送／应用启动。
真实 Electron 通过完整原生 200% 流程，自动与显式高度长提示均能以键盘／滚轮到达尾句，
Close 与交流按钮中心／上沿真实可点，关闭不收起阅读、不改变原显式高度／草稿／guest。
故障入口是隔离夹具对实际受信 IPC 保存请求的一次 409 回复，不是往 DOM 填一个提示；
该测试不证明修复了 BrowserHost 保存的 revision/CAS 竞争，本轮没有修改该逻辑。

验收脚本另纠正跨进程读取混用旧 ARIA 与新 panel 的布局快照，及原生缩放的滚轮单位／
整数视口量化；缩放后先核宿主侧栏、slot、webview 与真实 guest 一致再采点击前基线。
原拖拽精度、普通点击、完整网页状态、原稿与实际命中门禁不放宽。
Computer Use 在原 App 实看 Dock／局部动作分层与右上角位置，最终前端正常刷新后实际点
输入仍为仅输入；截图 `/tmp/morphz-composer-semantic-verified-input.jpg`、
`/tmp/morphz-composer-semantic-verified-reading.jpg`、
`/tmp/morphz-composer-semantic-final-refocus.jpg`。保留原 profile、数据、工作与空草稿；
恢复原事项页、右栏、100% 缩放、隐藏输入，原 App PID 20613 保持，未重启 Runtime 或发消息。

用户随后询问消息／输入衔接历史。只读 Git 审计确认上一阶段 `96a84a6b` 已将一体外框
拆为两张 16px 圆角表面，并加 8px 间距（16:43 截图已呈现，17:00 是提交时间）。这不是
实现悬浮按钮的必要改动；本轮没有再改这组边框或衔接间距，也未把用户的询问当作改回授权。

## 2026-10-03 输入框上方零占位悬浮操作层

按用户确认的布局，仅输入时交流控制在输入卡片外上方，与应用 Dock 同一基线；
阅读展开时按后续反馈保留在面板右上角，同一组 DOM 不重建，更多菜单向下打开。
Dock 与交流图标缩为 14px，保留 32px 点击区与触控 44px 点击区。
不增加整排底板、胶囊或外框。仅输入状态没有标题栏、拖拽条或多余高度，输入四角完整；
实际阅读展开后才有独立阅读表面与顶端伸缩入口。专用对话画布的原例外保留。
实际面板 620px 以下将展开／固定收进更多选项，440px 以下用 Launcher 承载应用入口，
360px 以下仅输入时靠左避让，阅读展开后恢复居中；快捷按钮可滚动，Launcher 不滚出视野，
触控保持 44px 命中区。

断点改为按面板布局宽度判断。控件被收纳前转交焦点到稳定的记录按钮／Launcher，
防止不可见焦点和未固定输入误收起。统一由面板测量实际浮层安全空间；修正 CSS zoom
下拖拽混用屏幕与布局像素的问题，ARIA、本地高度偏好与真实阅读高度采用同一单位。
不改输入、草稿、应用／Session 路由、批准、任务或 Runtime，不添加轮询或模型请求。

最终构建与 typecheck 通过；定向 Web／真实 Electron 回归 32/32、相关单元测试
13/13 通过，零跳过。最终输出 `/tmp/morphz-floating-topright-edge-green`，构建日志
`/tmp/morphz-floating-topright-edge-build.log`。
覆盖零占位、320px 至宽屏、CSS 200%、触控、真实命中与无碰撞、菜单／键盘焦点、
伸缩／取消／刷新、原节点／画布尺寸、持久草稿与无发送／应用启动请求。
原 16 项既有回归保留行为断言，仅迁移已不存在的标题栏／输入态伸缩条／伪分隔线。
原窗口通过 Computer Use 实看当前交流／完整记录的右上角控件、收起后的零占位操作层，
正常缩放及收起右栏后的窄宽向下菜单、Escape 焦点返回。实际鼠标点击记录按钮上沿，
正确切换为仅输入，未启动拖动。截图 `/tmp/morphz-floating-topright-original-reading.jpg`、
`/tmp/morphz-floating-topright-original-history.jpg`、
`/tmp/morphz-floating-topright-original-input.jpg` 与
`/tmp/morphz-floating-topright-original-compact.jpg`。沿用原 App、profile、center，验收后
恢复 100% 缩放、原右栏和《领证前夜》工作台位置、原隐藏输入状态；原 App PID 20613
保持。没有重启 Runtime、写入测试消息或创建手工验收中心。

右上角布局首次统一回归 32/32 通过后，只读复核发现伸缩条 z=5 覆盖 z=4 控件的上沿
4px，中心命中断言不能捕获。补充上沿 2px 实际命中门禁，先在未修生产时复现失败：
命中 `exchange-resizer` 而非记录按钮，证据 `/tmp/morphz-floating-topright-edge-red`。
将完整控制层提到 z=6，不裁剪或移动中央拖柄；最终 32/32 包含正常、紧凑、CSS 200%
及粗指针的上沿门禁，原窗口物理点击也通过。不将这次定向操作层验收称为全局三栏
响应式布局改造。

测试途中曾误点底层剧本启动按钮，造成切换到另一份独立空草稿；trace 确认不是原草稿
丢失。现用真实惰性画布命中点，并核准确持久草稿与零应用启动请求。一次宽窄切换的
测试 helper 锁定已卸载的 More，已只等待真实断点一致，不主动重开输入或重试已点击动作。
真实 Electron 初次末尾原稿曾出现多余单字母，尚未确定来源；保留原稿门禁并新增输入／
键盘因果记录，后续独立复跑 2/2 通过，不能将暂未复现说成已定位并修复该来源。
隐藏评论阶段以冻结的准确草稿 key 验证持久正文，重开仍核原 DOM 正文；不以主动打开
输入掩盖隐藏态。原生 200%、网页实例／视口／表单、原生点击／拖拽与 guest 隔离均通过。
随后真实 Electron、宽窄键盘／外部点击、Dock 刷新／启动／独立草稿三项各连续重复三次，
9/9 通过；不将重复次数与前面的唯一测试数相加。失败证据与后续独立输出分别保留在
`/tmp/morphz-floating-native-final`、`/tmp/morphz-floating-native-verified`、
`/tmp/morphz-floating-final-24` 和 `/tmp/morphz-floating-repeat`。
本段记录本轮定向范围，不代表整个应用所有旧页面均已验收。

## 2026-10-03 同一原窗口四节点终验：真实回执、分组与原数据保全通过

本轮生产实现本地提交 `33a58d68`，未推送。原同一 App、desktop profile、Session 与
18089 保持；确认无在途工作、完成在线备份后正常停止重开 Runtime，部署 binary SHA256
`d3308da4a3acf89da1c7d9d1afbe65459eb89f46456fedbb29a4f5adc1b82fbd`。
首次选错本机代理凭据绑定造成单次 TEST 的 HTTP 401，零成功响应／工具执行；该失败
独立留存在 `/tmp/morphz-original-receipt-acceptance.E8nZx2`，仅其新空 Thread 正常取消。
恢复正确既有绑定后，代理只读检查 HTTP 200，Runtime 68670；不改凭据文件或路由。

原空输入框一次发送新 input `0642ce7c-e1c4-4355-a04a-f2c767844d3a`，root
`msg_1791014382180501000_68670_0`，三个 canonical 来源逐字／SHA 一致。
真实主→A、B，A→A1 全 completed，四次成功 Profile.read、三 attached 调度、两 all
Group satisfied。四节点 title／intent／工作 progress／最终 result 经正式 Application
解析与 producer 绑定验证；Computer Use 在同一原窗口实看各组、独立步骤与结束状态。
没有另开手工中心、API 构造 Human 输入、重放旧 root 或覆盖旧错误输出。

Context 正常两批维护 28→30 后恢复工作工具并继续。实际 15 queued／15 accepted／15
usage，主 7／A 4／B 2／A1 2；continued、rejected、invalid wait、repair 和专用注解
请求各零，不称总体零请求。实际 `.messages` 单 WS 全捕获，25 份 accepted 回执精确
核 source／ACT／call ID／代际／协议／实际 manifest cutoff。主与 A 的真实 Group 最终
新 Activation 均保留自身 Profile 和 schedule 两个历史调用及 progress；验收器门禁已
补强，不能靠“只找到一条跨轮回执”通过，解析异常也不输出私有参数片段。

原 6357 Events、80 Profile versions、14 Frames、6 protected、剧本候选／版本／回执、
18 原 Schedule 和未来提醒保全。两条退休的旧真实阅读进度句独立语义复核通过，十条
精确相关 Event 与基线哈希相等；无新摘要，不将非驻留记录称为 Inbox 可见。机械报告
原 `passed=false` 的唯一末项是“待内容复核”，原报告未覆盖；补充独立语义审查文件。
新目录 `/tmp/morphz-original-receipt-verified-auth.yjNbbY` 的原业务／持久合同与物理
回执门禁均通过。剧本先前已在原窗生成并保存两人物与五场大纲的三候选，继续待人审，
没有伪造采纳、批准或覆盖正式空稿；本轮只核保全，不把候选自动采纳当修复门槛。

模型最终正确确认主节点注解；对子节点回执未在自身结果里展示明确表示未知，并非断言
丢失。当前回执仅证明本 Thread 的来源；四节点注解完整性由 Application family／Store
门禁核验，而非让父模型作全局验收器。不放宽 owner 边界或增加模型请求来强行生成
“全通过”。下面各节保留当阶段的失败和未部署状态，不能当作本段之后的当前运行状态。

## 2026-10-03 跨 Group 等待的注解回执：行为 RED 后请求链与实际 Store 通过

重新检查时磁盘空间已恢复，未追加删除缓存。第一次成功编译后的新夹具因沿用
`context_only` 模式而缺少它要求的 Recall，失败在工具断言，不算生产行为 RED。
仅为新增读取链启用普通工具策略，原 8 请求等待用例保持不变。

随后在未修改生产源码的情况下，原用例通过；新增 10 个业务请求真实完成两次读取、
调度、已落盘等待、两级 Group 唤醒及四个 Thread 终态，最后在新 Activation 请求中的
回执断言失败：`group-A-1` 已接受的原注解仍在 Store，但 canonical Context 中对应
`response-annotation-receipt` 为零。日志
`/tmp/morphz-annotation-receipt-regression.I9zEQX/old-runtime-red-fixture-corrected.log`，
夹具 SHA256 `71d88764a10a01fd3f0a7296a30735844c516b2f2a0b56e28704fc1c802a8c49`。

按 Proposal 接入生产后第一轮仍缺回执，进一步定位到 SQLite causal／scheduler 两处
手写 Thread 快照遗漏冻结 `response_annotations`。各补一个真实列字段，不加查询、表或
迁移；PostgreSQL 原 `to_jsonb(thread)` 已包含该字段，无需改其生产查询。
修正后的真实 10 请求链与原 8 请求链 2/2 通过，前者确认实际 Group 唤醒的新 Activation
仍看到早先接受的 intent／progress 及真实 call ID／generation／cutoff，不添加模型请求。
日志 `receipt-runtime-snapshot-fixed-green.log`。

实际 SQLite／PostgreSQL 快照合同 4/4、零跳过，Off／V1／V2 的 direct、causal、scheduler
Thread 全等。日志 `receipt-store-sqlite-pg-green.log`；唯一生成 TEST PG 库核 owner、
零连接与零生成 schema 后已精确删除，原用户库未改。新增 lib 门禁曾因测试模块缺导入
未能编译，已只修测试接线；随后 7 项新增 pure／Context／cache 门禁全部通过，同次
`receipt_` 筛选 11/11 与完整 annotations lib 34/34 通过（两组重叠，不相加计数）。
实际 experimental Delta 1/1、准确 3 个原业务请求通过，严格要求真正 Delta，不接受 Full
fallback 当通过；尚未端到端验证 Delta 跨等待／真实退休链，Off source batch 零查询是
源码早退保证而非新增 SQL 计数。最后默认请求回归 32/32：ingress 3、Runtime 24、steer 3、
真实等待 2；日志分别 `receipt-unit-gates-import-fixed.log`、
`receipt-existing-annotation-lib.log`、`receipt-actual-delta-runtime.log` 和
`receipt-final-default-request-regressions.log`。同原 App 真实模型语义复验仍待，不把机制
通过写成两项总目标完成。
成功的旧源码 Cargo 重试也重建了磁盘上的 `target/debug/morphz`，SHA256 为
`28b56c2cf0cc9131036864b5286028d576a14a5a000b3fff81709ad880cf2fa0`，已保存为
上述证据目录的 `pre-receipt-runtime`。原 Runtime 33840 未重启；不能把重新生成的磁盘
文件哈希冒充原进程的已加载镜像哈希，尚未部署本次回执修复。

## 2026-10-03 原窗口四节点等待复验与注解事实缺口（目标仍进行中）

当前同一原 App 可正常读取，不沿用早先锁屏或 Computer Use 工具故障猜测现场。
Runtime 仍为 33840／18089，部署 binary SHA256
`9901fef20c46affb779092d9efe73a7d7636ef9b1487cf9a905c9000f55cb56e`。
通过真实原 UI 只发送一次新的 `TEST 四节点只读活动（等待修复终验）`，input
`6d0abff8-87d9-4779-9dd1-cf82531136f4`、root
`msg_1791008977902387000_33840_0`；三个 canonical 来源逐字和 SHA256 一致。
没有通过 API 构造 Human 输入、复用旧 accepted root 或另开手工中心。

实际四个 Thread、四次成功 Profile.read、三项 attached 调度及两级 all Group 汇合均完成。
本轮 12 个物理业务模型请求全部接受，`invalid_wait`、协议纠错、拒绝及注解专用请求均为零；
不把 12 写成夹具的 8，也不说总体零 LLM 请求。四节点各有可核来源的工作进度，两次调度
各有精确 carrier intent；四个实际物理 Job 与标题／结果来源通过正式 Application 解析器。
原 6244 Events、Profile head／80 versions、Mind 28／14 Frames／6 protected、剧本候选／
正式版本／回执、原 15 Schedules 和未来提醒保持；本轮不需要 Context 维护。
证据目录 `/tmp/morphz-original-four-node-wait-regression.euab8K`，其中机制报告
`verification.json` 为通过，不等同于注解文案语义全部正确。

原窗口实际打开这项主活动，AX 和截图确认主执行、A、B、A1 分组、各自步骤及结束状态；
`original-ui-main.jpeg`、`original-ui-grandchild.jpeg` 保留该轮画面。模型最终正文及
44 字 result 却错误自评主节点 Profile／调度“缺少注解”，与持久的 title／progress／intent
事实相反。不能以来源合法或 JSON 契约通过，将这项语义错误宣称解决。

源码复核发现原始 `_annotations` 在即时工具 continuation 保留，但更后轮的 compiled Inbox
主要呈现已清洗业务参数，不回显已接受 bundle。最后上游 prompt 未保存，因此只证明存在
跨轮观察缺口，不把它断言为本次错误的唯一原因。按
`docs/morphz_response_annotations_proposal_v1.md` 的新回执设计继续修复：只在现有授权来源
附加有界的 Runtime accepted metadata 事实，区分 accepted／none_accepted／unknown／截断，
保持 Off、原业务参数与原 continuation，不增加 LLM 请求、表、账本或健康轮询。
仍需零付费真实跨 Group 唤醒请求链、部署及原窗口真实模型语义复验；两项目标未关闭。

新请求链夹具已写入 `morphz/tests/thread_group_wait_runtime.rs`：保留原 8 请求用例，
增加两个真实只读 Recall 后为 10 个业务请求，先完成实际等待／汇合／终态，最后才检查
新 Activation 的 canonical Context 中的先前注解回执及精确 call ID／generation／cutoff。
首次旧生产编译日志 `/tmp/morphz-annotation-receipt-regression.I9zEQX/old-runtime-red.log`
退出 101，失败在 lib archive 的 ENOSPC，尚未运行断言，不计行为 RED；生产三个修复文件
仍未改。仅清理本目标 02:26–02:28 编译期的两个独占 dep／query 缓存（847899471 字节）
后仍不足，已请求额外过期构建缓存清理的方向，未擅自扩大删除范围。实际部署 binary
哈希仍与上述一致；原 Runtime、数据、测试二进制和失败日志保留。
随后仅清理此次失败编译覆盖生成的 16 个独占 `.rcgu.o` 中间物（398090696 字节），
mtime 均落在失败日志窗口，清理前再核无构建进程／打开句柄；rmeta、其他 deps、二进制、
日志及用户数据保留。可由源码重建，实际空间恢复至 973 MiB；没有再赌一次大编译。

同轮另外补齐 populated-v6 PostgreSQL preparation 的实际迁移缺口：SQLite／PostgreSQL
同文件 14/14、零跳过，整应用严格类型检查通过。该测试与验证附记已聚焦本地提交
`925173c6`，未推送；唯一合成 TEST 库核 owner／无连接后删除，可由 fixture 重建，
不接原中心。这项迁移验证不代替上述尚未完成的语义验收。

## 2026-10-03 认知应用准备输入时保留模型与草稿

既有 `compose({ artifactId, text })` 入口在目标 surface 重建草稿时仅写 body／selection／revision，丢掉已选模型、effort、附件等字段；普通发送与刷新已有的修复并未覆盖这个分支。现在以 functional 最新状态追加目标正文，保留目标模型／effort／附件与原 selection／reading／page／revision，不搬移来源应用草稿。旧 key 仅在默认会话承接对应 project＋artifact 草稿；有专用补充、批注、事项结果或剧本生成绑定时明确拒绝，原输入不变。超出既有正文上限则拒绝，不截断。

Sandbox 在对象读取之后调用最新回调，按真实身份代际、navigationId、应用实例／版本／权限及仍存活的原 iframe 守门，并返回消费端的真实错误 ACK。独立审查补正实际卸载后迟到回调仍可操作旧页面的问题，以及把 `useWorkspace` 每次重建的 client 对象误当成身份变化的问题；同身份正常刷新不误拒。App 仅在这一准备入口用 `flushSync` 确认最新草稿守门后再导航，不改发送、Session、Runtime、目录授权或审批。仍只是本地准备，由用户决定发送；本地存储失败沿用原可见错误，不宣称发送成功。

冻结后专项回归 28/28、零跳过，严格类型和 diff 检查通过；主代理独立复跑草稿／真实 Sandbox 桥 21 项与相邻摘要／refresh-drain 7 项均通过。保留旧桥正文回滚／假 ACK／迟到范围的行为 RED、实际卸载与 client wrapper 误拒的 RED；早期缺 helper export 和夹具缺字段不是行为 RED。日志 `/tmp/morphz-artifact-compose-final-frozen.log` 与对应 `*-red.log`。真实桥在 StrictMode 中覆盖读取期间编辑、当前回调、错误 ACK、导航变化、同 Human 新身份代际、client wrapper 重建及真正卸载／跨工作空间；不冒称完成了真实 A→B→A 登录流程。

以上分别是生产纯合并 helper 与实际 `ApplicationHost`／opaque Sandbox iframe＋fixture consumer 的验证，不是原 App 的 `WorkspaceApp` 自动保存分支端到端或原窗口验收。测试使用现有 1228 headless 浏览器，无付费模型、原库或用户浏览器操作；未构建／发布原 App、未推送。磁盘不足 200 MiB，不开启 Cargo／整应用大构建，不为本项删除资料或运行产物。之前两项总目标仍 blocked，待原窗恢复后继续其严格验收，本项不关闭它。

## 2026-10-03 事项 Markdown 解析一致性补修

用户转为先处理不依赖解锁的既有反馈后，源码审查发现事项正文独立使用 `react-markdown`，只接原始换行插件，漏掉聊天／文档已有的 GFM 和中文标点强调规则。真实 `TaskSummary` SSR 先复现表格、任务清单、中文强调三项失败；不是声称此前换行修复全部失效。

现在两种正文共用 `markdownRemarkPlugins`，并抽取既有 `MarkdownTable` 滚动容器，事项宽表只在自身范围横向滚动。沿用原 class、region／中文名称、键盘入口及生产 CSS；不新增另一套渲染器或依赖。原始换行、代码、正文和版本保持；事项链接仍为不可跳转的 span、图片仍占位、HTML 禁用，任务清单的勾选框只读，不映射为真实事项完成。

聚焦 Node 回归 33/33、零跳过；实际组件 SSR＋三份生产 CSS 的隔离浏览器几何回归 4/4，覆盖 1440／320／390 px 和 390 px 的 CSS 200% 放大，页面不溢出、宽表内部滚动与键盘操作、普通表和禁用清单均通过。证据 `/tmp/morphz-task-summary-markdown-final-{node,browser}.log`，原语法失败与单独滚动包装失败日志保留。主代理独立复跑几何 4/4，严格类型检查通过。测试使用现成 Chromium 1228 的 headless 进程，无外部网络请求／模型／原库写入；CSS 放大不冒称原生 Desktop 缩放。

Browser 技能检查确认当前无可连接浏览器，以上是仓库的隔离自动回归，不是第二个手工中心或原 Morphz 窗口验收。未构建／发布原 App、未推送；先前剧本与嵌套活动的严格原窗目标仍未关闭，当前状态为 blocked，本项不代替它的剩余验收。

## 2026-10-03 两项修复范围与验收门槛（进行中，非完成声明）

用户所指的两个问题分别是：

1. 剧本任务：简短确认承接当前已约定范围；一次任务分别生成、保存两个人物设定与五场戏大纲。
2. 活动记录：一项工作汇总实际派生的子 Thread，按分支展示各自步骤、状态与结果，并修复子活动详情的 root 授权归属。

两项都完成实现与验收后才结束本轮目标。剧本的生产数据模型／语义设计见
`28-script-studio-executable-yao.md` 顶部；活动沿用真实父子关系与授权事实，不以同 Session／输入猜归组，不增加 LLM 请求、健康轮询或第二份执行账本。

原窗口后续进展：同一原 App 解锁后正常重开，已实看原提醒主活动及独立子 Thread，错误的 family 截断提示已消失，未停止原提醒。通过真实 UI 创建 `TEST  1003` 项目、《TEST 原窗短确认 1003》及三个空条目；不使用另一手工中心、复制隔离候选或构造 Human IPC 输入。首次发送发现新命名草稿错误查询尚不存在的目录授权，使发送按钮被锁住；现在只在已持久对话读取目录授权，首次输入仍原子创建对话，零继承旧授权，已有对话查询失败继续阻止发送。

10:22 后续纠正：此前“没有工作工具就停止”“仅一次固定六项维护”是验收输入自身增加的限制，不是 Runtime 不能维护后继续；不再把这项人为限制当作产品阻塞。原 App 在偏好恢复页空白，正常退出后 Electron 残留清理进程不退出，结束该残留进程并在停止态备份原 desktop profile 后重开同一个包；原 Runtime 54199／18089 不变，无新手工中心。通过原 TEST 对话 2 真实 UI 发送撤销上述限制的输入 `47da1c40-d7fb-45d6-8bed-e2b878ec8dfd`，root `msg_1790994166797885000_54199_3`，959 字／三个 canonical 来源及 SHA256 一致。正常 `context_tx` 已提交 27→28，94 项已消费调用退出视窗；原 6056 Events、14 Frames／来源、protected、Profile head／80 versions、原 Schedule／未来提醒以及剧本三候选／版本／回执不变。下一真实请求 full-work 246337→220513，36 个工作工具恢复，主 Profile Job 与实际 `schedule_tx` 创建 A、B 成功；没有改容量或 usage anchor。证据 `/tmp/morphz-original-four-node-normal-maintenance.GTXDui`，旧固定六项失败保留。

本次四节点仍未通过：两个子 Thread 在首次模型请求之前因 Custom 挂载校验失败而终止，A1 未创建。源码将 `stable_thread_id(root_turn_id)` 当作真实 Thread ID；调度创建的独立 Thread ID 与 synthetic root 的哈希并不相等，原非空 Profile 暴露了隔离空 Custom 测试漏检。正在补真实 scheduled 父子孙＋非空 Custom 回归，并按持久 Thread／Activation 的完整范围修复；不能移除身份守门、假装失败分支已完成或以维护成功代替两项完整验收。

该 Custom 身份缺陷随后修复：非空挂载按 exact root／activation ID 从 Store 并行读取真实 Thread 和 Activation，核 agent、Context、Session、principal、generation 及 View／Focus 归属；不猜 root 哈希、不靠有界模型目录或删除权限守门。合法 legacy None principal fallback 与空 Custom 的原字节保持；没有新公开 schema／索引／LLM 请求，非空重编译增加两次固定点读，并不冒称原子快照，执行撤销仍由原 fence 保证。真实 SQLite／Runtime／`schedule_tx`／V2／非空人格四节点先红后绿，原红为主模型 1 次、子模型 0 次的相同挂载前失败。最终夹具支持合法并发完成顺序（业务求值 6..8），第三次父求值若存在必须对应真实同范围 Group barrier；连续三跑通过，实际各 8 次原业务求值，零外部模型请求。现有 `custom_runtime` 2/2、`lib custom_` 10/10、remote-store 编译及格式检查通过。证据 `/tmp/morphz-custom-scheduled-regression.0OfJqy`；夹具初次终轮注解字段与计数错误的失败记录保留，不能算产品失败或原窗通过。

10:44 原 Runtime 正常 TERM／同配置与 18089 重开 24938，部署构建 SHA256 `2f120f84b2bbb9748c7e6b84cb359f4da3db34c1a38051db87f0924a7468c6a6`。随后 Cargo integration test 自动重链接了磁盘 binary，不以当前磁盘 SHA 冒充已运行进程的部署映像。原 UI 同一 TEST 对话提交新 input `58fa2464-ea04-4383-985a-5188fbe3e878`／root `msg_1790995460900180000_24938_0`，987 字／三个 canonical 来源一致。实际四个 Thread／独立 root 全部 completed，四个 Profile.read Job succeeded，三项 attached schedule、两项 all Group satisfied，各节点标题／意图／结果与精确子 family 校验通过；四份非空 Custom 均冻结 revision 80。原 6096 Events、80 Profile versions、14 Frames、protected、Script 候选／版本／回执及原提醒保持。只读报告 `/tmp/morphz-original-four-node-custom-regression.88BmGY/diagnostic-continuation.verification.json` 明确 `mechanismPassed=true`，但严格原输入验收仍 false：主节点额外调用了三次 readonly recall，原严格失败不覆盖。

本次真实业务计数为 18 queued／18 usage＝14 个已接收业务响应＋4 个被拒绝的 `no_reply(mode=wait)`，不能改成 14 或宣称零额外请求；其中独立命名／注解-only 请求为零，四次重试是工作等待协议被拒，不是注解修补。源码等待守门只计后台 Job、queued Schedule 和 pending Signal，漏掉已分派且仍 open 的真实 attached 子 Thread／Group；首个拒绝时 A、B 均在途。这造成额外修复与结果查询，正在补同范围真实待汇合 Group 的合法等待与终态／跨范围拒绝回归。两项总目标保持进行中，不以 Custom 已修复或四节点终态掩盖等待请求成本缺陷。

10:55 已用 Computer Use 打开同一原窗口主活动，实看主执行、A、B 与 A1 的分组、递进缩排、各自已结束状态及各自一次 Profile 只读步骤；原截图在 `/tmp/morphz-original-four-node-mechanism-ui.kuVLme/{main,children}.jpeg`。这只确认功能链的显示，不覆盖上述严格失败。独立原 SQLite 复核确认 18 份 usage／response hash 与精确 model attempt 归属一致；正式 Application 注解解析器确认四个物理步骤均有 intent、四节点终轮都有 title／result。模型最终回复中“早期业务调用缺少注解”的自评并不符合这些持久证据，不把自评当缺失事实；每步 result 注解仍为可选，不能冒称该轮已产生。

等待修复的真实 SQLite／Runtime 四节点夹具已先红：实际 Execution、v2、当前 generation、真实 schedule 回执后仍被 `invalid_wait` 拒绝，排除了 Dialogue-kind 的假红。新方案只读取 fresh 真实 owner／Activation 身份及同 Context／Session／owner／generation 的 Open Group，在 SQLite／PostgreSQL SQL 过滤后限量一项，结果为 bool 而非伪计数；先读 Group 后读 Signal，验证与 yield 共用规则。没有新增执行账本、依赖行、模型请求或生产轮询。独立审查还发现既有 v2 ThreadWait 回退 timer 漏代际守门，正一并补合法 v1／v2 的精确 fence 与 stale-v2 零唤醒回归。仍待绿测、部署及下一次原 UI 完整验收，不称这些待修复事项已完成。

Timer 红测的首次编译被 ENOSPC 中断，尚未获得该负测的行为结果；不把编译推进当红／绿通过。确认无 Cargo 后，只删除本轮 libtest 的失败 `s-hmusdz9eb9-1re6rl2-working`（1.6 GiB）及已验证 Custom libtest 对应的旧增量缓存 `s-hmurt0zwf9-1dzco21-28g72nieqr12odbjgc6097ah3`（1.9 GiB），均位于 `target/debug/incremental/morphz-1jxv1138pe5n0/`，可由源码重建；保留实际验证二进制 `morphz-5edcb2d3137b1930`、失败日志及所有用户库／资料。APFS 实际剩余 2.5 GiB 后继续验证。Pause 不扩成另一项控制重写：当前 admission 挡新 Activation、在途模型可收尾，等待 dispatch 仍核 Active；不能让 paused owner 的存在性 false 触发额外 `invalid_wait` 模型纠错，也不宣称本次改了 Pause／Resume 代际语义。

随后 Timer 行为红确证 stale v2 能产生当前代 wake（`timer-v2-red.log`）；该首红使用 due-now，测试构造器会自动启动 TimerEngine，因此只证明旧守门允许错误唤醒，不冒称唯一手动派发来源。最终夹具改 future-due 后手动调用真实 handler，V1／V2 stale 零 wake／Signal、Off 旧行为、同代 paused 零 wake 及既有持久长等待／取消／fallback 的两项回归全绿；owner 当前身份／Group 存在性 1/1、真实 SQLite 两 scope 的 64 个并发错误回执 1/1、既有 `custom_` 10/10。原并发失败同时暴露 timestamp-only 错误 Event ID 碰撞，已改既有 getrandom 的 128-bit ID，不加 UUID 依赖；随机源失败明确返回错误、不退时钟。64 条是生产 publisher／Store 回执测试，不是 64 次模型响应。

后续空间恢复仅追加清理本轮 11:07 红测以及 10:53–10:57 两次四节点夹具编译的五个精确增量缓存，二进制／日志仍留存；验证改为本次环境 `CARGO_INCREMENTAL=0`、jobs=2，未改 Cargo profile。集中首编译的 Arc move 错误只在新 timer 夹具，补 clone 后行为组退出 0，记录 `/tmp/morphz-custom-scheduled-regression.0OfJqy/wait-unit-green.log`。默认生产 Runtime 四节点等待、实际 SQLite／PostgreSQL 查询合同、最终构建／部署及原窗口仍待完成，不把这一阶段的单测全绿当两项目标结束。

默认生产 Runtime／SQLite 四节点等待随后 1/1 通过：真实 parent→A／B→A1、非空 frozen Custom、两个真实 Open owner Group、没有 Job／queued Schedule／pending Signal 时两个合法 wait；叶响应释放后四节点 completed、两组 satisfied、两个回退 Timer cancelled，准确 8 次既有业务模型响应、零协议纠错／注解专用响应／付费请求。日志 `wait-runtime-green.log`；直接 barrier Event 断言为 topic／owner Thread／root／status／sequence，Context／Session／generation 的严格证据分别在真实 Group 与 wait Timer 核验，不混作每个 barrier 字段均直接断言。新纯查询合同在真实 SQLite／PostgreSQL 2/2、零跳过，证实 SQL 先完整范围与 generation 筛选再 LIMIT；None 查询兼容、ASC／DESC、溢出与零 limit 保持。旧 None+LIMIT 后再过滤的反例是实际 Store 查询反例，不冒称旧生产 binary 回放 RED。证据 `/tmp/morphz-thread-group-generation-query.96vzex/`；唯一 TEST PG 库已核 owner／无连接后精确删除并确认不存在，原库未改。

新增 `ThreadGroupFilter.generation: Option<u64>` 不加表／列／迁移／HTTP 字段；外部 Rust 调用者若写满旧 struct literal 而未使用 `..Default::default()`，需补该可选字段，这是源码兼容边界，不冒称完全零 API 变化。该代码阶段已达到确定性行为门禁，下一阶段才是最终构建、同一原 Runtime 更新与原 UI 真实模型验收；两项目标仍未关闭。原 Runtime SQLite 已在线备份 `/tmp/morphz-owned-group-predeploy.rn4hZa/runtime.sqlite`，无在途执行且唯一原提醒仍在 2026-10-23T01:00:00Z。为新 integration 链接，仅另删本轮旧 10:56 静态编译缓存 `libmorphz-021d5f4da39a7917.rlib`，最新 library、所有测试可执行文件与日志保留。

等待修复已聚焦本地提交 `07fc3b39`，未推送；递归 rustfmt 误带的四个无关纯格式文件已精确去掉，网站等原 dirty 工作保留。最终 binary 构建与 `remote-store` 编译均通过；原 `attempt_loop::test_no_reply_wait_without_pending_runtime_fact_is_corrected` 实际 Runtime 1/1 通过，现有 libtest 的语法／phase／owned Group 守门另 7/7 通过，不把它们冒称 Dialogue 专项端到端。日志分别为 `wait-final-build.log`、`wait-remote-store-check.log`、`wait-old-no-pending-green.log`、`wait-existing-boundaries-direct-binary-green.log`，均在上述 regression 目录。integration test 自动重链接后，最终部署 binary SHA256 为 `9901fef20c46affb779092d9efe73a7d7636ef9b1487cf9a905c9000f55cb56e`，不沿用先前独立 build 的映像哈希。

再次核原在途 Job／Plan／Activation、pending Signal／recall outbox 均零后，正常 TERM 原 Runtime 24938；同一 launcher、原 root／配置／私有 key 源及 18089 重开为 33840，launcher 明确 ready、实际端口监听一致。原未来提醒 id／generation／due／pending 不变，重开后在途与 outbox 仍零，未发送新 Human 输入或模型验收任务。Computer Use 对原 App 的最新检查明确 Mac locked，已请求用户手动解锁，不修改锁屏设置、不经 API 构造 Human 输入。最后严格原窗口验收仍待，两个目标不关闭。

独立审查发现准备的观察器只统计协议拒绝却未纳入最终 PASS，已补 rejected／invalid_wait／protocol repair 为零、真实请求与持久 Thread 的 v2／generation、正式注解的有效 producer scope、Group／Timer 等门禁；合法 reasoning continuation 的 request ID 后缀只报告，不误当协议修复或硬设总模型请求为 8。两份纯门禁自测经 root 独立执行 17/17 通过，非生产行为或原窗验收替身。新基线 `/tmp/morphz-original-four-node-wait-regression.euab8K/baseline-before-send.json` 时间为 `2026-10-03T03:38:53.020Z`，实际 Mind 28／14 Frames／6 protected／6244 Events／Profile 80 versions，旧部署前基线另存；授权 Session GET 200。观察器没有模型请求或直接原库写，GET 的服务端正常 due-Frame housekeeping 不能冒称绝对零副作用；尚未启动新输入的 observer。

下一自动续轮，原 Runtime 33840／18089 与部署 SHA 不变；Computer Use 首次两读为 app-server exited（-10005），不以旧锁屏状态猜当前现场。保留未发送验收文本及 SHA 后，仅重置工具 JS kernel；重新初始化遇 ENOSPC，实见可用 116 MiB。已用 metadata 的相同 inode／SHA、`remote-store` fingerprint 与阶段日志确认，本轮 10:46 检查产生的单个 `target/debug/incremental/morphz-2xxorqgx7uedr/s-hmus0oaxm2-0pjsq27-5rfevc74b1dat052t6p5fi4hi` 是可重建缓存；确认无 Cargo／rustc 后仅删除此项，保留旧 02:23 缓存、deps rmeta、binary、全部日志／库／资料，实际可用恢复 629 MiB。新连接随后明确 Mac locked，已知工具故障恢复，但仍需手动解锁；没有新 Human 输入或原窗验收请求。独立当前 SQLite 核对在 `2026-10-03T03:47:12.853Z` 通过：剧本十表／catalog 精确 hash 与部署后基线一致，三 pending 候选及三正式 v1 空稿、Host 保存结果、八份已投递 outbox／回执保持；Profile head／80 versions、Mind 28 完整 state／metadata、14 Frames／6 protected 的节点集合及原提醒 Thread／Schedule／未来 timer hash 均保持。本次只读 SQL，零 GET／模型调用／直接 Store 写，不能以这次持久性复核代替未完成的嵌套原窗口验收；目标继续 active。

该首发守门的实际挂载 App／Human IPC／Host／Platform 回归 2/2、零跳过（`/tmp/morphz-draft-conversation-directories-verified.log`），验证逐字正文、稳定 input ID、低 effort、刷新恢复、旧授权不变和首次提交后恢复目录读取。真实 Platform 入口专项 1/1（`/tmp/morphz-draft-directory-ingress-test.log`）；生产构建与严格类型通过（`/tmp/morphz-draft-directory-original-build-fixed.log`）。首轮构建暴露 family 夹具的可选 Session ID 未收窄，已增加不存在时的 404 守门，不用断言强转。中间 UI 测试误把 effort／正文断言放到非权威投影字段，已改核实际 Runtime activation／text；失败日志保留，不降低生产授权检查。

原 UI 提案请求已于本地 02:55 实际发送，保存了原正文、轻量 effort，进入 Script discussion；候选仍为零。内部模型请求认证失败，尚未收到唯一提案，因此尚未发送简短确认，不把新 TEST Session 的创建当作剧本交付完成。原窗口四节点工具活动验收仍未开始；两项完整验收前目标保持进行中。

随后认证问题已确诊为本次重启的部署失误：launcher 误选既有 `DOUBAO_API_KEY`，与 8317 本机代理的已配置 key 不同；成功 Native 的明确既有私有源则与代理 key 相同，比较仅在内存输出布尔值、不记录凭据。没有归因于 Harness 或 `infer` 上下文。正常 TERM 40122 后，原 launcher／binary／root／18089／配置均保持，只改为该明确既有源，54199 就绪；同一个 pending TEST 自动恢复，未重发原输入。原 future timer `schedule_048bc5bac5e022eb04a8a1d4` 仍在 2026-10-23T01:00:00Z。401 期间 Runtime 自动 health probe 会发模型 POST，未进入 Session attempt 账本；其数量不可从业务计数反推，不宣称测试是硬请求上限或零探针。

本地 03:04 原 UI 收到唯一提案，零 preparation／candidate／receipt 已由原库复核；恢复的 discussion 与外层回复两次业务请求使用既有 `gpt-6.1-sol/low`，usage 为 input 355197、output 444、cached 0（处理 token，不是账单）。03:05 原 UI 在同一命名对话只发送“好的，你直接做。”，原 body 与 input 没改写、没有脚本生成参数，继续验证三目标交付；证据存于 `morphz-original-script-observation.El8aHx5N7u` 的原失败及恢复文件。新的活动已在原窗口真实显示标题和摘要，前述未知状态提示消失，但不据此推定旧提示唯一故障来源。

03:08 原剧本交付完整通过：两次 input 均 completed，两份真实 1.4.3 Plan succeeded；三目标各一份 pending 候选，正文 223／236／704 字、五场标题齐。三个精确 Host 回执、Script outbox、Platform `appReceiptId`／`versionRef` 及目录最终版本 8 对应；正式三稿仍 v1 空正文，无自动采纳／批准，准备、生成、自审、交付各一次。原窗口已逐项打开候选并滚动实看第五场及正文尾部，没有点击采纳／拒绝；图片在 `/tmp/morphz-original-final-window.L2NOIY/original-{character-one-pending,character-two-pending,five-scenes-pending,five-scenes-tail}.jpeg`。独立只读验收 25 项全真，报告 `/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-original-script-observation.El8aHx5N7u/verification.json`。原失败和恢复快照保留。

本次原 Session 共 12 次业务请求（11 成功、1 部署 401），成功 usage input 2177422／cached 88448／output 4107／reasoning 99（包含于 output），无额外语义实验重跑，不与无法统计的自动 health probe／HTTP 内部 retry 混算。03:13 已切原 TEST 项目应用启动台，在新命名对话经真实 UI 发起父＋双子＋孙的普通 Runtime 只读验收，无 Script Harness；活动验收仍在进行，不能因剧本已通过提前结束两项目标。

四节点首次原 UI 验收失败证据保留于 `/tmp/morphz-original-four-node-observer.YSajwt/verification.json`：实际输入三来源相同、无 Harness，精确 family 只有一个 completed Dialogue Thread、零 Job／子 Thread／group。实际模型请求及回复 phase 为 `critical-maintenance`，不是认证或 family 读取失败，也不是默认仅有 Yao 工具。普通工作估算 244156，超过 critical 229376（hard 262144、reserve 32768）；维护分支暂时移除 `schedule_tx` 与物理工具。模型按本次明确“没有 schedule_tx 则停止”的条件结束，不能冒称四节点验收通过或改用 par／infer 替代。原 API 授权读取均成功，没有改 Context 或提高预算；正在评估是否能仅维护本轮自己新增的可退休 TEST 内部记录，不能以测试为由整理全部旧用户内容。

有界恢复的只读评估已完成：六项 `@e5900 @e5935 @e5946 @e5982 @e5994 @e6006` 都是本轮真实 Script 父 Thread／Plan 下已消费的内部 infer 请求，未保护、无 Frame 来源依赖，预计从当前视窗释放 21426 tokens；Human 输入、唯一提案、三候选 Host 保存结果／交付回值、最终回复及旧用户资料／提醒必须保留。该数字来自当前精确 S-expression spans 的同算法 dry-run，不能代替随后真实 full-work 请求。现有 `context_tx` 可通过精确 retire 事务退出视窗，durable events 留存且可 restore；没有 TEST-ID 权限白名单，LogicalInline 不经过物理审批，因此不允许借机让模型自由整理全部旧 Mind。提交前需核 retiring=0、版本 26，后核六项以外的 Frame 内容／来源／版本、relations、protected、checkpoints、retired 集及原事件原文不变，不能要求包含合法版本／退休元数据的整 Mind hash 不变。证据 `/tmp/morphz-original-four-node-observer.YSajwt/context-pressure-audit.json`。

继续原窗口前，Computer Use 再次明确返回 Mac locked，已请求手动解锁；尚未发送维护事务或第二次四节点输入，不绕过 UI 注入 Human 消息，不改锁屏设置。当前边界：剧本完整原窗验收通过；嵌套活动实现、隔离真链和实际组件测试通过，原窗完整四节点验收仍待完成。目标包含两项且保持 active，不能只凭剧本通过关闭。

随后原 Mac 已解锁，原 App 45017／Runtime 54199／18089 均保持。03:31 通过同一原 TEST 对话的真实 UI 发送固定六项维护及四节点验收；实际 input `3b8bed9f-53da-4aae-982a-3149367d2703`、root `msg_1790969479969864000_54199_2` 三来源正文一致，无 Harness。唯一指定 context_tx 已提交 26→27。独立前后审计：原 6037 个 durable Events 原始字段／payload hash 不变、14 Frames 全内容／来源／版本不变、protected／relations／checkpoints／retiring、Profile head／80 versions、原提醒 Thread／Schedule／未来 timer 不变；仅指定六项退休并退出 active projection，原文未删除。证据 `/tmp/morphz-original-four-node-maintenance.J1uOFk/preservation-audit.json`，原窗回执 `/tmp/morphz-original-final-window.L2NOIY/original-maintenance-six-receipt.jpeg`。

第二次四节点仍未执行，原 FAIL 保留：本次维护前真实 full-work gate 为 265662，提交后为 244018，实际下降 21644，仍超过 critical 229376。先前预计恢复使用了第一次请求的 244156，未计同 Session 随后建立的 actual-usage anchor 20481，不能沿用其 6646 余量。计数 source 是 `usage-calibrated-estimate`，不是完整 work 的 exact usage：首次 reduced maintenance 实际 input 181906／local 161425；本次 reduced input 182934／local 162458，随后 full-work raw 223542＋anchor 20476=244018。退休有效、budget 未耗尽、不是 cooldown 或继承工具锁；因此当前 phase 仍 critical、family 仍 1、零 Job／子 Thread。没有清 anchor、改阈值或再盲发测试。下一步仅量化本轮 TEST 已消费的其他重复追踪记录；自身记录不足时必须取得维护旧用户内容的额外授权。

剩余 TEST 范围的独立复核已完成（`/tmp/morphz-original-four-node-maintenance.J1uOFk/remaining-test-trace-audit.json`）：严格保留唯一提案求值 `@e5918`、唯一候选生成 `@e5991`、所有 Human／回复／Host 保存与交付后，14 项已消费追踪记录的当前 JSON-escaped wire 释放上限 11450。即便全移出，244018→232568，仍需额外至少 3193 才严格低于 critical，且未计新维护元数据、输入、usage-anchor 变化和四节点增长。这只是乐观上限，不是恢复证明，因此未执行这批事务或第三次付费尝试。两份 1.4.3 Plan succeeded、10 个实际所属 Thread 均已完成，来源按真实 parent／Plan 核，不靠文本猜。

已向用户请求继续验收所需的新增边界：允许逐项核验后，让当前 Context 中已完成的历史重复调用参数／只读结果退出模型视窗，原始事件不删，保留 Human 消息、业务成果、Frames、Profile、提醒及未完成工作。未收到答复前不实施历史整理、不改预算、不切第二中心替代；目标保持 active，不将第二项原窗验收冒称完成。计量校准跨 reduced／full-work shape 的现有外推边界只记录为只读审查（`/tmp/morphz-full-work-pressure-review.92ozOr/review.md`），没有为让测试通过清锚点或改变 Runtime 守门。

子 Thread 实现、隔离真实 Runtime 与实际组件回归已通过。剧本 1.4.2 三组真实模型场景通过；
1.4.3 首次新正向模型验收失败，修复独立证实的输出传输缺陷后，第二次有界真实链通过。
原失败证据与新 build 的验收边界分别保留，详见下面的输出传输边界。
最终 1.4.3 应用全量 Node 为 1093 通过、161 条条件跳过、0 失败（共 1254，
`/tmp/morphz-two-problems-v143-frozen-node.log`），最终生产构建／类型退出 0（`/tmp/morphz-two-problems-v143-frozen-build.log`）。
条件跳过不算通过，专项 PostgreSQL 另有真实执行证据。原 Mac 曾解锁，同一个原 App 正常退出、完成 desktop 停止态备份后重开；新 Host 的 v7 迁移已实际发生。后续 family 修复验证完成后，原 Runtime 已正常更新到下述新 binary。原窗口已实看主活动与等待中的真实子 Thread，尚未验收新的剧本交付；准备明确命名的 TEST 项目时系统再次锁屏，已请求手动解锁，不绕过锁屏、不将隔离截图或后端 API 验收当成原窗口完整验收。

原中心重开后的只读一致性核对见 `/tmp/morphz-two-problems-backup.OtLfGi/after-audit-ycBuqJ/audit.json`：240 张原表均保留，234 张旧列字节和规范化摘要相同；原 Profile、Session、已有剧本与未来提醒的旧内容未变。其他变化为正常启动元数据、schema 6→7，以及 153 项既有 Thread 投影新增真实 `contextId`，逐项与 Runtime 持久范围相符；未添加／删除这些 Thread、未重放旧任务。原 preparations 为零，因此本次原库只能证明迁移 DDL，旧行迁移语义由 SQLite／PostgreSQL 专项验证，不混作原库旧行验收。

原活动详情发现并修复一个误报：Context 有 295 条历史，而 scheduler 页只载入 200 条，旧 family 聚合把全局历史 `has_more` 误作选中活动缺少子记录。该活动实际两项 Thread 均已载入，旧实现刷新仍误报。现已改为有界、精确、经 Session／Context 授权的真实 parent-family 读取；不靠清除提示掩盖真实截断，不扫描整个 Context、不增加 LLM 请求或轮询。原 App 新 family 读取模块仍需解锁后正常重开载入，完成两项原窗口验收前不结束目标。

本次精确读取的生产设计：Thread 及 `parent_thread_id` 继续由 Runtime 的现有 `threads` 表权威保存；不复制关系、不把可变 Supervisor 当成真实 parent。只增加 `(context_id, session_id, parent_thread_id, created_at, id)` 查询索引，SQLite／PostgreSQL 正常启动迁移幂等创建，旧行、版本、生命周期及删除规则不变。新增 Session-scoped `GET /api/sessions/:session_id/threads/:thread_id/family?limit=64` 与对应 SDK 读取；Session 授权在前后复核，选中 Thread 及所有返回成员固定于该 Session 的真实 Context。响应仅为 lineage 元数据，不包含消息、工具正文或 Jobs，也不授权停止／审批。

Store 在同一个只读快照内，以真实 parent 索引 FIFO 遍历，最多 64 个返回成员、一个超限哨兵及 65 次定向 SQL；精确到 64 个成员仍逐个检查叶子，不因“满页”就声称缺失。`has_more` 仅表示此 family 超过上限，跨范围成员排除、重复 cycle 失败关闭；不提供全 Session 扫描 fallback。Application 仍先核原 input 的祖先来源，再对成员有界并发读取 exact snapshot、核对 lineage 与最新 Grant。成员读取失败、新 API 不可用均不能被当成已完整载入。

补修验证：真实 SQLite／PostgreSQL 2/2（`/tmp/morphz-thread-family-store-93bd16a7.log`）、Rust SDK／真实 HTTP 3/3（`/tmp/morphz-thread-family-sdk-http-authorized.log`），包含成功读取后的实际 Session 撤权。唯一 PG 测试库核对 owner 后删除并确认不存在，仅删除可重建测试数据。TypeScript SDK 新增相同只读契约，15/15、严格类型及 JS/d.ts 编译通过。实际 mounted UI 2/2，App 全量 1255 条、1094 通过／161 条条件跳过／零失败（`/tmp/morphz-thread-family-app-fullnode-final.log`），生产构建／类型与 remote-store feature 编译通过。首轮旧假 Runtime 缺新增 family DTO 与重负载通知等待超时保留证据；补齐 exact fixture、限并发完整重跑，未删断言或放松权限。编译磁盘不足另仅清理本次失败的精确 working cache 1.7 GiB，可由源码重建，不清原数据、证据或已验证 binary。

新 Runtime binary `4239c5a1…` 的父＋双子＋孙真链 1/1，4 个独立 Thread/root、4 个成功 Job；16 次普通确定性 Provider 响应、零付费调用（`/tmp/morphz-thread-family-runtime-nested.log`），不为注解另起求值。前后真实 Session 授权编排由 SDK／HTTP 公开入口复用，无公开 reader hook。

原 Runtime 在核对无活动 Jobs／Plans／Activations、outbox 空且唯一提醒仍在未来后正常 SIGTERM 88551，再用既有 launcher、私有配置、模型凭据与同一 root/18089 启动 40122；未建立第二个手工中心／App。原中心 API 实读验证：295 条 Context 历史仍有 `has_more=true`，精确 family 仅两项、`has_more=false`；原 Jobs／Plans／Activations 的状态数量、未来提醒 ID／到期时间，以及模型 attempt／output／usage 计数均保持。证据 `/tmp/morphz-original-family-acceptance.c2sTKi/verification-after-reads.json`。该 binary 编译于本次 family 提交之前，内置 git 元数据仍为 `4215e885…`，不以旧元数据冒称未部署，也不冒称已包含后续无关代码；SHA 与新增端点共同确认实际运行功能。

更新 Runtime 后的 12 库审计见 `/tmp/morphz-two-problems-backup.OtLfGi/after-audit-9Dvl01/audit.json`：原 240 表保留，232 表旧列摘要完全相同，原事件零删除／修改。差异为此前 schema／contextId 投影及正常启动事件、心跳、一个 Session 的时间戳和对应恢复游标；未新增 Session，Profile、未来提醒、已有剧本草稿仍逐字节相同。模型配置变化控制事件不是 LLM 请求，已单独核对真实 attempt／output／usage，不用泛匹配 model 主题误作调用次数。原窗口两项交付验收仍待解锁，不标目标完成。

### 剧本确认承接与多条目交付

Harness 1.4.3 在既有意图求值中同时产生本次 `task`，共享 Context 的当前唯一提案可以被短确认承接；原输入不改写，明确暂缓与歧义不能转成授权。一次准备原子冻结同剧本的多目标集合，复用既有 preparations、候选、版本、回执与 outbox，各目标独立保存 pending 候选，不自动采纳或批准。v7 SQLite／PostgreSQL 升级保留 v6 精确基线和旧单目标回执。最后消除批次失败与部分保存的交付提示冲突，已安装的 1.4.2 不覆写，原文件归档且三版本并存。

独立审查发现并修复遗漏来源撤权复核：不能靠候选省略 `sources` 绕过准备时的来源权限；整批固定来源在提交前和最终授权后复核，已保存回执恢复不重写候选。真实 SQLite、PostgreSQL、迁移与 Host 专项 82/82、零跳过（`/private/tmp/morphz-script-v7-review-20261003.log`）；唯一合成 PG 测试库已删除，用户库未改。真实 Rust 多目标闭环及旧 14 分支通过，后者 82 次合成 Provider 请求、零付费调用。

真实 `gpt-6.1-sol` 在 1.4.2 的唯一提案确认保存两人物和五场大纲、明确不写零提交、两个互斥提案仅追问三组均通过。详细回执、失败实验保留和模型请求计数见 `28-script-studio-executable-yao.md`。没有按交付数额外发意图／总结请求，但批次材料扩大输入，不能宣称零新增模型成本；合成 create/review 请求分别实测 177327/208972 字符，不是 token 数。

1.4.3 新正向实验 `morphz-script-confirmation-live-qqAlhL` 的三个目标已准备，但第 7 次 Native 的规范化正文缺末尾 JSON String 闭合引号，严格解码失败，未创作／提交、零候选；共 8 次请求，失败原证据保留。现有代理只有对应 HTTP 200 访问记录，无该次原始 SSE 完成文本，不能归罪模型生成或声称已证明当次传输漏尾。零付费回放另证实 Runtime Responses 适配器有独立缺陷：已有部分 delta 时忽略提供方完整 done 文本，可丢失相同尾字符。

该独立传输缺陷已修复：按真实 output/content 索引核对完整文本，只追加提供方明确返回的尾部；相等终值不重复输出，重写、截断、冲突及无法消歧的无索引终值均拒绝，不猜索引 0、不修补模型坏 JSON。首轮新增回放 8/8、完整 Provider 74/74、原 String 严格解码契约 1/1 均通过，含真实本机 HTTP SSE Client；Runtime 与真实模型验证使用的 Native bridge 均重建成功。RED 保留在 `/tmp/morphz-responses-authoritative-red.log`，GREEN 与完整组分别为 `/tmp/morphz-responses-authoritative-green.log`、`/tmp/morphz-responses-provider-suite-final.log`。最后独立审查又补齐半索引 done 与 message 内容 offset 的已知约束，未知字段不得覆盖已知值；最终新增回放 11/11、完整 Provider 77/77、零跳过／失败（`/tmp/morphz-responses-provider-half-index-final.log`），半索引原 RED 也保留。不倒称真实模型先用了之后才生成的 build。

1.4.3 第二次真实正向 `morphz-script-confirmation-live-Q4TPoO` 与独立只读复核均通过：12 次 Native 请求，原 body 仍为“好的，你直接做。”，三份 pending 候选正文分别 240／250／744 字，大纲恰好五场；三个持久 Host 回执、outbox 与目录版本 6／7／8 对应，正式稿仍第 1 版空正文、未采纳／批准。实际包仍为下列 1.4.3 hash。该 run 的 preflight 留存首轮 prefix 修复 source `5246eb94…` 与 Runtime／bridge 二进制 `dc90b562…`／`dca7746f…`；不冒称已检验之后的半索引补修 build，也不倒推 qqAlhL 原始失败原因。未额外执行 partial 模型探针、未自动重跑。

Runtime 传输修复已聚焦本地提交 `48cfd917`；半索引最终源码 `4228ae37…` 对应当时 Runtime binary `0d48ad83…`、Native bridge `dbeb1c1e…`，两份构建退出 0，原 String 严格契约再次 1/1，均为零付费验证。当时原进程尚未重启；本轮后续已用包含传输与 family 修复的新 binary 正常更新原 Runtime，见本节开头的实际部署记录。

原 Runtime 已安装新 1.4.3 包（`sha256:0ebecb9bbf0695fb42dfee82e3af9b80f5c08c7cb2a6bf0f4c2727caa61899c8`）；安装当时未重启、不重放旧任务，后续正常部署如上。原 12 库、240 表与私有配置已在线备份到 `/tmp/morphz-two-problems-backup.OtLfGi`；只读检查原 v6 preparations 没有阻碍新唯一约束的重复分组，原候选仍为零。原 App 正常重开与新 Host v7 迁移已确认；原窗口新剧本交付查看尚未验收，未把隔离候选复制到用户剧本冒充真实执行。

### 主活动汇总真实子 Thread

活动列表按同 Session／Context 的真实 parent 链收拢子任务；详情保留每个 Thread 的独立 root、标题、步骤、状态、进度与结果。父 Thread 已结束而子任务仍开放时，主活动明确显示子任务状态。逻辑 spawn 不伪造物理 Job。子 root 查看与 Host 调用沿真实父链核验原输入；聚合读取不扩大停止／审批权限，写操作必须显式选择准确 Thread，并在 POST 前重新验证当前授权。

隔离真实 Rust 1/1：父、两个子与一个孙 Thread，4 个独立 root、4 个成功 Host Jobs，各自 v2 注解／结果不串线。Provider 请求 16 次，包括 4 次 Profile read、2 次 schedule_tx、6 次正常 wait/wake、4 次 reply；注解随既有工具产生，未另发注解生成请求，付费调用为 0。机械调度上限保留，不使用不成立的固定 ≤14 假设。证据：`/tmp/morphz-nested-thread-activity-runtime-final.log`。
首轮 prefix 修复的新 Runtime 上同一真链再跑 1/1，4 Thread／4 root／4 succeeded Jobs 与 16 次确定性调度请求保持，零付费；日志 `/tmp/morphz-nested-thread-activity-runtime-new-provider.log`。
最终半索引 Runtime binary 上再跑同链 1/1、零跳过／失败，Thread／root／Job／请求数保持；日志 `/tmp/morphz-nested-thread-activity-runtime-half-index.log`。活动实现已聚焦本地提交 `f4541b7b`。

最终实际挂载 UI 6/6：主活动归组、孙层级、各自状态与结果、准确子任务停止目标、变化通知更新、窄屏与 200%；补修仅逻辑 Thread、零 Jobs／审批的 embedded 详情也显示真实截断提示，完整回读后移除。旧运动、完成对勾及时间顺序回归保持。旧 SSR 18/18，权限／执行专项 43/43，另有准确子 scope 及读取期间撤权禁止 POST 的正反例；补修相关 Node 35/35、构建／类型通过。共享旧 fixtures 补真实 Context Thread DTO，未降低生产核验；共享相关单测 19 通过、4 条 PostgreSQL 条件跳过。最终 UI／单测／构建证据：`/tmp/morphz-nested-zero-job-{ui,unit,build}.log`；原专项见 `/tmp/morphz-nested-thread-ssr.log`、`/tmp/morphz-nested-thread-unit.log`、`/tmp/morphz-nested-final-targeted.log`，组间可能重叠，不相加。

边界：跨 Session delegate 未纳入本轮；200 条全局历史仅限制活动目录，详情的精确 family 独立有界读取最多 64 项，并以实际超限哨兵提示截断。原中心备份只读检查找到“可以，设置提醒吧”的真实父子活动，父已结束、一个子仍开放、各自独立 root，无物理 Jobs；本轮原窗口已实看归组与子状态，随后原中心新 API 证实两项完整，不把该样本当作原窗口多子步骤验收，也不得停止或修改原提醒。证据：`/tmp/morphz-nested-original-readonly-evidence.md` 及本节开头的新 API 记录。隔离窄屏截图已复看，不称用户审美已认可。

## 2026-10-03 剩余页面健康轮询改为变化通知

通知列表／偏好、执行详情、事项详情与列表上游批量状态读取、阅读器 OCR 状态、浏览器 guest 状态与 Agent 动作交换不再按健康间隔拉取。首次读取、明确操作后的读取、前台恢复与失败退避保留；事项的本地日期时钟、语音计时、OAuth 设备授权协议及 Runtime 执行／交付调度不因本轮被删除，不称整个系统没有定时器。共享观察器合并变化，废弃迟到读数与旧身份结果；读取取消不会停止业务执行。无新持久表或第二份执行账本。

Host 使用现有 Runtime 私有 WebSocket 作为失效通知，并继续授权回读真实状态。多位订阅者共享每 Session 一条连接；断线先订阅再补持久游标。真实 Runtime 联测发现 EventBus 对已持久事件可省略物理序号：这类帧现在只作有界 ID 去重的读取提示，不推进恢复游标，不冒充回执；模型 token／快照不唤醒状态读取。OCR 则从 Host 状态变化与原 SQL 提交发出元数据通知，跨身份版本不暴露。实际挂载测试发现 OCR 身份切换时旧 busy 锁死新按钮，已按 scope 隔离并保留旧结果不导航的断言。

验证：应用全量 Node 1060 通过、154 条条件跳过、0 失败（`/tmp/morphz-event-refresh-full-node.log`）；通知真实 Host/SSE UI 6/6，实际通知挂载 11/11；事项／执行实际组件回归 24/24；浏览器专项 2/2、隔离真实 Electron smoke 通过；OCR 实际组件 3/3、实际 SQL Host OCR 7/7；HTTP/WS 观察器专项 11/11，均零失败，独立组不相加。关闭 Host 的 1.2 秒核对 ticker 后，真实 Rust 工具 Job 和终轮仍通过 Host SSE 唤醒，1/1；注解真实 Rust 链 6/6，确定性 Provider、零付费请求。生产构建、类型与差异检查通过。未配置的 PG／模型／浏览器条件跳过不宣称已运行。

同一原 Morphz App 在空输入时正常退出／重开，原 Runtime 88551／18089 未重启，未发送输入或改动 Profile。12 库与私有配置在线备份在 `/tmp/morphz-event-ui-restart.6XCKxo`；退出过程第一份 desktop 复制遇到瞬态目录删除而失败，确认进程退出后的 `desktop-stopped-complete` 完整保存。原通知面板可读，原已完成活动仍显示真实工具步骤。重开后 239/240 表逻辑摘要一致；剩余 `runtime_deliveries` 的 250 行仅 JSON 序列化顺序不同，规范化后零语义差异。原 Profile、Session、未来提醒和草稿保留；不把隔离测试称为原窗口完整交互矩阵。

本轮没有修改已有 dirty Script Studio Harness，也未将“infer 共享 Context”冒称“简短确认接续已修复”。父子 Thread 的 Runtime 关系可读，但一个主活动分组展示各子 Thread 命令时间线仍未实现。

## 2026-10-02 整份 Profile 不使用时的视觉区分

总开关关闭时，下级已选开关、滑轨／圆点及数值底面改用现有中性色，讲话风格保留所选位置但减弱底面与字重；再次启用恢复原主题强调色。只由既有 `data-profile-use` 派生本组件的颜色，不改字段 checked／数值／原文、编辑能力、自动保存、权限或模型上下文。名字与独立头像、能力与连接不灰化，不新增状态文字、外圈、全局透明度或第二套使用状态。

最终 Profile UI **50／50**、零失败／跳过（58.8 秒，`/tmp/morphz-profile-unused-ui.hkkFan/full-final.log`）；新增明暗专项 **2／2** 属于该组，不另相加。实际渲染验证 on→off→reload→on 的开关、滑轨、徽标及风格颜色／字重，保留 4／5／2／2、风格及作者原文，关闭仍可编辑且不自动启用，刷新零额外提交，原媒体、权限、CAS、未知回执、键盘、触控及布局守门保持。明暗 off 及暗色 on 截图已复看；首专项两项因本次调用旧 quiet-label helper 误传参数失败，修正为保留真实「不设置」取消选项后重跑通过，旧 helper 与断言未改，失败日志／trace 保留。完整 50 项首跑通过。

相关领域／自动保存／真实 Client 单测 **39／39**、零跳过（`/tmp/morphz-profile-unused-visual-unit.log`）；生产构建、最终类型及格式／差异检查通过。不冒称本轮重新跑了付费模型或 Runtime 请求链，这次只改 CSS 与回归，没有持久数据／API／Runtime 改动。

原同一 `/Users/shafreeck/Applications/Morphz.app` 在空输入、听写关闭且资料已确认时正常 Cmd+R 载入；实看总开关 off 后下级灰色与风格弱选中，Echo、4／5／2／2、细腻、左侧图标模式、右栏设定及展开分组保持。没有替用户点击总控、修改选值、头像、主题或发送消息；Runtime 仍 67258／18089，未重启。明暗及重新启用行为由隔离自动回归覆盖，不将隔离截图冒称原窗口完整矩阵或用户审美已认可。

## 2026-10-02 ROM 正式改名为 Context 作用域内的 Custom

当前正式概念为 `context::Custom`，模型上下文新节点为 `(custom …)`；Rust／TypeScript SDK、operator HTTP `/custom`、Profile Client、当前设计文档及普通测试使用新名称。第三方拥有 Schema 与正文，Profile 只是应用定义的一种结构。正文、Profile v1／v2 Schema、作者状态及已有资料不改；数据库表、迁移 ID、entry ID 和幂等哈希域保留原值。旧 SDK 名称与 `/rom` 路由只是同一存储和权限边界的兼容入口，不维护第二份数据。

新 Thread 使用新编译器与 Custom 缓存契约；已有 Thread 按持久 compiler hash 保留原 `agent-rom` 节点、System Rule、manifest hash、`rom_*` cache contract 和 `agent_rom` attempt metadata。空内容仍零额外节点／规则／缓存维度；作者编辑态仍不进入模型。ContextView JSON 输出字段现在叫 `custom`，兼容读取旧 `agent_rom` 字段，不承诺 JSON 输出名逐字相同。说明见[Runtime Custom 设计](../../docs/context-custom.md)及[Profile 当前设计](39-profile-custom-production-design.md)。

最终验证：Runtime 单测 **16／16**、SQLite／真实 PostgreSQL 与真实 Runtime 请求捕获 **9／9**（6+1+2），均零失败；PG 使用独立临时数据库，已删除，仅测试数据，不动用户库。日志 `/tmp/morphz-custom-lib-tests.log`、`/tmp/morphz-custom-postgres-integration-tests.log`。Profile 六组单测 **28／28**（含真实 browser 身份 race、真实 PG）与自动保存 **21／21**、SDK **11／11**，均零跳过；日志 `/tmp/morphz-custom-profile-tests.log`、`/tmp/morphz-custom-autosave-tests.log`、`/tmp/morphz-custom-sdk-tests.log`。Runtime binary、Application 生产构建与最终类型检查退出 0；`remote-store` 特性编译通过，但不称本轮运行了 workerd 或远程 Cell 验收。

新 binary＋新 Web bundle 的实际 Profile 保存→发送→Context 链最终 **5／5**、零跳过（38.6 秒，`/tmp/morphz-custom-actual-transport.log`）；控制面 smoke 的重启版本保持、双凭据隔离通过，零 Session、零模型请求（`/tmp/morphz-custom-profile-runtime-smoke.log`）。请求链使用本地受控模型传输，不冒称付费模型行为或供应商 cache 命中。

首轮实际链 **4／5**：旧自定义风格的全文 `"(custom "` negative 与新顶层节点撞名，已改为真实 SExpr 的 `Context/custom/entry/body/agent-profile/speech/custom` 精确路径，保留停用 marker 零字节、作者原文与重新启用恢复断言；初跑日志保留。SQL 升级测试首轮也发现测试查询误把旧物理表写成 `agent_custom_command_receipts`，已恢复 `agent_rom_command_receipts` 后完整重跑通过，不把测试误改当生产迁移、不删校验。原同一 App、资料、草稿、Runtime 与在途工作未重启／重写；本轮完成代码与隔离链路验证，不冒称运行中的旧 Runtime 已热替换。

## 2026-10-02 主题气泡内引用悬停同色系

截图中的白块来自已发送引用卡片的 hover 与所有按钮的 active 继承普通中性 `--hover`。现在仅覆盖本人消息内的 `.sent-text-quote`：悬停／主动键盘焦点沿原气泡面色混入 12% 可读强调色，按下混入 16%；按下时来源小字改用正文色。默认透明引用底、编号、引用线、布局与原键盘轮廓保持，不改全局 `--hover`／`--tint`，也不扩到草稿引用、选文浮层、附件、回复来源或菜单。无新的持久状态、API、Host／Runtime 修改或模型请求。

最终生产构建退出 0（`/tmp/morphz-message-quote-hover-final-build.log`）；新增实际 Conversation 引用呈现 3 项与既有引用／来源 12 项完整 **15／15**、零跳过（28.9 秒，`/tmp/morphz-message-quote-regression.NJ0fJo/verified-run.log`）。实际切换四强调色亮暗，8 组 hover 色各不相同，32 状态的正文与来源小字最低对比度 **4.603:1**；验证真实鼠标、Tab、按下、无几何变化、390px／200% CSS、重复原文第二锚点精确回跳、草稿与评论保留及零消息提交。平台历史 schema 与实际引用组件参与，不假挂 DOM；缩放属于 CSS 几何，不冒称原生 Electron 缩放。指标见同目录 `verified-report.json`，26 张新截图中的亮青悬停、亮紫按下、暗青悬停已复看。引用快照／持久入队单测 **5／5**、零跳过（`/tmp/morphz-message-quote-hover-unit.log`）；类型、格式与差异检查通过。

首轮 **14／15** 实际发现亮紫按下时来源小字只有 4.338:1，因此仅加强该状态的小字前景，没有降低 4.5 阈值。第二轮 **13／15** 为新增正常态截图驱动未清除合法的键盘焦点，以及既有引用用例结束时 route／context 关闭竞态；新驱动恢复正常态后才截图，原 fixture 与断言未删改，随后完整 15 项通过。两次失败日志／trace 保留为同目录 `first-run.log`、`final-run.log`，不把重跑结果称为首轮全部通过。

原同一 `/Users/shafreeck/Applications/Morphz.app` 在空输入、资料已保存且没有正在处理时用正常 Cmd+R 载入最终构建；在原对话中仅滚动与微量滚动定位指针，实看原引用悬停仍为青色系、没有白块，未点击引用、发送消息或修改用户内容。原侧栏显隐、设定页签及分组、幽默 4／严谨 2／亲和 2／详略 2 和细腻风格保持，Runtime 仍 67258／18089、未重启。用户操作变化导致的一次滚动被安全取消，重新读取现场后才继续，不恢复用户旧输入或强行结束工作。真实窗口验收为正常／鼠标悬停；暗色、按下和键盘矩阵由隔离回归验证，不称本轮已修改或完整审计原库，也不称用户审美已经认可。

## 2026-10-02 Markdown 正文链接主题化

截图中的纯蓝链接来自 SafeMarkdown 外部地址没有应用样式、回退浏览器默认色。现在外部锚点增加共享类，正文外链和内部对象入口共用主题前景 token：84% 可读强调色加正文色，配 1px 淡下划线、3px 偏移，悬停及主动键盘焦点加强；沿用四主题亮暗色源，保留作者粗体，长中文链接可换行。只改呈现，不改安全 URL、系统浏览器打开、对象权限／导航、错误反馈或流式解析；不批量改变导航、工具栏及阅读器外部 HTML，无新增状态、Host／Runtime 字段或迁移。

最终生产构建退出 0（`/tmp/morphz-markdown-links-final-build.log`）。新增实际 Conversation／ArtifactEditor 消费者回归 **6／6**、零跳过（17.2 秒，`/tmp/morphz-markdown-link-regression.E6mS6Z/evidence-run.log`）：通过实际外观设置切换四强调色亮暗组合，逐一检查外链／对象按钮正常、悬停、Tab 焦点、按下、文字至少 4.5:1、细下划线与无几何变化；覆盖 390px／200% CSS 换行，以及非法协议／凭据地址、原始 HTML、远程图片、原对象打开及外部打开失败反馈。同目录 `verified-report.json` 保留 32 组实际链接观测／128 状态，两消费者最低文字对比度均为 **6.281:1**；前次完整 6／6 的 17.0 秒日志仍保留。文档经实际 typed Host 创建，外部打开使用隔离桌面 bridge，不称真实系统浏览器或原生 Electron 缩放验收。20 张主题及响应截图中的亮色、暗色、长链接已复看。

首轮 **4／6** 暴露最后加载的共享焦点规则把链接偏移覆盖为 2px，已用 a／button 语义选择器提高特异性，保持 3px 断言、没有全局修改或 !important。第二轮 **4／6** 为既有对象按钮 90ms 颜色过渡被提前采样；回归现按实际 computed 色轮询收敛，不弱化颜色／对比度／几何断言。失败日志保留于同目录 `first-run.log`、`final-run.log`。相关呈现／流式单测 **7／7**、安全解析 **3／3**（`/tmp/morphz-markdown-links-unit.log`、`/tmp/morphz-markdown-links-safety.log`）；原消费者流式／授权撤回缓存／对象前进返回回归 **3／3**（`/tmp/morphz-markdown-links.x4VgAu/existing-consumers.log`），均零跳过，各组不相加为独立总数。最终类型、格式与差异检查通过。

原同一 `/Users/shafreeck/Applications/Morphz.app` 在空输入、资料已保存时正常 Cmd+R 载入，最终构建再次确认空输入且没有正在处理后刷新，实看原文链接已为沉静青灰色与细线。左右栏显隐、设定页签、两组展开和 324px／345.875px 宽度、用户自己设置的幽默 4／严谨 2／亲和 2／详略 2 与细腻风格保留；未代用户切换主题、Profile、头像、模型或发送消息／打开外站。真实窗口验收为正常态，交互矩阵由隔离回归验证。Runtime 仍 67258／18089、未重启；第一次刷新前后 12 库逻辑核对 **215／240 表相同**，用户同时继续新输入／回复，Profile 表全相同，不称全库不变或停止用户在途工作。只读摘要保留 `original-state-audit.json` 于现有消费者日志目录，无凭据／私有原文；不以这次样式验证宣称人格主观效果或审美已经获用户认可。

## 2026-10-02 名字原位编辑与人格滑杆去外圈

名字／称呼现在直接在原文字位置编辑，不再显示「完成」「不设置」操作行、铅笔、清除图标或输入下划线；字号、行高及头像／总开关位置保持。沿用450ms自动提交，Enter或离开结束，空文本明确结束时写null；输入中临时空名字不覆盖确认值，Escape不清空中间态或伪装撤销已保存值。IME候选只作临时输入显示，组合结束才进入原队列；关闭编辑的同步标志防止随后blur／尾input重新写值，失焦不抢回点击／Tab目标。同事件轮的其他字段合并最新意图，不丢名字。默认回退Morphz／我只作展示，打开／离开零写；整体关闭后编辑仍保持关闭。没有新增持久模型、Host／Runtime字段、API、迁移或客户端人格副本，CAS／unknown／确认读回与身份边界保持。

追加截图要求的人格滑杆整条青色外圈已移除，鼠标与键盘均无轨道外outline／box-shadow；现有圆点、轨道和数值不改，Tab提示只在圆点内部，方向键／Home／End与自动提交仍可用。不扩大为删除分组卡片边线或全站焦点提示。

最终生产构建退出0（`/tmp/morphz-profile-inplace-final-build.log`）；相关队列／Host／领域单测 **36／36**、零跳过（`/tmp/morphz-profile-inplace-unit.log`）。完整Profile UI **48／48**、零跳过（52.4秒，`/tmp/morphz-profile-inplace-ui.fIfXud/final-profile.log`），包括原43项语义守门、新原位明暗／390px／200% CSS几何、失焦去向、触控清空、组合输入与同事件轮合并，原开关case扩展滑杆鼠标／真实Tab／Home与方向键及实际确认读回。明暗原位及滑杆鼠标／内部键盘提示截图已复看。CSS几何和DOM组合事件不称原生Electron缩放或系统IME验收；类型、格式与差异检查通过。

实际UI → typed Host → 隔离SQL → 现有Rust Runtime → 确定性Provider **5／5**、零跳过（21.4秒，`/tmp/morphz-profile-inplace-actual.6WoY2Q/deterministic-inplace-focus-final.log`）。增强原第4项：临时空名字／Escape保留原revision，Enter／失焦真正持久null且新请求省略旧名字／称呼，默认打开／离开零写，Human只保留称呼及全空规则保持；实际CAS、丢回执、Echo发送屏障、停用保留、自定义作者态、旧Thread冻结版本全部保留。首轮同实际链5／5的22.9秒日志保留。未修改Runtime或新增付费模型调用，不把确定性请求证据称为人格主观效果或上游cache命中。

首轮UI44／48失败日志保留为`/tmp/morphz-profile-inplace-ui.fIfXud/profile.log`：两项对齐比较使用未归一化的left／start，另外两项是测试flush helper主动blur已正确获得焦点的summary；现仅结束真实文本输入，原失焦前后断言未删除。定向原位4项通过；追加滑杆首轮仅hex／rgb比较失败，DOM解析颜色后专项通过（`/tmp/morphz-profile-inplace-targeted.KQOEiX7u/profile-targeted.log`、`/tmp/morphz-profile-inplace-range.X7VpHJlA/profile-range.log`），随后统一重跑最终48项。

原同一`/Users/shafreeck/Applications/Morphz.app`确认空输入、资料已确认后正常Cmd+R载入；实看名字原位输入无操作行／下划线，未输入或清除用户资料。原侧栏显隐、设定页签、两组展开、324px／345.875px宽度，以及用户本轮自己选择的使用on、幽默4／严谨2／细腻均保留，没有代用户切换开关、移动滑杆、头像、模型或发送消息；用户继续操作后不强行恢复旧状态或结束其编辑。Runtime仍67258／18089，未重启。短时12库逻辑核对 **212／240相同**，其间用户继续对话和选风格，另有3个新Thread／输入、6条时间线记录和revision64；旧63条Profile版本／回执hash全相同、零改零删，不称所有数据库或在途工作停止变化。只读审计摘要保留`/tmp/morphz-profile-inplace-ui.fIfXud/original-state-audit.json`，无凭据／私有原文。本轮只完成原位与去圈实现，不宣称长期人格化目标或用户审美已验收。

## 2026-10-02 恢复 Logo 右侧直接人格开关

按用户本次明确方向撤回末尾按钮，Agent 身份行恢复 Logo／名字右侧原生「使用人格设定」正向开关，不增加标题或重复关闭文字。沿用原 32×20 胶囊及 44px 触控命中区；按追加要求，总控和单项开关均去掉外焦点圈，鼠标只显示底色与圆点，主动键盘焦点只在胶囊内部提示，Tab／Space 仍可达；不因字段为空或分组收起而禁用。关闭保留全部选值／头像，不停止 Agent，继续编辑不暗中开启；仅尚无 head 的首次有效字段自然使用。Human 原标题开关位置和空字段规则不改。

Agent 总控的明确 true／false 现在经自动提交队列、Host、不可变 ROM revision／CAS／receipt 精确持久，不用本机状态冒充生效；默认读取及空文本展开仍零写。空 on 和清空最后字段保留总体意图，但新 Thread 对精确内建 Agent v2 空 BODY 不绑定、不加 ROM 槽或系统规则。新选择共用 SQLite／PostgreSQL 窄判定，检查原规范版本及内容 hash；其他 namespace／schema、非空 Profile、Human、历史 mount、通用 compiler 与旧 prefix 字节不改。作者态仅保留编辑原文，不参与空配置判定，无新 API 字段、表、列或迁移。实现前设计与边界见 `39-profile-rom-production-design.md` 和 Runtime `docs/agent-rom.md`。

最终去外圈后的完整生产构建退出 0（`/tmp/morphz-profile-logo-toggle-no-outer-ring-build.log`）；Profile UI **43／43**、零跳过（43.8 秒，`/tmp/morphz-profile-no-outer-ring-ui.jnKZOz/profile.log`）。主控与逐项验证鼠标真实焦点无 outline／box-shadow，Tab 真实 focus-visible 时仅内部 inset 提示；新增全空直接开／关／刷新及清空最后字段保持 on，原 Space／Tab、触控外沿、头像取消零修改、权限、CAS、unknown、确认读回、折叠及明暗390px／200% CSS 几何守门保留。明暗及内部键盘提示截图已复看，CSS 几何不称原生 Electron 缩放。追加要求前构建和 UI43／43（40.6 秒）记录仍保留，不用旧结果冒称最新外观验证。相关队列／Host／领域单测 **36／36**、零跳过（`/tmp/morphz-profile-logo-toggle-final-unit.log`）；补充领域／头像／配置组30通过、2缺PG配置跳过（`/tmp/morphz-profile-empty-enabled-domain-unit-headless.log`），不与前组相加。类型、格式与差异检查通过。

实际 UI → typed Host → 隔离 SQL → 最终 Rust Runtime → Provider 请求 **5／5**、零跳过（20.4 秒，`/tmp/morphz-profile-empty-switch.uFZAFm/deterministic-empty-switch.log`）。验证默认0head／receipt／POST、empty on真实SQL enabled1及作者态读回、刷新零重写、新输入on/off/reon均零Profile／ROM／系统扩展／bindings；保留非空0／5、Echo输入保存屏障、停用编辑、自定义 off／原文保留／reload／on、旧Thread绑定、实际CAS和丢回执守门。Runtime SQL／实际请求 **9／9**（含隔离真实PG）、ROM单元 **5／5**、相关Context／cache **38／38**均无跳过，日志 `/tmp/morphz-empty-profile-runtime-sql-final.log`、`/tmp/morphz-empty-profile-unit.log`、`/tmp/morphz-empty-profile-unit-context.log`。以上组不相加为独立总数；Provider为确定性字节验证，未新增付费模型调用或人格效果／上游cache命中验收。首轮Runtime测试使用客户端消息ID查询实际Thread失败，已改用真实 receipt.event_id；首轮App构建捕获测试迁移中途的helper引用不完整，源码冻结后完整重建通过，失败日志保留。

原同一 `/Users/shafreeck/Applications/Morphz.app` 在空输入、听写关闭、资料确认且无 queued／running activation 时正常退出。12库一致SQLite备份、私有配置及退出后desktop副本位于 `/tmp/morphz-original-logo-switch.SJ8pxN`；首次退出中的desktop复制仅因短暂Singleton链接消失而失败，确认进程已退出后完整副本另存 `desktop-stopped`，不将中途副本称为完整备份。原模型凭据只在内存保留，同端点18089正常SIGTERM／重开验证Runtime（67258），再重开同一App，不重签名或新建手工环境。实际窗口及再次Cmd+R均确认身份行总开关可用且off、幽默0／严谨0、原设定页／两组展开、左右显隐及324px／345.875px宽度保持，末尾按钮已消失；没有替用户切换人格、头像、审批、目录、模型或发送消息。

首轮重启核对240表中 **235表逻辑摘要相同**，当时Profile所有版本／回执、ROM绑定、原消息、Threads及未来安排均未变。正常重启只新增2个控制事件（objective_control／runtime_control），原4553事件未改；execution_targets仅last_seen_at、principals仅updated_at、单个Session仅更新时间／活动时间、单个Host runtime_sessions仅确认cursor变化，行数不变。追加外圈要求后的12:36再次核对为 **232／240相同**：资料另有12:32的12个 enabled 交替版本及回执，BODY content_hash保持一致，原26条版本／回执零修改、零删除，head仅推进revision／更新时间。这些提交早于12:35的最新样式构建，不能归因为随后Cmd+R；没有代用户点击总开关，也不回滚后续选择。最新原窗口仍off、幽默0／严谨0和原栏位／分组状态保持，去圈样式已通过Cmd+R载入并实看。没有将首验235或上一轮240全部不变套用于后验；此为本次直接开关实现与验证，不称用户审美或长期人格化目标已经验收。

## 2026-10-02 人格使用操作的按钮可识别性

用户已找到并体验末尾操作，但原文字样式缺少可点击提示。现仅改其外观：中性底色、1px 细描边、8px 圆角、正常文字色及 12px 横向留白；悬停与按下有反馈，鼠标点击没有额外焦点圈，键盘仍有清晰焦点，触控目标至少 44px，减少动态偏好关闭过渡。沿用现有主题令牌，不使用主按钮或红色删除样式。位置、显示条件、关闭保留选值、自动提交及实际回执语义不改，无 Profile／Host／Runtime／schema 修改。

生产构建退出 0（`/tmp/morphz-profile-button-affordance-build.log`）；完整 Profile UI **42／42**、零跳过（40.7 秒），日志 `/tmp/morphz-profile-button-ui.fABwba/profile.log`。补实际渲染按钮的明暗、390px／200% CSS 几何、正常／悬停／按下、鼠标／Tab 焦点及真实触控关闭／使用的 typed 提交与 Host 夹具确认读回；悬停按下不写入、双方相机取消选择零修改、权限、CAS、未知回执与身份守门保留。明暗截图已复看，CSS 几何不冒称原生 Electron 缩放；类型、格式与差异检查通过。本轮未重新运行实际模型请求链，不把样式验证称为人格效果验收。

原同一 `/Users/shafreeck/Applications/Morphz.app` 已用正常 Cmd+R 载入新构建，并复看「使用这些设定」的正常态按钮外框与底色。用户本轮检查前自己所选的幽默 0／严谨 0、整份不使用、两组展开及左右栏状态均保留；没有代用户点击人格操作或发送消息。刷新前后 **240／240** 数据表逻辑摘要一致，Runtime 仍为 34696／18089、未重启；真实窗口此次只确认正常态外观，悬停／按下及触控由隔离回归验证，不补称用户已认可审美。

## 2026-10-02 不使用人格设定改为末尾次级操作

用户指出名字右侧总开关默认不可点击、需先设单项才解锁，也容易被理解为 Agent 启停。现身份行只展示头像与已确认名字，有有效字段时在资料末尾、能力与连接之前提供中性的文字操作「不使用人格设定」。明确关闭并获得实际回执后显示「未使用人格设定」与「使用这些设定」；个性分组收起不隐藏该操作。全空时没有灰色死控件或虚构未使用状态，首次有效字段自然使用。头像和 Agent 工作不受影响，关闭保留名字及选值，继续编辑仍保持不用，明确使用后才应用保留的有效字段；单项关闭的自定义文字不会被整份使用暗中打开。Human 原个人资料标题开关不改。

正常字段和操作仍自动提交，复用既有 enabled、身份范围队列、CAS、持久 command／readback；没有新增 Runtime／Host 类型、schema、迁移、客户端人格副本或永久禁用标志，旧 Thread 和缓存契约不改。新增延迟提交与已提交丢回执两项 UI 验证：乐观意图可以改为 off，但未确认期间不显示「未使用人格设定」，错误／重试继续可达；确认后才显示该状态，同 command 重试不多写版本。Agent 总控现在是实际 button，不通过隐藏 checkbox 或绘制假开关模拟操作。

最终完整生产构建退出 0，日志 `/tmp/morphz-profile-usage-redesign-final-build.log`；相关单测 **33／33**、零跳过（`/tmp/morphz-profile-usage-redesign-unit.log`）。Profile UI **42／42** 与侧栏／Dock／伸缩 **20／20**、均零跳过，日志 `/tmp/morphz-profile-usage-ui.yABc0v/final-profile.log`、`/tmp/morphz-profile-usage-ui.yABc0v/sidebar.log`。保留并迁移原 typed payload／Host head／授权读回、CAS、unknown、身份、头像和键盘守门；补明暗、390px、200% CSS 几何及展开／收起的末尾操作可见、Tab／Enter关闭与使用，以及鼠标文字操作无额外焦点框、键盘仍可见焦点。明暗隔离截图已复看，不称这些截图为原窗口的已配置人格验收，CSS 缩放不冒称原生 Electron 缩放。

最终构建实际 UI → typed Host → 隔离 SQL → Rust Runtime → Provider 请求 **5／5**（18.8 秒）、零跳过，日志 `/tmp/morphz-profile-usage-actions.oA01t7/final-deterministic-usage-actions.log`。默认空字段无 ROM，关闭后新 root 连自定义名字也不注入，修改保持关闭、使用后生效、原 custom 作者态／刷新／off请求零marker／reon和旧 Thread 的冻结版本均保持。Provider 为确定性字节验收，未新增付费模型调用，不称人格效果或上游 cache 命中已验收。

原同一 `/Users/shafreeck/Applications/Morphz.app` 确认空输入、无附件、听写关闭后，用正常 Cmd+R 刷新真实载入新构建；菜单 AX 的首次 Reload 动作没有更新界面，未以该动作宣称生效。原 Profile 是全空，实看身份行已无总开关、没有无效末尾操作，个性与能力两组展开、设定页签和左右栏显隐／324px及345.875px宽度保留。原库 **240／240** 表逻辑摘要相同，Runtime 仍为 34696／18089，未重启；没有替用户改 Profile、头像、模型、审批、目录、主题或发送消息。当前原窗口只验证空资料布局，已配置／不使用／再次使用由隔离实际链及 UI 回归验证，不补称用户审美已验收。

## 2026-10-02 折叠偏好持久化与自定义风格停用保留

按连续反馈，Agent 不再另画「设定」标题行；整份使用开关移到头像／名字所在身份行右侧，保持与头像垂直对齐。Human 个人资料标题不变。个性与表达未设置时只有分组名，没有「由模型决定」等占位说明；配置摘要仍只显示已确认、已启用的实际字段。自定义风格标题和开关同行，开启直接展开并聚焦文本，关闭收起且保留原文，不需重新填写；正常操作自动生效，不增加手动保存步骤。

三个资料分组（个性与表达、能力与连接、已安装执行方式）的 open／closed 现在由共用 `PersistentDetails` 保存在客户端。使用当前 center／principal 的显式作用域，不保存 CSRF，不借全局最新身份写入旧作用域；嵌套 toggle 不覆盖父组，非法存值按收起处理，无法使用存储时仍可现场操作。刷新、页签往返及关闭再打开保持选择，不写 Profile／ROM、不发送输入或恢复旧 Thread。左右侧栏原有显隐、宽度和分类保持规则仍适用。

关闭保留原文不采用 Renderer 缓存或 BODY 内隐藏文字：既有 ROM BODY 整体进入模型。Runtime 增加通用可选作者状态，与有效 BODY 在同一不可变版本、CAS、事务和回执保存；SQLite／PostgreSQL 的 02 nullable 列迁移保持旧行和旧回执。作者状态仅供受信控制面读回，Thread manifest、Context 序列化和模型请求都去除；Host 严格校验有效投影，Agent 的 read 工具也不透传停用原文。Profile 只增加兼容旧数据的可选自定义风格使用标志，关闭文字仍存在、有效配置中无 custom，重新开启原文恢复。其他选值、整份明确不使用、旧 Thread、内容／compiler hash 与缓存契约不改；作者编辑创建新 revision，不保证新工作的 prefix 与旧 revision 相同。旧 JSON／wire／receipt 兼容，Rust struct literal 调用方需补新增字段为 None。实现前设计和边界见 `39-profile-rom-production-design.md` 与 Runtime `docs/agent-rom.md`。

最终生产构建退出 0（`/tmp/morphz-profile-custom-retained-final-build.log`）。Profile／Dock／侧栏刷新／原伸缩 UI **60／60**、零跳过，日志 `/tmp/morphz-custom-style-ui.4OfjCn/final-ui.log`，明暗单行风格和默认资料截图已复看；390px／200% 为 CSS 几何覆盖，不冒称原生 Electron 缩放。保留首轮 53／60 失败：重载时旧驱动早读 isVisible、名字之后的新键盘顺序、将停用误当清空的旧预期，以及缩放后滚动／确认摘要布局的驱动问题；专项 **8／8** 后完整重跑，原权限、媒体、CAS、unknown、身份、草稿及完整可见断言没有删除。

实际 UI → typed Host → 隔离 SQL → Rust Runtime → Provider 请求 **5／5**、零跳过（18 秒），日志 `/tmp/morphz-profile-custom-retained-complete.Xyu1oV/deterministic-custom-retained-complete.log`。同一 Session 验证 on → off 精确 SQL 作者态读回 → 刷新原文仍在 → 新 root 请求唯一停用 marker 零字节且 Nova／幽默0保留 → 旧 Thread continuation 仍用旧版本 → re-on 恢复原文字；空选择不建版本及原五项断言保持。Provider 为确定性验证，不称新付费模型、人格质量或上游缓存命中验收。错误 binary 路径与 reload 驱动竞态的失败证据保留，最终使用仓库根 `target/debug/morphz`。

相关 App 单测 **51 通过、2 跳过、0 失败**（总53，缺 PG／cloud PG 配置），日志 `/tmp/morphz-profile-authoring-unit-final.log`；codec 专项 **14／14**。Runtime 作者状态专项 **4／4**、SQL／迁移／实际模型请求专项 **6／6**（包括本机隔离真实 PostgreSQL）及 Context／cache 等相关 lib **38／38** 均无跳过；这些组可能重叠，不相加为独立总数。默认构建、类型／格式／差异检查及 remote-store 编译检查通过；后者不是实际远端 Cell 迁移或运行验收。日志 `/tmp/morphz-rom-authoring-unit.log`、`/tmp/morphz-rom-authoring-sql-runtime-pg.log`、`/tmp/morphz-rom-authoring-context-cache.log`、`/tmp/morphz-rom-authoring-remote-check.log`、`/tmp/morphz-rom-authoring-build.log`。

原同一 App 在空输入、听写关闭且无未结束 activation 时正常退出；Runtime 一致性 SQLite 备份及退出后的原 desktop profile 备份位于 `/tmp/morphz-original-profile-cutover.J4E5u4`。从原 11395 仅在内存保留同一模型凭据，正常 SIGTERM 后用验证二进制重开原 18089 Runtime（34696），再正常重开同一 Morphz 包，不重签名、不建立新手工环境。用户临近退出已切到授权，重启保持授权、左右栏及宽度；随后只操作分组展示，以一收两展正常刷新，三项均恢复，再恢复原个性展开、系统／执行方式收起及授权页签。未代用户改 Profile、头像、模型、审批、目录或发送测试消息。

原库 240 表比较中，新增 nullable 列从旧版本投影中排除；**233 表逻辑摘要相同**，含 Profile 旧12个版本／12个回执、ROM heads／bindings、Threads、Mind 和未来安排。7表因正常启动／Host 重连发生变化：新增一个迁移 marker、两个 runtime/objective 控制事件；Runtime 原事件未改，execution target／principal／Session 仅心跳或更新时间变化，Host 的 runtime_sessions／runtime_deliveries 重新确认投影，行数不变。未冒称本轮仍是 240／240 hash 不变；旧版本新增作者列全部为 null，用户资料没有被迁移重写。原窗口仍104条消息、原未来提醒，展示已实看；不称用户审美或整个人格化长期目标已验收。

## 2026-10-02 Profile 资料展示与侧栏刷新保持

常态改为资料展示：64px 圆角头像和已确认名字直接同行，不再使用身份卡片描边、常驻「名字」标签或姓名开关。点击名字才进入局部编辑；Human 的名字、称呼沿用同一方式。打开编辑不提交，不把 Morphz／「我」展示回退写成配置；完成、Enter、非组合输入的 Escape 结束编辑并保留自动保存，不假称撤销。组合输入的 Escape 阻止原生 dialog 取消，不关闭整窗；此项有 DOM 事件回归，未补称原生系统 IME 实测。姓名与称呼可在编辑内明确「不设置」，仍写 null；0、全空、不使用、CAS、未知回执及身份范围队列保持。个性与表达默认折叠，简短描述仅来自实际已确认、已启用字段；无设定时「由模型决定」，不生成虚构简介或默认人格。系统入口收进独立的「能力与连接」，没有删除原功能。

右侧栏原来只持久化页签和宽度，显隐是挂载即空的局部状态，因而刷新收起。现仅在既有 center／principal 范围的界面偏好中记录 `subjectOpen`，按严格布尔读回，保存打开／收起与合法页签；左侧栏原有宽度、收起和隐藏互不覆盖。旧执行图钉及具体 Thread／root／input 范围不持久恢复，刷新只还原分类，不重开旧工作详情；批注与主体栏保持互斥。页签 Logo 使用所在按钮的 currentColor，四主题明暗与同组图标一致；只影响页签，不改变身份头像、左侧品牌或上传图片颜色。Runtime、Host、Profile schema 与缓存契约未改。

最终构建通过；Profile／Dock UI **43／43**（41.4 秒、零跳过），实际 UI → typed HTTP Host → 隔离 SQL → 实际 Rust Runtime → Provider 请求 **5／5**（14.5 秒），自动保存／transport／侧栏布局及模型单测 **39／39**、零跳过。Provider 回应为确定性测试，本轮没有新付费模型调用；新真实模型 probe 仅迁移驱动，未运行。日志 `/tmp/morphz-profile-person-final-proof.log`、`/tmp/morphz-profile-person-final.Uh5aje/deterministic-person-final.log`、`/tmp/morphz-profile-person-sidebar-unit.log`。保留失败证据：初轮 30／43 包含真实 Chevron 16px 超出 14px 列导致的 2px 横向溢出，修为明确 14px 而非裁切；其余驱动移入默认折叠分组、原生 details 真实可见性及有限 CSS 过渡的取证问题也逐项修正，原媒体、权限、CAS、unknown、身份与草稿断言未删除。明暗、390px 局部编辑及 200% CSS 缩放的资料截图已复看，后者不是原生 Electron 缩放验收。

侧栏刷新／原伸缩回归最终 **14／14**（29.5 秒、零跳过），包含四分类展开和收起、左右宽度独立、草稿、旧执行详情不恢复、四主题明暗，以及隔离 Electron 图标栏。异身份／中心存储键双向污染不能覆盖当前已认证作用域，且外域键原样；这不是新增真实登录切换验收。日志 `/tmp/morphz-subject-reload-final.bWBaCA/final-ui.log`。首跑系统 Chrome 未安装，使用已装 headless-shell 复跑；随后 11／14 的三个失败分别为旧用户菜单漏算「个人资料」、不完整伪造 bootstrap 触发身份一致性保护、受控 Runtime 在线时夹具遗漏只读模型目录。已迁移真实菜单排列、改为真实当前身份的存储隔离验证并补严格 GET 模型目录驱动，不删除零消息／零执行、详情、草稿或几何断言。

原同一 `/Users/shafreeck/Applications/Morphz.app` 在空输入、无附件、听写关闭后正常 View → Reload 载入最终构建。首次从旧 bundle 切换时旧版未记录显隐，手动恢复当时已打开的右栏；随后再次正常刷新，无需重开即保持「设定」和 345.875px 宽，左栏仍打开且 324px。只读打开双方资料实看新身份展示、折叠分组、页签中性 Logo，再恢复原设定页。前后 **240／240** 数据表逻辑摘要一致，Runtime 仍是 11395、未重启；没有修改用户已清空的 Profile、头像、审批、目录、主题或发送消息。此为本轮展示与刷新修复，不代表长期人格化目标或用户主观审美已验收。

## 2026-10-02 Profile 标题同行开关与不使用语义

按用户最后给出的定位，将总开关放到「设定」标题右侧，不再单独占重要一行；Human 的同一操作放在「个人资料」标题右侧。保持 32×20px 胶囊、独立键盘焦点和触控目标，不常驻重复标签；可访问名称分别为「使用人格设定」「使用个人资料」。关闭是正常的“不使用”，不是临时暂停、不定时恢复；保留选值及独立头像，后续新工作不加入这份 Profile。复用 Runtime 的既有 `enabled`，不新增状态表、迁移或永久禁用标志，旧 Thread 的冻结版本不改。

首次有效单项自动启用；已关闭且有保留值时，修改或新增名字、特性、风格、称呼均保持关闭，只能由标题开关明确恢复。空控件不构成设定；全空时总开关禁用且未选中。名字临时删空与自动保存队列一致，保留已确认名字，不误停用或误恢复；明确清空最后一项后，再设置第一项可自然启用，包括直接重新填写唯一的自定义风格／称呼。

最终构建、TypeScript、格式及差异检查通过。Profile／Dock UI **41／41**（34.3 秒，零跳过），保留原媒体、权限、CAS、未知回执、身份与连续修改守门，增加双方关闭后新增字段、Echo 临时空名、最后文本清空与直接重输；标题与开关同行的真实几何、明暗、390px 和 200% CSS 缩放通过。日志 `/tmp/morphz-profile-header-complete-ui.log`，截图 `/tmp/morphz-profile-header-complete-ui.LJvXrr`；CSS 缩放不是原生 Electron 缩放。实际 UI → typed Host → 隔离 SQL → Rust Runtime → Provider 请求 **5／5**（11.8 秒）通过：不使用时新增幽默仍为 `enabled=false`／零 ROM，显式启用后原名字及新增数值同时进入新 root，旧 Echo Thread 绑定不变；日志 `/tmp/morphz-profile-header-complete.OpjIng/deterministic-header-complete.log`。Provider 回应为确定性测试，不称本轮新真实模型效果测试；未再次付费。既有自动保存与 transport 单测 **25／25**、零跳过。保留首跑实际链4／5的失败证据：清空唯一自定义风格后 Host 已全空关闭，raw intent 却把 disabled 总控画成选中；现以有效配置与 enabled 共同绘制，并未削弱读回断言。

原同一 `/Users/shafreeck/Applications/Morphz.app` 确认输入和附件为空、听写关闭后，经 View → Reload 正常载入最终构建；Agent 设定及 Human 个人资料标题右侧开关已只读实看，关闭资料后恢复原设定页。没有代用户改字段、头像、审批、目录或主题，没有发送验收消息。每次临近刷新前后的 **240／240** 表逻辑摘要一致，Runtime 仍为进程 11395、未重启；保留用户当前全部未设置状态，不恢复旧 Echo 或幽默值。此为本次控件与语义修复，不代表长期人格化目标或用户主观审美已全部验收。

## 2026-10-02 Profile 自动生效、安静操作与定时任务分类修复

用户实际把名字旁「已设置」理解为已经生效，但当时它只是手动保存表单的草稿：原 Runtime 没有 ROM head，Echo 尚未写入。旧验收点击了保存，没有覆盖改名后直接提问。现将设定改成 App 生命周期、身份范围内的自动保存队列：整份「使用设定」置于名字和偏好之前，有效首次选择会启用，关闭保留字段，编辑已停用值不暗中再启用。开关／单选立即提交；文本停顿、失焦或 Enter，滑杆停顿或手势结束提交。名字编辑中的暂时空白不删除旧已确认名字；空控件与全空首态不建立 ROM，0 与 null 保持不同。去掉常驻「未启用／不设置／已设置／待保存」清单及手动保存区，真实取消风格仍保留「不设置」。成功静默；未确认、权限错误、冲突及重试可见，网络未知结果使用中文，不冒称保存成功。

连续修改在确切修订下串行，旧回执不覆盖新输入。丢回执后冻结原 command，必须显式同命令重试，后续编辑排在它之后；CAS 继续由本人选最新或覆盖。队列跨编辑器关闭／重开仍存在，身份切换取消旧定时提交并丢弃迟到结果。普通新输入在 staging 前确认 Agent／Human 全部待提交意图，失败保留消息草稿且不执行；同一长期 Session 的新 root 使用最新有效 head，无需新建 Session。旧 Thread continuation 的 manifest 和绑定版本不变。Runtime、Host 数据模型、权限与 prefix-cache 边界未改，不将本轮称为上游 cache 命中率或人格表现质量验收。

身份仍为 64px／18px 圆角底座和 40px 默认 Logo，更换头像按钮在桌面悬停或键盘进入时显示，移开隐藏；触控直接可用，不变上传授权、媒体或 CAS。32×20px 胶囊开关不继承全局输入框的鼠标焦点外圈，键盘 Tab 仍有焦点。时钟页签、标题、刷新及错误文案统一为「定时任务」；来源仍为实际 Runtime Schedule，不把人的待办日期、未启动的事项或不存在的 Runtime 记录算作定时任务，原权限、去重及有界读取保持。

最终构建、TypeScript、格式和差异检查通过。自动保存单测 **19／19**；最终 Profile／Dock UI **37／37**（28.9 秒、零跳过），含 Agent／Human 的闲置／悬停／移开／实际 Tab 聚焦、触控 file chooser、鼠标无外圈与键盘外圈、连续修改、中文未知回执、真实读取／权限／CAS／身份竞态及明暗、390px、200% CSS 缩放守门。CSS 缩放不是 Electron 原生缩放。最新截图 `/tmp/morphz-profile-hover-focus-ui.zjEKom/verified` 已实看，日志 `/tmp/morphz-profile-hover-focus-verified-ui.log`。保留失败记录：初次 30／33 的问题是未暂停的假时钟及滚回顶部后的旧焦点；后续键盘自定义风格开启会自动聚焦，旧测试多按 Tab；悬停专项首轮 36／37 的旧用例用程序 focus 期待键盘外圈，改为真实 Shift+Tab／Tab 并保留原断言。没有删除保存确认、媒体、权限或冲突断言。

实际 UI → typed HTTP Host → 隔离持久 SQL → 实际 Rust Runtime → Provider 请求链 **5／5**（11.9 秒），新增 Echo 后不点保存立即发送，故意阻塞 Profile 持久化时没有输入提前入站，放行后请求含 `(name Echo)`；之后 Nova 新 head 不改变旧 Echo continuation，停用后新请求无 ROM。另做 **2 次**隔离真实 `gpt-6.1-sol` 请求：同一 Session、改 Echo 后立即提问回答「我叫 Echo。」；关闭后回答「当前只读 Profile 未设置我的名字。」，实际请求没有 Profile。凭据仅在内存传给既有本机代理，未写入文件或原用户资料／对话。真实回应不代替表现质量评估。日志 `/tmp/morphz-profile-actual-final.MI9sPo/deterministic-final.log` 和 `/tmp/morphz-profile-actual-check.NvbNIq/profile-real-model-probe.sanitized.log`。定时任务／投影单测 **13／13**，定时任务与 compact 菜单浏览器 **16／16**（12.3 秒）通过；不是应用全量回归，也不补称 PostgreSQL 已验收。

提交前交叉检查发现一处窄身份风险：全局 transport 已观察新 bootstrap，但旧 hook 尚未重绘的间隙，隐式 generation 可能借新身份发起旧操作。Profile read／update、头像 read／set／clear 现在全部显式捕获本 hook 的 generation。新增真实 React hook／applicationCall 隔离桥接回归，故意先把全局切 B 而保持 A hook：旧 timer、显式 flush 及五种 RPC 均带 A，被 B 权威拒绝，新身份 head 零变化；真正重绘 B 后仅新 B 意图成功。两个子场景及父项 **3／3**、零跳过，日志 `/tmp/morphz-profile-identity-generation-verified.log`；这是桥接边界测试，不补称额外实际 Host 验收。最后构建日志 `/tmp/morphz-profile-identity-final-build.log`，Profile／Dock 最新复跑 **37／37**（30.0 秒），真实 Host 链 **5／5**（11.3 秒），定时任务与 compact **16／16**（12.6 秒），已有 transport 与自动保存单测合跑 **25／25**，全类型／格式／差异检查通过。最新日志分别为 `/tmp/morphz-profile-identity-final-ui.log`、`/tmp/morphz-profile-actual-scope.4qqzkd/deterministic-scope-final.log`、`/tmp/morphz-timed-tasks-final-ui.log`、`/tmp/morphz-profile-scope-unit.log`；没有再次付费调用。新测试初次类型检查的 Window 声明缺少全局类型已修复，最终类型检查通过，没有修改权限或删去行为断言。

原同一 Morphz 窗口切换前先保留用户已经填写的 Echo-only 选择：在旧页只保存这份实际意图，读回已启用且仅名字有值，没有添加默认特性；较当时基线仅三个 ROM 表发生这次预期修改。后续用户继续修改设定，以临近最终刷新前状态建立新只读基线，不把旧 Echo 快照盖回去。发现输入区仍有待发送截图时取消刷新；待输入与附件为空、听写关闭后，通过 View → Reload 正常载入最终构建。原窗口实看默认无相机、开关无鼠标遗留外圈、使用设定在名字之前，以及定时任务正确标题和原未来提醒；未代用户切换特性、头像、审批、主题或目录授权，未发送验收消息。只读检查后恢复刷新前收起的右栏和设定页签。最后身份补丁也在空输入时正常刷新并实看读回正确；每次临近刷新建立的基线前后均 **240／240** 数据表逻辑摘要一致，Runtime 仍为进程 11395，未重启。此为当前问题的实现与验收，不代表用户已认可审美或此前整个人格化目标已经完成。

## 2026-10-02 Profile 设定页层级与圆角身份重设计

按个人助手的身份与表达偏好组织设定页，替换等权的原生复选框清单：身份区先展示 64px、18px 圆角头像底座与同行名字，既有 Logo 内缩到 40px，上传图片与 Human 首字使用相同外框；相机操作为 32px。总开关与逐项开关保留真实 checkbox／键盘语义，视觉改为统一胶囊开关，默认不设置不展示数值。四项表达偏好共用一个紧凑分组；选中时描述和准确 0–5 值收进标题同一行，再显示滑杆和两端短标签。模型与账号、智能体连接及已安装执行方式组成独立「能力与连接」操作组，不新增角色预览、长说明或假能力。Human 沿用同一身份组件；修复旧 `.create-dialog footer` 样式泄漏到内嵌保存区而产生 42px 多余空白、窄窗初开只露半个保存按钮的问题，只覆盖该内嵌页脚，不改其他对话框。

最新完整构建通过，Profile／Dock UI **27／27**（21.7 秒）、Avatar 实际 DOM／领域 **5／5**、实际 UI → HTTP Host → 持久 SQL → Rust Runtime → Provider 请求 **4／4**（9.1 秒）通过，TypeScript、格式和差异检查通过。Provider 的回应仍是既有确定性测试回应，本轮没有再次调用付费模型，也不将外观重设计称为人格表达质量验收。旧 20 项 Profile 语义回归保留；新增加真实 64px／18px 几何、非重叠、完整键盘操作、矮窗及未选项密度守门，上传素材保持 cover 和同一圆角。明暗、390px、200% CSS 缩放的初开／选中／完整保存区截图已逐张复看；200% 使用真实滚动后要求保存及整组页脚 intersection ratio=1，不用已聚焦或部分可见冒充完整显示。CSS 缩放不是 Electron 原生缩放实测。首轮 26／27 和后续截图守门的失败记录保留：上传后真实「移除头像」操作需要一行独立空间，统一高度假设补为有／无该操作分开；测试在缩放并滚回顶部后保留旧焦点，重新 focus 不会再滚动，现显式滚入操作区后仍严格检查完整可见，不删除保存、权限、CAS 或媒体断言。日志 `/tmp/morphz-profile-redesign-build.log`、`/tmp/morphz-profile-redesign-verified-ui.log`、`/tmp/morphz-profile-redesign-actual-ui.log`，最终截图在 `/tmp/morphz-profile-redesign-ui.MSxbjE/verified`。

原同一 `/Users/shafreeck/Applications/Morphz.app` 先确认空输入、听写关闭、无资料草稿和当前处理，再通过 View → Reload 正常加载最终构建。右侧 Agent 设定及 Human 个人资料都已只读打开并截图实看：缩小圆角身份、分组与完整保存操作可见，仍未启用、各项不设置；核对后关闭资料与右栏，恢复检查前的收起状态。没有替用户保存资料、上传头像、切换主题／审批／目录授权或发送验收消息，没有重启 Runtime（仍为进程 11395）。本轮前后全部 **240／240** 数据表逻辑摘要一致，原消息、资料、Session、Thread 和未来安排保持。此为本轮 UI 实现与证据，不代表用户已认可审美，也不把先前长期人格化目标的未验收项称为完成。

## 2026-10-02 Profile 显式设定与默认 Logo 修复

首轮 UI 自动预填 2／3 等数值，但原窗口未保存，Runtime 没有 Profile；界面容易被当作已生效，首轮验证也缺少 UI 到实际模型请求的整链证据。本轮不以该预填值代替配置：Agent／Human 默认停用，姓名、称呼、四项特性、讲话风格及自定义风格独立允许不设置。`null` 完全省略，0 是明确分值；全空不能启用。关闭整份保留已选值及独立头像，但新 Thread 不挂载该 Profile。保存前显示待保存，真实回执与持久读回一致后才显示实际启用状态。已保存 v1 不自动改写，原 Thread 的确定版本绑定不变。默认 Agent 头像改回既有 Morphz Logo，删除被否决的紫色卡通及其概念变体，上传能力和已有资源保留。

Core／Host 阶段本地提交 `9320a105`：25 项定向测试，24 通过、0 失败、1 跳过（未配置本轮 PostgreSQL 环境）；包含 v1 原样读取、稀疏编译、0／null、停用数据和头像保留、权限、CAS／幂等与 Agent 工具 JSON Schema。最新 UI **26／26**、Avatar 实际 DOM／领域 **5／5** 通过，明暗、390px、200% 截图逐张复看；TypeScript、Vite、Host 构建及差异检查通过。构建日志 `/tmp/morphz-profile-optional-final-build.log`。不是应用全量回归，也不补称本轮完成 PostgreSQL 验收。

新增实际整链 **4／4**（8.8 秒）：真实 UI → typed HTTP Host → 隔离持久 SQL → 实际 Rust Runtime → 实际模型 HTTP 请求；确定性 Provider 回应仅用于请求字节断言。验证初始无 Profile、只选幽默5／严谨0、关闭及全空后新工作无 Profile 扩展、旧工作 continuation 固定旧版本、真实丢回执同命令重试及 Rust CAS409；Human 只设称呼的私有 Principal 精确绑定，公开入口404，停用后新请求不注入。最后补正空自定义风格／空称呼的 UI canonical intent 与 Host 一致，实际提交为null，读回未启用且不再误报资料再次变化。最新构建再跑上述UI26／26及Avatar5／5通过。日志 `/tmp/morphz-profile-actual-transport-final-ui.log`，复跑配置 `playwright.profile-actual.config.ts`。

另用原已配置的 `gpt-6.1-sol` 做独立真实模型 probe，**3 次实际请求**：未设置回答「幽默配置：未设置。」→ UI 保存幽默5回答「幽默配置：5/5。」→ UI 关闭后回答「幽默配置：未设置。」。输入只含合成验收问题，Host／Runtime 都是新建隔离库，凭据只在内存中交给既有本机代理，未写入仓库或测试配置，不传用户历史。不把这三次准确自报当作人格表现质量或上游 prefix-cache 命中率证明。

原 `/Users/shafreeck/Applications/Morphz.app` 正常退出／重开后已实看：默认 Logo、使用 Profile 未启用、全部特性不设置、讲话风格不设置，原输入为空、听写关闭，恢复原设定侧栏。最后空文本修复仅正常刷新Renderer，仍实看未启用与不设置。升级前私有备份包含12库、原配置、desktop和旧编译产物；原可见未保存测试值单独记为草稿快照，不擅自保存／启用或把旧预填迁成显式设定。切换前后240个表逻辑摘要中239个一致，唯一变化是原 Host 的 `runtime_deliveries` 投影（182条不增减）；早期备份已有180条全部原样，新增2条来自用户升级前的实际聊天。另已保存当前12库一致备份，全部quick_check=ok，包含新增消息。所有 Runtime 表原样，进程仍为11395，Session17、Thread237、ROM heads0，未来 pending timer1及原审批／目录授权保持。没有在用户原窗口保存 Profile、上传头像、发送验收消息或重启 Runtime。

## 2026-10-02 审批预览与推理默认读回修复

审批控制器原先只在菜单打开后读取策略，导致首次进入或刷新时底栏保留未读取的空盾牌。现在对可见输入范围只读一次，菜单打开时再核对最新策略；不创建空 Session、不发送消息、不改审批权限，补充在途工作的入口仍不读取或修改它的权限。审批专项 **18／18**（24.9 秒）通过，新增三种模式在未打开菜单和刷新后的真实 SVG 断言，覆盖原有范围／身份竞态、安全默认及几何回归。日志 `/tmp/morphz-approval-preview-ui.log`。

推理底栏原先把模型目录的继承档位映射为具体标签，而弹层保留「默认」，导致相互矛盾。现省略本次强度时统一显示「默认」，仅明确选值显示「轻量」等档位；实际请求仍省略 override，未修改 Runtime 默认。新增轻量默认下的弹层／底栏／重开／刷新与恢复默认回归。单位测试 **4／4**，最新构建后的推理与审批 UI **23／23**（25.7 秒）通过，日志 `/tmp/morphz-preview-and-default-final-ui.log`。首轮使用修复前的 dist，新增回归如实失败；重建而非删除断言后通过。以上目前是本地实现及隔离回归，尚不冒称原用户窗口已载入新修复。

随后在原同一 Morphz 窗口确认输入为空、听写关闭且没有当前处理中后安全刷新。未打开菜单的截图已确认人物盾牌及「默认」；只读打开菜单后截图确认询问批准和两处「默认」一致，再 Escape 收起。用户当前实际策略为询问批准，未替其恢复旧自动审批／完全访问或更改策略；未发送测试消息、重启 Runtime 或停止未来提醒。

## 2026-10-02 人工审批去除问号

用户指出问号仍会被理解成疑问或未知状态。本轮将「询问批准」共用图形改为人物盾牌（ShieldUser），明确由人审批；自动审批仍为勾选盾牌，完全访问仍为开锁。只替换图形，不更改真实 Session 权限、保存或风险确认。完整构建及审批专项 **15／15**（21.5 秒）通过，实际 16px 人物盾牌和弹层截图已复看；覆盖三态图形、颜色、焦点、读回、竞态与稳定几何。日志 `/tmp/morphz-approval-human-build.log`、`/tmp/morphz-approval-human-ui.log`。这一条取代前次圆形问询图形，不再使用任何问号表达审批状态。

## 2026-10-02 审批图形语义修正

用户要求美化而非删除「询问批准」，认可「自动审批」，指出斜线盾牌让「完全访问」看成禁止访问。本次仅替换共用图形：询问批准使用清晰圆形问询，自动审批保留原盾牌打勾，完全访问改成开锁；输入触发器和菜单审批项使用同一组件。沿用现有线宽、尺寸与中性／强调／危险色；未读取与自定义策略不冒充已确认预设。没有修改审批预设、Runtime 安全评审、确认风险、授权范围或保存行为。

完整构建通过，审批专项最终 **15／15**（19.9 秒）UI 通过，包含三态实际 SVG 圆环／路径／锁体完整图形、16px 触发器和审批项一致、颜色与实际回执、冲突／迟到回复守门、风险确认／取消及保存过程稳定几何。三态弹层及实际小尺寸截图已保存，弹层截图已复看。首轮 **14／15** 的唯一失败为扩展图形 helper 后残留旧函数名，已补正全部调用、以完整图形对象比较，不删除原失败／冲突断言。日志 `/tmp/morphz-approval-symbols-build.log`、`/tmp/morphz-approval-symbols-ui.log`、`/tmp/morphz-approval-symbols-final-ui.log`。

原同一窗口安全刷新后只读打开设置并截图，确认用户当前「完全访问」在菜单及输入入口均为开锁，没有替用户切换审批或发送消息。另两态的证据是隔离回归，不冒称原用户 Runtime 策略写入验收。此前「空盾牌／划线盾牌」的设计被本条替代，而不是再次撤掉模式区分。

## 2026-10-02 个人菜单分态定位与两侧对齐

用户明确展开侧栏仍从个人按钮上方弹出，只有收缩图标栏才向右弹。原实现将 `placement="right"` 固定用于两态；桌面底部入口现依据实际 `leftSidebar.compact` 传入方向，不复用仅表示移动顶栏头像的 `compact`。后续用户指出仅右边缘对齐的窄菜单仍不协调，展开弹层现与完整个人按钮同宽、左右边缘同时对齐；共享弹层的匹配宽度选项默认关闭，仅这一入口启用，收缩菜单保持原紧凑宽度。保留菜单内容、材质、搜索快捷键、外部关闭、焦点返回与移动端行为，没有改动授权、输入路由或持久化模型。

完整构建与格式／差异检查通过，侧栏布局 **4／4** 单测通过，个人菜单／紧凑输入／主体 Dock **15／15** UI（21.3 秒）通过。涵盖明暗、760／1440、打开期间 1440→640→1440 的双向重锚、实际菜单同宽、原菜单动作与焦点、草稿存储及恢复、无消息／Session 变更。200% 用例是真实 CSS 缩放下的菜单几何验证，夹具约束画布高度以隔离根元素 `100dvh` 翻倍，不称 Electron 原生缩放或整壳缩放验收。日志 `/tmp/morphz-profile-placement-aligned-build.log`、`/tmp/morphz-profile-placement-unit.log`、`/tmp/morphz-profile-placement-aligned-ui.log`。

首轮 **13／15** 的两个新增夹具失败分别误要求窄窗收起后仍挂载输入框、根 CSS 缩放把画布高度也翻倍；现前者检查真实草稿存储并在还原后重开输入核对正文，后者按上述限制验证定位，没有删除草稿、边界或焦点断言。原窗口初次向上修复的窄宽截图被用户指出左边不齐，已继续修正，不将初次效果记为完成。

同一原 Morphz 窗口在确认空输入、无当前处理中或听写后刷新。原窗口截图已确认展开弹层在入口上方、实际同宽且两侧对齐；未改变原侧栏宽度、主题、审批、目录授权、用户消息或后台工作。收缩／移动端及缩放证据为上述隔离 UI 回归，不冒称全部已在用户原窗口操作。没有启动第二个手工测试实例或重启 Runtime。

## 2026-10-02 移除消息目录清单与个人默认空关联

删除消息气泡中常驻的「目录读写」行，不搬到其他消息区域；真实原文件引用和附件预览保持。输入框个人默认工作台路由不再显示「未归项目」或另一个空标签；依据实际 space kind、对象／浏览器现场显示有意义标题，补充原工作和可操作意图、事项、剧本引用仍保留。空项目仅在实际可操作关联弹层内称「无项目」。不按标题字符串猜测归属，不改 projectId、conversationId、输入目的地或冻结授权。命名会话选择当前只在真实项目入口可达，沿用项目范围，不为一项文案虚构个人命名会话机制。

完整构建通过，消息保存／模型冻结／发送模式 **15／15** 单测通过，日志 `/tmp/morphz-directory-scope-cleanup-build.log`、`/tmp/morphz-directory-scope-cleanup-unit.log`。扩跑十三组 UI 首轮 **62／66**（2.4 分钟），日志 `/tmp/morphz-directory-scope-cleanup-ui.log`；本项两个新增真实 Host 测试及全部授权／发送／草稿／关联用例通过。新测试使用真实已授权目录及原文件，Host 持久入队、历史读取和失败气泡跨刷新重试均保留原 command／directories／localFile；隔离 Runtime dispatch 停止，不冒称模型执行完成。前置探针修正测试自身误用 dialogueId 作为 projectId，按实际 deskId／dialogueId 路由验证，没有修改产品协议。

四个扩跑失败均为旧 `composer-layout` 验收仍要求常驻模型 select、原浮动「输入工具」附件／截图组或固定三个按钮；此布局已由单底栏与应用 Dock 替代。另一记录位置旧用例因空按钮数组比较而未有效验证，仍需迁移为非空实际 Dock 几何；不把首轮称为全绿。该测试维护单独记录和提交，不混入本项生产修改。

新构建在原窗口确认空输入、无处理中与录音后刷新并截图：实际阅读对话四条原消息不再显示目录行，左下仅保留加号，空项目标签消失；审批只读核对仍为用户选择的自动审批，当前额外目录为用户先前自行撤销后的零个，实际默认 workspace 路径及添加入口可见。目录展开截图证实没有两段说明或英文节点名称，模型／强度与审批／目录仍为统一主次布局。Launcher 整组中轴及初开图钉隐藏也已在同一原窗口截图复看，补足上一阶段未完成的现场定位证据。未发送测试消息、改审批或目录、改变外观／导航偏好、重启 Runtime 或停止工作；关闭验证弹层后保留现场。此前「已移除」仅指源码、尚未加载窗口的说法已纠正，本条原窗口效果确已验证。

## 2026-10-02 执行设置主次统一与精简目录详情

用户认可强度轨道后要求整组样式一致。设置现由居中强度、原模型选择器和主题轨道组成主控件；审批／工作目录同排为两项次级操作，保留真实选择值与图形区分，不再混排四行字段。模型选择器仍使用原目录、原值、加载／失败／重试和下一输入语义；非输入的事项选择器不变。触控模型、审批和目录入口至少 44px，键盘字段名与焦点仍可达。

目录展开删除两段常驻授权说明和英文执行节点名字，仅保留默认实际路径及原添加／撤销操作；完整范围与权限边界在提示及可访问描述中保留，不删除完全访问风险确认或错误。原生 details 及授权控制器持续挂载，展开内容占整组宽度，没有新增状态机或 Runtime 请求。用户随后指出消息卡片内目录读写信息冗余，另列后续独立展示修复，不将其混称本阶段已经解决。

正式完整构建通过，八组相关 UI **49／49**（1.3 分钟）通过，日志 `/tmp/morphz-settings-cohesion-accepted-build.log`、`/tmp/morphz-settings-cohesion-accepted-ui.log`。覆盖主控件顺序与居中、次级同排、390px 长模型／200%缩放、明暗截图、目录持续挂载／冻结授权、审批保存几何、范围竞态和风险取消／确认。初轮 **47／49** 的两项旧外观断言仍要求强度块完全没有 select 和审批外框透明；现验证其中只有真实模型 select、推理仍为 range，以及两个次级操作在鼠标／键盘切换时静态材质不变，原安全载荷断言未删。修正后的三组专项 **24／24**（27.2 秒）另通过。

原 Morphz 同一个应用窗口已加载新布局；只读打开设置并截图确认主控件与同排操作、自动审批短名称、无常驻字段说明。实际目录展开的可访问状态中仅有真实 workspace 路径及原添加入口，没有两段说明或英文节点名；用户同时操作收起菜单，因此不冒称该展开态已经截图验收。当前审批和目录数量随用户实际操作变化，未代替用户设置、撤销或恢复旧授权。没有发送测试消息、重启 Runtime 或停止工作；刷新受用户导航保护拦截时不强行操作。此为相关 UI 回归和原窗口布局复看，不是应用全量验收或用户已认可整组审美。

## 2026-10-02 强度控件与 Launcher 中轴修复

输入设置推理强度改为独立离散滑杆：当前强度居中、恢复默认在右侧，24px 圆角轨道与白色滑块沿用主题色。首版灰色轨道和五档文字被用户退回，现已取消常驻档位文字，仅保留轻刻度；用户随后确认已有设计感，模型／审批／目录的整体层级统一属于下一阶段，不冒称已获整组界面验收。实际模型能力、默认继承、旧不兼容值守门、下一输入范围与原事项选择器不变；没有增加 LLM 请求或修改 Runtime 档位。旧紧凑 Grid 选择器曾覆盖新控件布局，已修正限定样式并由真实轨道宽度、层级及缩放几何验证。

Launcher 从最后一个按钮右对齐改为整组 Dock 中轴定位，保持独立悬浮按钮材质，窄窗先居中再夹紧到安全边界。真实测试发现缩放／恢复时只监听固定宽度的 Dock 与面板会漏掉祖先工作画布尺寸变化，产生 20px 或 720px 漂移；现只对有该水平锚点的 Launcher 观察其真实祖先布局链，不增加持续轮询或改变其他菜单默认定位。鼠标初开不画原生蓝色粗框，键盘保留细中性焦点。

正式完整构建通过；八组相关 UI **49／49**（1.4 分钟）通过，日志 `/tmp/morphz-ui-polish-accepted-regressions.log`，包括明暗原生滑杆 PNG 像素形状、默认不冒充标准、首档点击、键盘／重置焦点、零档／不兼容／旧服务／失败状态、390px 和 200%、审批风险与范围竞态、输入草稿、媒体／个人菜单、Launcher 固定变化及触控。Launcher 原失败用例另连续 **3／3**（10.4 秒）通过，日志 `/tmp/morphz-launcher-reanchor-focused-repeat-ui.log`；摘要投影 **3／3** 单测通过。最终重新构建日志 `/tmp/morphz-ui-polish-loaded-final-build.log`。

初轮强度合并测试 **31／33**，两项旧验收分别期待已退役的失败草稿恢复和工作空间菜单；改验原失败气泡冻结 model／effort／commandId、刷新不自动重发、重试不覆盖下一草稿，以及实际媒体附件入口而非独立原文件浏览。未删除载荷或权限守门断言。Launcher 新回归初轮 **4／5** 的真实定位失败也保留，不把后续修正称为首轮通过。此阶段为 UI／隔离 Host 回归，不改用户真实审批、目录、消息或 Runtime 工作；尚待同一原窗口完整定位复看。

## 2026-10-02 Launcher 首项图钉常显修复

根因是共享弹层默认自动聚焦第一应用，其父卡片的 `focus-within` 因而显露图钉，不是错误的固定偏好。Launcher 改用现有的初始面板焦点，不改网格／材质／固定语义；鼠标悬停与主动键盘 Tab 进入对应应用后显露图钉，离开隐藏，无悬停触控设备仍直接可操作。

正式构建通过；主体／Dock **5／5** UI（8.5 秒）通过，包括新增初开隐藏、悬停／离开、Tab 到启动／图钉、Escape 返回和真实触控固定回归；原草稿、Session、固定刷新恢复和实际应用启动断言保留。日志 `/tmp/morphz-launcher-pin-build.log`、`/tmp/morphz-launcher-pin-ui.log`。原版同一应用 Renderer 已刷新，实际打开 Launcher 截图确认首项图钉不再常显；键盘后续操作遇到用户导航变化被工具取消，因此键盘／触控验收是隔离回归，不冒称原窗口全链路。未发送、修改审批／目录权限或重启 Runtime。

## 2026-10-02 审批图标美化、短名称与切换跳动修复

用户明确「丑」要求美化，不是取消模式区分。审批和输入触发器统一 16px、2px 线稿，询问批准／自动审批／完全访问分别使用轮廓／带勾／关闭防护盾牌；后两者辅以现有强调／危险色，不用细碎问号或厚重实心填充。菜单三项统一四字，`auto_review` 仍保留真实安全评审语义、可能拒绝或转交用户，未修改 Runtime、审批合同或沙盒策略。

延迟真实组件回执复现：保存时临时「正在确认审批方式…」追加 Grid 行，使弹层高度从 183 增至 206.390625 CSS px、顶边从 717 移至 694；主画布和输入几何原本不变，用户看到的是弹层反复跳动。修复只将读取／保存状态放入无布局读屏状态，原控件禁用与 title 保留，不隐藏错误和完全访问风险确认，不乐观授权。100%／200% 连续 12 帧几何一致，原焦点及跨范围迟到回执保护保留。

正式构建通过；审批专项 **15／15**（17.9 秒）通过，含三模式实际读回、短名称、风险确认／取消／Escape、错误、身份／范围竞态、390px 及200%缩放。日志 `/tmp/morphz-approval-polish-build.log`、`/tmp/morphz-approval-polish-ui.log`；初次失败复现保留于 `/tmp/morphz-approval-jitter-before.log`。三模式截图已复看，隔离权限响应不等于原用户 Runtime 权限写入验收；未为验收修改用户安全策略或发送模型请求。

## 2026-10-02 用户连续反馈实施与验收清单

后续反馈追加到同一清单；不能以收到反馈、源码已改或隔离夹具截图代替完成。每项记录验证边界并在完成阶段作聚焦本地提交。

| 项目                                           | 当前证据与状态                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Objective 混合中英技术状态                  | 已修复并提交 `b6061856`：正常状态中文，原始原因按需展开；原窗口已核对                                                          |
| 2. 右栏分类间重复「进行中」文字                | 已移除并提交 `e2bd7ec6`：分类和开关保留；原窗口鼠标命中已核对                                                                  |
| 3. 原生提醒未出现在安排，提醒与 Objective 区分 | 已修复并提交 `bed59edd`，54 项 Host/model 回归和 11 项相关 UI 通过；原窗口显示实际提醒且数据库未变                             |
| 4. 首字前聊天处理中但 Logo 没反馈              | 已修复并提交 `1a8e5318`，16 项模型及 9 项相关 UI 通过；原窗口等待状态保留，处理中验收为隔离回归                                |
| 5. 审批预设图标没有视觉区分                    | 首次提交 `a4018e48`；后续用户明确要美化而非取消区分，最新线稿／短名称及跳动修复见上节                                          |
| 6. 执行设置常驻说明过多                        | 已移至提示，保留完全访问风险确认与错误；确认后焦点和 Escape 已修复并验证                                                       |
| 7. 普通关联弹出无操作的重复信息                | 已改静态标签，仅实际引用／意图操作可展开；草稿与移除操作回归通过                                                               |
| 8. 加号媒体菜单向左覆盖导航                    | 已改从加号向右，320／390／760／1440 与 200% 缩放回归通过                                                                       |
| 9. 文件拖入输入框                              | 已接原附件上传，只在输入框接收、先存草稿不自动发送；5 项隔离拖放回归通过                                                       |
| 10. 搜索菜单显示快捷键                         | 已接现有 Cmd/Ctrl+K，在菜单右侧标注；原窗口已核对 ⌘K                                                                           |
| 11. 个人菜单按侧栏状态弹出                     | 展开向上并与入口同宽两侧齐，图标栏向右；最新回归及原窗口证据见本页「个人菜单分态定位与两侧对齐」                               |
| 12. 默认打断，快捷键显式并发                   | 已实现既有 Runtime interrupt，Option/Alt+Enter 显式 parallel；132 项后端、3 项发送 UI、现有 Rust 缓存 2 项通过，本阶段聚焦提交 |
| 13. Profile 分类图形                           | 已提交 `acf76a53`，静态 Morphz Logo；4 项右栏 UI 及原窗口坐标核对，名字／风格／用户资料机制以后单独设计                        |
| 14. Profile 中已发布项目摘要入口               | 已提交 `acf76a53`，未迁到别处；当前实际中心 0 条发布版本，原窗口无旧入口                                                       |

不得为验证上述界面修改而发送真实测试消息、改变审批策略、重新安排提醒或停止无关工作；自动化隔离执行测试与原窗口只读验收分别说明。

### 第 12 项：默认打断沿用 Runtime 契约，不改底层

原 Host 的 typed Session IO 固定 `parallel`，而 Runtime 本来已有 `interrupt`。新普通输入在 Client 本机暂存之前冻结 `dispatchMode`，普通发送为 interrupt，Option/Alt+Enter 或按住该键点击为显式 parallel；不是持久会话偏好，不加输入按钮或第二行。既有 Enter／Mod+Enter 发送偏好、Shift 换行、输入法／重复键／多修饰守门保持。定向补充固定 parallel 与原 InputDestination，批注和人的事项结果不获得普通消息模式。

打断对象是 Runtime 当前 Session 最近一条尚未释放 dialogue lane 的思考回复，不是遍历停掉线程；已进入非 context_tx 工具执行、独立 Execution、Supervisor、Objective 和提醒不被这个手势取消。个人默认 Session 跨项目，所以不是按当前页面或 Principal 独立打断；共享命名 Session 也沿用 Session 语义，不伪称“只打断自己的回复”。尚未消费完成的旧思考输入按 Runtime 原契约带入替代回复。未修改 Rust、权限、线程生命周期或取消 API，也未加 LLM 请求。

Host 持久请求首次准入冻结模式，同 command 重试不能换模式；已准入旧 typed 请求省略模式仍保留原省略字段及历史 parallel 语义。本机升级前 saved 输入缺模式时发送 parallel，不重写原保存 bytes；不把新默认强加到旧请求或在途工作。模型、附件、授权守门与原 durable receipt 保持。

18 组后端 **132／132** 通过（4.36 秒），日志 `/tmp/morphz-input-dispatch-20261002-backend.log`；原应用路由及真实 Host 入站另 **4／4**（8.71 秒）通过，日志 `/tmp/morphz-dispatch-original-ingress-fixed-unit.log`；输入快捷键 **3／3**，构建和最终 typecheck 通过。原 Session IO／补充／入站夹具缺少持久 PATCH 读回导致安全初始化挡住投递，修补真实夹具状态而不降低守门或原断言；原入站首轮 3／4 的失败日志保留。测试文件已有的独立 Harness 升级差异不混入本提交。

Runtime 既有测试缓存直接运行思考打断及 context maintenance 重放两条 **2／2** 通过，日志 `/tmp/morphz-input-dispatch-20261002-rust-cached.log`；缓存构建于 9 月 30 日，本轮 Rust 源码未变，不称今日重新全量编译。发送 UI **3／3** 通过，连同偏好与 Profile **11／11**；最终合并审批／首字 Logo／安排／Profile／发送 **34／34**（37.9 秒），原生安排另 **3／3**（5.4 秒），日志 `/tmp/morphz-feedback-final-integrated-ui.log` 与 `/tmp/morphz-runtime-schedules-last-ui.log`。这是相关回归，不是应用全量验收。

同一个 Morphz 应用正常重开加载新 Host，原 profile、中心、空输入及消息保留；实际发送入口提示默认打断／Option+Enter 并发。未发送真实测试消息，因此原窗口打断执行的证据为隔离 Host UI 与 Runtime 缓存单测，不伪称现场新模型请求。复看原提醒仍为 10 月 23 日 09:00；只读 SQLite 核对原 schedule revision=1、queued、not_before／updated_at 未变，人的事项 revision=1、planned、local-human、10 月 24 日、0 个 run link。阶段提交后不推送。

### 第 13–14 项：Profile 入口清理，不扩展人格机制

设定分类使用现有静态 BrandMark，图形与左侧 Morphz Logo 一致；不为第二个入口加入状态动画。保留真实名字、默认模型、模型与账号、智能体连接和已安装执行方式。删除「已发布的项目摘要」按钮与旧打开回调，不在其他位置加替代入口；这不是完整 Profile 编辑器。用户明确后续另讨论 Agent 名字／风格及用户名字等资料机制，本轮仅记录边界，不增加配置数据库、假编辑按钮或新设置表单。

旧摘要来自 Agent 显式发布的 Runtime `public-summary` frame，经 Host 校验后进入 Platform `project_understanding_versions`；不是自动聊天记录、人格记忆或本轮新增数据。当前原中心只读查询为 **0 个版本、0 个项目**。此前「已有摘要数据不删除」表述不成立，应说保留旧存储机制而非声称存在用户正文；现阶段未证明独立摘要入口的使用价值，不保留 UI 入口。

完整构建与 typecheck 通过；右栏 4／4 连同发送及偏好共 **11／11** UI（27.0 秒）通过，日志 `/tmp/morphz-dispatch-profile-final-ui.log`。验证相同 Logo path／viewBox、静态无动画、无旧摘要按钮、保留配置入口、四分类切换不发消息／创建会话／修改草稿。原 Morphz 同一应用正常重开后，实际鼠标选择设定页并截图复看，Logo 分类及名字／模型／原配置可见，旧摘要入口消失；执行设置也复看为普通盾牌、四行无常驻说明，真实询问批准和默认目录未改变。安排页仍为原 10 月 23 日 09:00 提醒。没有测试消息或 Runtime 重启，此阶段聚焦提交。

### 第 5–11 项：输入区真实模式与有用操作

审批入口及弹层采用同一真实 Session 读回：询问批准为普通轮廓盾牌、自动安全评审为带勾盾牌、完全访问为实心盾牌，并使用既有中性／主题／风险色。撤回用户指出过于细碎的问号盾牌。未读、错误、跨身份／场景迟到不会冒充预设，不增加轮询或本机权限。常驻范围段落撤下，范围与模型下一输入语义保留在 title／可访问描述；完全访问风险确认、读取失败和目录详情边界仍保留。确认保存临时禁用按钮前捕获焦点，真实回执后只在原范围、原弹层且未转移导航时恢复，Escape 可以正常关闭。

普通输入关联不再弹出只重复未归项目的空菜单；真实引用、意图和事项结果操作仍可展开。媒体菜单以加号左缘向内容侧展开，个人菜单在头像右侧底部对齐，窄窗与缩放限制在视口内；搜索沿用原 Cmd/Ctrl+K，只增加标注。

文件拖入仅绑定现有 composer，重用粘贴／文件选择的上传、格式／大小／8 个限制、部分失败与原草稿回写。显式拖入才有临时边框，移开即撤；文本／路径／URL 保留原生拖动，不下载或读取路径，文件夹不递归读取。附件先进入草稿，不发送、不入内容库、不创建会话；迟到上传仍归原场景。输入不支持附件或正在上传时拒绝，不扩大全窗拖放范围。

完整构建通过，十组相关 UI **52／52**（56.9 秒）通过，日志 `/tmp/morphz-composer-fixes-final-ui.log`。包含审批 13、拖入 5、粘贴 4、菜单定位／单底栏／Dock／焦点／交流层回归；此前审批颜色比较夹具和确认焦点失败的日志保留，不称首轮全绿。原 Morphz 同一窗口坐标核对个人菜单右侧与 ⌘K、媒体菜单向右、静态普通关联和四条执行设置无常驻段落。没有改变真实审批；三模式写回与文件上传验证为隔离 Host／浏览器回归，尚未做原窗口 Finder 实际拖入。此阶段作聚焦本地提交，不推送。

### 第 3 项：原生安排投影与显式只读刷新

根因是安排页只查询 Platform 事项，原提醒由 Runtime 直接创建且没有事项绑定。现接入同一活动快照中的真实 Schedule，严格校验 Session、Context、source turn、原始 Human 输入及当前访问权限；只读投影不另存安排。Platform 与原生记录仅按确切 scheduleId 去重，人的截止日期不自行转为 Agent 安排。手动刷新走原 runtime.navigation 的可选只读刷新参数，重新核对 Human 授权并读取既有调度快照；不 tick、投递输入、创建或变更工作，普通轮询不加请求。

一次性定时提醒本身不要求 Objective；当前 Agent durable spawn 的监督契约要求绑定目标，因此这条已有提醒带了目标。Session Schedule API 本可独立安排。这里不为修 UI 改 Runtime 契约，也不删除已存在的监督目标。

Host/model/transport 相关 54／54 通过，构建与 typecheck 通过；原生安排、事项安排与主体 Dock 11／11 在合并 UI 重跑中通过，日志 `/tmp/morphz-subject-input-final-ui.log`。此前 10／11 的失败是监听把初始空间 ensure 计入刷新写操作；现仅在初始读取完成后监听实际手动刷新，仍断言所有 POST/PATCH/DELETE 为零，没有过滤掉写接口以求通过。原 Morphz 同一应用正常重开后，安排页显示真实「等待触发 · 2026/10/23 09:00」，鼠标刷新保持原条目。SQLite 只读核对 schedule_048bc5bac5e022eb04a8a1d4 仍 revision=1、queued、原 not_before/updated_at；人的待办仍 revision=1、planned、run_requested=0。没有重启 Runtime、发送消息或更改提醒／权限。合并 UI 中审批颜色与文件夹夹具尚有待修复失败，不把本项通过称为全部反馈已完成。

### 第 4 项：首字前 Logo 处理反馈

根因是 Logo 只看有文字的流输出，started 的空回复被现有流投影过滤；聊天已经根据 running 投递显示处理中，但长期等待提醒先匹配掉 Logo 反馈。现用与聊天一致的既有投递／回复／错误／交付／审批事实区分 processing、排队／发送与实际 working，不改 Runtime 或流投影。已回复、错误或交付能撤下处理反馈，当前审批不伪处理，另一新输入可以独立反馈；断线与减少动态保留静态。未增加请求或下标。

模型 16／16、相关 UI 9／9 在合并重跑中通过（response-waiting、subject-logo-visible-motion、subject-logo），构建通过。首字前用真实渲染的 CSSAnimation 时间推进及两帧 Logo PNG 差异验证，不暂停动画或伪造时钟；随后覆盖首字、终态、排队／发送、系统减少动态、草稿保留。日志 `/tmp/morphz-logo-final-unit.log` 与 `/tmp/morphz-subject-input-final-ui.log`。原窗口当前回复已经结束，仅验证等待提醒状态、无下标和菜单入口；没有为验收发送真实消息，不能把隔离处理状态截图称为原窗口实时处理验收。

## 2026-10-01 会话审批与真实默认工作目录

执行设置增加紧凑「审批」行，直接读写 Runtime 已有的询问批准／自动安全评审／完全访问预设；不增加 LLM 请求，不改 Rust 权限或调度机制，不保存另一套用户权限。审批在当前 Session 持续生效，个人全局对话跨项目、命名项目会话独立，影响后续工具操作及进行中工作的后续步骤。自动安全评审仍可能拒绝或交由本人批准；完全访问另有明确风险确认和取消。模型与推理仍只选择下一次输入；补充沿用原工作设置。

本机 Human 才能修改，Agent、团队及 HTTP／远端只读；读取和选择设置不创建 Session、会话或输入。首次未发送草稿及不存在的 Runtime Session 只读安全默认。首建安全初始化使用原传输账本的持久回执：创建之前保存，绑定先核验，继承状态必须初始化及读回成功才能投递；丢回执、409、失败及重启重试不会绕过守门。已有 Session 的实际审批选择不再被每次输入重置。Host 串行、范围／身份重检、指纹前检和写后读回不等于 Runtime 原子 CAS，其他 Runtime 客户端仍有并发限制。

「工作目录」按需展开，默认路径只读来自该 Session 实际有效执行节点，额外目录仍由原授权工具添加／撤销；零个额外授权不再叫没有本机目录权限。控制器常驻、仅打开时读取，无新增轮询；迟到结果按身份代次和范围隔离，失败不乐观授权或自动重写。共享弹层另修复 200% CSS zoom 下 viewport／layout 坐标混用，模型、审批、媒体及关联菜单均保持可达。

后端相关回归 **72／72**（3.4 秒，含新增 23 项）通过，覆盖真实 Host outbox 两次投递保留 auto_review／full_access、初始化失败零 IO 后跨重启安全重试、Principal／Context／共享路由、团队／远端拒绝和真实目录来源。最终 UI **26／26**（25.9 秒，新增权限 11 项及原设置／compact／focus／Dock 15 项）通过，覆盖风险取消／确认、写回失败、跨项目／命名会话／身份迟到守门、草稿、390px、真实 CSS zoom=2、键盘和补充。完整构建及最终 typecheck 通过；日志 `/tmp/morphz-session-permissions-20261001-final-regressions.log`、`/tmp/morphz-composer-session-ui-20261001-final-ui.log`、`final-build.log`、`final-typecheck.log`（后三份同前缀）。保留旧夹具未模拟持久 PATCH 的四项回归失败、首轮 UI 20／26 与第二轮 25／26 的记录；修正夹具及实际 zoom 缺陷后完整重跑，不称首轮或应用全量验收。

原 Morphz 同一应用正常重开载入 Host、末次 Renderer 刷新后截图复看：实际审批仍是询问批准，三个真实预设可见；默认目录为原中心对应 workspace，额外目录仍为空，菜单无模型行灰色高亮或白框。Escape 和输入收起恢复原事项现场，原 Logo 无下标、坐标点击仍打开真实等待活动与 Objective。没有发送消息、批准请求、停止工作、改变真实审批／目录授权或重启 Runtime；审批写回验证限于明确标注的隔离快照和真实 Host 测试。聚焦本地提交，不推送。

## 2026-10-01 移除执行设置自动焦点高亮

按用户截图撤掉模型行自动焦点灰底和鼠标打开时的选择框描边，不新增下划线或替代高亮。打开设置只聚焦弹层本身，主动键盘导航仍保留细中性焦点与正常选择、Escape 返回；目录权限、模型／推理下一次输入语义不变。同时修复系统目录选择器快速失败时按钮尚未重新启用导致无法恢复焦点的渲染时序，不放宽原焦点或权限守门。

五项设置专项重复运行 **10／10**（12.7 秒），包括明暗主题截图、Tab／ShiftTab、选择、长模型窄窗、授权输入冻结、控制器持续挂载、目录取消／失败／撤销失败与草稿保留；随后随 Logo 修复合并 UI 回归 **14／14**（17.1 秒）并完整构建通过。日志为 `/tmp/morphz-composer-highlight-20261001-final-ui.log` 与 `/tmp/morphz-logo-no-badges-20261001-ui.log`。保留此前原生选择键盘模拟及目录焦点时序失败记录，不称首轮全绿或全量验收。

原 Morphz 同一窗口已实际打开执行设置并截图复看：没有模型行灰色高亮或白色选择框，焦点位于弹层；Escape 返回真实入口，输入收缩后恢复原事项现场。没有更改真实模型、审批或目录授权。此 UI 修复独立本地提交，不推送；自动审批和默认目录展示尚未由本条实现。

## 2026-10-01 Logo 动效、真实当前状态与移除全部下标

按最新反馈移除 Logo 的全部右下角状态符号和专属样式，包含工作点、待批准、暂停、等待时钟及未知横线；所有状态只保留原品牌轮廓，具体状态留在提示、可访问名称与右侧信息中。日常增加低频轮廓内流光，悬停／键盘聚焦持续轻回应，实际工作才呼吸并加快流光，系统与本机减少动画仍保持静态。实时对话输出直接复用现有流投影，首个真实增量即显示工作，不等待五秒快照轮询；没有增加请求或改 Runtime 调度。

此前原窗口的「未知」确有 Host 投影缺陷，不是网络状态：历史有界页和来源读取预算影响了当前开放工作判断，计划创建的 root 又不是可读取的原始 Event。修复将开放工作完整性独立于历史截断，先关联当前工作，再用现有 Schedule.source_turn_id 和已验证的 Objective 来源线程追溯原始输入。仍校验真实 Session／Context／人类输入权限，保留原执行 root，不从 ID 前缀猜来源或扩张补充权限；真正读取失败仍不伪报空闲。沿用每 Context 两次调度读取和既有 16 次来源读取预算。

完整构建通过，模型／Host 单测 **28／28**，相关 UI 合并回归 **14／14**（17.1 秒），涵盖六种状态无任何附加下标、原轮廓、真实 PNG 动效差异、首个流增量、减少动画、准确来源、草稿、焦点、导航及 Dock；模型设置五项也在此合并运行，具体修复另记。日志为 `/tmp/morphz-logo-no-badges-20261001-build.log`、`model.log` 与 `ui.log`，均使用同前缀。此前失败和修正保留在 `/tmp/morphz-logo-visible-fix-20261001-*.log`；不是全量验收。

原 Morphz 同一应用正常重启载入 Host 修复后，实际显示「等待后续条件」，右栏能看到一项真实等待提醒及其 Objective。去下标构建后只刷新 Renderer，截图确认 Logo 周围无时钟／横线等下标，坐标鼠标点击仍打开活动的全部工作，品牌轮廓内流光可见。未发送、审批、停止工作、修改目录／审批策略或重启 Runtime，原身份、中心、草稿、事项现场均保持。本阶段聚焦本地提交，不推送。

## 2026-10-01 左侧 Logo 状态与灵动

保持左侧原位置、原 M 形轮廓与四主题品牌色，增加工作／待批准／暂停／等待／未知的微型符号及悬停说明，空闲不挂符号。实际执行中（含对话生成）才有低幅呼吸和轮廓内流光，悬停／键盘聚焦有短暂回应；系统或本机减少动画时保持静态。状态来自现有授权投影，不增加 Runtime 机制、模型请求或人格接口。投递已受理不冒充正在执行，暂停后当前步骤仍在执行时保留工作状态，Objective 暂停不代表整个主体暂停；断线或缺失／截断快照不能冒充空闲。

点击 Logo 只查看右栏：新鲜审批进入授权，否则打开活动的「全部工作」，不沿用旧消息详情或当前项目限定。状态更新不抢分类、导航、输入焦点或草稿；不发送、创建 Session、审批或改权限。紧凑栏原 32px Logo 和 80px 栏宽保持，标记位于轮廓外，不遮住右侧翼面。

完整构建、最终前端构建及 typecheck 通过；Logo／主体状态单测 **13／13**，最终统一界面回归 **16／16**（33.3 秒），涵盖品牌、执行体验、左右伸缩、四分类、Dock，以及新状态／草稿／焦点／减少动画／390px 窄栏测试。保留失败记录：相关回归初轮 **13／14**，原生伸缩用例仍点击已撤掉的旧右栏菜单；只迁移该段为实际四图标分类与键盘切换断言，完整重跑 **14／14**，再与新增 Logo 两项合并得到最终 16 项通过。日志为 `/tmp/morphz-subject-logo-20261001-build.log`、`unit.log`、`verified-ui.log` 与 `final-typecheck.log`，均使用同前缀。不是全量应用验收。

原版 Morphz 同一窗口仅刷新 Renderer，截图确认原 Logo 轮廓完整、未知符号独立且无伪工作动画；真实坐标鼠标点击 Logo，右栏活动和「全部工作」打开。工作／待批准／暂停截图由隔离组件状态夹具生成并复看，不能称为原窗口真实执行／审批验收。没有发送、批准、停止工作、改权限或重启 Runtime。本阶段独立本地提交，不推送。

## 2026-10-01 移除活动顶部完整性说明

按用户截图反馈移除活动页顶部「概览尚不完整」及其展开说明和专属样式，不添加替代横幅、不改列表或 Runtime 数据。保留真实断线／读取失败反馈、截断数据下的未知／至少状态守门，以及目标组件原有的独立提示；不把近期历史称为完整，也不因移除提示就报告空闲。

完整构建（含 typecheck）通过；主体／执行相关浏览器回归 **7／7** 通过（10.3 秒），覆盖线程截断与仅目标截断均不恢复该块、真实线程状态保留、断线不冒充空闲、审批准确来源、旧图钉偏好退役、草稿及 Dock 保留。日志为 `/tmp/morphz-remove-activity-notice-20261001-build.log` 与 `/tmp/morphz-remove-activity-notice-20261001-ui.log`。原版 Morphz 同一窗口只刷新 Renderer，再展开侧栏截图确认该块消失、活动列表上移；未发送、审批、停止工作、改权限或重启 Runtime。独立本地提交，不推送；不是全量验收。

## 2026-10-01 移除信息侧栏图钉

按用户「没用可以去掉」移除 Morphz 信息侧栏及旧独立活动面板的固定按钮；该固定原用于锁定执行范围，不是任务优先级或窗口置顶。退休 `executionPinned` 的全部生产读写，旧本机记录即使为 true 也不自动打开活动栏、不阻止工作现场切换清除具体执行选择。记住的信息分类、显隐恢复、伸缩、审批及准确执行来源保留；输入框固定、Dock 固定不变。未改 Runtime，不删除偏好记录或业务数据。

完整构建（含 typecheck）通过；主体／执行／交流伸缩相关浏览器回归 **14／14** 通过（16.3 秒），覆盖旧 true 刷新不冒出活动栏、设定分类和宽度恢复、输入与 Dock 固定偏好保留、具体线程切换现场不残留、未发送草稿恢复、四分类与宿主开关不重叠、320／390／1440 宽度和 200% 审批。日志为 `/tmp/morphz-sidebar-pin-removal-20261001-build.log` 与 `/tmp/morphz-sidebar-pin-removal-20261001-ui.log`。不是应用全量验收。

原版 Morphz 同一窗口刷新后截图确认顶部只有四分类与宿主显隐，图钉已移除，真实活动列表仍可见。核对期间用户自行展开了侧栏，未抢占其导航或草稿；没有发送消息、审批、停止工作、改权限或重启 Runtime。此删减独立本地提交，不推送。

## 2026-10-01 执行设置弹层修正

按实际截图反馈，将快捷执行设置改为模型／推理／目录权限三行，移除重复标题、满宽表单及粗青色外圈，保留细中性键盘焦点。默认模型显示真实短名，完整来源仍在目录及提示内；下一次发送的影响范围只说明一次。目录详情按需展开，真实路径、添加、逐条撤销及当前对话／持续权限／撤销影响／不含执行命令与删除的边界仍可见。权限控制器不随菜单或详情收起卸载，不清空现有授权；补充依然沿用原工作设置。未改 Runtime、权限接口、应用 Dock、导航或单底栏布局。

原版 Morphz 同一窗口刷新后，已实际截图复看三行与目录展开状态；坐标鼠标打开系统选择器并取消，仍为未授权、焦点回到添加入口。原窗口 Tab 可依次进入模型、推理与目录说明，Enter 展开、Escape 回到执行设置。不发送消息、不创建会话、不增加或撤销用户授权；目录失败和实际授权载荷由隔离测试核验，不将它们冒称为原窗口授权验收。

完整构建、最终前端构建与 typecheck 通过；模型摘要／推理持久化单测 **5／5**，最终相关 UI 专项统一重跑 **28／28**（31.1 秒）。覆盖 390×540 长模型、首屏三行高度、目录控制器持续挂载、真实 Host 的模型／推理／目录授权输入冻结、撤销后历史不变、选择器取消和失败守门，以及原单底栏／Dock／设置／焦点回归。隔离测试的模型目录与连接状态为受控呈现，实际输入止于持久排队，不冒充模型执行成功。

验证过程中保留失败记录：旧设置回归初轮 **13／16**，三项仍检查已撤掉的独立设置按钮，改为检查实际个人入口后重验；新增专项首轮 **0／4**，夹具缺少 Runtime 连接投影；修正后 **3／4**，真实发送因夹具未绑定本机目录校验节点而被正确拒绝。最终仅将隔离夹具的同一 LocalFiles 接入现有 Runtime 授权边界，未解除生产校验或改变断言，再统一重跑通过。证据日志为 `/tmp/morphz-settings-popover-20261001-*-tests*.log`、`build.log`、`typecheck.log`；不宣称全量应用验收。

## 2026-10-01 三块 UI 首轮落地与验收

用户授权统一实现线程式活动记录、单底栏输入与独立应用 Dock、Morphz 信息侧栏图标切换，并追加 Objective 的活动内分层展示试用。实施基线见 UI 规范「三块 UI 统一实施目标」。按阶段验证并聚焦本地提交，保留无关修改和原应用数据；不推送、不改 Runtime 调度，不新增命名请求。当前单次沙盒权限接口尚不存在，权限 UI 只能呈现已有真实能力，不能用目录授权冒充执行沙盒。

第一阶段已接通 Runtime 有界历史及持久 root 来源投影：线程保留真实 intent、终态和 Objective supervision；未知来源不猜项目，同一共享 Session 仍逐 root 校验授权。没有修改核心调度、建立活动台账或增加模型请求。第二阶段把输入改为正文加单底栏，媒体进入加号菜单，模型／推理／真实目录授权合并为执行设置。

第三阶段已接入右侧 Morphz 信息的活动／授权／安排／设定四个图标页，以及独立应用 Dock。Dock 与工作台复用同一授权应用目录；固定只写现有本机偏好，打开应用不发消息、不创建 Session、不停止执行。各工作现场草稿继续独立保存恢复，不自动把附件和授权搬到新现场。Objective 位于活动列表前，仅呈现已有目标、真实状态原因及其 supervision 关联执行；没有第五个页签，也不把输入自动包装成目标。

最终完整构建及 typecheck 通过，线程投影、活动分组、主体状态、实际安排、应用目录和输入摘要 **28／28** focused 单测通过。右侧四分类直接进入已有顶栏，与固定及宿主开关同排，不再给名字和模糊状态独占两行；原 Runtime 概览仍不完整，只保留一处可展开说明，实际状态含义留在对应图标提示和可访问名称中，不宣称空闲或完整历史。Objective 点击复用准确的执行来源，保留对象与 input 身份；安排读取失败不变成空目录。

左栏底部「更多」已并入个人菜单，删除独立省略号和重复齿轮；搜索、外观、通知、设置及真实账号能力保留。搜索／通知／设置在跨手机宽度关闭后回到可见的等价个人入口。Launcher 按后续反馈改为图标网格，使用真实目录与 AppIcon，图标上、名称下，按目录数与窗口减少列数；固定按悬停／键盘显露，管理仍进入工作台。应用 Dock 恢复原先独立 32px 小按钮、既有底色与细内描边，撤掉本轮新加的整排胶囊背景／外框／阴影。

相关浏览器回归分组验收：主体／执行／Dock **9／9**、真实事项安排 **5／5**、个人菜单与现有设置 **15／15**；Launcher 新网格及旧悬浮样式 **3／3** 重验；最终输入／伸缩／附件／Dock 边界 **23／23**（26.7 秒）。这些是相关专项，部分用例重验，不能相加当成独立用例总数，更不是全量应用或模型验收。最终输入回归之前曾 **22 通过／1 失败**：旧测试直接点击按新约定隐藏的固定按钮；迁移为真实悬停后点击，保留持久固定偏好断言，再完整重跑通过。另实际复现 390×540 长稿附件挤入正文首行，已修正预览与写入区伸缩，并新增完整发送边界和预览／正文不重叠断言。

原版 `/Users/shafreeck/Applications/Morphz.app` 已正常重启过一次并按阶段刷新，同一数据目录／profile。实际截图与坐标鼠标确认个人菜单四项、顶部授权分类无窗口拖动区遮挡、恢复的独立悬浮按钮和新 Launcher 网格；Escape 回到真实触发器，外部点击恢复原收起态。未发消息、批准请求、增加目录权限、创建 Session 或停止用户工作。原 Runtime 没有本次可见的已授权 Objective 样本，非空目标展示由隔离真实组件／授权传输测试验证，不冒称原窗口已有目标验收。

能力边界仍在：事项安排当前只覆盖经过真实 Runtime record 确认的 Platform 事项安排，不冒充全量 Runtime 提醒目录；设定只提供实际名字／默认模型与现有模型账号、连接入口，不伪造人格编辑接口。单次输入沙盒、视频附件、完整主体档案与 Logo 状态试用均不能因此描述为已完成。

## 2026-10-01 整体 UI 与应用 Dock 设计确认（仅文档，待实施）

用户确认左侧整体导航、中间应用／内容、右侧 Morphz 主体信息，底部 Agent-first 输入与应用快捷 Dock 的职责分工。工作台仍是完整应用浏览、安装、设置和管理入口，也保留继续工作；Dock／应用选择器只是同一授权目录与固定偏好的快捷访问。底部采用共享交互区显隐，内部操作保持、离开且未固定时收起、固定保持、后台输出不自动展开；应用快捷、输入工具和交流控制分组，切应用不发送、不启动任务、不创建 Session、不停止原执行，保留各自草稿与工作现场。

已写入 [UI 设计规范](./16-ui-design-standard.md)，并同步 [应用宿主约定](./15-cognitive-application-host.md) 与 `application/AGENTS.md`，修正旧工具 Dock、默认当前理解和混合右栏的目标指引。本次只有文档修改：没有改 UI／Runtime／存储，没有构建、刷新或重启原应用，也没有 UI 验收。当前仍使用撤回试验后的左侧 Logo 与既有工具 Dock／检查器；角色活动记录重设计暂缓，新主体右栏、应用 Dock 和完整应用管理体验不得描述为已经落地。

## 2026-10-01 撤回主体入口试验

用户否决主体入口的两轮界面试验，要求恢复 Logo 在左侧栏的版本。仅撤回主体菜单、顶栏身份占位、隐藏对话标题和相关专用代码；恢复左侧 wordmark、原页面导航及执行记录／审批入口。保留此前的主题、导航图形、侧栏伸缩、回复引用、即时发送与流式体验改动。执行概览针对不完整／断线快照的真实状态修正保留，不恢复误报空闲。以下试用与验收内容均是历史记录，不代表当前启用设计。

本次正式构建通过：`/tmp/morphz-left-logo-rollback-20261001-build.log`。即时发送与侧栏模型单测 **7／7** 通过；回退界面专项 **29／29** 通过，日志分别为同前缀的 `unit.log`／`ui.log`。补充导航／检查器首轮 **11项：9通过、2失败**，失败是用例直接查找启动台，却恢复了前序用例保存的浏览器；修正两项测试的初始返回工作空间步骤、保留全部后续断言后，二项 **2／2** 重跑通过，证据为 `navigation.log` 与 `navigation-final.log`。不将分轮结果描述为首轮全绿。

原版 `/Users/shafreeck/Applications/Morphz.app` 同一窗口只刷新 Renderer；实际截图确认左侧 Logo、原工作台工具栏与对话标题恢复，并用截图坐标验证右栏开关、内容菜单及菜单外导航。原身份、中心、暗色主题、360px展开侧栏、默认 sol 和空输入保持；未发送消息、取消工作或重启 Runtime。已移除四份仅主体试验使用的新增源码／测试，不删除业务数据。该已完成 UI 阶段作为独立本地提交，不夹带网站或剧本 Harness 修复，也不推送。

## 2026-10-01 Morphz 主体入口体验试用

按用户「可以试试」的授权完成有限界面试用，未将其当作完整档案产品定案。侧栏撤下品牌标题，保留五个工作导航、更多工具和 Human 身份；Morphz 品牌图形作为同一主体的初始头像，名字读取现有 actant。宽对话画布使用原顶栏中央的头像与名字；工作页、认知应用及小窗收为右侧紧凑头像，不增加顶栏行或侵占原页面工具。主体是稳定单一组件，右栏开关不重新挂载入口或丢失焦点。居中浮层跟随主体中心，其他原菜单的右对齐保持。

点击主体只打开身份／状态小面板，「工作状态」「活动记录」复用原执行检查器的全部工作和已加载近期记录。没有新增首页、Session、身份数据库、多个 Bot、自定义头像、完整跨 Session 历史接口或 Runtime 机制。原消息详情、审批及分支停止保留精确来源；查看主体不改变导航中的执行权威、输入范围、草稿或消息。选中项目显示打开文件夹，单独展开其会话列表不误标为当前项目。

状态按授权活动、投递与审批快照呈现并去重，不以当前页面的消息数代表 Morphz。断线不显示缓存任务数；快照不完整时使用「至少」或待核对。原窗口真实发现 `activity.truncated=true` 时旧执行面板仍称「0 项进行中／当前没有工作」，已一并修正为「工作状态待核对／尚不能确认是否有工作进行中」；没有为了改善显示而改写 Runtime 数据或假定空闲。活动记录只展示已经加载的真实记录，不能称为完整活动历史。

正式构建成功：`/tmp/morphz-subject-profile-20261001-build.log`；五项状态模型单测 **5／5通过、0失败／跳过**：`/tmp/morphz-subject-profile-20261001-unit.log`。最终相关界面回归 **49／49通过、0失败／跳过，1.4分钟，退出0**：`/tmp/morphz-subject-profile-verified-20261001-ui.log`，trace目录 `/tmp/morphz-subject-profile-verified-20261001`。覆盖五页面与390／760／1024／1440宽度、四主题明暗品牌、菜单中心与命中、原输入／Session／草稿保持、未加载原输入的已授权活动、截断／断线／完整快照、浏览器交流层、真实隔离 Electron、左右侧栏、即时发送及原对象流程；这是相关专项，不是应用全量回归。

此前扩大回归 **48项：46通过、2失败**，证据仍保留于 `/tmp/morphz-subject-profile-complete-20261001-ui.log`。两条旧项目用例仍要求发送失败后消息／附件留在输入框，与已确认的即时发送行为不符；现在断言失败气泡以原ID重试，权威历史已确认时不再伪造失败。保留确切命令载荷、幂等、原草稿与会话范围断言；丢回执场景另直接重复原真实Host命令，验证只存一次。专项8／8通过后已纳入上述49项完整重跑，没有把分轮结果合写成首轮全绿。

真实验收使用原版 `/Users/shafreeck/Applications/Morphz.app` 的同一 profile／中心，只刷新 Renderer。按截图坐标实际打开居中及紧凑主体菜单、进入全部工作与展开近期记录、关闭／恢复右栏、打开右栏内容菜单并在外部直接聚焦原输入、使用相邻工作空间菜单；再进入工作台核对工具未被头像挤占，菜单外点击直接返回原对话。最终为原80px图标栏、原对话、空输入及默认 `gpt-6.1-sol`，没有发送新请求、取消工作、修改主题／宽度偏好或重启 Runtime。当前真实快照仍不完整，界面明确待核对；完整状态读取与活动档案不因这次只读试用被宣称已完成。

## 2026-10-01 图标栏底部更多与身份重叠修复

用户截图中的三点与身份头像确实互相侵入。根因是 `.compact-sidebar-controls` 的 `flex: 0` 加 `min-height: 0` 让容器只保留8px内边距，40px工具按钮溢出到后面的身份区域；不是SVG路径重叠。改为 `flex: none`，按实际内容高度占位且不被压缩，原按钮、图标和菜单保留，导航区仍承担小窗滚动。

新增四项真实布局回归覆盖亮暗、760×540与1440×960，核对整个控件至少8px间距、容器包住按钮、SVG分离和中心鼠标命中，随后实际打开更多并Escape返回；身份按实际Host能力为按钮或信息分组。旧CSS专项已真实失败，日志 `/tmp/morphz-compact-footer-before-20261001.log`，trace保留在 `/tmp/morphz-compact-footer-before-20261001`，不以仅尺寸或可见性断言代替重叠复现。

修复后的正式构建 `/tmp/morphz-navigation-icons-footer-20261001-build.log` 成功。原版同一窗口只刷新Renderer，实际截图确认两图形分离；按最新截图坐标点击三点打开搜索／外观／通知／设置，Escape回到更多按钮，仍为80px图标栏、原事项页面及原数据。未重启Runtime、改偏好、发送请求或退出身份。

最终相关回归 **31／31通过，0失败／跳过，56.7秒，退出0**，日志 `/tmp/morphz-navigation-icons-final-20261001-ui.log`，失败trace输出目录 `/tmp/morphz-navigation-icons-final-20261001`。包含四项底部几何／命中、新导航图形明暗／展开收缩、左右拖动、隔离真实Electron、整体布局／身份以及全部十项选文引用。

## 2026-10-01 核心导航图形与内容库名称替换

按用户确认，将原五个导航按钮的图形替换为同一24px网格的自定义线稿：交流气泡、事项清单、内容卡片、工作台B三卡、项目A文件夹。全局目录显示名改为「内容库」，全局工作空间入口为「查看内容库」；项目内容、Objects应用页签及专业内容名称不改。按钮、路由、导航顺序、17／24尺寸、点击区、主题色和布局保持，未更改业务存储或Runtime。项目的其他图形只在设计稿待选，不放入生产组件。

正式构建成功，日志 `/tmp/morphz-navigation-icons-20261001-build.log`。原版 `/Users/shafreeck/Applications/Morphz.app` 只刷新同一窗口加载产物，实际可访问性状态和截图确认名称及五个新图形；依次打开内容库、工作台、项目，均进入原页面及原有内容。刷新时原335px展开宽度、两条事项、连接和应用保持；收尾只返回原事项页面，最新实际截图为80px图标栏，五个新图形可见，没有主动改写宽度偏好。未发送请求或重启Runtime。

首轮相关回归 **77项：75通过、2失败**，日志 `/tmp/morphz-navigation-icons-20261001-ui.log`；两项失败是先前乐观发送已将引用转入失败消息卡片，而旧用例仍要求引用留在输入框。仅改这两项测试为从同一消息卡片重试，严格深比完整请求、同命令ID、仅一次存储，保留仅引用发送、跨刷新恢复和新草稿不被重试改变；未改发送产品代码。修正后与底部修复联合的31项全部通过，见上节，不将分轮结果写成一次完整77项全绿。

## 2026-10-01 窄栏图标比例与原生红绿灯间距修正

原窄栏仍沿用展开导航的 17×17 SVG 和 23×25 品牌标记，导致只有图标时视觉过小。五个原导航现使用 24×24 SVG、至少 44px 高的点击区，品牌标记 32×32，居中轴线一致；底部更多保留 20px 次级图标。展开态与手机尺寸不变。此次尺寸修正时，图标仍为 Lucide React 的 `MessageCircle / Inbox / Library / PanelsTopLeft / Layers2`；品牌标记为 Morphz 专用 SVG，非系统图标。这次尺寸修正没有重画五个导航图形或更换图标库；随后确认并替换的核心图形见上节。图标库／产品定制的分工与官方参考已写入 UI 规范。

原 Mac 原生按钮左边距 20 逻辑像素，第三颗按钮与 72 CSS px 窄栏分界相碰。现原生坐标为 `(8,16)`，窄栏宽 80 CSS px，拖动命中从分界左侧 4px 开始；展开范围 200–360、160 收缩阈值及原宽度偏好保持。顶部仍避让不随页面缩放的原生控件。本节的新尺寸覆盖下节早先 72px／横坐标20的记录，不改写已取得的历史验收证据。

两次正式构建通过：`/tmp/morphz-native-traffic-spacing-20261001-build.log`、`/tmp/morphz-compact-icon-scale-20261001-build.log`。定位模型单测 **4／4**（`/tmp/morphz-native-traffic-spacing-20261001-unit.log`）；最终相关界面回归 **35／35、0失败／跳过，1.1分钟**（`/tmp/morphz-compact-icon-scale-20261001-ui.log`），包含窄栏24px／Logo32px与居中、展开原尺寸、五入口／菜单、草稿、取消手势、刷新、隔离实际 Electron 1×／2×、原生坐标与保守安全包络。68px 按钮右缘是测试设计包络，不冒充原窗口 OS 按钮像素测量。

原版 `/Users/shafreeck/Applications/Morphz.app` 正常退出并重开后，实际截图确认三颗按钮整体左移、绿按钮与分界不再重叠。按原窗口截图坐标实际验收右栏开／关、右栏内容菜单、菜单外点击聚焦输入、相邻工作空间菜单及窄栏隐藏／恢复；恢复后仍为80px、五个原入口。随后刷新同一窗口加载放大图标，实际可见新比例；对话、空输入、默认sol和连接保持，未发送新请求、取消工作、重启Runtime或改变业务存储。

## 2026-10-01 侧栏伸缩与极简导航、回复来源视觉

左侧栏可拖动调宽，展开 200–360 CSS px，低于160切为72图标栏；保留上次展开宽度，拖动帧只更新布局，松手保存本机视图偏好。Escape、失焦、指针取消恢复原状，视口暂时变窄不改写首选宽度，手机保持原顶部导航。图标栏复用原五个导航按钮（对话、事项、内容、工作台、项目），搜索、外观、通知、设置收入底部更多；项目仍走原目录，不复制导航数据或添加常驻文件夹列表。展开侧栏不改变原操作。

已修复“图标栏隐藏后恢复按钮被原生红绿灯覆盖”：隐藏时移除当前呈现态 `sidebar-compact`，但保留宽度偏好。左右拖动界面改为连续 1px 中性细线；焦点、悬停、拖动不再出现主题色粗矩形。Mac 原生红绿灯纵坐标从20调整为16逻辑像素，横坐标保持20。亮色Logo使用同色相的明亮填色，暗色和单色保持原样；没有修改Dock图标。

跨输入／迟到回复去掉“关于”和箭头，使用可点击的原消息单行短引文；按确切输入ID打开原消息执行记录，发布时间顺序、连续回复合并规则、草稿及流式状态保持。最新生产构建成功：`/tmp/morphz-compact-sidebar-refinement-20261001-build.log`；布局模型单测3／3通过。最终集中界面回归 **35／35通过，0失败、0跳过，1.2分钟，退出0**：`/tmp/morphz-compact-sidebar-refinement-final-ui-20261001.log`。覆盖原五导航、新建和选择项目、更多各入口及焦点、草稿／消息不变、连续拖动／取消／刷新、小窗／手机、八主题左右细线、原生Electron 1×／2×隐藏恢复、安全区、Logo、来源ID／窄窗截断、气泡／停止／流式等待。

真实验收使用原版 `/Users/shafreeck/Applications/Morphz.app`，已加载最新构建，原对话及默认sol、身份和连接保持。原生截图确认亮色Logo与无箭头短引文；按截图坐标实际操作了右栏开关、内容菜单、菜单外点击聚焦输入、相邻工作空间菜单，以及图标栏隐藏／恢复；恢复后仍是72宽、五个原入口，更多内只有四项。原版自动拖动动作未产生宽度变化，不把它记作原生拖动通过；连续鼠标拖动由隔离的实际Electron／浏览器回归覆盖，原窗口图标切换另通过键盘验收。首次集中跑测曾因复制隐藏导航导致三个strict定位失败，已消除重复导航DOM并保留原测试断言，最终35项完整重跑通过；此前失败日志和trace保留。

## 2026-10-01 最终合并验收

本轮存储切换目标已完成：正式 UI／Agent 使用唯一写入权威，退役业务写处理器、旧测试依赖和服务端旧编译文件已清理，最终生产构建成功。冻结源码后的界面回归分两轮完成 **362＋2 项全部通过、无跳过**；最终原版已正常重启，原件、完整未保存草稿、阅读标注和附件经实际窗口及只读摘要核验保留。最终构建 `/tmp/morphz-server-build-prune-final-build-20261001.log` 成功，新增构建收尾六项安全测试后的实际 PostgreSQL 全量单测 **945 项：942 通过、0 失败、3 项仅 S3 专用跳过**，日志 `/tmp/morphz-server-build-prune-final-full-unit-20261001.log`。此前清理后的 939／936 和清理前 941／938 日志保留；数量变化来自退役用例改为现行领域契约以及新增六项构建安全测试，具体覆盖见下。未经验证的 S3 服务、Mobile GUI、第三方托管及新的跨节点 Store 不纳入本轮已完成能力。

最新界面回归发现并实际复现了改色后的选中标注丢失：原用例三次重复为一过两败，原 30 秒等待和断言未改变。根因是刷新／窄窗重排后用旧像素坐标重新命中，而非持久 mark 被删除。修复只冻结首次点击字形的精确原文位置，在完整当前授权页返回后核对重叠标注；不缓存旧权限、不扩大到整章。新增真实 HTTP 延迟、640 宽最新页消费、新批注重叠，以及段间空白／重复字／emoji 精确位置断言。最终 Reader **21／21**、受影响原 50 项加新 2 项 **52／52**，日志 `/tmp/morphz-reader-mark-repro.34zt2B/final-freeze-reader-suite.log`、`final-freeze-affected-suite.log`；旧失败 trace 和先失败后修复证据保留在同目录。

最后完整 GUI 首轮 **363 通过／1 失败，0 跳过，16.2 分钟**，原日志 `/tmp/morphz-storage-final-complete-ui-20261001.log` 和全部 trace 保留。唯一失败是 `document-late-read-platform.spec.ts` 的按 URL 门闩把卡片可见预览与显式打开混计；旧成功 trace 也有两次同 URL 读取，只是第二次在断言后到达。该用例要验证的是显式打开后的撤权，不是请求合并。现仅在第一次目录挂载前设置正常、真实身份作用域的列表偏好，新增打开前读取为零、列表可见且无卡片预览的前提；原 count=1、撤权 404、两次成功 200、同 CSRF 和允许项目草稿断言均不变，没有产品 hook 或生产／UI 修改。真实重复 **5／5 通过**，日志 `/tmp/morphz-document-late-read-list-fixture-20261001.log`。随后同一生产构建的完整重跑取得 **364 项：362 通过／2 失败，0 跳过，16.1 分钟**，日志 `/tmp/morphz-storage-final-complete-ui-after-fixture-20261001.log`、全部 364 个 trace 位于 `/tmp/morphz-storage-final-complete-ui-after-fixture-traces.HpD313`。文档、Reader 及原生侧栏通过；网页交流与截图两项均在原 5 秒 `BrowserWindow.isFocused()` 前提前失败，未进入对应功能步骤，源码和断言未改。上海 04:20:33 和 04:45:42 的独立只读系统状态均为锁屏；旧成功 trace 初始 focused=true，新失败 focused=false 且没有 focus 事件。这是待解锁复验的原生环境门槛，不把本轮记为全绿或据此声称产品故障已修复。

最终源码审计另发现 `core/model.ts` 的 `applyCommand`、`script-studio-commands.ts` 和 `reader-commands.ts` 已无正式消费者，仍只被旧单测／DTO 夹具引用。这三套退役写处理器及其专用的内容整理、项目管理、收藏身份／Inbox 处理分支已删除，不迁到测试目录另留一份实现。当前 `Workspace`／schema 仍是正式 Client 的展示 DTO，展示读取、当前事项顺序、应用定位和格式契约保留，UI 不重设计。核心七项业务契约改走实际 Host、Platform／Objects 私库，包含冷重开、原件版本、CAS、历史批注、Human／Agent 授权、持久事项顺序、关联及未投递输入；与收藏冷迁入专项和接口缺席断言共 **12／12 通过**，日志 `/tmp/morphz-retired-reducer-core-bookmark-final-20261001.log`。未消费的旧网站迁入夹具已删；收藏历史输入直接声明旧格式样本，不为构造样本保留旧业务处理器。

十份纯视图回归改用明确的 DTO 样本，仅声明项目、原件、输入和关联，不实现授权、CAS、命令、回执或持久化。原 **46 项／369 个断言**保留，真实执行 **46／46 通过**，日志 `/tmp/morphz-view-model-dto-cleanup-unit-20261001.log`。剧本旧处理器的 20 项改为八组 SQLite／实际 PostgreSQL 领域回归和一项参数 schema，共 **17／17 通过**；与既有剧本领域测试联合 **121／121 通过、0 跳过**，日志 `/tmp/morphz-script-domain-scoped-owned-oid-final-20261001.log`。新测试直接调用正式领域服务，固定真实授权来源、原件及 workflow 修订，核对权限、创作代际、候选范围、迟到意见、阻断问题、历史和冷重开；清理仅删除本测试成功创建且再次核对同一 OID 的 PostgreSQL schema。

测试迁移不复活已停用契约：旧 Workspace 字段兼容、漏依赖／重复引用必须拒绝、变化后先保存 stale 候选、累加整份原作的 prepare 预算退出退役处理器测试。正式实现及其有效断言保持：依赖自动闭包／去重，已有候选过期后不可采纳但可拒绝，迟到提交拒绝；Host 的有界生成 packet、确切原作／引文授权分页继续测试。有效 CAS、历史恢复、人工许可／采纳、撤权、跨集影响和正式导出由当前领域联合测试验证，不为保持旧标题数保留另一份实现。

最终产物核对发现 TypeScript 编译不会自动删除已删除源码的旧 `.js`／声明／map。构建现于服务端编译成功后定向清理没有对应 `.ts`／`.tsx` 源码的输出，跳过未知扩展和符号链接，删除前重查实际目录与文件；不清空目录，不处理 `dist/web`。六项临时目录安全回归通过。最终构建实际移除 **38 个退役模块的 114 个编译文件**，无符号链接跳过；再次执行删除数为 0。正式五个入口的 121 个可达编译模块全部仍在，114 个旧文件全部不在，前后构建的 Web 哈希资源文件名一致。日志 `/tmp/morphz-server-build-prune-final-build-20261001.log`、核对 `/tmp/morphz-server-build-prune-final-output-verification-20261001.json`。仅删除可追溯的旧构建输出，未触及用户数据库、原件、草稿或界面源文件；脚本在正常受信构建目录使用，不声称能原子抵御恶意路径竞态。

源码冻结后的当前 GUI 重跑取得 **362／362 通过、0 失败、0 跳过，15.9 分钟**，进程实际退出 0；日志 `/tmp/morphz-retired-reducer-final-ui-362-20261001.log`，全部 362 个 trace 位于 `/private/tmp/morphz-retired-reducer-final-ui-362-traces.IhVZYk`。`--list` 的 364 与 362 差集严格只有 `browser-composer.spec.ts:62` 和 `capture-window.spec.ts:42` 两项原生焦点用例，不是用宽泛过滤跳过其他测试。解锁后，这两项保持原配置、1440×960 窗口、5 秒焦点断言及后续完整断言，实际 **2／2 通过、0 失败、0 跳过，12.8 秒，退出 0**；日志 `/tmp/morphz-retired-reducer-final-ui-native-2-20261001.log`，trace 位于 `/private/tmp/morphz-retired-reducer-final-ui-native-2-traces.eZyFoE`。两轮共同覆盖当前全部 364 项，不能说成一次完整 364 项重跑。正常沙箱首跑因 macOS MachPort 权限未能创建 Electron 窗口，原日志保留为同前缀的 `sandbox-denied`；之后同配置、尺寸、超时和断言的受权运行才取得上述终态。

最终原版正常退出后，同一 `ai.morphz.desktop`、原 profile 和中心于上海 **10:04:15** 重启为 PID **32756**，此前 PID 78215 已退出，Runtime PID 2195 未重启。实际原窗口中，对话历史与连接正常、下一输入默认显示 `gpt-6.1-sol`；原 125,332 字节附件打开后实际解码显示；「TEST 剧本分页验收 0930」仍为 v2，编辑器完整保留原本机未提交草稿及末尾“不能写成正文 v3”，未保存；「TEST 文档持久化 0930」仍显示原 v2 正文，原书签、高亮、批注共三条存在，实际坐标点击原文高亮显示改色、取消高亮、编辑及删除批注。只查看、不修改、不重发或取消原输入，最后恢复对话、连接和空输入框。

重启前后以只读方式核验六库完整性和外键，所有 schema 不变；三个 Store 的身份、版本、回执、配额及物理字节摘要完全相同，Host 投递、Browser、Objects、Script 和 Reader 全表摘要不变。仅 Platform 的八条 `app_view_instances` 导航状态和两条对应新导航命令回执变化，不是专业原件被改写。证据 `/tmp/morphz-final-original-before-restart-20261001.jsonl`、`/tmp/morphz-final-original-after-restart-20261001.jsonl`、`/tmp/morphz-final-original-restart-comparison-20261001.jsonl`、`/tmp/morphz-final-original-restart-domain-preservation-20261001.jsonl`。原短剧输入仍为 failed，提醒输入为 completed，原中心 queued／sending／running 投递计数为 0；精确输入／root、未请求取消及只读终态见 `/tmp/morphz-original-user-input-terminal-final-audit-20261001.jsonl`，没有重放原请求或重复创建提醒。

源码清理后实际 Runtime 联合复验 `/tmp/morphz-runtime-ipc-retired-reducer-final-20261001.log` 已退出 0；最终构建并移除旧输出后，`/tmp/morphz-runtime-ipc-final-pruned-build-20261001.log` 再次退出 0：阅读原件与不可变选文进入 Platform 输入，通过 Unix 工具回调写 Objects 原件并形成确切目录交付回执；Host 重开保持原件，同命令不重放合成模型。没有旧 workspace 业务表或应用 TCP 监听。它仍是 SQLite 内嵌 Host 与真实 Runtime，不扩称 PostgreSQL IPC 或真实模型质量。

| 验收范围             | 当前权威证据与口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原版 Store 升级      | 三个原 Store 精确 1→2，逻辑 ID、物理根绑定、原创建时间、六张业务表摘要、版本、回执及配额不变；原消息附件实际 125,332 字节 SHA-256 不变。`/tmp/morphz-original-store-v2-upgrade-20261001.jsonl`。无调用的 Workspace 迁移文件已删除，当前 Store 公共 API／SQL／备份没有节点字段。                                                                                                                                                                                                                                                                               |
| 原版冷备份／独立恢复 | 正常退出后六库无写入者，现有 CLI 生成 `center-2026-09-30T19-43-42-500Z-f3cd42e0`，恢复到 `/private/tmp/morphz-store-v2-original-restore-vmmavW/restored-center`；121 张表／2,204 行的完整 schema 和全部行摘要、应用实例绑定、三个 Store 的业务版本与原非空附件一致。恢复目录是新物理根，不复用旧绑定。日志 `/tmp/morphz-original-store-v2-cold-backup-20261001.log`、`/tmp/morphz-original-store-v2-restoration-20261001.log`、`/tmp/morphz-original-store-v2-restoration-consistency-20261001.jsonl`。不含 Runtime、客户端草稿、第三方私库或 UI 包非空恢复。 |
| 原版最终构建重开     | 同一 `ai.morphz.desktop`／profile／中心于上海 10:04:15 正常重开为 PID 32756；原 Runtime PID 2195 未重启。实际窗口保持原对话、连接和默认 sol，原附件实际解码可预览；剧本 v2 和未提交草稿全文保留，Reader 的原书签／高亮／批注存在，原文坐标点击显示改色、取消高亮和编辑／删除批注。前后只读核验原件库及三个 Store 摘要不变。只查看、不保存、不重发／取消用户输入，结束恢复原对话和空输入；客户端草稿保留不冒充中心备份包含草稿。                                                                                                                               |
| Runtime 独立恢复     | 实际 SQLite 原生备份、PG `pg_dump`／`pg_restore` 到新 inode／新 schema OID；73 表／132 行、65 表／159 行，SQL 及序列、7 个文件字节／长度／权限摘要全部相等。恢复后未来 Schedule 原状态、跨身份 403、严格消息引用／附件／跨 Host／幂等断言仍通过，模型调用 3→3，未重放。日志 `/tmp/morphz-runtime-backup-sqlite-final-20261001.log`、`/tmp/morphz-runtime-backup-pg-final-20261001.log`；归档和 manifest 目录见日志。                                                                                                                                          |
| 执行节点请求基线     | 既有 Runtime HTTP → Job → 双 Edge Worker →显式 Transfer 的实际 64KiB 字节，各后端 2 次预热加 20 正式样本；摘要／回执／Target 固定验证，重试不新增物理写入。日志 `/tmp/morphz-node-request-performance-isolation-final-20261001.jsonl`；不使用新的 Store／文件索引／扫描。仅 loopback、串行、温缓存和 Transfer 子集，不能推定广域网、吞吐、read/list 或批准 SLO。                                                                                                                                                                                              |

原生 Runtime 恢复是路径保持式离线验证：绝对附件路径保持，来源 schema 经 OID 保护隔离后恢复到新的 schema 实体；没有任意迁址、在线跨库快照、OS keyring 或第三方文件备份承诺。此次 fixture 的 Node／Job／Approval 行为空；这些非空生命周期由既有执行节点／状态专项证明，不能冒称备份样本也覆盖。真实执行节点双后端证据使用同机两个 Worker，不代表两台实体电脑或 Mobile 产品。

独立中心还原耗时另按真实原版冷备份补测，不能用 Host 重开计时代替。生产 `restore:center` 连续五次恢复至全新临时目录；每次之后额外核对六库 121 表／2,204 行完整 schema／行摘要、应用实例、三个 Store 版本／回执和原 125,332 字节附件 SHA，并清理本次生成的恢复目录。SQLite 库文件共 54,501,376 字节；CLI 过程（含进程启动与内部恢复校验）p50／p95 **430.443／681.104ms**，外部完整摘要审计另计、不混入该时间。最终退出 0、五次无失败，备份原包的文件清单、manifest 和各文件摘要未变，日志 `/tmp/morphz-center-independent-restore-timing-20261001.jsonl`。同归档此前已恢复过，未清 OS 缓存，同时有其他回归负载；n=5 的 nearest-rank p95 为最大值，不是生产尾分布、PG 恢复、Runtime 恢复或批准 SLO。首次验证脚本在五次还原后清理空父目录时报 EISDIR，改用准确的空目录删除后完整重跑；失败证据保留为同前缀的 `first-cleanup-failure` 日志，不冒充第一次已正常退出。

请求基线还保留了首次严格失败：自有 Session 请求另一个主体的私有 Target 时，当前 Runtime 拒绝执行但包装为 HTTP 500，不是预期 403；没有文件访问或写入。最终合法 Target／Session 权限探针返回 401／403，不因此声称该 Runtime 错误映射已修复。该既有错误呈现与“未知 POST 的停止待确认”限制如实保留，不为本次存储切换新增协议、可靠投递接管或跨节点 Store。

节点基准脚本最终隔离复核已完成：随机 schema 创建后固定真实 OID，`search_path` 只含该 schema 与 `pg_catalog`，删除前再次核对 OID、删除后核对不存在；缺少或被替换的 schema 一律不执行 DROP。原权限、字节、路由、回执、幂等及测量断言未改。最终 SQLite／实际 PostgreSQL 各 2 次预热、20 次实测全部通过，40 次正式传输无丢弃样本，脚本临时进程和自建 schema 已清理。新日志 `/tmp/morphz-node-request-performance-isolation-final-20261001.jsonl`；类型检查与五个安全分支证据为同前缀的 `isolation-typecheck-final`／`isolation-guard-final` 日志。观测端到端 p50／p95 为 SQLite 537.705／547.655 ms、PostgreSQL 97.316／119.626 ms，仍仅限上述 loopback／串行／暖缓存场景；`modelRequestsIssued: 0` 是脚本执行范围的声明，不当作模型服务请求计数器。

架构核验已对照正式实现和测试体：Platform 目录无正文，应用域保存精确原件／版本；Human 与 Agent 共用授权、CAS、幂等回执及目录补偿；`WorkspaceStore` 只管本机身份、投递与页面控制，旧 RPC／Workspace 业务读写有负向陷阱测试。现有 Desktop 本机文件引用／目录授权仍由 Host `LocalFiles` 按实际输入和当前权限执行，不把它的本机测试说成远端 Target 路由；远端 Node 操作及显式 Transfer 使用既有执行节点机制。第三方 UI 包只准导航状态，不能得到私库 SQL 或保存专业正文；完整第三方服务接入和托管不是本轮交付。

提交前清理与复验（2026-10-01）：删除三份没有调用方的迁移残留：`packages/core/src/collaboration-state.ts`、`packages/core/src/legacy-command-fingerprint.ts`、`packages/application/src/postgres-stage-digest.ts`。随后正式构建通过，构建清理器另移除这三份源文件对应的 9 份编译产物；此前记录的 114 份清理结果仍属于此前那次验收。构建日志：`/tmp/morphz-storage-cutover-commit-build-20261001.log`。

清理后重新运行完整应用单测，配置实际 PostgreSQL：945 项中 942 项通过、0 失败、0 取消，仅 3 项未配置 S3 端点的测试跳过，耗时 65,027.742 ms；日志：`/tmp/morphz-storage-cutover-commit-unit-20261001.log`。类型检查、Rust 格式检查和 6 项构建产物清理测试均通过。本次无调用文件清理后未重跑 GUI，GUI 证据仍是上述 362＋2 两次运行。

## 2026-10-01 消息即时显示、主题色与停止操作归位

- 原延迟来自等待消息提交及目录／历史刷新后才更新列表。普通发送现在先冻结请求 ID 与载荷、保存本机待提交展示，再立即显示气泡、清空输入并允许继续编辑；服务端仍是已发送消息的权威，不新增 Runtime 消息机制。
- 提交失败保留原消息，仅显示红色重试图标；重试沿用原 ID 和载荷。迟到回执不清空新草稿，连续发送独立处理；刷新／重开不自动重放结果未知的请求。权威历史确认同一 ID 后移除本机展示，气泡不重复。
- 本人气泡使用现有 `--accent` 主题色与底面混色；按用户反馈将主题色占比从 13% 提高到 25%，描边为 28%。不新增主题或修改主题选择。
- 红色停止图标属于原用户输入，与时间、复制按钮共用正文下方的悬停操作区；不会独自出现在气泡另一侧，也不跟随 Agent 输出。键盘聚焦和触控可达，停止待确认／失败保持可见；后台执行分支保留执行面板中的独立控制。

验证：正式构建通过；8 个相关单测文件共 **30 项通过、0 失败／跳过**，即时发送、失败重试、连续发送、离线恢复、停止归属、明暗／窄窗和流式等待等渲染层交互测试 **11 项通过、0 失败／跳过**。交互测试使用现有隔离 headless Chromium 和合成消息传输，不能代替实际模型或原版窗口验收，也未重跑整个应用测试集。

原版 `/Users/shafreeck/Applications/Morphz.app` 已正常重开，同一 profile／中心和 Runtime 保留。实际发送的 TEST 气泡在等待处理阶段已经可见，输入框为空且可继续输入；原窗口实见当前青色主题的加深气泡、复制旁的红色停止图标。点击该图标后，本次 `TEST 操作区停止验收 1001` 显示“已取消”，进行中入口与停止按钮撤下，已输出的部分正文保留为未完成回复。只停止这一条测试请求，没有停止既有用户工作或创建额外内容。

## 2026-10-01 流式末尾提示与输出停顿诊断

正文末尾的细光标改为主题色三点动态提示，在增量间歇也继续运动，不增加状态文案、JS 定时器或文字缓冲。完成／断线撤下，减少动态保留静态三点；正文、列表、引用、代码、表格末尾均覆盖。原有文字渐显不变。停止图标另按反馈提亮：亮色 `#e5484d`，暗色 `#ffb4b8`，不改变停止归属及其他错误颜色。

正式构建通过（`/tmp/morphz-stream-activity-build-20261001.log`）；流式文字、会话投影和传输相关单测 **22／22**（`/tmp/morphz-stream-activity-unit-20261001.log`），等待／停止／即时发送渲染交互 **9／9**，均无失败或跳过。断线测试首跑发现夹具仍发送 `connected=true`，修正为真实断线帧后完整复跑九项；未放松原断言。这是相关专项，不冒称全量应用回归。原版同一 Electron 窗口刷新加载，Runtime、profile、中心未重启；实际 TEST 输出中途能看到醒目的三点，结束完整 1～300 后三点撤下，没有重发或取消用户请求。

用户“继续测试”原请求 `msg_1790830887800182000_2195_17` 首段等待约 19 秒、全程约 80 秒，无中途工具或重试；原逐段时序未持久保存，不能重建截图处的准确停顿。原版受控 TEST `msg_1790831681492939000_2195_18` 的只读 WS 观测收到 311 次公开文字增量、共 1,091 字符；输出到 512 字符后，Runtime 发布前已有 **9.304 秒**无新增量，随后一次到达剩余 579 字符。此次停顿位于 Desktop 渲染之前；具体是模型转发适配、CLIProxyAPI 还是上游模型仍未确定，不能将动画改善称为停顿已修复。未修改 Runtime 或代理配置。

## 2026-10-01 普通聊天创建剧本修复

根因是创作 Harness 的准备阶段禁止一切创建，而且操作发现把简单的空剧本／条目创建也标为必须进入 Harness，导致“先有目标才能准备”的死循环。现有创建接口没有缺失。本轮不改 UI、Runtime 源码、存储 schema 或消息机制：显式新建直接使用原 `script.create-production`／`script.create-item`；生成、改写及检查继续使用编剧 Harness。`morphz.script-studio@1.4.1` 的准备阶段只允许按本次明确请求创建空目标，不覆盖正式稿、不采纳候选、不代替 Human 确认资料权利；只创建的请求不进入生成准备或推理。操作发现和工具说明同步，返回真实 input 的 `projectId`，不让 Agent 猜测项目。

新增空书库真实工具／领域集成测试覆盖创建、冷重开、同请求回执恢复、不重复创建、项目边界、未授权生成及停止后不再新写。创建处理器在已有幂等回执之后沿用现有活动输入检查：停止不会妨碍读取之前的成功回执，但不允许开始新的创建。实际 PostgreSQL 参与的七份相关单测 **24／24 通过、0 跳过**（`/tmp/morphz-chat-create-unit-postgres-20261001.log`）；正式生产构建通过（`/tmp/morphz-chat-create-build-20261001.log`）。真实 Runtime／内嵌 Host／SQLite 工序冒烟增加无预绑目标的聊天创建分支，**14 个 Plan：13 成功、1 预期 malformed 失败，82 次固定合成供应商调用**；新空剧本和第一集无正文／候选，旧讨论、审阅轮次、阻断、采纳、锁稿、导出和冷重开断言保留，进程与 teardown 退出 0。日志 `/tmp/morphz-chat-create-runtime-20261001.log`，证据目录 `/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-script-runtime-ahucYO`；合成工序不冒充真实模型写作质量。

原版 Runtime 在只读确认无活动任务后正常重启为 PID **34419**，同配置、数据与凭据保留，新精确 Harness 已安装；原版 Morphz 也正常重开，工具清单实含新的创建说明。上海 **13:46—13:47** 在原普通会话以默认 `gpt-6.1-sol` 发送独立 TEST 请求：input `b092a3c5-e21e-4316-904f-977b0836a215`、root `msg_1790833588552229000_34419_0`。真实模型直接调用原创建操作，剧本 `fb95ee63-3588-5bf0-b182-6aa545f9a993` 与第一集 `4dee33ae-eb5c-5c58-a422-50236727a718` 的两条领域回执、真实工具输出与原窗口卡片一致；打开结果后第一集为草稿 v1、正文为空、保存禁用，最后返回原对话与空输入。未重放原婚姻短剧请求，未改旧剧本、资料许可、事项或提醒。本轮只验证新建与空条目，不宣称新资料处理许可或完整新剧本生成已经获验收。整体配色投诉本轮仅定位了灰底混色、侧栏渐变和选中态装饰，尚未调整配色。

## 2026-10-01 白净底面与平面主题配色

按用户对 Muse／Codex 的实际视觉对比调整公共样式，不改布局、字号、间距、按钮位置或操作逻辑。浅色主画布、顶栏及控件使用白底，侧栏使用不透明的 `#fafafa` 平面底色，去掉灰蒙渐变与侧栏投影；暗色侧栏保持 `#242424` 中性实底。选中项使用 12% 主题浅色，失焦为 8%；本人气泡使用 25% 主题色与白色／暗色纸面混色，无描边或阴影。普通控件不叠立体装饰，覆盖层保留必要投影。四组品牌强调色源、原生外观与辅助功能协议保留，没有新增主题或强制亮色模式。首次回归实际发现主导航选中项在悬停时被灰色覆盖，已从普通 hover 规则排除选中项，没有放松状态断言。

正式生产构建通过（`/tmp/morphz-clean-palette-build-20261001.log`）；相关界面专项最终 **35／35 通过、0 失败、0 跳过，1.6 分钟**（`/tmp/morphz-clean-palette-ui-20261001.log`）。覆盖四主题明暗的侧栏／气泡／搜索／通知、文字对比度、选中与悬停区分、草稿、即时发送、独立停止、流式提示、菜单键盘与辅助功能；其中真实隔离 Electron 用例保留窄窗口及 200% 缩放断言。这是本轮配色专项，不冒称全量应用回归。

原版 Morphz 的同一窗口已刷新加载新构建，实际检查电光青的亮暗模式及亮色鸢尾紫，白净侧栏、平面选中及无描边气泡可见；菜单关闭后画布正常。最终恢复原「跟随系统＋电光青」偏好与原普通对话，输入为空、默认 `gpt-6.1-sol`、连接正常。没有发送新的模型请求、取消工作或重启 Runtime，原 profile 与中心保持。

## 2026-10-01 清亮消息面色与引用可读性

根据用户对灰绿气泡的反馈，本人消息改用独立的 `--human-message-fill`：亮色保留主题色相，以 90% 饱和度、88% 明度生成清亮浅色，不再简单稀释深色前景；纯单色使用中性 `#f0f0f0`，暗色保留原混色。品牌按钮、链接、导航、布局及流式交互不变。气泡内引用来源小字改用适合实际叠色底面的文字色，八种主题／明暗组合均验证至少 4.5:1 对比度。

正式构建通过（`/tmp/morphz-fresh-surface-build-20261001.log`）；界面专项 **35／35 通过、0 失败、0 跳过，1.6 分钟**（`/tmp/morphz-fresh-surface-ui-final-20261001.log`），覆盖四主题明暗、实际引用叠色、草稿、即时发送、停止、流式提示与原有导航／菜单交互。原版同一窗口刷新后，实际亮色电光青气泡已显示新的清亮浅青色；未发送新的模型请求，未重启 Runtime，未改变数据与会话。验收期间用户也在操作外观菜单，因此不宣称最终外观偏好已恢复。

## 2026-10-01 后续优先级：UI 体验优先，存储访问优化待办

用户确认先记录下面两项欠账，暂不实施；下一阶段优先优化 UI 体验。已经完成的存储权威切换不回退，也不为这些访问优化重新设计整个存储模型。以下为待办，不属于已完成或已验收能力。

### 待办：客户端按页面范围读取

- 现状：`apps/web/src/platform-workspace-view.ts` 将领域查询结果拼成旧 UI 使用的内存 `Workspace` 展示模型；首次读取仍收齐项目、导航会话，进入事项页时收齐事项。`platform-client.ts` 的 `allProjects` 等通过多页请求收齐列表，项目上限为 10,000 条。这不是旧 JSON 持久化权威，但初始化与失效刷新有随列表总量增长的成本。
- 改进方向：在保持原导航、过滤、排序及草稿交互的前提下，改为当前页面／展开分支按需读取和列表分页；相应收敛缓存失效及迟到响应处理。保留数据库权威与领域授权，不增加另一份客户端业务数据库。
- 验收：大列表首屏和局部刷新不再隐式收齐所有页；分页无漏项／重复，切页与撤权后不消费旧响应，现有操作和未提交草稿不回归。用实际请求数、返回条数及数据量验证，不能只看底层存在分页接口。
- 复杂度判断：中等，主要成本是多个页面消费者与缓存行为的逐项迁移。

### 待办：剧本写操作按实际依赖加载

- 现状：`packages/script-studio/src/store.ts` 的部分单条目写操作仍调用 `productionSnapshot`，加载整部剧本的元数据历史、条目版本、草稿正文、候选和审阅等，再完成局部操作。编辑器展示读取已分页，并不代表写路径已经局部化。
- 改进方向：逐个操作明确必需的对象、版本及依赖闭包，改为精确读取；涉及跨条目连续性或审阅约束时读取真实依赖，不能以省略校验换取性能。优先复用现有表，确有查询需要时单独补索引。
- 验收：增加无关历史后，单条操作不再加载整部剧本；当前权限、CAS、创作代际、候选基线、跨条目约束、幂等回执和目录恢复保持原语义。SQLite／PostgreSQL 均验证正确性与读取成本。
- 复杂度判断：中等偏高，难点是业务依赖范围而非建表；可逐个操作替换，不需要一次重写。

### 当前工作边界

先优化用户可见的 UI 与交互，遵循极简、内容优先和操作流畅的既定要求；不因本次记录启动后台存储重构、增加功能或改变已有数据模型。后续修复上述待办时，以小范围、可验证的改动交付。

## 此前阶段与诊断证据

最终审计进展（2026-10-01）：Reader v4 已拆为位置独立读取、正文可见范围分页及原侧栏滚动续页；双后端千条专项 4／4、真实 Client 迟到 2／2、原 Reader／新分页／PDF 完整 GUI 18／18 通过，日志 `/tmp/morphz-reader-marks-pagination-20260930.log`、`/tmp/morphz-reader-marks-client-late-read-20260930.log`、`/tmp/morphz-reader-marks-ui-accepted-20260930.log`。首次点击在异步标注读取前被丢弃的真实回归已修正，并保留全部编辑、删除、恢复及引用跳转断言。

原版用户实测的两处消息缺陷已修正：① 引用仍先用 Session／输入 ID／消息 ID 精确定位并核验身份，选文校验与界面共用 CJK／GFM Markdown 解析，不靠正文搜索定位消息、不任意剥星号。真实 Runtime 的 SQLite、PostgreSQL 验证原 61 字 Markdown 对应 53 字可见选文通过，篡改文字、消息／输入根或 1µs 时间仍拒绝；实际 PG 输出 `/tmp/morphz-platform-message-runtime-pg-final-20261001.log`。② 本机首次普通输入在持久 outbox 提交前读取 Runtime 当前默认模型，显式选择优先；同命令重试／重开使用首次固定信封，补充不改原模型，默认读取失败保留草稿而不回退旧 Session 模型。实际 Runtime 同 Session 原 astra、新默认 sol、再次改默认并重开仍 sol 的 Thread／接受请求证明见 `/tmp/morphz-input-model-runtime-final-20261001.log`；只用不可达本机合成供应商，不作为真实模型质量证据。受限团队网关无 operator 默认读取权限，不另授予该权限，仍明确呈现 Runtime 管理的默认。未重发、取消或改写用户原输入。

真实 PG 冒烟同时发现 Session IO 两条快速准入 SQL 没有写 causal 索引列及 input timeline；已在原单次 CTE／事务内补齐，不新增消息副本、网络协议或补写兼容路径。真实 PG 专项覆盖普通 Parallel／Interrupt／FollowUp、steering、重复／冲突、权限与 CAS；投影插入故障使请求、Event、Thread、Signal、outbox 与会话一起回滚，同 ID 重试恢复。实际 PG 热路径 statement 预算、完整 storage conformance、SQLite 事务 conformance 和原跨 Host 来源／重开幂等冒烟均通过，原断言未降级。

短剧真实失败原因已确定：原 Runtime 没带入本部署 Yao 允许调用 `host_morphz` 的启动配置，首轮模型成功、Harness 选择成功后被工具边界拒绝。实际已安装 Harness 和对应库的纯校验复现同一错误。原 Runtime 已在无运行中 Activation 时正常退出并重启为 PID 2195，原参数、目录、数据库和凭据保留；只读进程核验确认启用原七工具加 `host_morphz`，Host 清单路径不变，不扩大 Runtime 全局默认权限。当前已安装 `morphz.script-studio@1.4.0` 的源码／摘要不变，新 build 的纯准入及八个导出接口校验通过，实际 HTTP 状态正常且默认模型为 sol。证据 `/private/tmp/morphz-live-failure-diag.cn8y4S/evidence.md`、`/private/tmp/morphz-live-failure-diag.cn8y4S/deployment-gate-evidence.md`。这是部署与准入验证，不冒充原短剧已成功生成；未自动重发原失败输入。提醒原 `schedule_tx` 已成功提交，`schedule_048bc5bac5e022eb04a8a1d4` 仍 queued、revision 1、2026-10-23T01:00:00Z（上海 09:00）；503 后原 Thread 于 15:58:42Z 完成，不重复创建提醒。

Reader／消息修正后的实际双后端完整单测 **929 项，926 通过、0 失败、3 项仅 S3 专用跳过**，日志 `/tmp/morphz-quote-model-reader-final-unit-20261001.log`；合并生产构建 `/tmp/morphz-quote-model-reader-final-build-20261001.log` 成功。最新整套界面首轮 **362 项，353 通过、9 失败**，日志 `/tmp/morphz-quote-model-reader-complete-headless-20261001.log`。7 项项目对话失败来自其真实 HTTP 夹具返回空默认模型，正式入口正确保留草稿并拒绝发送；仅补上隔离测试模型后原 8 项全部通过，`/tmp/morphz-project-conversations-model.mEOMWE/project-conversations-final.log`。浏览器拖拽 trace 直接记录脚本路线之外的无按键鼠标事件引起 capture 丢失，生产按既有规则取消；未忽略 capture 丢失或宣称修复产品。截图失败发生于取消后第四次 picker 打开；新增被动诊断的专项两次均 3／3 通过，取消后原生与 renderer 焦点恢复、没有焦点授权拒绝，不能仅凭候选解释改生产代码。最新完整诊断 `/tmp/morphz-native-two-diagnostic-complete-20261001.log`。最终同一 GUI owner 的完整回归 **362／362 通过、0 失败／跳过，退出码 0，16.5 分钟**，日志 `/tmp/morphz-quote-model-reader-final-complete-20261001.log`，完整 trace 位于 `/tmp/morphz-quote-model-reader-final-complete-results-20261001`；真实原生浏览器、截图、剧本 Electron 和侧栏用例均通过，没有用专项拼接冒充整套。最初 Chrome 启动错误及该应用路径后来实际不存在的记录保留；现使用已安装的隔离 headless Chromium，实际 Electron 用例仍启动真实隔离 Electron，不将 headless 截图冒充原版窗口。

分页修改前的完整界面回归已取得 **359／359 通过、0 跳过**，日志 `/tmp/morphz-storage-final-acceptance-ui-20260930.log`；不能用它替代 Reader／消息修正后最终合并构建的完整验收。原版清理构建的正常冷重开、六库恢复、2 万对象及引擎 WAL 已验证，保留真实长尾和测量边界。当前原版 Desktop 已正常退出并以同一 `ai.morphz.desktop`／profile／中心重开为 PID 20425，原会话恢复、Agent 已连接、默认显示 sol。原窗口实见「TEST 剧本分页验收 0930」仍为 v2，原未保存草稿全文保留，未按保存；阅读「TEST 文档持久化 0930」仍为原 v2，有原书签／高亮／批注及原批注文案。只读原库断言确认 Reader schema 已为 v4，三条 mark ID 及 revision 1／3／3、位置 section-1／0／font20／revision1 不变，外部 Objects 原件仍是原 ID／v2、book_id 为 null，无导入副本；Script 与 Objects 原不可变版本列表仍各为 [1,2]，没有 v3。验收只切换原界面查看，结束后恢复原对话页，未发送、删除或重发用户请求。最新完整合并回归已通过；下述两项无消费者的遗留仍未清理，当前整体目标未完成。

正式接线状态（2026-10-01）：UI／Agent 的项目、事项、目录、文档、剧本、阅读及消息入口已使用 Platform／所属应用／Runtime。旧 Workspace 在线业务权威、Collaboration、通用搜索索引和 RuntimeBridge 快照回退已删除；`WorkspaceStore` 只提供本机身份、可靠投递及页面控制日志，renderer 的 Workspace 形状只是展示适配器。历史业务表不是当前写入权威，未增加双读或双写。Objects v5 按行表格、投递脏键增量提交、导航分域修订复用、剧本卡片轻量读取及编辑器 head／分页／确切正文均已接通。Reader v3 解析缓存及 v4 标注分页已分别验收。Application 来源关注沿用 typed Session IO／Signal，不新增协议或调度器；停止待确认表达与既有执行节点契约已有专项和整套证据。首次收齐导航、选中事项历史及 Host 启动验证保留记录仍有明确成本。最终消息缺陷、完整合并构建与原窗口验收以本节开头为准，不将正式接线等同于整个目标完成。

本轮较早只读 A／B／D 架构审计确认双后端独立领域 schema、Human／Agent 共用写服务、授权／CAS／幂等回执／私库 outbox 和目录恢复的正式入口，没有缺域时回退旧 Workspace 的写路径；同时找到死迁移文件、Store 节点字段和 §7／§8 的两个证据缺口。这四项已在上方最终合并验收中清理或补齐，不能再以本段旧状态称尚未实现。真实 S3 部署及其云备份仍未验证，不纳入已完成证据。

本轮清理后的完整单测已取得终态：实际 PostgreSQL 参与的 **914 项，911 通过／0 失败／3 跳过**，日志 `/tmp/morphz-storage-last-cleanup-unit-20260930.log`。生产构建 `/tmp/morphz-storage-last-cleanup-build-20260930.log` 成功；六份 DDL 与当前 schema 导出逐字节一致，日志 `/tmp/morphz-storage-final-cleanup-ddl-match-20260930.log`，结构专项 24／24 通过，日志 `/tmp/morphz-storage-final-cleanup-schema-proof-20260930.log`。最后两种无 caller 的来源同步操作也已从核心 command 移除，负断言拒绝它们；没有恢复旧文件同步。三项跳过只针对未配置的 S3 中心字节替代后端，不是 PostgreSQL 缺失，也不是本次切换必需功能；不能据此宣称 S3 部署或其成套云恢复已验收。以上终态在新标注分页修改之前取得。

删除 Platform、Objects、Script 生产类中仅供旧测试数据使用的导入／免授权核验方法及专属转换 helper，没有转移成另一个 Workspace 兼容适配器；正式 SQL schema 升级保留。有效测试改用当前领域 API，Platform 58／58、Objects 25／25、Script 16／16 的 SQLite／实际 PostgreSQL 专项通过。保留对话分页、授权、CAS、幂等、候选、来源、依赖、历史及冷重开断言；退休一条仅验证旧 Workspace 剧本格式导入的用例，并新增生产不暴露旧接口的负断言。尚无 Objects PDF 创建操作，既存 PDF 读取测试使用小型当前 schema 初态，不称它为 Human 创建；正式 PDF 创建另通过 Reader 导入后 Agent 读取验证。生产及运行脚本没有旧导入 caller，不为开发样本遗留生产兼容入口。

保留此前一次 Playwright 失败证据：**359 项中 358 通过、1 失败、0 跳过**，日志 `/tmp/morphz-storage-final-frozen-ui-20260930.log`；浏览器交流向下拖动后仍停在完整记录。新增测试内事件诊断保持原坐标、断言、阈值与超时，原用例连续 15 次通过，随后完整套件 359／359 通过。原偶发失败未复现，不能声称找到根因或已修复；没有改产品或盲加等待。外观重复通知及正文竞态 waiter 的计量修正也保留原业务断言。专项日志 `/tmp/morphz-browser-exchange-diagnostic-repeated-20260930.log`、`/tmp/morphz-browser-exchange-diagnostic-passive-20260930.log`；最新合并构建还需完整回归，不拿 Reader 等专项替代。

来源关注的真实 Runtime 专项 `npm run test:platform-task-source-runtime` 在三域旧导入清理后完整复跑八阶段通过，日志 `/tmp/morphz-task-source-runtime-post-legacy-cleanup-20260930.log`：活动 Thread 精确 generation 接续、终态后同 Session 新 root 且不新建 Schedule、暂停期间三个修订合并、真实 200 回执丢失后两次冷重开不重复、已接受接续的读取失联期间不确认停止／不允许改派、当前 Schedule 排队／实际延后日期／未终依赖不提前调用模型、POST 尚未到达时停止保持待确认且迟到接收后确切取消、首次 POST 前失败后活动执行以同一 client ID／完整 wire 安全重试。真实编译 Runtime、内嵌 Host 与 Unix Agent 工具实际写入 Objects，15 次本地合成供应商调用、7 条来源 IO；不证明真实模型理解质量或实际审批生命周期。旧阶段日志 `/tmp/morphz-task-source-runtime-final-stop-20260930.log` 及摘要证明保留为历史，不替代清理后终态。

三域清理后的真实 Runtime IPC `npm run test:runtime-ipc` 通过，日志 `/tmp/morphz-runtime-ipc-after-script-cleanup-20260930.log`。Reader 原文及不可变引用经 Platform 输入和 Unix 工具回调形成 Objects 精确交付；Host 冷重开保持同一原件／来源／回执，同命令不增加供应商调用。核对没有应用 TCP 监听和旧 Workspace／command／asset 业务表；这是实际 Runtime 与 SQLite 内嵌 Host、合成供应商，不是 PostgreSQL IPC 或模型质量验收。

来源与执行检查器专项 `/tmp/morphz-task-source-all-final-20260930.log`：SQLite／实际 PostgreSQL 联合 **45／45 通过，0 跳过**。两个独立 Host／Pool 验证相同冻结请求及停止门槛，104 条历史执行仍可分页；只读检查器按原执行的确切 Thread 和来源接续 roots 查询，不从 Session 最近 100 个其他任务推测归属。已停止、移过项目的历史仍按原准入和当前真实授权可读；第三项目选择或任一必需权限撤销均拒绝。停止门槛同时保护移动、改派和新 run，即使原 Thread 已终态或当前执行引用已清，也不绕过已接受／未知来源投递。当前 Runtime 没有对未知 client_message_id 原子拒收的操作：尝试已落盘但 POST 前崩溃且从未接收时，停止可能持续待确认；不删除证据、不伪造停止成功、不为停止主动发起新工作。此失败边界保留为明确限制。

停止状态的最小可见性修复：事项清单与原面板在已有 stopRequested 为真时统一显示「停止待确认」，说明「已请求停止，等待执行结果确认。」；原按钮、禁用条件和操作保持不变，不新增状态表或 Runtime 协议。核心、正式组件 DOM 与实际双后端操作专项 21／21 通过，日志 `/tmp/morphz-stop-presentation-unit-20260930.log`；即使观测 Thread 已终态，停止回执未确认也不显示已停止或开放重新执行。原 UI 清单／面板／刷新用例加入最新整套，其受控 Runtime 投影只验证展示，物理停止证据仍由实际 Runtime 专项提供。

既有执行节点契约复验：6 个精确 Runtime 用例及 SQLite／实际 PostgreSQL conformance **8／8 通过，0 忽略**，分别见 `/tmp/morphz-storage-final-existing-target-contracts-20260930.log`、`/tmp/morphz-storage-final-existing-target-conformance-20260930.log`。追加双后端真实 HTTP／Runtime／EdgeWorker 验收 **2／2 通过**，`/tmp/morphz-storage-final-multi-target-cleanup-20260930.log` 最后一次终态：四个真实 write／exec Jobs、两次 exec 同时 Running 且有实际开始文件与 side-effect 时间；Thread、Job、Node、Target 固定绑定，明确 Edge relay Transfer 校验实际长度、摘要和回执，重放不再次写目标。Human HTTP 发现与精确 Target 读取拒绝未登录和其他所有者的私有节点／执行；停止 A Worker 后真实心跳到期，HTTP 显示 A 离线、B 在线。仅使用既有机制和同机两个独立 Worker，不新增路由／Store，也不称作两台物理电脑或 Mobile 产品验收。日志保留了首次夹具错误：全局公共 Target 可见，不能将其误判成私有 Target 泄露；最终断言仍严格验证私有节点和执行不可访问。

中心字节的非 S3 双 Host 验收 `/tmp/morphz-center-bytes-multi-host-20260930.log`：SQLite／实际 PostgreSQL **2／2 通过**。独立投递库与连接显式共用同一中心目录，Reader 原件、图片的旧／新版本及两个 UI 包版本跨 Host 精确读取；撤权、重开、CAS、幂等及缺失原件拒绝保留，A 的本机投递不由 B 接管。已接受附件另经当前真实 Runtime 冒烟 `/tmp/morphz-platform-message-runtime-final-cleanup-20260930.log`，第二 Host 从 Event／resource 核验字节，不读取发送方私有 Store。这些是共置文件型中心的能力，不是任意 NFS、跨机器文件服务或 S3 部署。

容量追加基线 `/tmp/morphz-storage-capacity-enhanced-20260930.jsonl` 已完整通过 SQLite／实际 PostgreSQL：每后端 24 个不同摘要原件、554 章、5,858,794 解析字符、主租户 480 条／另一租户 20 条标注、72 次有界正文读取与三次冷重开。两个租户各四个真实 Agent 工具请求同时在途，24 个独立提交，同版一成功三冲突、同命令四并发一后继；Runtime 来源为受控夹具，不证明模型吞吐。首次导入 p50／p95 SQLite 270.399／362.401ms、PostgreSQL 312.785／452.239ms；4,000 字符服务读取 0.399／0.623ms、1.796／2.805ms。详细口径见实施设计；用户态原件写量及分配容量不是物理设备 IO／写放大，不承诺复杂 PDF／OCR、无限书库或批准 SLO。

写成本测量 `/tmp/morphz-storage-write-cost-wal-20260930.jsonl`：实际 SQLite／PostgreSQL 各八个正式 Human 操作与精确重开通过，测试观察器与临时 schema 清理完成。文档创建／修订各九个直接影响行，单行表格修改只新增一个行状态、三个单元格和十条版本引用，其他九行复用；重放零行，旧版 CAS 零 DML／一次回滚。SQLite 连续有效 WAL 帧，PostgreSQL 实际连接 XID 归属的解码记录分别测得文档修订 103,000／5,643 字节、单行表格修改 131,840／14,441 字节；重放与过期 CAS 均为 0。PG 独立 xid=0 的 167 字节噪声使全局窗口增长，但准确排除，未算入重放。标量绑定、分配容量和引擎日志均不冒充 SSD 物理 IO；未测 SQLite checkpoint 主库写量及 PG 页头／对齐／段分配。详细口径和实际比率见实施设计。

2 万对象实测 `/tmp/morphz-storage-20k-final-20260930.jsonl` 完整通过：SQLite／PostgreSQL 各生成 1k／20k，400 页各不超过 50 条且完整去重，总数 20k；正式授权原件读取、CAS、60 次四并发修订、同版一胜三冲突及五次重开核对。2 万目录首屏 p50／p95 SQLite 0.323／10.288ms、PostgreSQL 9.985／302.856ms；重开 50.769／485.075ms、61.750／126.602ms。SQLite 创建最大 5,387.224ms 是真实长尾，当前日志不能归因。15／5 样本的 p95 即最大值，不作为稳定尾分布或批准 SLO；重开不清系统缓存，单 Host／单 Human／静态游标的边界保留。

最后来源操作清理后的生产构建在同一原版 `ai.morphz.desktop`、原 profile／中心正常退出、冷备份并重开。冷备份恢复到独立新目录，日志 `/tmp/morphz-original-last-cleanup-cold-backup-20260930.log`、`/tmp/morphz-original-final-restoration-20260930.log`；六库全部 schema 和有序全行摘要核对为 121 张用户表、2,120 行，另有一张 SQLite 内部表，见 `/tmp/morphz-original-final-restoration-consistency-20260930.log`。本中心三类受管 Store 实际均为空、UI 包引用为零且未声明 UI Store，不能把它称为非空字节／UI 包恢复；非空覆盖由当前单测的 `center-backup` 与双 Host 中心字节用例另行证明。

原窗口重开实际显示「TEST 剧本分页验收 0930」正文 v2 和独立本机未提交草稿，其末段「TEST 本机未提交草稿：正常退出后仍保留，不能写成正文 v3。」仍在。只读核对 head／版本数均为 2，没有 v3；原 Reader 显示 Objects 文档 v2，批注栏有原高亮、书签、批注，三个标注 ID／修订及位置／字号保持不变，`book_id` 为空，没有复制正文。随后回到退出前的原「对话」页面，22:09–22:16 的实际历史仍可见；未保存、发送或重新执行。此项在新标注分页修改之前取得，后续修改后需复验其可见操作，不以隔离截图代替。

额外原生脚本的正式端口清理：七个脚本的退役 `workspace`／通用 `command` IPC 调用已移除，没有生产兼容适配器。隔离原生 draft、Exchange、Reader 稳定性、模型与账号、真实 OCR、Reader Session 和连接脚本均已通过；最后两项保留原断言，复验取消后部分回复 reload／cold restart、Runtime 断开时 Platform 数据与草稿仍可用。证据包括 `/tmp/morphz-reader-session-port-20260930.log`、`/tmp/morphz-connection-port-20260930.log`；PDF 和 OCR 各 12 轮稳定性另行通过。这些脚本不在完整 Playwright 套件中，不能以界面套件通过代替它们。Reader Session 使用真实 Runtime 和合成模型供应商，不作为真实模型效果证明。

实际 Client 撤权缓存专项 `/tmp/morphz-document-client-race-real-20260930.log`：2／2 通过。React 正式 renderer 创建真实 `useWorkspace` 方法及 refs，正式 HTTP 客户端连接隔离真实 Host；服务端先真实授权取得正文、随后才延迟响应。同 CSRF 撤权后旧正文释放前后 `getSnapshot()` 的 current 不变，原件不进入 artifacts；重新授权并真实读取 v2 后，迟到 v1 不能覆盖 v2。仅适配浏览器 cookie／偏好，没有模拟业务结果或增加生产测试 API。此直接缓存断言补足了 GUI 重新授权自身清缓存可能掩盖旧响应回填的问题，不替代原生操作验收。

阅读解析缓存 `/tmp/morphz-reader-cache-integration-20260930.log`：SQLite／实际 PostgreSQL 联合 59／59 通过，0 跳过。Reader 私库只增加对既有 canonical reading source 的解析索引，不保存另一份正文；缓存键核对原件摘要、格式、实际解析模块／依赖版本和解析选项，命中前检查当前身份和原件授权。真实 Worker 首次／变化／损坏时启动、命中和稳定重试不启动；新书、旧解析版本、个人标注和原命令幂等仍各自独立。索引提交与 Reader import 同事务，故障回滚与旧 schema 结构错误拒绝已覆盖。缓存只避免重复解析，原件完整性验证和新书保存仍有 O(N) 成本。

PDF Range 专项 `/tmp/morphz-reader-range-integration-20260930.log`：真实 SQLite／PostgreSQL 联合 46 项通过。原件元数据先核对当前授权、不可变 manifest、路径和长度，不扫描全文件；读取 16 字节只核验所触及的 1MiB 校验块，授权变化、损坏块及显式全文件验证仍拒绝错误字节。2,100,689 字节原件的元数据读取实测为 0 字节文件读取；未触及块的损坏由该块实际读取或显式全验证发现，不把元数据检查冒充整文件完整性证明。

表格专项：SQLite／实际 PostgreSQL 的 Objects、Agent、Human 本地与正式 HTTP、原编辑器命令联合 30／30 通过，0 跳过。原 GUI 普通记录增改删发送 `interactive.patch`，字段／视图／顺序变更保留完整修订契约；2／2 原界面用例验证局部请求及原有 XSS、视图、历史、刷新断言。旧表格版本一次性事务转换，错误回滚，无正式 JSON 读取 fallback。1000 行 × 24 字段改变一行只新增一个行状态，但版本清单与全文投影／提交核验仍有界 O(N)，不把减少写入当作只读一行。

表格单元格查询追加优化 `/tmp/morphz-interactive-point-final-20260930.log`：改为每批最多 100 个完整版本主键 SELECT UNION ALL；真实 SQLite／PostgreSQL 联合 19／19 通过，0 跳过，含千行当前／历史版本、冷重开、损坏与缺失单元格、实际 Agent／Human 权限、CAS 和幂等。未改 schema、容量、历史或摘要语义；查询计划及正式 Human n20 读／改计时见实施设计。不因查询提速而取消有界版本清单和全文投影成本。

导航专项 `/tmp/morphz-navigation-final-20260930.log`：SQLite／实际 PostgreSQL 及现有 Platform／Client 联合 106／106 通过，0 跳过。真实 Agent 连续三次修订文档不重读项目／会话／事项列表；项目、对话和事项命令只使对应分组失效。112 项目按两页完整读取，页间变化不能缓存成一份同版本列表；撤权清除受保护投影，身份配置轮换使访问修订失效，冷重开保持计数。另有真实授权读取后延迟返回、期间撤权及重新授权的响应竞态专项：旧代响应不能回填缓存，也不能清掉同 key 的新请求。初次完整导航树仍收齐所有授权页，没有截断或改变现有展开／筛选／排序操作。

剧本消息交付 `/tmp/morphz-script-delivery-48-20260930-final-http.log`：真实 SQLite／PostgreSQL 联合 48／48 通过，含正式 HTTP 登录、精确历史、采纳后状态及撤权；2／2 新构建界面回归通过。未打开时卡片只读明确的元数据 DTO，不读取 `scripts.snapshot`；点击精确原件与候选，同名其他剧本不预读，返回保留草稿。编辑器现在也已接 head／分页／确切正文，但其证据另列，不能由消息卡片专项推导整个编辑器通过。

剧本编辑器领域读取 `/tmp/morphz-script-editor-integration-20260930.log`：真实 SQLite／PostgreSQL 联合 34／34 通过，0 跳过；正式 HTTP 登录及 CSRF、当前 head、目录／候选／历史／事件分页、精确正文／候选／检查／导出 manifest、权限撤销及冷重开均已覆盖。Script schema v4／v5 一次性升级到 v6 的固定结构和回滚验证通过，没有正式快照回退；测试令完整 `productionSnapshot` 读取直接失败，编辑器端口仍通过。原 UI 的接线、分页刷新、迟到响应及原生 Word 导出正在专项验收，尚不能用这 34 项代替界面整体通过。

已修复创建者投影：Agent 创建的原件被人工修订、改名或撤销后，仍显示最初创建者；修订作者另属该版本。客户端通过既有版本元数据接口精确读取 v1，不读取旧正文或扫描历史，并核对当前授权、原件身份与版本。62 项专项回归及隔离 Catalog／Desktop Electron 冒烟通过。便笺示例 1.3.0 保存后仅把文档 ID 留在视图状态，重载读取同一 Objects 原件，继续保存以确切修订修改同一文档；冲突保留输入。没有把正文或未保存私有草稿塞入 `saveState`。5 项正式界面验收通过；未保存的第三方便笺草稿持久化不在该例提供的能力中。

原版窗口最新复验：同一 `ai.morphz.desktop`、原 profile／中心，在上述最新构建正常重开后，Script v6 实际显示「TEST 剧本分页验收 0930」的正文 v2 和独立本机未保存草稿；数据库仍只有 v1／v2，没有自动写成 v3。Reader 原库已升级到 v3，原窗口仍显示同一 Objects 文档 v2、书签、高亮和批注；三个标注 ID／修订保持不变，`reading_sources` 指向原 Objects ID／版本，`book_id` 为空，没有复制正文。正常退出并确认六库无写入者后，冷备份 `center-2026-09-30T11-48-30-261Z-c869e4ce` 成功恢复到全新目录；六个数据库 121 张用户表、2,096 行的结构和逐行 SHA-256 全部一致。日志 `/tmp/morphz-original-reader-v3-cold-backup-20260930.log`、`/tmp/morphz-original-reader-v3-cold-restore-20260930.log`。未覆盖运行目录，未启动第二个手工验收应用。备份不包含 Runtime、客户端草稿或 PostgreSQL 私库，不能称为全系统恢复；草稿保留由同一原版应用的冷重开另行验证。原中心中的旧测试表同样被备份，保留备份不代表其业务代码仍可运行。

此前全量单测记录 `/tmp/morphz-storage-full-20260930-final.log` 为 842 项：838 通过、1 个真实来源事件缺口失败、3 项未配置 S3 测试端点跳过；实际 PostgreSQL 已参与。354 项完整界面运行终态为 341 通过／13 失败／0 跳过：两处旧夹具错误（便笺保存后空白预期、将原件写入 dialogue scope）及后者留下未投影原件导致的后续恢复失败。修正后干净中心复跑 42 项，41 通过，剩余连接刷新用例与既有 5 秒刷新周期竞争；测试现等待真实 bootstrap 503 响应后核验原 UI，不增加超时或放宽恢复保护，该项单独复验通过。上述分批通过不能合并冒充最新完整套件通过；最新表格、导航和剧本页式读取定版后必须重跑。下方 804／352 全绿是清理前的历史证据。

性能基线已新增 opt-in 脚本 `tests/storage-performance-baseline.ts`，1k／10k 记录均通过正式 Human Application 写入，不用 SQL 业务种子。SQLite 和实际 PostgreSQL 的目录 50 条、全游标遍历、精确原件版本、CAS 修订／拒绝及重开恢复均通过；串行记录为 `/tmp/morphz-storage-baseline-full-20260930.jsonl`，追加四并发及内存采样为 `/tmp/morphz-storage-concurrent-full-20260930.jsonl`。每后端运行 60 次独立原件并发修订；同版四命令竞争严格一成功／三冲突，重开后当前版本及旧 v1 不变。10k 时目录响应约 22KB、原件约 4KB，与总量独立。它测的是一个 Host 的领域 API，不证明多 Host／多租户吞吐；全进程内存样本含测试状态且未强制 GC，不是峰值或泄漏证明。重开只有 5 个样本且未清 OS 缓存，未测物理写放大、大文件或批准 SLO。具体基线见实施设计性能节。

2026-09-30 最新收口验收：启用本机 PostgreSQL 的全量单测 804 项中 801 通过、0 失败、3 项未配置外部对象服务端点而跳过；生产构建通过。完整 Playwright 界面套件 352／352 通过。真实编译 Runtime、Yao Harness、Unix Host 工具的剧本联合流程通过，16／16 故障恢复分支通过；模型供应商为合成夹具，不作为真实模型写作质量证明。Browser 控制入口已删除旧快照授权方法，正式测试使用 Platform 项目、页面所有者和持久操作日志；冷重开仍返回原回执。单测并发显式限制为 4，避免本机默认 14 个测试进程争抢数据库／进程启动资源；未延长产品超时或删掉故障断言。

同一原版 Morphz（`ai.morphz.desktop`，原 profile／中心）已实际创建「TEST 文档持久化 0930」：真实 Agent 工具保存 v1，人工编辑保存 v2；在 Reader 打开同一 Objects 原件后，书签删除／撤销、高亮取消／撤销和批注保存均通过。正常退出、中心冷备份校验并重开后，原输入、Agent 回复、精确 v1 交付入口、文档 v2 和三条标注均恢复；数据库核对标注原 ID 未变，`reading_sources` 指向 Objects 的同一对象 v2，`book_id` 为空，没有为阅读复制正文，待投递计数为 0。冷备份为 `center-2026-09-30T06-36-52-369Z-6bb42a0e`，不含 Runtime、客户端草稿或 PostgreSQL 私库。本轮原版读写／重启验收已完成上述范围，不能替代未逐项核对的全产品实机验收。

主要剩余代码工作：删除旧 Workspace 业务实现及 RuntimeBridge 的快照回退，迁移仍依赖旧模型的流程测试，并核对事项来源变化、暂停／恢复等原有生命周期能力。历史业务表仍存在于原中心但不由正式入口写入；未以保留开发数据为由恢复双写。此项未完成前，整体目标仍保持进行中。未修改已接受 UI，未新增跨节点 Store、文件上报或 Runtime 消息机制，代码未提交。下列较早“完整界面套件运行中／原版重启未验收”记录以本条为准。

2026-09-30 剧本与多对话正式回归更新：剧本工作室 18／18 界面用例通过，覆盖实际应用私库中的创作、候选、采纳、历史版本、审改、导出与隔离内嵌 Electron 四主题／200% 缩放。项目多对话原有 8 项用例现使用真实 HTTP Host、Platform 会话目录、应用私库及持久 Runtime outbox，不再访问旧 workspace／command API；8／8 通过，保留未发送草稿、只发附件、首发失败、丢失回执不重复、迟到回执不抢导航、独立 Session 与共享默认 Session 完整历史、引用归属、归档／恢复与刷新断言。Runtime 接收／模型执行在该界面夹具中停用，排队不冒充实际发送或生成结果。回归复现并修复了未发送会话草稿被请求为已存在会话、导致导航读取 404 和输入禁用的问题：草稿首次提交前只保留原授权历史范围，不创建空会话，不改 UI。启用本机 PostgreSQL 的全量单测 802 项：799 通过、0 失败、3 项外部对象服务端点未配置跳过；生产构建通过。完整 Playwright 套件已重新启动，整套结果尚未确认；旧业务实现清理及原版 Morphz 本轮打包／实际写入／重启恢复验收仍未完成，整体目标保持进行中。

2026-09-30 事项依赖与阅读验收更新：事项开始仍使用既有 Platform outbox 与 Runtime Schedule，没有另建调度器。准备请求固定人工答复 ID 和 Agent Thread 引用；停止未准备执行不创建 Schedule，重复停止不增加版本，也不能误停下一次执行。正式快照核对真实前置状态、审批和当前权限；排队不冒充正在执行。真实编译 Runtime 与本地合成模型的联合冒烟通过：人工结果未提交时没有执行安排，Agent 前置未结束时后续不调用模型，结束后正常接续。该测试暴露并修复了待准备请求不足一页时游标未复位、导致下一轮跳过已满足条件请求的问题。SQLite／本机 PostgreSQL 的应用全量单测为 800 项：797 通过、0 失败、3 项因外部对象服务端点未配置跳过；类型检查与生产构建通过。本条取代下方较早的 775 项／16 失败作为当前测试状态。

阅读原有六条界面用例已从退役 workspace 接口迁到 Platform 目录、Reader 私库和实际客户端未发送输入；首次合跑四项失败是夹具读取输入时漏了执行身份，界面实际已保存。修正后与正式 Reader 和事项测试合跑 17／17 通过，保留取消高亮、撤销、批注、常见格式、精确选文、翻页不改引用、位置恢复、窄窗和失败不误报成功断言。未连接 Runtime 的保存不冒充已发送消息。内嵌 Electron 冒烟也已改用正式 Platform／Reader／应用包接口，通过真实打包入口的幂等项目创建、PDF 画布与文字层、原位文件读取不导入、原生网页隔离、应用沙箱、刷新及关闭／activate 恢复，并确认没有应用 TCP 监听或旧 workspace／assets 业务表。真实 Runtime IPC 的阅读选文 → Platform 输入 → Objects 交付及 Host 重开幂等复验通过。

剩余三项：旧业务实现及剩余旧流程夹具清理；完整界面与恢复回归；原版 Morphz 本轮打包、实际写入和重启验收。完整 Playwright 套件正在运行，尚不能报告整套通过。上述 Electron 和浏览器验收使用隔离数据，不代替原版窗口验收。未修改已接受 UI，未新增跨节点 Store、文件上报、第三方托管或 Runtime 存储；整体目标保持进行中，代码未提交。

2026-09-30 Agent 新领域接线复验：共享会话测试改走真实 Platform 消息入口、应用私库及 Runtime 来源授权，不再在 workspace JSON 中造输入或交付。保留跨项目默认 Session 的完整历史、独立 Session 隔离、Yao 子执行来源校验、伪造来源拒绝、审批失联和重启幂等断言，并确认传输库没有旧业务表。剧本生成、材料与审查用例改走实际准备记录和领域命令；复现并修复生成中更改风格会偷换固定创作要求的问题，新增按确切元数据版本读取和固定材料目录分页，生成摘要不重复携带正文。补齐现有 Yao Harness 必需的 `reviewPasses`、输出规则及审查数组 schema，提交与资料包共用同一 schema；整批原文校验失败不部分保存，越预算／阻塞拒绝，合法意见重开后沿用原回执。SQLite／本机 PostgreSQL 的固定创作要求与事务专项通过；真实编译 Runtime 的阅读输入 → 本地 Unix 工具 → Objects 交付与 Host 重开冒烟通过，模型供应商为合成夹具，不冒充真实模型质量验收。

本轮类型检查与生产构建通过。启用本机 PostgreSQL 的最新全量单测为 775 项：756 通过、16 失败、3 项对象服务端点未配置跳过；失败由本轮开始的 20 项降至 16 项，剩余集中在剧本 Agent 的旧流程用例，覆盖取消／迟到结果、撤权、来源读取、影响范围、结果恢复及精确版本审批，须继续迁到真实领域并修补实际缺口，不能直接删断言或恢复旧工作区。旧冒烟入口及旧业务实现清理、完整界面套件和原版 Morphz 本轮打包／写入／重启验收仍未收口。未修改已接受 UI、未改 Runtime 存储、未新增跨节点 Store 或普通文件上报；目标保持进行中，代码尚未提交。

2026-09-30 共享入口旧存储回退清理：删除旧 `artifact.read`、HTTP 原件读取和未指定 Platform 对话的订阅路径；正式消息重试／取消、目录授权、图片／附件、OCR 与执行查询在缺少所属领域配置时明确失败，不再回退到 workspace 快照或旧字节表。新增负向测试用陷阱拦截旧读写，验证 11 种调用与两类字节读取不会触达旧库；本地身份、取消、迟到结果和订阅失效测试改用实际 Platform／应用私库。启用本机 PostgreSQL 的全量单测 774 项中 771 通过、0 失败，3 项对象服务端点未配置跳过；生产构建通过。真实 Runtime IPC 的阅读选文 → Platform 消息 → Objects 精确交付与 Host 重开幂等通过；隔离内嵌 Electron 的项目、文档、事项与 PDF 重启恢复也通过。本轮 11 个测试文件、38 项联合界面回归全部通过，覆盖连接设置、听写、消息框伸缩、执行与审批、通知、身份切换，以及百万字 TXT 阅读和完整转写保存；原尺寸、焦点、草稿、确切控制范围及原件不变断言保留。修正的夹具问题包括：待发输入的键前缀必须包含实际身份；并发 Runtime 快照不能修改共享空状态；身份用例必须配置真实应用域。这些不代表全部界面套件或原版窗口已经验收。Agent 工具及其他旧业务实现、剩余旧流程测试和原版 Morphz 的本轮打包写入／重启验收仍未收口，目标保持进行中；未修改已接受 UI，也未扩展跨节点 Store、文件上报或 Runtime 存储。

2026-09-30 原界面导航、外观与身份接线复验：启动台、视觉层级、搜索／通知外观、原生侧栏、紧凑外壳、检查器、通用交互及账号一致性共 8 个测试文件改用正式 Platform／应用域读取与写入，不再访问退役 workspace／command 业务入口；全部 27 项合并回归通过，原尺寸、键盘、焦点、未发送草稿、导航迟到回执及原件不变断言保留。首次合跑有 3 项卡在启动台、2 项未运行：前序用例已在真实 Platform 保存浏览器视图，测试却假定工作台总是启动台外壳；导航助手现通过既有「返回工作空间」再打开启动台，不重置数据、不改变 UI。验收另复现并修复成员名称丢失：私有成员配置的既有名称通过当前身份 bootstrap 传给原界面，不再硬编码为「我」；改名不改变登录凭据摘要或注销会话，撤权仍拒绝访问，返回值不包含登录令牌或摘要。专项 31／31、启用本机 PostgreSQL 的全量单测 773 项中 770 通过／0 失败／3 项对象服务端点未配置跳过、生产构建、格式与差异检查通过；真实 Runtime IPC 的 Reader → Platform 输入 → Objects 精确交付及 Host 重启冒烟也通过。界面中的 Agent 原创／实时消息为受控应用域和 Runtime 展示夹具，不能代替真实模型执行；隔离 Electron 外观验证也不代替原版窗口。其余旧业务实现、旧测试／冒烟以及完整套件仍需清理和验收，原版 Morphz 的本轮打包写入／重启复验未做，整体目标保持进行中。

同轮隔离界面复验：正式消息操作与长历史性能的 4 项 Playwright 回归全部通过；保留窄窗、悬停、键盘焦点、复制与当前授权校验断言。这不代替原版窗口或完整界面套件验收。

2026-09-30 本地旧业务入口与真实联合冒烟收口：删除共享调用协议及 `ApplicationSession` 中的旧 `workspace`、通用 `command`、`message` 入口和 HTTP 客户端映射；本地桥未经 Platform 配置也不能恢复这些入口。原取消、迟到结果、身份撤销、HTTP 404 和领域回执断言保留。目录与原位文件、定向补充测试现使用真实 Platform／应用私库、正式消息投递及 Runtime 授权器；Runtime HTTP 接收、线程与事件由受控夹具提供，不冒充实际模型执行。验收暴露并修复两处幂等问题：已接受的文件输入重试只核对原回执，不因后来撤销文件授权而误判失败；补充 HTTP 回执丢失后重启重试，由 Runtime 对同一 immutable 请求判定是否已接收，不先以线程结束拒绝。身份、项目／对话授权与新文件访问仍逐次校验，相同命令更换输入被拒绝。`test:runtime-ipc` 已改为实际 Reader 导入／选文、Platform 输入、Unix 回调、Objects 原件及精确交付来源，真实编译 Runtime 与合成模型联合通过；Host 重开原件不变、同命令重试不再次调用模型，投递库不创建旧 workspace／assets 业务表。启用本机 PostgreSQL 的全量单测 773 项中 770 通过、0 失败、3 项对象服务测试端点未配置跳过；生产构建通过。仍有 26 个界面测试文件及部分旧冒烟依赖退役夹具，其他旧业务实现残留和原版 Morphz 写入／重启复验未清完；整体目标保持进行中，不修改已接受 UI，不增加跨节点 Store 或普通文件上报。

2026-09-30 旧 HTTP 回退清理与真实身份回归：删除 `/api/workspace`、`/api/commands` 和 `/api/messages` 的旧快照／通用命令处理；即使没有配置 Platform 也不会恢复这些入口，新增 HTTP 404 回归。将共享 Desktop／HTTP 命令回执、CSRF、对象修订冲突、登录、私有附件、项目共享与撤权用例迁到实际 Platform／应用域，并保留原有隔离和失败断言。身份流用受控空 Runtime 传输验证真实 HTTP／授权生命周期，不冒充真实 Runtime 消息执行。启用本机 PostgreSQL 的全量单测 772 项中 769 通过、0 失败、3 项对象服务端点未配置跳过；生产构建通过。消息操作与长历史性能的四项界面回归通过，已完成消息使用正式 Platform 历史夹具，原尺寸、悬停、键盘、复制与权限断言保留。仍有 26 个界面测试文件依赖旧 workspace 夹具；共享本地调用中的旧 workspace／command 业务实现、其余旧路径与完整界面回归还未清完，原版 Morphz 写入及重启复验未完成。整体目标保持进行中，未修改已接受的 UI 布局，未扩展跨节点 Store。

2026-09-30 按最新范围继续验收：内容目录、当前理解、历史消息、失败重试、停止、首字等待、流式标记、未读与返回最新的夹具改为走正式 Platform／应用入口，不再模拟已关闭的 workspace 端点。51 项界面回归通过。发现并修复历史引用冷启动时显示新版标题却标注旧版本的问题：标题按对应应用的精确版本读取，Objects 版本元数据接口统一为 `objects.versions`，不读取正文、不把旧标题另存进 Platform；最多解析当前消息的 100 个去重引用、8 并发，缓存与当前授权目录及 provider 绑定核对。启用本机 PostgreSQL 的全量单测 771 项中 768 通过、0 失败、3 项云对象端点未配置跳过，生产构建通过。原版 Morphz 窗口只读核验了现有文档及项目页“查看全部交流”，能显示完整个人 Session 历史；未向真实模型新发请求，也未重启原版，不能据此声称新修复已完成原版打包验收。仍有 27 个界面测试文件依赖旧 workspace 夹具，旧业务实现清理及其余正式交互、原版重启复验仍未完成；总目标保持进行中，不扩展跨节点 Store 或普通文件上报。

2026-09-30 公开“当前理解”真实执行验收：新增隔离 Runtime／Host／Platform／合成模型联合冒烟。模型先调用真实 `context_tx` 提交项目公开帧，再调用正式 `host_morphz.publish-understanding`；Host 从确切已提交帧读取正文，Platform 保存版本，模型取得成功回执。第二条输入修订同一帧并发布 v2 后，v1 正文仍可按版本读取。`npm run test:platform-understanding-runtime` 通过，未接触原版资料或真实模型服务。此前“仅有预置夹具、尚未证明真实 Runtime 发布”的缺口在此路径已关闭；原版窗口、完整多端恢复与其余旧界面套件仍不能据此称已验收，存储总目标继续进行中。

2026-09-30 正式“当前理解”存储接入：旧 workspace 中的同名文档不再是检查器数据源。Agent 必须先提交 Runtime 的项目公开认知帧；Host 按确切帧修订读取后，Platform 以独立、不可变、按项目授权的版本和幂等回执发布展示视图，不混入应用内容目录。来源目前只接受本项目 Objects 文档的确切版本：Host 验证原件版本，Platform 在发布事务内复核目录归属和类型。已验证 SQLite／PostgreSQL v7 原位迁移、两种后端授权与重试语义、Desktop／HTTP 正式读取、构建与类型检查；应用全量 765 项中 762 通过、0 失败、3 项因对象服务端点未配置跳过。隔离浏览器界面确认检查器从正式视图读取，引用在文档更新至 v2 后仍打开 v1，窄窗及草稿交互 2／2 通过；旧假快照测试的同一有效断言已迁走。此阶段界面测试仅使用隔离中心的受控发布夹具，真实 Runtime 联合验收见上。扩大 Playwright 回归在第 73 项因 10 项失败提前停止，63 项通过、278 项未运行，运行器另报告 1 项非测试错误；已观察到的失败多是退役 workspace／消息模拟夹具，不能推断其余用例通过，也不能为夹具恢复旧入口。原版窗口与完整云端恢复仍未完成，整体目标保持进行中。

2026-09-29 全量界面验收定位与来源修复：在隔离中心启动完整 Playwright 套件，351 项中的前 62 项运行后因 5 项失败提前停止：57 项通过；其中 4 项共用旧 `seedCenter`，直接向已停用的整份 `workspace` 写入，另 1 项用旧 `/api/workspace` 消息桩。没有为测试恢复旧 API。将一条“内容入口／搜索／来源”用例改用正式 Platform、Objects 和导入领域操作；这暴露出 Agent 以发起 Human 的主体 ID 创作时，卡片误显示“作者未知”，现按 Agent 执行身份显示“Morphz生成”，Human 来源仍需主体与身份同时匹配。对应领域单测、正式内容界面和原搜索界面回归通过，生产构建通过。其余旧夹具需逐项迁到真实入口；旧“当前理解”发布仅见于旧工具，正式 Platform 路径尚需单独明确保存方并验收，不能从旧夹具失败直接宣称原版现有理解数据已丢失。完整界面套件仍未通过。

2026-09-29 中心字节实现与并发启动：把实际用于附件暂存、Reader 原件、图片及界面包的实现命名为 `ManagedArtifactStore`，移除代码中的 `NodeArtifactStore` 名称；v1 manifest SQL 内容、Store 身份及原件字节不变，不把它变成跨节点服务。全新 PostgreSQL 库上的全量并行测试暴露 Objects 多个独立 schema 同时安装数据库级 `pg_trgm` 扩展时的唯一键竞态；初始化现以数据库级事务锁串行化该一步。六个 schema 并发启动专项、全新 PostgreSQL 库上的应用全量单测、生产构建、四条正式 Reader／Objects／附件界面测试及隔离内嵌 Desktop 重启均通过。对象服务端点专项仍需单独环境验证；本轮未改原版用户中心，也不代表整体存储目标完成。

2026-09-29 中心受管字节与原版窗口复核：设计文档明确 Morphz 已接收并承诺保存的字节使用中心部署域，本机中心目录或中心对象服务均不需要执行节点之间的 Store 通道；所属 Runtime／应用域仍管理授权和版本，Platform 业务表不保存字节。原版 Morphz 窗口只读检查能打开现有项目文档，事项“全部”及“我的”最终均能显示同一待处理和已取消测试事项；切回筛选时曾短暂显示旧的 0，异步加载后恢复，不能据此认定数据丢失。本轮没有发送消息或修改原版中心。正式内容上下文的未发送草稿回归及旧 `workflow-details.spec.ts` 的批注／截图附件／听写三项已改用 Platform／应用私库；截图保存为未发送消息后刷新仍有附件，目录内容和 Runtime 投递未增加。与事项、表格、Reader、PDF 等正式路径合并运行 16/16 通过。旧界面测试中引用退役 workspace／command HTTP 接口的文件降至 38 个；完整云端灾备、其余旧验收迁移和全部产品流程仍未完成。

2026-09-29 正式表格验收替换旧快照：将 `interactive.spec.ts` 中依赖已停用 workspace 写入的表格录入、未保存草稿刷新、XSS 文本、三种视图、历史版本及只读切换断言迁至 Platform／Objects 正式原件测试，旧测试文件已删除；与事项、文档、PDF、Reader 合并的正式界面回归 12/12，隔离内嵌 Electron 项目／文档／事项／PDF 重启冒烟通过。应用单测在隔离 PostgreSQL 库重跑两次均为 757 项中 754 通过、0 失败、3 项对象服务端点未启用而跳过；首次重跑曾有一次双 Service Host 启动前退出，单独及随后两次全量运行未复现，测试现保留脱敏启动诊断，根因尚未证明。隔离 PostgreSQL 测试库已删除，原版用户中心未改动；仍有 39 个旧界面测试文件引用退役 HTTP 接口，完整云端故障恢复也未验收。

2026-09-29 正式事项与受管附件复核：新增 Platform 事项界面的真实回归，覆盖按日期分组、完成／撤销／刷新后的同一事项版本及写入失败不误报成功；与文档、PDF、Reader 合并运行 10/10 通过。消息附件的未发送字节留在发起 Host，Runtime 接收后由其消息事件保存并供获授权的其他 Host 读取；附件身份、重启与双 Host 预览专项 3/3 通过，不需要为此建立通用跨节点 Store。原版用户窗口及完整云端故障恢复仍未在本轮验收，存储总目标仍在进行。

2026-09-29 阅读正式入口复核：将导入文档的阅读／引用／版本、Markdown 读物的离开与刷新后位置恢复／百万字有界章节、PDF 的画布／文字层／批注／搜索排除测试从旧 `/api/workspace` 快照改为 Platform 目录与 Reader 私库实读，三组共 8/8 通过。修正 PDF 设置中误显示无效字号／字体控件；同一读物的两个视图提交相同进度时，客户端在冲突或结果不确定后核对 Reader 已保存位置，仅在内容一致时确认成功，不吞掉不同位置或权限错误。PDF 测试强制制造过期修订并核对恢复写入，重复运行 3/3 通过；隔离内嵌 Electron 重启与 PDF 设置回归、生产构建、类型检查和格式检查通过。仍有 40 个旧界面测试文件引用已停用 HTTP 接口；原版用户窗口与完整云端恢复尚未验收，存储总目标仍在进行。

2026-09-29 正式入口附件与后端复核：粘贴、文件选择共用的消息附件上传在读取文件前检查类型对应的 6／8／20 MB 上限，错误直接说明限制；应用域服务端复用同一大小规则，避免大文件只显示泛化 HTTP 错误。附件未发送时不创建 Platform 内容或消息，超限文件不发出上传请求；粘贴附件 4/4、附件服务与大小边界单测 3/3 通过。`test:e2e` 现在先构建当前源码，避免误测旧前端包；最新构建后，正式 Platform／Reader／剧本／内容／消息及附件界面回归共 40/40 通过，隔离内嵌 Desktop 项目／文档／事项／PDF 重启冒烟通过。本机隔离 PostgreSQL 测试库参与的应用全量单测 757 项中 754 通过、0 失败；3 项因本机未配置对象服务测试端点跳过，测试库随后已删除。仍有 43 个旧界面测试文件引用已停用的 workspace／command HTTP 接口；原版用户窗口和完整云端故障恢复尚未验收，存储总目标仍在进行。

2026-09-29 Runtime 存储边界清理：撤回未被正式入口消费的通用节点 Store 登记／观察试验接口及其专用迁移、SDK、HTTP 路由、应用桥接和冒烟脚本；保留 Runtime 授权 Session timeline、消息来源和 Execution Target，也保留附件、Reader 原件、图片及 UI 包实际使用的应用域受管字节 Store。下方较早的“Node Store 登记”“远端 Store 路由待接通”是历史阶段记录，不再是当前存储切换的前置工作。Rust 编译、格式、SQLite／本机 PostgreSQL 存储契约 7/7 和消息时间线 HTTP 测试通过；真实 Runtime 的 Platform 消息重启／跨 Host／幂等冒烟通过。应用全量单测 756 项中 753 通过、0 失败、3 项因外部对象测试端点未配置跳过；类型检查、生产构建与正式内容／消息分页界面回归 8/8 通过。目录授权与 PDF 附件两条旧界面测试已改用正式 Platform 入口；其余 44 个界面测试文件仍引用旧 HTTP 入口，不能把整套 E2E 当成已通过。未操作原版用户窗口，也未验收完整云部署；存储总目标仍未完成。

2026-09-29 正式消息验收夹具收口：跨 Host 消息、选文、附件、补充及重试的集成用例现以两个各自独立的 `transport` 投递库运行，断言两边均不创建旧 `workspace`／`assets` 表；它仍通过 Platform 授权读取 Runtime 的同一 Session 历史，不靠旧快照或第二 Host 接管队列。正式内容改名新增界面并发冲突回归：外部修订后，过期保存被拒绝，未提交名称仍留在表单，应用原件不被覆盖。上述两项定向测试通过；旧 Playwright 套件还有多处依赖已停用 `/api/workspace` 的夹具，需要按正式领域 API 更新，不能为测试恢复旧接口。

2026-09-29 存储目标范围修正：用户确认，普通节点文件由 Execution Target 按授权实时访问；Agent 文件操作已有此抽象，面向 Human 的跨端文件浏览如需实现也沿此边界。本轮不建设通用跨节点 Store、节点文件预上报或第二份目录索引。已接收的消息附件、Reader 原件、应用包等仍由各自所属 Runtime／应用域的受管字节后端负责，可物理部署在中心节点；这不把专业正文或字节改归 Platform 业务库。此前记录中把“远端节点 Store 通道未接通”列为整体存储切换阻碍的判断已撤销；保留这些日期记录用于追溯，不再据此扩展 Runtime。下一步按正式 UI／Agent 写路径和现有受管字节消费者逐项验收。

2026-09-29 修正后主路径回归：Reader 三条领域 Host 测试改在正式 `transport` 模式运行，直接断言投递库没有旧 `workspace` 表；Markdown 标注／取消、书籍导入、PDF 范围读取与 OCR 校对重启仍通过，不再靠“旧 JSON 恰好没变化”证明切换。隔离 Desktop 重启冒烟保住项目／文档／事项／PDF 原件；32 条正式 Platform／应用界面用例通过。应用全量单测在本机 PostgreSQL 可用时 759 项中 756 通过、0 失败、3 项因外部对象端点未配置跳过；类型检查与生产构建通过。这些是所列入口的证据，不等于原版窗口全部功能或 Cloud 故障恢复已验收。

2026-09-29 正式 Host 中心身份缺失防护：当同目录已有 Platform 库、应用实例／私库或受管字节 Store，而本机投递库不存在、为空或缺少中心身份记录时，启动现在在写库前拒绝生成新的中心身份，避免把旧项目和原件显示成一个空中心。已有投递库仍可按原身份重开；原版用户中心只读核对身份记录，未被写入或重启。隔离测试先复现误建库，修复后定向 14/14、应用全量 759 项中 689 通过／0 失败／70 条环境条件跳过，类型检查、生产构建与差异检查通过。此项是数据保护，不代表节点 Store 的远端读写已经接通。

2026-09-29 原版普通对话界面复核：对当前运行的同一 Morphz.app 窗口（CGWindow ID 224906）作窗口级截图，实际看到「对话」页中的「你好」及 Agent 回复，旧的 Runtime 能力错误不再显示在该消息上。此前只读核对同一输入在 Platform 本机投递为 `completed`、Runtime 有输入与回复；这次补上了可见界面的证据，没有重新发送消息、修改用户中心或改动 UI。此验收只覆盖普通对话，不代表节点 Store 远端字节路径或整体存储目标完成。

2026-09-29 普通对话能力探测纠错：Platform 原消息已排队时，Runtime 能力接口的临时 5xx／网络失败不再被误判为版本不支持并标记发送失败；保持原命令待发，Host 重启及探测恢复后仍只投递同一条。接口确实缺少 `client_metadata` 时明确拒绝发送，提示改为用户可理解的服务版本信息。真实 HTTP 故障恢复专项、启用本机 PostgreSQL 的应用全量单测 757 项中 754 通过／0 失败／3 项因外部对象端点未配置跳过，类型检查及生产构建通过。原版 Morphz.app 在确认本机没有待发／运行投递后正常重开同一中心，Platform 项目／事项／内容目录计数保持 4／2／3，投递状态计数不变；未代用户重发消息。macOS 拒绝辅助访问，不能把本次进程和数据库检查称为目视界面验收；节点 Store 远程字节路径仍未接通。

2026-09-29 Node Store 虚假提供者防护：Runtime 的 Store 登记、观察和恢复登记现在要求绑定 Node 在当前能力列表中声明 `artifact_store`；执行型 Node 不会因在线就被当作 Store。SQLite／真实 PostgreSQL 存储专项 2/2、Runtime HTTP 授权／能力撤回专项 1/1、Rust 格式与差异检查通过。**仅收紧身份与观察，不构成节点受管字节跨端读写已接通**；当前 Edge 默认不声明 Store 能力，正式数据通道仍待实现。

2026-09-29 Platform 对话本机事件镜像收口：正式会话的输入和回复仍由 Runtime timeline 持久保存、授权分页读取；Host 轮询只在同一事务保存已处理游标、投递状态和因果关联，不再向本机 `runtime_session_events` 追加 Platform 会话的事件正文。旧会话的事件投影维持原行为，既存镜像行不删除。新旧并存、两次重启后续写及既存行保护专项 11/11，本机 PostgreSQL 参与的应用测试 757 项中 754 通过、0 失败、3 项外部对象端点未配置跳过；真实 Runtime 的 Platform 输入／跨 Host 来源／重试冒烟及生产构建通过。此项减少重复持久化，不代表节点 Store 跨端字节通道已接通。

2026-09-29 保存方范围纠偏：复核设计后，删除了未接入正式入口、且错误地把 Runtime 节点心跳当成认知应用可用性裁决的解析器，也撤回了只为该解析器增加的 Platform 节点所有者字段与 v8 迁移。应用原件仍由应用自己的领域 API 和保存策略负责；Morphz 必须接通的是其明确承诺的节点 Store／普通文件按需能力，不是通用应用领域代理。此前对原版中心 v7 一致性副本所做的 v8 升级验证仅证明试验分支未损坏记录，不再作为待发布迁移；临时副本已删除，原库未写入。**节点 Store 的跨端字节读写仍未接通。**

2026-09-29 本机应用实例与私库封存：Objects、剧本、Reader、Browser 四个 SQLite 私库分别保存租户／应用／实例绑定，Host 在 Platform 发布实例路由前完成四库封存。首次启动中断可沿用原实例继续初始化；旧 v1 身份在四库结构核对后一次升级，已封存的完整异实例库或未绑定库不能冒充原件，冷备份也拒绝错库。一次性收藏迁入先建立待封存实例身份，再写 Browser 库；正式 Host 随后封存四库。备份包校验通过隔离副本打开 SQLite，不在封存包中制造 WAL／SHM；活动源库仍读取其现存 WAL。专项 Host、收藏迁入与冷备份 27/27；SQLite／本机 PostgreSQL 应用单测 755 项中 752 通过、0 失败、3 项外部对象端点未配置跳过；类型检查与生产构建通过。原版正在运行的中心四库只读身份核验通过，但尚未重启迁入；节点应用跨端请求路由仍未实现，整体目标未完成。

2026-09-29 本机应用私库防丢失：已有应用实例身份时，正式 Host 启动前现在同时核对 Objects、剧本、Reader、Browser 四个 SQLite 私库均为私有真实文件且具有原应用结构；Reader／Browser 文件丢失、空文件替代或符号链接替代均拒绝启动，不创建空库掩盖原件、标注或书签。原版中心只读校验通过，未重启或改写当前窗口数据。专项 17/17、启用本机 PostgreSQL 的应用单测 751 项中 748 通过、0 失败、3 项外部对象端点未配置跳过；类型检查、生产构建、格式和差异检查通过。此项不替代节点应用跨端路由，整体存储目标仍未完成。

2026-09-29 原版窗口普通对话与 Agent 跨项目验收：截图中的「Runtime 尚不支持对话来源记录」来自仍在运行的旧 Runtime 二进制；加载支持来源记录的版本并修正本机 Runtime 身份核对后，原版 Morphz 的「你好」已收到真实回复。随后发现个人对话的 Agent 项目查询错误地局限于「未归项目」；现仅允许同一实时成员集合的个人对话跨项目查询和操作，项目会话与定时任务仍受原项目约束，SQL 在分页前过滤，创建事项可使用查得的精确项目 ID。原版窗口中 Agent 找到 `TEST Platform 切换验收 0927` 并创建待处理事项 `TEST 存储切换主路径 0929`；Platform 持久事项 ID 与 Runtime 工具回执一致，旧 workspace 正文字节未变。该测试事项随后从界面取消，仍以取消状态保留为测试记录。SQLite／PostgreSQL 应用单测 748 项中 745 通过、0 失败、3 项未配置外部对象端点跳过；类型检查、生产构建与差异检查通过。本轮未改 UI，也不代表整个存储目标或节点应用跨端路由已经完成。

2026-09-29 Desktop 目录按需读取与项目提示校正：非事项页只读 Platform 授权事项汇总，保留侧栏未完成数、项目卡片的待推进数与最近活动排序；进入事项页才分页取事项，消息链接仍可按 ID 打开单个事项。内容目录汇总同时返回当前授权范围内的最近更新时间，项目排序不会因内容目录首屏只加载 50 项而遗漏较早页面的活动。项目删除提示直接按已登记的会话目录计数，不再以当前会话已加载的消息判断其他会话是否存在。未修改 Runtime 或原 UI 布局。SQLite／PostgreSQL 应用单测 739 项中 736 通过、0 失败、3 项对象服务端点未配置而跳过；生产构建、按需目录 Web 5/5、项目管理 Web 4/4 通过；首屏外内容排序 Web 1/1 通过。原版日常窗口与整体存储目标尚未完成验收。

2026-09-29 Desktop 项目目录性能收口：保留原页面与排序语义，把每次项目排序／卡片渲染时对整份展示工作区的重复扫描改为一次聚合，再按项目 ID 读取活动时间和待推进事项数。共享默认 Session 的回复仍按实际输入归属；未知输入不借消息上的项目字段混入活动。逐项目语义对照与事项状态测试 7/7、正式导航界面 1/1、类型检查、生产构建、隔离内嵌 Desktop 重启通过；启用本机 PostgreSQL 后应用单测 739 项中 736 通过、0 失败、3 项云对象端点未配置而跳过。本轮没有改动 `morphz/` Runtime、持久存储模型或 UI 布局；项目与事项冷启动仍会分页取齐导航所需记录（客户端上限 10,000），原版日常窗口也未人工验收，不能据此称整个存储切换完成。

2026-09-29 正式 Host 旧 Session 工具边界：`application/` 的 RuntimeBridge 在 `transport` 模式收到旧工作区 Session 的工具回调时，过去可能落入旧权限范围兜底；现在核对会话身份后、读取旧 `workspace` 前明确拒绝，新 Platform Session 继续走持久输入与 Platform 授权。隔离回归先红后绿，专项 9/9、启用本机 PostgreSQL 的应用全量单测退出码 0、类型检查、生产构建以及真实 Runtime 的 Platform 消息重启／跨 Host 幂等冒烟通过。本轮未修改 `morphz/` Runtime，也不表示旧 Session 已迁移或原版窗口已验收。

2026-09-29 正式界面存储回归复核：搜索弹窗现用「全文搜索」而非旧的「按标题搜索内容」，三条首屏外原件／引用用例原本因过期定位器超时；修正测试定位后，搜索结果打开精确版本、带入实际原文和拒绝伪造引用均通过。扩展运行 Platform 内容、项目、事项、消息分页及 Reader 界面共 27/27 通过。此轮未改变产品界面或 Runtime；这证明所覆盖路径，不代表原版日常窗口、全部客户端或整体存储目标已验收。

2026-09-29 Desktop 切换回归：正式 Platform bootstrap 恢复向客户端声明本机模型设置能力，保留原「模型与账号」入口；未配置 Runtime 或非本机管理身份时不展示不可用入口。修正旧 `/api/workspace` 的界面测试桩，改按正式 Platform bootstrap 验证。模型设置界面 13/13、应用全量单测退出码 0、生产构建、隔离内嵌 Desktop 重启冒烟和差异检查通过。本轮只修 Application Host 与客户端的能力传递，未把 Runtime 远端 Store 路由作为 Desktop 切换前置条件；原版日常窗口尚未人工验收。

2026-09-29 Desktop 存储切换继续收口：正式 Application Host 的 RuntimeBridge 定时轮询只处理 Platform 会话与投递；旧会话和待发记录留在原库，不被正式 Host 重排、发送或拿来解析旧 `workspace` 快照。Platform 补充消息的失败回执也不再以旧输入作兜底。新增旧会话混存、旧待发记录重启和失败回执回归；定向 13/13、应用全量测试退出码 0、类型检查、生产构建与隔离内嵌 Desktop 项目／文档／事项／PDF 重启冒烟通过。本次只改 Application Host，未新增 `morphz/` Runtime 改动，也未改变界面；原版窗口、旧实现整体清理和节点应用跨端路由仍未验收或完成。

2026-09-29 正式旧数据依赖清理：Desktop／Service 的 Platform Host 不再在启动时查询旧 `workspace` 收藏或通知状态、强制先迁移开发期旧数据；Application Host 的旧事项协作轮询也不再让旧待执行事项触发旧快照解析或装载旧调度状态。旧行原样留在原库，不自动删除或并入新权威。删除未被正式入口引用的候选 HTTP 适配器及其替换脚本；原 HTTP 入口不变。旧数据不改写、独立新域可用和定时事项隔离定向 14/14；本机 PostgreSQL 参与的应用单测 735 项中 732 通过／0 失败／3 项云对象端点未配置跳过，生产构建和隔离内嵌 Desktop 重启冒烟通过。本轮未修改 `morphz/` Runtime；旧业务实现仍有代码待清理，原版用户窗口未人工验收，节点应用跨端路由未接通。

2026-09-29 范围纠偏：Desktop 正式存储切换不以新增 Runtime 远端 Store 路由为前置条件；该路由属于后续节点应用／多节点能力，不能替代当前 Platform 与内置应用域的正式入口验收。本轮仅修客户端 PDF／书籍导入的重试确认：同一文件、项目和导入方式在结果未确认前复用命令 ID，目录刷新失败不再清掉该 ID；刷新成功后再次明确导入才使用新 ID。专项 4/4、启用本机 PostgreSQL 的应用单测 734 项中 731 通过／0 失败／3 项未配置云对象测试端点跳过，类型检查、生产构建和隔离内嵌 Desktop 项目／文档／事项／PDF 重启冒烟通过。未修改 Runtime；原版日常窗口未实际操作验收，旧实现清理和节点应用路由仍是独立缺口。

2026-09-29 正式 HTTP 路由再收口：配置 Platform 业务域的 Service 不再提供旧 `/api/workspace` 快照和 `/api/commands` 写入端点，返回 404；同一进程的 Platform bootstrap、项目与文档领域操作仍可用。旧端点仅留在未启用 Platform 的历史测试服务中，尚未从类型／实现中整体删除。正式 HTTP 专项 6/6、隔离内嵌 Electron 的项目／文档／事项／PDF 重启冒烟、启用本机 PostgreSQL 的应用单测 730 项中 727 通过／0 失败／3 项云对象端点未配置跳过，生产构建通过。原版 Morphz 仍运行且本机投递库仅有终态回执，但 Mac 锁屏且辅助访问被拒，未重启或实际操作用户窗口；原中心数据未改动，真实窗口验收仍待解锁。

2026-09-29 正式 Agent 能力发现补齐已接通的 `content.organize`、Reader 和浏览器收藏：`operations.list/describe/invoke` 现在能走现有 Platform／应用域处理器，Reader OCR 只在本机引擎可用时展示；收藏仍从 Runtime 持久输入核验发起者。正式 `transport` Store 即使打开含旧业务表的中心，也在存储层拒绝旧命令、成员、附件、PDF 和读物写入。真实领域测试验证 Agent 经发现入口创建／改名原件、读取可阅读内容目录和保存收藏，旧 workspace 没有新增对象。启用本机 PostgreSQL 的 730 项应用单测中 727 通过、0 失败、3 项云对象端点未配置跳过，类型检查和生产构建通过。本轮未修改 Runtime 或原版日常窗口；节点应用路由、旧实现清理和原版窗口验收仍未完成。

2026-09-29 原版中心只读核对：当前运行的 Morphz 进程确实打开同一 `center` 下的新旧库。旧 `workspace` 尚有 9 个项目、44 个 Artifact、9 部剧本；Platform 现有 4 个项目、3 条内容目录和 1 个事项，项目／内容／事项 ID 与旧对象均无交集。旧字节未删除，但不能称作已迁入新存储，也不能用新入口的少量对象证明旧对象得到保护。最近一份封存的 2026-09-28 11:50 中心备份包含六个关系库和 Reader／图片／消息三个受管 Store；在全新临时目录恢复并校验成功，恢复的 Platform 计数为 4／3／1、旧 Artifact 为 44。原应用持续运行，本次未生成当前时刻的冷备份、未修改或删除原中心，也未对原版窗口作交互验收。临时恢复副本已移入系统废纸篓，可恢复。

2026-09-29 内容整理契约收口：正式 Client 与 Agent 共享单次只改名称、移到已有项目或新建项目并归入三者之一的校验；混合请求在任何原件或目录写入前拒绝，不再误报“应用原件未接通”。新建项目并归入仍是 Platform 单事务；改名涉及应用私库和目录投影，不能与移动伪装成跨域原子命令。正式 Desktop 重启测试不再通过创建旧 `WorkspaceStore` 污染测试目录，而是在项目创建及重启后只读核对旧业务表不存在。专项 39/39、内嵌 Host 6/6、正式内容界面回归 2/2、隔离内嵌 Electron 项目／文档／事项／PDF 重启冒烟、类型检查、生产构建及本机 PostgreSQL 启用的应用全量 729 项中 726 通过／0 失败／3 项云对象测试端点未配置跳过。本次未修改 Runtime、界面布局或运行中的原版窗口；节点应用路由与真实窗口验收仍未完成。

2026-09-29 应用保存方切换缓存校验：Platform 的内容目录现在向 Client 提供应用实例路由修订号；正式 Desktop 即使遇到正文版本号未变，也会在保存方切换后重新读取原件，且不再把旧保存方的历史版本并入新原件。客户端专项 28/28、类型检查、生产构建、启用本机 PostgreSQL 的应用全量测试 729 项中 726 通过／0 失败／3 项云对象端点未配置跳过，以及隔离 Desktop 重启冒烟均通过。此修复只处理已成功刷新目录后的客户端原件缓存；不表示节点应用请求路由、应用数据迁移或原版日常窗口验收已完成，Runtime 未因此增加消息或存储机制。

2026-09-29 内容搜索存储切换：Platform 继续只查已授权目录的标题；Objects 私库新增独立正文搜索投影，创建时仅收录 Agent 原创且非导入的原件，后续人工修订更新同一投影。Human 搜索入口与 Agent `content.search` 共用应用域候选、Platform 当前目录权限／实例／版本核对，不把正文或节点普通文件写进 Platform。旧 Objects v3 的创建者类型无法从原件可靠还原，升级保留原件但不猜测性补建旧正文索引。SQLite 与本机 PostgreSQL 应用域测试、正式搜索面板 6 项界面回归、构建和类型检查通过；应用单测 729 项中 726 通过、0 失败、3 项云对象端点未配置跳过。界面回归使用隔离 E2E 中心，不代表原版 Desktop 人工验收；其他应用正文及节点应用路由仍未接通，存储总目标未完成。

2026-09-28 应用数据保存方校验：Platform 的应用原件授权现在可同时核对当前 `route_kind + route_ref + node_id`；正式 Host 的 Objects、剧本、Reader、Browser 私库及图片／阅读原件字节操作都绑定其启动时实际登记的保存方。实例路由更新后，旧 Host 不再因持有原私库句柄而继续响应读写。SQLite／PostgreSQL 路由专项 3/3、两种正式 Host 的原件保护测试、应用全量单测 724 项中 721 通过／0 失败／3 项云对象端点未配置跳过，生产构建通过。**这不构成节点应用路由已接通**：正式 Host 仍只注册 `service` 实例，节点应用请求转发及原版窗口验收未完成；跨应用域迁移仍须显式停写、迁移、校验和切换，不以一次路由字段更新代替。

## Platform 存储切换纠偏（2026-09-27，未完成）

2026-09-28 路由边界复核：Runtime 的 Execution Target 已通过已认证的 Edge Node 连接执行受权物理工具和 Artifact Transfer；不需要为 Node Store 再建立第二套设备连接。内置 Reader／Objects 等受管 Store 目前由 Application Host 创建，其短期授权在所属应用服务内核验；Rust Edge Worker 不能直接读取这些私库。Platform 已有 `app_instances.route_kind='node'` 的登记模型，但正式应用域只登记本机 `service` 实例，尚无将节点应用实例的领域请求经现有 Edge 连接交给该节点 Application Host 的执行适配器。**节点上专业原件的跨端打开／修订仍未接通**。下一步须以所属应用域的授权命令为入口复用节点连接，不能仅增加 Runtime Store 请求表或把通用 Target 文件操作冒充应用版本提交。

2026-09-28 全新正式 Desktop／Service Host 的本机库只初始化身份、Runtime 投递和浏览器控制回执，不再创建 `workspace` 整行 JSON、旧业务命令及 `assets.bytes` BLOB 等表；已存在的旧表不删除，旧迁移哨兵仍可识别已有数据。正式 Desktop 从空目录创建项目后核对库结构的新增回归 1/1、所在专项 5/5；双 Service／PostgreSQL 真实进程也核对两台 Host 均没有旧业务表，1/1 通过。冷备份／恢复测试已改为从这种无旧业务表的正式库出发，恢复后仍无旧表，并验证 Platform 与内置应用原件及其字节，专项 2/2。应用全量单测 721 项中 718 通过、0 失败、3 项云对象测试端点未配置跳过；生产构建、隔离 Electron 重启，以及真实 Runtime 的 Platform 消息持久投递／跨 Host 定位冒烟通过。**旧业务实现代码尚未全部删除，远端 Node Store 数据路由仍未完成；这不是整体切换完成。**

2026-09-28 节点 Store 补上独立命令回执查询：远端写入或删除丢失响应后，可凭原命令 ID、原始版本前提及写入摘要查询已提交结果；查询重新核验当前 Store 授权和原件所有者，写入回执还要核验受管字节与分块摘要，损坏时不报告为完整提交。未提交、参数冲突、跨所有者、提交失败后重试与备份恢复均有 SQLite／PostgreSQL 测试。Node Store 专项 28/28、应用类型检查与完整单测 720 项中 717 通过、0 失败、3 项云对象测试端点未配置而跳过。**Runtime 到远端节点 Store 的实际请求路由仍未接通**；此回执契约不能冒充跨节点读写已完成。

2026-09-28 冷备份补齐跨域一致性校验：Platform 中标为可用、且由本次备份包含的内置应用实例拥有的内容，必须对应未删除的私库原件；指向其他实例的目录条目保留为外部引用，不冒充其原件已备份。SQLite 备份与恢复额外执行外键检查；PostgreSQL 云备份与恢复按同一实例边界分页核对目录。Objects 图片与 Reader 导入书籍的版本还须对应 Store manifest 的身份、摘要与长度。篡改目录对象、关系或字节版本会被拒绝；测试同时覆盖同类型外部应用实例仍可保留。专项测试及生产构建通过；启用本机 PostgreSQL 的完整应用单测 720 项中 717 通过、0 失败、3 项云对象端点未配置跳过。原中心既有冷备份在独立临时目录通过新外键与引用校验，未改动原版应用或其数据。完整云对象备份／恢复因无测试端点仍未验证；原版日常窗口未验收，节点 Store 的正式跨节点字节读取尚未接线，整体目标未完成。

2026-09-28 隔离 Desktop 重启冒烟发现并修复正式入口回归：`artifactId: null` 是“打开项目内容列表”的合法导航状态，新的应用窗口校验误将其拒绝。现内置和第三方窗口均保留这一导航语义，但仍拒绝正文和草稿写入窗口状态。状态专项 7/7、隔离 Desktop 的建项目→建文档→重启保留文档与事项状态通过；启用本机 PostgreSQL 的完整应用单测 720 项中 717 通过、0 失败、3 项云对象端点未配置跳过，生产构建通过。原版日常窗口和整体存储切换尚未验收。

2026-09-28 Web 健康检查已改为直接读取 Runtime 连接状态，不再为一个布尔值展开旧工作区和整段会话事件；正式 HTTP 与隔离候选适配器保持同一语义。回归测试让完整快照调用直接报错并连续检查 3 次响应；本机 PostgreSQL 已启用的完整应用单测 720 项中 717 通过、0 失败、3 项云对象端点未配置跳过，生产构建通过。此项消除正式请求上的旧全量读取，不等于全链路性能或整体存储切换验收。

2026-09-28 窗口状态补上应用数据边界：Platform 只接受明确的导航字段，第三方便笺正文或草稿不能通过 `saveState` 写入窗口表。便笺示例改为仅在当前窗口暂存，显式「保存为文档」才经 Objects 领域命令持久化；示例包升为 1.2.0，不改变旧已安装包的不可变字节。SQLite／PostgreSQL 全量应用测试 719 项中 716 通过、0 失败、3 项云对象端点未配置跳过；相关界面 6/6、生产构建通过。原版窗口仍未人工验收，整体存储目标未完成。

2026-09-28 应用窗口状态已从浏览器 `application-instances` 写入切到独立的 Platform `app_view_instances` 关系；它与认知应用服务路由 `app_instances` 分开。正式 Desktop 与 HTTP 入口共用打开、保存、关闭及读取命令，按用户和项目授权，具备版本冲突和幂等回执。旧浏览器窗口记录不导入；旧选中 ID 不会遮蔽新存储中实际打开的窗口，应用原件不受影响。SQLite／PostgreSQL 存储专项 50/50、Desktop／HTTP Host 7/7、客户端 28/28、应用界面隔离浏览器回归 4/4 及生产构建通过；全量 Node 测试 714 通过、0 失败、3 项云对象存储端点未配置而跳过。尚未在用户原版窗口人工验收，也不能把窗口状态接线视为整体存储目标完成。

2026-09-28 正式事项编辑补齐：原编辑器的分派状态选择、换负责人后重置为待接受，现经同一 `tasks.revise` 命令写入 Platform 的不可变事项版本；未借修改内容暗改执行轮次。负责人变化不再静默清除已有依赖与关注来源，仍按项目授权、版本和幂等回执校验。Human UI 与 Agent 的修订参数走同一领域操作；SQLite／PostgreSQL 专项、Desktop Host、Agent 路由、713 项应用单测（710 通过、0 失败、3 项云对象端点未配置而跳过）、生产构建和隔离浏览器“保存→重开→刷新”回归通过。未在原版日常窗口验收；其他未接通的正式操作与整体存储切换仍未完成。

2026-09-28 跨 Host 退役安全边界：正式共享 PostgreSQL Service 不再以其中一台 Host 的本机消息投递列表认定全项目已空闲；无法核验其他 Host 在途输入时，归档／删除直接拒绝且不建立退役栅栏。单 Host 流程仍按 Runtime 输入和事项执行状态核验。跨 Host 未完成投递的全局核验尚未实现，故这不是多 Host 归档完成。定向测试验证拒绝后项目版本不变、无残留栅栏和 PostgreSQL 正式 Host 的实际接线；完整应用单测启用本机 PostgreSQL 后 712 项中 709 通过、0 失败，3 项云对象端点未配置而跳过，类型检查通过。另更正存储模型文档中过时的“图片内容写入未接通”：正式图片入口已切到 Objects 私库与独立 Store，Agent 图片生成／上传仍未接通。

2026-09-28 界面回归夹具纠偏：旧 `workspace.spec.ts` 不再假定隔离中心预置「我的项目」，改由原界面创建后执行原有文档、输入、批注、关联与事项断言，3/3 通过。阅读套件中的标注完整操作和常见格式导入两条已改为从 Platform 目录及 Reader 私库核对结果，不再靠旧工作区快照；并发运行的 7 条新存储界面用例、这两条阅读用例及类型检查通过。批注用例通过正式标题查找定位新对象，避免把分页目录第 51 项误判成数据丢失。其余旧阅读／剧本用例仍使用 `/api/workspace` 与旧命令夹具，完整界面回归尚未通过；这轮只修验收路径，没有新增产品能力或完成原窗口验收。

2026-09-28 消息附件跨 Host 补齐：已接受的附件由另一台 Host 按确切 Runtime 输入根读取；当前 Platform 对话授权、消息来源声明、Runtime Event 的名称／类型／摘要和返回字节均逐次核对，不复制发送 Host 的私有附件 Store。未发送草稿仍由上传者本机 Store 读取，Web、内嵌 Desktop 与远端 Desktop 预览传递同一消息来源。隔离双 Host 测试覆盖错误范围／摘要、篡改和两种入口；真实 Runtime 联合冒烟覆盖接受、重启后读取及其他身份拒读。应用生产构建与当前默认环境的 711 项单测已运行：646 通过、0 失败、65 项因 PostgreSQL／云对象测试端点未配置而跳过；Runtime PDF 附件端点专项通过。此项不等于原版窗口或整体存储切换完成。

2026-09-28 核对：剧本 `submit-workflow` 已经由真实 Agent 输入和固定的生成准备约束，写入 Script Studio 私库，并将回执投影到 Platform 目录；普通客户端的旧 `script-command.submit-candidate` 仍拒绝直写，以免绕过来源和人工采纳边界。下文较早阶段把这概括为“候选生成未接通”已过时。全量界面回归当前仍有大量旧 `/api/workspace` 夹具：本轮抽样跑到 107/342 时为 54 通过、53 失败，余项未跑，不能把旧夹具失败直接算作产品失败，也不能称全套界面验收通过。已把 `agent-first.spec.ts` 的未发送不创建用例改为查询 Platform 内容目录及 Runtime 投递；断线用例现在拦截带查询参数的导航请求。四项专项回归通过。原版窗口及完整跨端验收仍未做。

2026-09-28：Host 的正式 Runtime Bridge 启动不再装载本机 Session 的全部事件正文：只按 Session 索引取得持久尾部位置，投递、会话和连接状态照常读取。新事件与投递结算同一 SQLite 事务追加；提交后清空内存中的本轮事件，下一轮只处理新增尾部。旧事件镜像保留在磁盘，只有明确调用旧历史读取时才按需载入；v18→v19 一次性流式提取各投递的最近回复时间及因果 Thread ID，保留共享 Session 合并回复的歧义拒绝规则。运行中的投递重启后凭这些精简关系结算，不靠启动时重放全部旧事件。另将连接配置检查改为只读小型连接 envelope，避免它暗中触发旧历史加载。损坏事件导致升级失败时，事务回滚并保留原投递和库版本。SQLite／PostgreSQL 参与的 710 项应用单测：707 通过、3 项因云对象端点未配置跳过；构建、消息分页正式界面 3 项、真实 Runtime 的 Platform 输入／跨 Host 定位／重启幂等冒烟及隔离 Desktop 重启冒烟通过。**尚未在原版日常窗口验收**，旧历史显式读取仍是全量操作，长期投递数组规模与端到端性能基线仍需单独核查；这不是整体存储目标完成。

2026-09-28：正式对话历史在 Runtime 单页上限之外，Host 单次请求现在最多读取 8 页（每页至多 100 条）；遇到大量已撤权、不可见记录时，返回实际扫描位置的微秒精度续页游标，不为凑满可见消息而扫完整个 Session。本机待投递输入若早于扫描边界留给后页，避免跨页丢失；客户端一次点击最多继续跨过 4 个空的授权窗口，并共享 15 秒总等待上限。新增 450 组不可见输入／回复与待投递混排的专项，验证有界读取及无漏页；构建、消息相关 35 项单测、历史分页／引用／缓存 3 项正式界面回归通过。完整应用测试 708 项：705 通过、3 项云对象端点未配置而跳过。界面回归还修正了测试夹具未拦截带查询参数的导航请求；这不是产品路由改动。**尚未解决 Host 启动时加载本机全量事件镜像**，也不代表旧存储清理或原版窗口验收已完成。

2026-09-28：团队登录会话已从 Host 本机 `identity-sessions` 迁入 Platform 逐会话关系表；旧哈希只作一次性导入，提交后清除本机行，中断后按完全相同记录幂等重试，不保存明文凭据。新的登录、每次 HTTP 请求验权、跨 Host 退出和凭据撤销均以 Platform 为权威。`members.json` 的身份配置摘要、项目成员授权、目录修订与失效会话清理在同一个 Platform 事务提交；移除成员同时撤掉其项目关系，另一 Host 的旧配置不能写回，加载同一份已提交配置时只接纳结果而不重放写入。凭据重新绑定到另一身份再恢复时，旧会话不会复活。本机 `identity-mode` 仅留缺配置时的拒绝启动标记，不再保存会话权威。SQLite／PostgreSQL 的事务、失败回滚和旧 Host 拒写专项，两台独立 HTTP Host 的登录／退出回归、完整应用测试 707 项（704 通过、3 项未配置云对象端点跳过）及生产构建通过。**仍未完成整个目标**：Runtime 历史的服务端有界读取、其余旧写路径清理、原版窗口及完整跨端验收仍缺；本轮未修改原版登录数据。

此前阶段：团队成员配置加载不再调用旧 `workspace` 整体快照写入。既有 `members.json` 的项目授权关系由受信 Host 写入 Platform 的 `project_members`，在单个事务中校验目标、变更成员关系与目录修订；重复加载不制造修订，停用成员撤权，新建项目的创建者不会因尚未更新配置文件而被撤权。配置读取使用成员／项目索引和有界批次，不枚举整个租户目录。SQLite／PostgreSQL 同义测试、正式领域 Host 的旧 workspace 禁写回归、当时的完整应用测试 699 项（696 通过、3 项云对象端点未配置跳过）和生产构建通过。当时团队登录会话仍依赖 Host 本机状态，已由上段切换取代。

2026-09-28：正式事项创建／修订把既有的依赖、关注来源和交付产物写入 Platform 的不可变事项版本关联表，不再因这些字段拒绝原界面保存；Agent 的同一领域工具也接入这些参数。Platform 在事务内核对同项目有效对象、依赖类型、自引用与依赖环；PostgreSQL 按项目串行化关联变更和跨项目移动，防止并发引入环或跨项目悬空引用。SQLite／PostgreSQL 同一组版本、权限、幂等及并发测试通过；正式 Desktop 领域入口验证写入和读回，旧 workspace 未新增事项；Agent 的创建、修订、读回专项通过。完整应用单测启用本机 PostgreSQL 后 696 项中 693 通过、3 项因未配置云对象测试端点跳过，类型检查和生产构建通过。仍保留未接通状态流转的明确拒绝；全文搜索、团队身份状态等其他旧路径尚未因此切换，整体目标未完成。

2026-09-28：原有可编辑表格的创建、修订与 Agent 读写已接入 Objects 应用私库和 Platform 目录；Web HTTP 与 Desktop 本机调用使用同一领域命令，目录投影失败后可凭原回执重试，不写旧 workspace。正式内容界面完成“打开→增加记录→保存版本→刷新恢复”的 Playwright 回归；SQLite／PostgreSQL 的原件版本、权限、回执与补投影测试均通过。完整应用单测在本机 PostgreSQL 下 693 项中 690 通过、3 项因未配置云对象测试端点跳过；构建与类型检查通过。两份本轮专用 PostgreSQL 测试库已删除。此项补齐已有功能，不代表整体存储切换完成；尚未接通的旧路径仍需逐项审计。

2026-09-28：移除已停用、正式界面不再引用的目录导入／自动同步入口及其 Desktop IPC、服务代码和专用样式；不删除用户已保存的来源配置或旧内容。正式 Desktop 项目、文档、事项重启冒烟，Platform 导航／最近内容界面回归，旧 workspace 禁写和消息入口专项均通过；独立本机 PostgreSQL 测试库上的应用测试 692 项中 689 通过、3 项因未配置云对象端点跳过，生产构建通过，测试库已删除。这是清理旧写路径，不代表存储切换完成；团队成员配置仍有旧 workspace 写入，搜索和部分旧操作也尚未接通新领域存储。

隔离 Platform Desktop 冒烟已验证项目、应用原件文档与事项状态在重启后仍可读取；另用数据库触发器禁止旧 `workspace` 行更新，正式 Desktop 创建项目、文档、事项仍全部通过。未触碰原版日常窗口。

2026-09-28 浏览器控制的 Host 本机投递记录已从旧 `service_state` 三份 JSON 改为逐条关系日志，旧回执一次性迁入；重启时未完成操作标记为拒绝／结果未知，已完成回执保留。正式 Agent 工具现在以 Runtime 实际输入证明和 Platform 当前项目授权读取当前 Human 授权的页面，不要求项目存在于旧 workspace；同一次工具调用有限等待页面结果。旧的“伪造 Human 输入唤醒 Agent”写路径已移除，慢于等待窗口的审批只返回待处理回执，**尚无自动继续该 Session 的新 Runtime 机制**。旧回执若无法证明原 Human 所有者，不向新的 Agent 工具开放；可在本机日志审计。正式 Host 的旧工作区快照／搜索／原件读取入口拒绝回退；纯 Platform 域启动只定向检查旧数据迁移哨兵，当前版 Host 重启不再改写整份旧 workspace。旧版本升级时仍执行一次性索引修复，正式新版本启动不为旧测试索引反复重建。完整应用单测（含本机 PostgreSQL）、8 项正式界面回归、隔离 Electron 浏览器冒烟、类型检查及生产构建通过；专用测试库已清理。**原版日常窗口未完成本轮实际交互验收**，此次改动也不等于整体存储切换完成。下段较早记录中的“浏览器 Agent 控制回执仍未切换”已由本段取代。

2026-09-28 正式客户端继续脱离整份工作区投影：保存对象批注按内容 ID 重新核对 Platform 授权与应用归属；修改事项读取 Platform 当前不可变版本后沿原 CAS 命令保存；整理内容按目录 ID／应用对象 ID 授权定位；剧本设置、条目、审阅、候选决定与导出也按应用对象 ID 定位剧本目录，不再要求目标先出现在客户端首屏快照。未接通的候选生成仍明确拒绝，不写旧库。SQLite／PostgreSQL 应用测试 689 项中 686 通过、3 项因未配置对象存储测试端点跳过；生产构建、批注与剧本设置正式界面回归通过。新正式界面用例还验证“创建剧本→加入新项目→目录中的应用对象 ID 不变→刷新后重新打开”。旧 `workspace.spec.ts` 的一条用例仍等待已经不存在的“我的项目”入口而超时；旧 `script-studio.spec.ts` 的剧本归属用例仍从 `/api/workspace` 查新剧本而失败，均不作新存储验收依据。浏览器 Agent 控制回执与唤醒仍依赖旧 Host 状态，尚未切换，本次不以换一张表假装完成。

2026-09-28 Agent 剧本目录查询：剧本列表现在沿用 Platform 同一套授权筛选和计数，再按所请求的窗口分页读取；不再把项目下所有剧本加载进 Host 内存后筛选。SQLite／PostgreSQL 原件与目录集成测试、105 条目录项的跨页窗口回归、类型检查和生产构建通过；完整应用单测 686 项中 683 通过，3 项未配置 S3 测试端点而条件跳过。大偏移量仍须顺序经过前面的目录页；Runtime 历史加载的无界问题也未因此解决。S3 仍是未单独评审的可选实现，不因相关测试存在而成为确定的产品方案。

2026-09-28 Host 启动内存修正：本机 Ledger 读出的事件数组在 Bridge 校验后直接沿用，不再由 schema 校验长期保留第二份全量事件数组；逐条事件形状仍验证，损坏行仍拒绝启动，追加写入仍沿用原数组游标。定向 12 项、类型检查、生产构建和完整应用单测通过（685 项：624 通过、61 项因本轮未配置 PostgreSQL／S3 测试端点而跳过）。**这不是有界历史读取**：Ledger 仍加载所有会话事件，打开历史页仍扫描整段授权会话；跨 Host 消息读取也未因此完成。未修改原版 Morphz 数据或运行配置。

2026-09-28 历史与轮询减载：Host 仍须读取 Runtime Session 的全量本机事件缓存，但构造历史页时不再另外复制、排序全部输入与回复正文；遍历期间只保留请求页最多 100 条候选，流式阶段仍以首次发布身份／时间合并，迟到回复和上一页游标语义不变。运行中投递的结算改为每个 Session 先建立一次 thread→root 因果关系，再遍历终态事件；合并回复可结算多个 root，但不冒认唯一消息来源。130 组双阶段回复的跨页回归、并发因果回归、真实 PostgreSQL 参与的应用单测（684 项：681 通过、3 项 S3 条件跳过）、类型检查、生产构建及历史分页界面回归通过。测试专用 PostgreSQL 数据库已删除。这降低的是每页投影的额外内存和排序工作，以及轮询逐投递重扫的成本，**没有解决启动时加载全量事件或每页扫描全量事件**；真正的有界读路径仍是未完成项。S3 兼容云字节适配器是开发中加入、尚未单独评审的可选实现，不应当作已确定的 Store 协议或 Desktop 默认存储。

2026-09-28 跨 Host 身份与冷备份复核：Service 的 PostgreSQL Platform 部署现在要求显式稳定的中心 UUID；新 Host 使用自己的本机投递库连接同一云端 Platform／应用私库／Store，不再靠复制旧 Host 的 `workspace.sqlite` 获得中心身份。已有本机库若绑定别的中心，启动前拒绝改绑；备份与恢复命令也从同一部署配置读取 UUID，不再另收一份命令行身份。两个真实 Service 进程的正式 HTTP 客户端已交叉读取同一项目、文档与剧本。真实 PostgreSQL 15＋LocalStack 4.4.0 环境的跨 Host 原件读取、冷备份／隔离恢复、损坏及覆盖拒绝测试通过；全套应用测试 682／682、生产构建与工作流检查通过。原版 Morphz 仍从既有中心启动，窗口可见原有事项和 Agent 已连接；这是基本运行检查，不代表多 Host 在线消息入口或完整界面流程已验收。原版数据与安装包未改动。

2026-09-28 云应用存储冷备份补齐：新增停写条件下的一组备份／恢复命令，把单中心的 Platform、四个内置应用 PostgreSQL schema、三个 Store manifest 与 S3 对象字节作为一个校验单位。备份先核对界面包、图片和阅读原件引用的真实 Store 版本；恢复前核对关系归档、Store manifest 和每个 Blob 的摘要，拒绝损坏包及已有 schema／对象 prefix。隔离 PostgreSQL 15＋LocalStack 4.4.0 的备份→新库新 prefix 恢复→重开 Host 读取 PDF／图片／界面包、损坏引用／字节／覆盖拒绝测试通过；完整应用测试 680／680、生产构建通过。CI 的 PostgreSQL 作业已配置 PostgreSQL 客户端和云对象模拟服务。本命令不覆盖 Runtime、其他 Host 的本机投递／附件、客户端草稿和第三方应用，也不证明在线多 Host 或真实云账号灾备；原版 Morphz 中心未改动。

2026-09-28 云对象存储进展：Service Host 在显式配置 PostgreSQL Platform／认知应用私库后，可将界面包、Reader 导入原件和 Objects 图片接到三个独立 PostgreSQL manifest＋S3 兼容字节空间。不同 Host 的本机暂存目录不共享；隔离测试验证第二个 Host 读取同一 PDF、图片和界面包，以及错位置拒绝、云字节损坏拒读、孤立字节隔离和 Store 级备份恢复。CI 的 PostgreSQL 作业加入 S3 兼容服务，使这组测试不能被环境跳过。原版 Morphz 当前仍使用其原有本机中心；本轮没有把原有书籍或图片上传到云端。云部署整体尚未验收：消息附件由投递 Host 管理，PostgreSQL＋云对象的成套部署备份／恢复和真实云账号／故障切换仍缺；不把新字节后端称为存储目标已完成。

2026-09-28 界面包安装切换：Human 确认后，Platform 只保存应用声明、安装者与不可变 Store 版本引用；独立 NodeArtifactStore 保存并校验 HTML 字节。工作台只读取包摘要，打开精确版本时才取界面；Web 与 Desktop 均已接通，冷备份／恢复现在同时校验安装记录和包 Store。修复包摘要被旧完整 Manifest 校验拒绝、`@` 编码后界面路径 404，以及沙箱仅有读取权限却能写入的回归；已测试跨项目写入拒绝。生产构建、671 项应用单测（启用本机 PostgreSQL）与两种包协议的握手／恢复、4 条应用浏览器回归全部通过。PostgreSQL 用独立 schema 验证界面包 Store 与 Platform 重启读取，Platform 和 Node Store 的 65 条 SQLite／PostgreSQL 测试全部通过。原开发中心另做了正常退出后的冷备份并恢复到独立目录，恢复层读取到中心身份、4 个内置应用实例和 3 项内容；原版进程已重开。当前截图接口只能取得桌面背景，不能把这次自动化或独立目录检查算作原版窗口目视验收；大量界面包的分页与云端多 Host 尚未验证。

2026-09-28 会话历史分页进展：Platform 对话接口、HTTP/Desktop 客户端和正式消息列表按输入与回复的统一时间线分页，默认读取最近 100 条；可继续加载旧消息，引用回跳可按需找回旧页，权限版本改变时丢弃已缓存旧页。实时订阅从已持久化的 Session 游标接续，避免首次重放整段历史；消息列表的多处逐条全表查找改为索引查找。200 条同时间戳回复、迟到回复、引用回跳、滚动位置和撤权缓存的定向测试，以及生产构建、类型检查和完整应用单测通过（610 通过，56 条环境条件跳过）。完整 Playwright 套件仍有旧命令接口预期失败，不能宣称全套界面验收通过。**这只是传输和客户端有界**：Host 启动及历史页生成仍读取／扫描整段 Session 事件，长期开启的实时投影也会积累历史；原版窗口本轮未完成可见界面验收。

2026-09-28 补充验收：将原开发中心的冷备份恢复到独立目录后，以独立 Desktop profile 启动当前构建，真实界面只读检查显示 4 个项目、3 项内容和 1 项事项；Platform、各应用库及 Store 的备份／恢复校验已通过。该测试没有写入原中心，也不等于原窗口或云端多 Host 验收。会话历史的批量归属改为每个 Session 建一次因果索引，保留合并回复的歧义拒绝规则；2,000 条合成事件／投递的局部对照约为 0.66 ms 对 58.89 ms，属于同机微基准，不代表端到端 p95。历史首次归一化 200 个模型发布身份时只提交一次本机投递状态，重读不写入。历史仍会一次读取整段会话，真正有界分页及启动时按需加载仍未完成。

2026-09-28 最新进展：正式 Web/Desktop 客户端冷启动改为读取授权内容目录首屏 50 项，再按稳定内容 ID 补当前打开、最近打开和当前会话中明确引用的对象；超出首屏的剧本及其引用原文按应用对象 ID 定位。内容、剧本、阅读书库仍分别在自己的列表上分页，客户端正式路径不再调用 `allContent` 枚举整份目录。已验证首屏外最近内容恢复、剧本卡片按需进度、历史导航、目录搜索及切换范围；SQLite／PostgreSQL 相关存储测试、完整应用测试、生产构建和 11 条正式 Web 回归通过。下方同日“冷启动仍枚举全目录”的段落是此前阶段记录，已由本段取代。当前 Runtime 会话历史的打开路径仍需有界分页；原版 Morphz 窗口尚未完成本轮人工验收，不能据自动化测试宣称整个存储目标完成。

2026-09-28：原「内容」页、剧本工作室和阅读书库列表已改为 Platform 授权分页查询：范围、应用／类型／可用性、标题词与排序在服务端同一查询上执行，UI 每次只呈现 50 项，可继续加载且显示过滤后的准确总数；切换范围会立即撤下旧页。剧本条目「引用项目原文」从全量客户端目录改为同项目分页与标题查找，超过首屏的原作可继续加载，原有版本和引文校验保留。「关联对象」的候选从同项目目录分页查找，已有关联的标题按对象 ID 授权定位，不再因目标没出现在首屏而隐藏关系；超过 50 项的保存、刷新和打开回归通过。分页多取一条判断是否还有下一页，不靠与列表分开读取的计数决定游标，避免并发变更造成后续内容不可达；恰好 50 项时不显示空的下一页入口。修复悬浮输入挡住列表末尾操作的问题，使末尾卡片和加载按钮可滚到浮层上方。SQLite／PostgreSQL 的目录筛选测试、HTTP 客户端及超页正式界面回归通过；原按需卡片／打开、阅读正式界面回归通过，生产构建及全套应用测试通过。**客户端冷启动仍调用 `allContent` 枚举全目录**，最近打开、消息交付、其他引用显示等入口还依赖完整客户端目录；本轮只完成已列页面的有界展示和查询，不能称为冷启动或整体存储目标完成。正文全文搜索仍未接新应用目录，现明确只提供标题查找；阅读书库也只按书名查找，不声称支持未打开读物的作者搜索。

2026-09-28：内容目录的类型／标题词筛选、精确分组计数和「最近修改／最近创建／名称」排序使用同一授权查询；SQLite 与 PostgreSQL 均以确定性游标分页，HTTP 和 Desktop 复用同一语义。项目目录及项目操作提示改读服务端计数，不再为每张项目卡遍历整份内容目录；搜索面板的最近内容按应用与项目有界读取，切换范围会立即清空旧结果，原 UI 结构未改。39 项 SQLite／PostgreSQL 定向测试、601 项应用测试（56 条条件跳过）、生产构建和 12 项相关正式界面回归通过；项目管理旧测试改为验证 Runtime 不可达时拒绝归档、离线输入只保存不发送的现行行为，不再期待旧错误或未获准的归档。原版开发配置完成一次非覆盖冷备份和独立目录恢复；恢复的 Platform、各应用库与对象清单均通过 SQLite 完整性检查，Platform 的项目／内容／事项数量与原目录一致。**正式客户端冷启动仍枚举全目录**，其他目录消费者尚需迁至分页查询，不能据此声称整体切换与全量界面验收完成。

2026-09-28：Platform 内容目录新增按应用 ID、对象 ID（及可选实例 ID）精确定位，SQLite／PostgreSQL 同一授权与冲突语义；剧本从消息／旧位置打开时不再依赖先枚举到该目录项。已缓存的文档与剧本在再次打开时重查当前目录权限和版本；历史前进后退按对象 ID 解析，内容移到另一项目后仍能打开同一获授权原件。SQLite／PostgreSQL 的 v3→v4 升级、Agent 项目范围、39 项定向存储／Host 测试通过；生产构建、601 项应用测试通过（56 条环境条件跳过），8 项当前 Platform 浏览器回归通过。**冷启动仍枚举全目录；有界分页和旧界面测试迁移尚未完成**，不把精确定位称为整体存储目标完成。

2026-09-28：剧本目录投影现只使用 Platform 已登记的对象身份、归属和版本，不在冷启动时逐部读取剧本应用摘要。内容目录和剧本工作室的卡片进入可视区域时才读取简介／进度；打开剧本仍单独读取完整原件，并核对目录与原件身份和版本。身份变化清空摘要缓存。655 项应用测试中 600 通过、55 条环境条件跳过，生产构建和 4 项按需读取 Web 回归通过；原版 Morphz 重载后，两部既有剧本的内容卡片、工作室列表和返回事项页面均实际可见。**仍未完成目录分页**：客户端冷启动会枚举全部授权内容，现有 10000 条上限与列表 DOM 规模仍是后续性能工作，不能把本次减少摘要请求称为整体性能目标完成。

正式消息入口已接通网页与工作台界面的选文：同一项目或访问成员完全一致的项目可发送；撤权、未知项目和跨受众引用被拒绝。网页／界面选文由 Client 提供，Host 没有持久原件可核对，因此给 Agent 的文本明确标为“来源原文未核验”，不附带网页控制权。定向消息／引用测试、类型检查、生产构建和全套 648 项应用测试通过（594 通过、54 条环境条件跳过）；尚未在原窗口发送真实网页选文验收。Runtime 仍是消息和 Session 的权威；各 Host 只负责自己的本机投递与重试，另一 Host 不接管它的队列。此处不需要在 Platform 重建消息库或增加跨 Host 投递恢复。

未连接 Runtime 时，正式消息入口将未发送输入按当前中心、用户与身份保存在客户端；项目命名对话的首条输入仍是可恢复草稿，不会因保存而在 Platform 建立对话。恢复连接后，发送按钮用原输入 ID 调用 Platform 消息准入；已由 Runtime 接收的失败输入才走服务端重试。修正了本机保存与重发使用不同身份范围键的问题。构建、648 项应用测试（594 通过、54 条环境条件跳过）及三条正式 Web 回归通过；回归覆盖刷新恢复、服务器端无空命名对话、重连后原 ID 发送。不把拦截式重连回归当作真实 Runtime 恢复验收。

正式界面的冷启动应用原件读取现共用 8 路并发上限，避免目录有大量对象时同时向 Host 发出全部读取请求。事项列表只读取首版与当前版；打开事项时再补齐完整版本历史，原版本菜单不变。定向并发／按需历史测试、真实 Web「列表无全历史请求→打开事项→版本菜单」回归、全套应用测试（591 通过、54 条因当前环境缺少 PostgreSQL 等条件而跳过）、生产构建及隔离 Platform Desktop 重启冒烟通过。**仍未实现有界目录页面加载**：冷启动仍枚举全目录并读取每项内容或剧本原件；本轮降低请求峰值和事项历史读取量，不把它称作性能目标完成，也未在用户原窗口手工验收。

正式消息现在还可引用剧本工作室的已保存条目、不可变候选稿和明确标记的未保存编辑草稿。已保存引用按当前 Platform 目录权限进入剧本私库，核对剧本、条目／候选、基准版本、标题与原文；候选只读取该候选，不加载整部剧本。草稿作为用户提供的编辑中材料，不伪装为已保存原文。SQLite／PostgreSQL 的候选读取与权限测试、Host 实际消息入队／伪造来源拒绝测试通过。网页和通用界面来源仍未接通。

正式消息入口现可校验文档和读物的选文引用：文档核对 Objects 中获授权的确切版本与原文；读物核对 Reader 私库中的章节、来源标识和有界选文片段。客户端提供的位置只是定位信息，不能凭它伪造引用或扩大读取权限。针对性引用测试、SQLite／PostgreSQL 全套 643 项应用测试、类型检查和正式阅读界面隔离回归通过。网页及通用界面来源尚未接通；这不表示整个存储切换已完成。

通知候选现直接从 Platform 当前事项及不可变版本推导，按当前用户的项目成员资格读取，通知进入时间取连续相同阶段的首个版本；改标题／说明不重新提醒，离开后再进入会产生新提醒。偏好与已读仍在 Platform，正式通知界面不再读取旧 `WorkspaceStore` 事项快照。SQLite／PostgreSQL 的候选、版本及隔离测试、正式 Web 创建事项→通知→刷新→打开原事项、全套 643 项应用测试、生产构建和隔离 Desktop 主路径冒烟通过。旧测试事项不会因为仍留在 workspace 文件里就重新出现在新通知中；本轮未在用户原窗口手工验收，也不代表其他尚未接通的入口已经完成。

Platform 目录增加与命令回执同事务推进的租户修订号；个人空间首次创建也推进一次。正式客户端先完成首次初始化，再读取修订号；轮询中目录未变时复用已授权的目录投影，导航和消息均未变的空闲轮询也不再重复解析、序列化整份工作区正文。身份切换会清空缓存，幂等重试不制造新修订。SQLite／PostgreSQL 的旧 schema 升级、修订隔离和重试测试，正式 Web 定时刷新请求计数回归、全套应用测试和生产构建通过。**冷启动仍会读取全部目录及应用原件**，当前目录适配器仍有 10000 条上限；此项只消除未变化时的重复工作，不等于已实现按页冷加载。

Runtime 桥的本机投递表不再把全部历史事件正文复制到第二份内存 Map；追加事件只处理新尾部，重启后也不重新序列化已有事件。替换／截短历史时仍逐会话从持久表校验，保留原子事务和原有 Session 结果。新增千条历史的重启追加回归，类型检查和 SQLite／PostgreSQL 全套应用测试通过。**这只降低桥的重复内存与写入工作**：启动仍把所有历史事件加载进活跃桥，当前会话历史和工作区展示适配器仍会全量读取，尚不满足有界分页目标。

原内容页的「关联对象」现写入 Platform `work_relations`，从当前对象按页读取，不再读取空的旧 workspace 关系快照；刷新可恢复并打开关联目标。Agent 的同一操作绑定实际输入项目，不能拿别的项目对象建立关联。SQLite／PostgreSQL 的授权、幂等、分页和跨项目拒绝，Desktop／HTTP Host、Agent 路由及原界面隔离浏览器回归均通过；全套应用测试与生产构建也通过。此项不改变 Cognitive App 原件归属，且不代表全部旧 UI 操作已切换。

Service Host 的认知应用私库现可整组使用四个独立 PostgreSQL schema，显式部署 ID 固定跨 Host 应用实例身份；各 schema 的随机绑定 ID 固定在 Platform 实例路由，误连另一组空库（包括只换 Browser 库）会拒绝启动。本机已有私库、目录指向不同实例，以及另一 Host 缺少已有书籍／图片字节时也拒绝静默切换。隔离 PostgreSQL 测试实际跨两个 Host 读取同一 Objects 原件，验证身份错配与缺字节保护。Platform 和应用可以物理共用 PostgreSQL 服务器，但仍各守 schema／迁移边界。图片、书籍及附件字节仍在本机 Node Store，云端对象字节路由尚未完成，不能据此声称多 Host 云端部署已可用。

消息引用发送现按输入 ID 找到获授权的投递，再从 Runtime 精确读取被引用的事件 ID，核对它与原输入的因果归属、时间和实际选文；无效事件返回不可用，Runtime 不可达则保留可重试错误。发送一条引用不再构造整个会话的消息历史。Host／Runtime 模拟入口回归包含“全历史读取被禁止”的断言；隔离真实 Runtime 冒烟验证原始输入的精确来源在投递及重启后均可读取。当前会话打开时的完整历史仍无分页，不能把引用路径的优化当作历史列表已优化。

Host 的 Runtime 投递状态已从单行 JSON 拆为按输入、会话、事件、发布身份和 Thread 绑定的关系行；旧库升级在同一 SQLite 事务中搬迁原投递和事件，不重发输入。正常事件追加只持久化新尾部，投递状态变更只更新对应行；`runtime_state` 仅保留小型连接状态。632/632 应用测试（SQLite／PostgreSQL 环境均参与，0 跳过）、生产构建、隔离 Desktop 主路径和真实 Runtime 消息／附件重启幂等冒烟通过。**这只是本机 Host 传输存储的拆分**：桥仍会在启动时读取所有历史事件和投递到内存，消息历史没有有界分页；云端多个 Host 也不能共享这个本机库，项目退役仍只有单 Host 安全证明。未在原 Morphz 窗口手工验收，不把这一步称为整体目标完成。

正式客户端的「停止生成」现按 Platform 输入来源查找同一条 Runtime 投递：只允许原发送者在仍有权读取该对话时停止，排队输入不发往 Runtime，运行中输入按确切 Session／root 执行停止；不再查询旧工作区输入。Host 调用与 Runtime 根级取消均有回归测试。

原内容界面的选文批注已切到 Objects 私库：写入固定原件版本、引文、作者与稳定命令回执；选中对象时分页读取批注，重开仍可见。Agent 从真实 Runtime 输入经同一应用命令写入，不再回退旧 workspace。SQLite／PostgreSQL 全套应用测试 619/619、构建、真实 HTTP 入口及原界面隔离 Playwright 保存／重开回归通过。当前原 Morphz 窗口尚未人工验收；内容改名等其他正式操作仍有未接通项，整个存储切换未完成。

正式消息刷新不再每 5 秒重取当前会话的全部正文：Runtime 导航返回绑定当前主体、可读项目、投递状态和 Session 事件游标的失效标识；Client 仅在标识及会话范围均未变化时复用当前历史，新事件或授权范围变化会重新读取。原界面未改。新增缓存范围／事件失效测试及正式 Web 入口的轮询回归、类型检查、生产构建、SQLite 应用测试（567 通过、46 条条件跳过）、PostgreSQL 15 独立测试库全套 613 项（613 通过、0 跳过）及隔离 Desktop 主路径冒烟通过；专用测试库已删除。当前仍每轮拉取 Platform 导航目录，Runtime 桥的投递状态仍为整行 JSON，不能宣称全链路性能完成。另有 12 条旧 Playwright 用例仍向 `/api/workspace` 注入历史或调用已停写的 `/api/commands`，在新主路径下失败；这些旧夹具需改为真实 Platform 接口，不恢复旧写路径，也不把这批失败解释成现行消息路径已验收。

正式阅读入口的 PDF OCR 已接入 Reader 私库：识别和人工校对追加不可变页版本，原 PDF 仍由受管 Node Artifact Store 保存，Platform 只保留书籍目录；重启后可读取校对版本，不写旧 workspace。Agent 经真实输入的 Platform 授权调用同一阅读服务；后台步骤逐次重新核验输入归属，模型下载仍须用户在阅读器确认。类型检查、生产构建、SQLite 环境应用测试（567 通过、46 条条件跳过）、本机 PostgreSQL 15 独立测试库的全套 613 项（613 通过、0 跳过）、2 项正式阅读界面回归和隔离 Desktop 冒烟通过；独立测试库已删除。OCR 引擎的真实模型识别质量和当前原窗口尚未验收；整个存储切换仍未完成。

原事项看板的跨状态拖动现将状态修订与选中事项的顺序调整作为一条 Platform 事务提交；复用与单独安排一致的身份、负责人、依赖和版本校验，重复命令只返回原回执，陈旧版本或无权操作不会留下半次排序。原 UI 不变。SQLite 领域测试、Desktop／HTTP 领域入口测试与全套 611 项应用测试（565 通过、46 条环境条件跳过）、类型检查和生产构建通过；PostgreSQL 测试因本机未配置服务跳过，不据此宣称已做该后端本轮实际验收。其他尚未接通的正式操作仍需继续切换。

图片内容的正式入口已切到 Objects 应用私有存储：上传字节进入独立 Node Artifact Store；原件与不可变版本在 Objects 库，Platform 只记录内容目录。原 UI 的上传、创建、修订和按摘要预览不变；未绑定内容的上传不能凭摘要公开读取，读图复核当前目录权限与 Store 字节摘要。图片目录投影可从应用回执恢复，冷备份和恢复包含该 Store，损坏 Blob 拒绝恢复；已有图片时 Store 缺失则拒绝创建空 Store 遮盖原件。新增摘要查询索引通过原子 schema 迁移添加到已有 Objects 库，不重写原件。针对性 Host／真实 HTTP／备份测试、全套 610 项应用测试（564 通过、46 条环境条件跳过）、类型检查、生产构建和隔离 Desktop 冒烟通过。尚未做当前原窗口的鼠标验收；Agent 的图片生成／上传能力也未接新存储，不宣称整个切换已完成。

消息附件已接入正式 Desktop／Web 入口：上传先进入独立的受管 Node Artifact Store（关系 manifest＋文件字节），草稿只保留内容引用；Platform 输入入队校验原件和身份，Runtime 发送前按引用读取、验证摘要并上传到其 Session 附件暂存，消息事件继续由 Runtime 持有。原工作区的 `assets` BLOB 不再接收新消息附件。历史回显保留确切附件引用，读取前复核当前对话权限；冷备份同时包含该 Store。上传、HTTP／Desktop 预览、重复投递、重启及备份恢复已有自动回归；隔离真实 Runtime 验收又核对了消息绑定的原始字节、重启重试和跨身份拒读，并修正附件字段顺序导致的幂等误冲突。未进行原窗口人工验收；旧输入的资产路径及其他未切换操作仍未完成，不能据此宣称整体目标完成。

Runtime 桥保存投递进度不再读取并重写旧 `workspace` JSON，也不增加业务工作空间修订；正式 Client 的消息与目录刷新各走现有独立路径。结构回归、606 项单元／集成（其中 46 项条件跳过）、隔离 Desktop 和真实 Runtime 消息验收通过。桥自身仍把投递状态保存为 `runtime_state` JSON，正式界面仍构造旧 `Workspace` 形状作为展示适配器；这两处还不是目标中的按实体有界模型，不能把移除一次写放大称作完成迁移。

曾把正式挂载入口错误地替换成只有部分功能的简化 `PlatformApp`，导致原有阅读器、剧本工作室、浏览器和旧内容暂不可见。这不是数据模型切换的必要结果，而是把界面重写与数据迁移混为一谈。该入口及其专用 UI、烟测已撤回；原 Morphz 窗口已重新加载原 `App`，旧项目、消息和剧本工作室入口实际可见，旧数据未删除。

现已保留原 `App` 界面，将项目、事项、内容目录、对话以及剧本工作室的读取改为 Platform 目录与所属应用原件；新建项目／事项／文档／剧本／剧本条目、人工正文修订及已有候选的采纳／拒绝已逐项接入领域命令，不再通过旧 workspace 写入。原事项列表的纯排序经 Platform 事务保留未选中事项的位置，跨状态移动仍未接通。剧本完整编辑态按单部剧本读取，未变目录版本复用前次投影；正文修订在应用私库事务中新增不可变版本并使受影响的下游审阅失效，Platform 仅凭原件回执更新目录，目录失败可按同命令恢复。候选决定沿用剧本私库的同类事务与目录投影；投影失败的原命令 ID 会留在客户端供安全重试。Agent 已可从真实输入范围经同一领域服务创建剧本和空条目，并按确切版本分页读取；不能绕过候选决定直接写正文。HTTP 与嵌入式 Desktop 共用同一业务接口。此切换**尚未完成**：新候选生成及审阅、部分事项安排、其他认知应用写入，以及 Agent 其余剧本操作仍有未接通项；界面明确拒绝这些操作，不能把当前可读取或可保存正文称为完整验收。旧测试数据未作为继续保留旧写路径的理由。

范围见[桌面能力实施路线](./12-desktop-capability-roadmap.md)。四轮作为一个目标实施，已完成本轮 macOS 开发版验收。最后一项系统截图选区、预览与保存于 2026 年 9 月 8 日通过；这是开发交付，不是正式发行包或所有平台验收。

## 继续自动化：OCR 顺序、资源释放与草稿恢复（2026-09-24）

修正横排同一行因检测字框微差而乱序、PDF 物理尺寸较小导致 OCR 分辨率不足，以及 OCR 窗口关闭后隔离分区回调仍持有 PDF／模型缓冲区的问题。直接释放已结束任务数据，不加入生产强制 GC。当前窗口的草稿归属不再被旧地址覆盖，引用／意图计入有效草稿；没有新增兼容分支。

405 项单元集成、23 项阅读界面、构建、生产嵌入入口和草稿完整重启通过。150 轮阅读／OCR 循环发现的原生缓冲区保留已有红测和修复后 12／60 轮实测，六页合成 OCR 通过；两页真实古籍有所改善但质量仍未通过。原窗口四条引用已按原值恢复并复验重开，最初一次同窗口空值的根因尚不能完全归于已修复的旧地址缺陷。新增 CI 回归在本机运行，远端未运行；无付费请求或 Runtime 重启。证据及未完成边界见[专项验收](./reader-ocr-stability-acceptance-2026-09-24.md)。

## 继续验收：阅读、PDF 与统一选文（2026-09-24）

修复 Host 工具说明残留的「不剧透」要求，以及阅读入口允许 32 MB、PDF 解析仍限 20 MB 的不一致。直接纠正定义，不保留旧策略分支。更新生产 Desktop＋真实 Runtime 的选文测试，使其走当前统一就地评论与共享发送流程；核对持久化来源、评论和同一 Session，不恢复旧 UI。

397/397 单元集成、23/23 阅读／PDF／评论界面及生产构建通过；104 万字合成读物有界加载、末章跳转、刷新恢复通过。本地真实 OCR 与公开古籍扫描样本可运行，但古籍存在印章杂字、姓名和繁体识别错误，质量未通过，不能称为全部阅读验收完成。原 App/profile/center 与同一 Runtime 已正常重载，91 条原输入和全部工作区集合、原四条引用草稿、凭据与配置保留。详见[本轮证据与质量缺口](./reader-followup-acceptance-2026-09-24.md)。本轮无付费模型调用、推送或发布。

## 本轮整体整改：剧本创作体验（2026-09-23）

纠正宽屏目录的伪折叠：实际可见状态与按钮同步，宽屏可收放并保存偏好，窄屏使用覆盖式目录，不挤走正文；关闭后恢复有效焦点。合并重复的标题／位置行，候选改为横向切换，消除第二条常驻侧栏。正文编辑区随剩余高度伸展，保留手动伸缩；保存、恢复历史、编辑简报和重新下载沿用明确的主次控件样式，不把操作伪装成正文。

候选序号不再混同可采纳数量：页签只计有效待选稿，过期稿标记旧稿并保留比较，采纳后明确指出已保存的正文版本。可选人工审批移至审阅页，显示真实审阅人和操作后果，仅显示当前状态适用的动作；没有新建审阅分派／通知或声称完整多人协作。普通创作保存和 Word 导出不要求先审批自己；新增创作副本用途，正式交付仍校验有效审批与锁稿，二者均沿用版本固定、权限和历史回执。

原窗口实测另复现系统保存取消后的焦点被通用命令恢复到正文标题：导出现在由完整原生保存生命周期负责焦点，延迟保存夹具先红后绿。结果提示移出工具按钮行，避免按钮横向跳动，可关闭但不删除历史。

最终构建／类型检查、367/367 单元集成和 18/18 界面回归通过，含四主题明暗及真实 200% 缩放。原窗口完成创建、保存、草稿恢复、目录、候选阅读、TEST 审阅锁稿／解锁和真实 Word 保存。最后一轮曾被 Mac 锁屏阻断；解锁后最终构建原生保存全流程复跑通过，原窗口也已刷新确认最后的控件样式、取消后焦点和可关闭导出提示。最终原 8 部剧本及所有原项目、会话、输入、内容与配置保持不变，窗口回到原候选 7；本轮整体整改及验收已完成。

逐项验证、原窗口测试样例、文件与数据保留证据见[本轮验收记录](./script-studio-ux-acceptance-2026-09-23.md)。2026-09-24 提交前重新通过构建、396/396 单元集成、17/17 剧本界面及一套原生保存流程，并复验原窗口目录和导出取消。剧本改动单独作本地提交，不混入网站工作，不推送或发布。未重新评定模型创作质量，也不把结构／界面测试作为专业编剧质量或多人协作验收。

## 本轮新增：已有 API 连接可以编辑（2026-09-23）

设置 → 模型与账号 → API 连接增加「编辑连接」，可读取并修改 Base URL、替换 API Key，不必重新添加账号。地址和密钥分别显式保存；留空不覆盖原密钥，原密钥不回显、不进入 Renderer 持久化或操作日志。保存不切换默认模型、不请求模型、不重新发送已有输入。OAuth 仍走原授权流程；外部命令／钥匙串等非托管凭据源明确提示在原源更新，不伪造可编辑状态。修改共用地址／密钥前列出影响账号并要求确认。

Desktop 仍经共享应用服务与原 Runtime 通信，不打开 Dashboard。新增 Runtime SDK/API 的连接读取／地址更新／凭据更新契约，只返回白名单元数据；沿用 operator 权限，gateway 凭据不获管理权。已有账号、provider、route 和 secret 身份保持不变；更新带版本校验和写入互斥，冲突保留表单并可重新载入。不用首次配置接口覆盖已有凭据，也不创建轮换后的孤立密钥。

类型检查、366/366 单元集成、13/13 模型设置界面回归通过；Runtime 专项验证鉴权、敏感字段剔除、不安全地址拒绝、配置与模型保留、原密钥位置替换、共用范围和并发旧版本冲突。真实 Runtime + 生产 Electron IPC 隔离验收验证了改地址、换密钥后的实际模型读取／显式测试，以及重启后继续使用新地址和密钥；配置保存本身没有访问模型服务。覆盖窄窗和原生 200% 缩放。日志：`/tmp/morphz-api-hot-key-green.log`、`/tmp/morphz-api-settings-ui-final.log`。

额外复现并修复「已经用过的连接换密钥后仍复用旧认证客户端」：红测实际返回 401，现客户端缓存核对 Secret Store 的进程内写入代次，后续请求重新解析凭据；旧在途构造不能重新污染后续请求，缓存项数量保持有界，不重放正在执行的请求。29/29 路由专项通过，覆盖共用密钥账号、复用、轮换、撤销及旧构造晚到；桌面隔离验收在已预热连接上只更新密钥、不重载目录或重启，真实后续请求使用新密钥成功。失败／通过证据为 `/tmp/morphz-api-hot-key-{red,green}.log`，路由日志为 `/tmp/morphz-api-routing-tests.log`。

原 Morphz 窗口已验证「编辑连接」→ 修改地址草稿 → 返回 → 重开，原地址不变，密钥始终空白且未提交。Runtime 更新时发现默认构建没有桌面所需 `experimental-session-io`，补齐此编译特性后已恢复原 18089 服务和所有原编剧包；启动沿用已有持久凭据源、原数据库、配置和 Host 工具。原 75 条输入及文档／剧本／会话／项目与在线备份一致，配置文件逐字节不变。本轮未修改真实 API 连接或发送模型请求。

热更新缓存修正后，用包含上述编译特性的最终二进制正常更新同一 Runtime；停止前再次检查无在途任务并在线备份。原连接元数据、配置文件、编剧包及全部创作数据均与重启前一致，原窗口仍显示同一候选。最终本机核验记录：`/tmp/morphz-api-hot-key-live.sdTO4n/verification.json`。

## 本轮修正：候选页以阅读和决定为主（2026-09-23）

候选页原来连续展开所有备选稿，将长篇生成说明放在正文之前，又混入作用于正式稿的提交审阅、批准和锁稿按钮，导致操作对象不清。现按候选编号、时间、字数与决定状态切换，一次阅读一份完整候选。默认展示正文；差异对比、其他字段变动与创作说明／自审记录按需展开。保留原始版本和引用追溯，不截断正文或隐藏变更。

「采纳为新版本」使用明确主按钮，「拒绝候选」使用有边界的次按钮，状态与说明不伪装为控件；正文页生成／改写和审阅流程按钮同时补足控件外观。候选页不展示保存正式稿或正式稿审批按钮。采纳仍走同一领域命令、权限和版本校验，不能绕过锁稿、过期引用或未保存草稿；采纳之后不跳到另一份待决定候选，提供「查看正文」。本轮不改变生成、审阅或锁稿规则。

最终类型检查及 366/366 单元集成通过。相关 29/29 界面回归通过，包含候选切换、键盘、采纳后焦点、过期阻断、正式稿审阅锁稿、实际 Word 导出，以及明暗主题和 480/760/1440 窗宽；既有四主题／200% Electron 回归仍通过。日志为 `/tmp/morphz-api-candidates-{unit-final,ui-final}.log`。

在原 `/Users/shafreeck/Applications/Morphz.app`、原 profile 和中心中正常重开，实际检查已有 TEST 剧本候选 7 与候选 6 的正文切换、对比展开及按钮层级。原窗口留在候选 7。未采纳／拒绝任何真实候选，未发送消息；读库与本轮在线备份对照，原 75 条输入、项目、会话、文档和全部剧本数据保持不变。

提交记录（2026-09-11）：按用户要求，将本轮视觉与动效升级、项目默认入口、首条输入创建会话及配套测试／规范汇总为 `codex/desktop-ux` 分支的本地提交，不推送、合并或发布。下文“尚未提交”保留各轮验收当时的状态；热更新前端退出根因仍未定位，不因提交而标记为修复。

## 本轮接通：Agent 共享操作接口与剧本纯聊天生成（2026-09-22）

新增 `host_morphz operations/list|describe|invoke`，从实际领域参数 Schema 注册内容、事项、项目、会话、浏览器收藏及剧本等已有操作，发现与执行分离，仍由原处理器校验身份、版本、权限和回执。没有把按钮点击包装为业务工具，也没有新增一套工作流引擎。完整范围及仍未实现的 Human 决定桥接见 [共享业务能力](./29-agent-operable-cognitive-applications.md)。

剧本准备由 GUI 和 Agent 共用 `prepareScriptGeneration`。普通输入可查找目标，读取确切版本，固定递归依赖和预算；准备单独持久化，不改写原输入或伪造人工消息。1.4.0 Yao 判断讨论／执行后，在准备 infer 内使用真实工具，再进入创作、自审、按需修订和受控提交；讨论不写入，保存候选不等于采纳。修复了实际执行中发现的 Yao 子线程工具无法关联原输入的问题：依据 Runtime 自己记录的 Plan infer 事件验证父执行链，核对同一 Session／Context／principal／Agent 并拒绝循环，而不是信任模型捕获值。

构建、365/365 单元集成、17/17 剧本及交付界面回归通过；真实 Runtime＋固定测试模型跑通 13 个场景（68 次模型请求），包含完全无应用实例／无 `scriptGeneration` 的能力发现、选择 Harness、准备和保存；原生成链 16/16 强制中断恢复点通过。新增准备的持久重开、重试、冲突、取消与撤权有专项测试；尚未对准备 infer 的每一个中断位置做完整矩阵。日志：`/tmp/morphz-chat-{tools-unit-tests,e2e,runtime-test,recovery}.log`。最后回执补正的构建、全量测试、Runtime 复验在 `/tmp/morphz-chat-receipt-{build,unit,runtime}.log`。

原 `/Users/shafreeck/Applications/Morphz.app` 已加载本轮构建，沿用原 profile、中心和模型凭据；确认没有在途投递后正常重启已有 18089 Runtime，并安装精确 1.4.0 包。备份位于中心 `backups/workspace-2026-09-22T15-00-06-075Z-e4d612b0.sqlite` 和 `backups/runtime-before-chat-operations-20260922.sqlite`。未创建第二套 Desktop 或替换身份。

第一条原窗口真实 `gpt-6-astra` 普通聊天测试 `537a956e-6a10-48ac-8956-a8f0910d1552` 未带应用或生成绑定，自动准备「TEST 专业编剧 Harness 验收 0919」的分场 v1／父集 v2，实际完成创作与一次自审，保存候选 `d3dcef20-7212-51d4-8332-6b86463062a0`。点击消息中的结果卡片打开了该候选，正文与依赖可见，未覆盖正式稿。此轮同时发现模型误称“没有链接”：Host 的 Yao 提交回执只返回保存记录、未返回 UI 交付。现回执增加真实 `deliveries` 和 `message-result-cards` 展示说明，不编造 URL，不改写已发消息；原窗口复验另记。

最终原窗口复验 `537009cb-c37f-4ec0-b64d-2d9be0688d8b` 于 23:30 完成，同样是无应用绑定的普通聊天。保存候选 `5168963a-877f-5cea-9d75-48311982ba7e` 后，模型明确提示点击本消息结果卡片；实际点击打开了该候选的约 200 字正文，而非之前的候选。两条请求各只有一条独立准备记录和一个新候选，Plan 均为精确 1.4.0 并成功结束。第一轮显示等待／处理状态，第二轮验证回执和界面一致；不把多阶段编剧的耗时当作已经完成首字延迟优化。

最终读库与本轮备份对照：原输入逐条不变，原文档、项目和全部剧本正式条目保持不变；仅新增上述两条 TEST 输入及两个待决定候选，没有自动采纳或批准。最终 Host 回执补正后重跑完整 Runtime 场景及提交成功但回执丢失的强制恢复，仍通过且只保存一次。窗口留在最新候选供查看。代码未提交、推送或发布。

## 前轮修正：内容归属、剧本直达与交流反馈（2026-09-22）

对话只承载交流，不再作为新内容的存放位置。个人对话／事项入口创建的内容归入稳定的「未归项目」；「内容」统一列出真实文档、图片、PDF、表格和剧本，项目页筛选同一对象，工作台负责应用与跨项目的最近工作。全局剧本列表可看到未归项目及授权项目内的剧本，明确展示归属。从消息结果、内容目录、最近工作及剧本列表打开的都是原剧本／原分集，不创建副本。

删除整工作台 `save-workspace-as-project` 命令、界面、状态与样式，不保留别名。人和智能体统一使用带对象类型的 `organize-content`，只为选中的文档或剧本设置项目；新建项目和归入该内容原子完成，多部剧本可以归入同一项目。保留版本校验、来源／目标权限与在途执行边界；不改变其他内容、输入或 Session。已有确切原文引用在相同权限的正常整理后仍可用，后续撤权立即阻断。修复整理成功后使用过期快照打开新归属的实际错误；剧本编辑草稿改为对象身份键，整理及刷新不丢未保存正文。

数据库升至 14，一次性纠正既有个人内容归属；历史输入、执行身份、命令与投递回执保留原样，不用读取别名兼容错误归属，也不重放旧操作。本地草稿键同样只作一次性纠正，不增加旧键读取分支。已移除临时的「重试旧命令时补写剧本交付」代码；新剧本交付与原命令原子记录，重试只返回原回执。

同批修复还包括首字前的真实等待反馈、普通对话直接继续发送、仅对在途后台工作显示定向补充、操作记录显示具体动作／剧本／条目，以及消息里的确切剧本交付入口。等待反馈不等同于优化了模型首字延迟；没有把内部推理或工具进度当作回复正文。

最终构建／类型检查、362/362 单元集成和 62/62 相关界面回归通过，覆盖内容／项目整理、未保存草稿、原文权限、剧本全流程、直接交付、等待状态、Dock、未读、伸缩和真实 Electron 缩放。最终日志：`/tmp/morphz-content-unify-final-{build,unit,ui}.log`。原窗口手测后只作格式化和测试流程修正，生产构建无新的功能差异。

原 `/Users/shafreeck/Applications/Morphz.app` 已正常退出并从同一路径重开，沿用原 profile／中心，Runtime 进程未重启。在线备份为原中心 `backups/workspace-2026-09-22T10-27-20-038Z-4ab74607.sqlite`。实际检查「全部内容 → 废火」「全部剧本（8 部）→ 原项目剧本」、设置项目取消，并把两部已有 TEST 入口样例归入新建的「TEST 内容流转验收 0922」；项目内容页真实显示并可打开两部原剧本。读库对照确认原 71 条输入、35 项内容正文、8 部剧本条目正文、原命令／输出／附件／身份数据保留；除一次性归属纠正及上述两部 TEST 剧本整理外，未改动正式创作元数据。没有新发或重试模型请求。本轮未提交、推送或发布。

## 前轮新增：交流面板拖动高度与阈值切换（2026-09-21）

按用户要求，在工作页交流面板的上沿加入可拖动边缘。拖动连续调高低，松开后按实际可用阅读空间吸附为仅输入／当前交流／完整记录；中间高度按本机工作页面保存，窗口变小不覆盖偏好。复用原交互状态与悬浮 Dock，不新增输入、消息、Session 或业务操作。保留草稿、附件、固定、浏览器／剧本画布、原按钮及快捷键；专用对话画布不加重复入口。支持键盘调整、Escape／指针取消／窗口失焦撤销，以及导航／隐藏时清理未完成手势。

验证中修正了两个实际拖动边界：Electron guest 会接走移出面板的鼠标事件，拖动期间以临时宿主命中层保持事件归属，结束即撤除；原窗口手测还捕获到原生松开落在该命中层而非拖动条，现由窗口统一接收对应 pointer 的移动／松开／取消，同时覆盖移动事件被合并的快速拖动。没有裁切、重载或授权网页。收缩过程中约束阅读区固有内边距，保证输入及 Dock 底部位置不漂移。

最终代码构建／类型检查、格式检查、354/354 单元集成和 37/37 非原生界面回归通过；覆盖连续高度、阈值、持久化、不同页面、旧消息阅读位置、跟随最新、长草稿／附件、窄短窗、取消／导航、命中层松开及原按钮语义。前一构建的真实 Electron 网页／200% 缩放在 38/38 回归中通过；最后一处原生松开修正后重跑该用例被 Mac 锁屏挡住，不能拿前轮通过替代最终原窗口验收。日志为 `/tmp/morphz-exchange-resize-{build,accepted,release,final-web,unit-final}.log`。

原 Morphz.app 已在同一位置、同一 profile／中心重开，实际观察到读取区随鼠标改变；手测诊断代码已从源码和最终构建移除。**待用户解锁后：刷新原窗口加载最终构建，再验收松手收起／展开和浏览器拖动，并重跑原生回归。** 未发送消息、修改文稿或重启 Runtime；本轮未提交、推送或发布。

## 前轮修复：单字段弹窗的纵向布局（2026-09-21）

用户指出上轮截图仍有“项目名称”单独占行、输入上方空白偏大的问题。上轮只对齐控件尺寸，未解决短表单的纵向结构。现新建项目／保存为项目、项目改名、手动新建剧本与内容改名共用 `dialog-input-row`：标题／关闭一行，带名称提示的输入与现有确认／取消动作一行。移除原项目专用布局和窄窗强制换行规则；无单独字段标签行或短表单底部按钮行。输入保留可访问名称，多字段表单、文档编辑结构、范围说明、错误、原操作语义均保留。

新增布局断言先在旧构建复现失败，修复后专项 6/6、最终相关回归 29/29、构建／类型检查和单元集成 351/351 通过。检查标题至输入间隔不超过 4px、无多余可见标签、单字段无错误弹窗高度不超过 96px，覆盖四主题亮暗、320px 窄窗、44px 触屏控件、中文名称、创建／改名／撤销、保存范围、长错误、键盘取消和真实 Electron 200% 缩放。自动化截图与日志：`test-results/dialog-density-{before,focused,accepted}/`、`/tmp/morphz-dialog-density-{build,focused,accepted,unit}.log`。这里的尺寸是当前产品回归基线，不是外部平台规范。

原 Morphz.app 已刷新加载，实际打开新建项目、手动新建剧本和保存为项目核对两行布局；项目中文输入、Tab 到确认、Escape 返回入口及剧本取消均通过。工作台全部 5 部剧本的归入说明仍可见，未提交这些空表单或启动创作。本轮不重启 Runtime、不改数据／凭据；代码尚未提交、推送或发布。

## 前轮修复：弹窗共用表单尺寸与遗漏入口（2026-09-21）

上轮只统一了外框和标题，仍遗留通用输入约 40.8px、主按钮约 34.8px、次按钮约 28px 的混用，以及字段灰边外另画焦点圈。现共用单行控件高度、字号、圆角与内贴合焦点；项目新建／改名／保存、剧本表单、内容重命名／移动、设置及截图确认操作均沿用。`form` 内外的取消按钮使用同一材质；清除内容元信息表单叠加的标题／底部间距，不改变保存、权限、取消或对象归属。

审计还修正了收藏弹窗未用共用标题结构，以及设置内部「添加账号」返回按钮和标题分成两行的遗漏。账号服务商连接入口仍是完整的 48px 信息行，不把所有按钮压成单行控件；多行正文、媒体比例、长表单滚动、必要范围说明和错误保留。

新增项目用例先复现旧高度失败，修复后两项控件专项连续三轮 6/6 通过；最终 61/61 相关界面回归、构建／类型检查及 351/351 单元集成通过。覆盖四主题亮暗、窄窗、触屏、键盘创建／取消／改名、内容移动与冲突、模型表单与账号入口、长错误、图片预览和真实 Electron 200% 缩放。几何在同一渲染帧读取，保留真实入场动画；原生 select 按实际高度验证，不把浏览器报告的 `normal` 行高误判为布局失败。证据：`test-results/dialog-controls-{before,verified}/`、`test-results/dialog-complete/`、`/tmp/morphz-dialog-{build-accepted,unit,complete}.log`。初轮发现的账号连接行误缩已修正；新用例的隐藏输入恢复、菜单定位和动画采样问题在最终回归前修正，未放宽原有应用行为断言。

已在原 Morphz.app／原 profile 和中心刷新加载，实际打开新建项目、手动新建剧本、保存为项目、模型设置和账号入口，验证前几处外观与项目表单 Tab／Escape 返回；未创建项目、剧本、账号或发送测试文字。最后补查设置步骤标题时 Mac 锁屏，尚未完成该处原窗口终验，已请求解锁，不将隔离 Electron 截图等同于原窗口验收。只读前后哈希确认所有工作空间集合及 Runtime Sessions 未变；Runtime 未重启。当前改动未提交、推送或发布。

## 前轮修复：悬浮 Dock 按钮的选中状态（2026-09-21）

原选中与悬停共用 `--soft`，图标、浮起阴影均未区分，持久开启看起来像普通悬停或灰掉。现在选中使用已有中性 `--selection` 底面、内边界及较清楚的图标；未选中悬停仍为轻反馈，键盘轮廓独立，听写的红色停止信号保留。只修改共用绘制规则，不调整按钮尺寸／位置、浮层、输入范围或操作语义。

新增用例先验证旧版不满足独立选中反馈，再覆盖四主题亮暗、指针移开／悬停、键盘切换、原草稿与命中区，以及生产 Desktop 正常窗、760px 窄窗和真实 200% 缩放。视觉断言等待实际 CSS 过渡完成，不取消动画，也不把阴影过渡的分数帧当作稳定基线。构建／类型检查、最终 33/33 相关界面回归通过，证据在 `test-results/dock-state-{before,accepted}/`、`/tmp/morphz-dock-state-{build,accepted}.log`。

单元／集成初跑有一项既有 continuation 用例失败；本次未修改其实现或断言。专项 6/6 与后续全量 351/351 通过，初次日志保留在 `/tmp/morphz-dock-state-unit.log`，复验在 `-continuation.log` 和 `-unit-verified.log`；不将样式修正当作该偶发情况的修复。

原 Morphz.app 已刷新加载，保留原工作台／剧本工作室与输入意图；实际点验记录显隐、完整记录、固定及 Enter／Tab／空格，取消固定后按原规则聚焦输入。恢复未固定状态，留在当前交流及输入面板供查看；未发送文字、启动录音或修改作品。只读前后哈希确认所有工作空间集合及 Runtime Sessions 不变，Runtime 未重启。本轮未提交、推送或发布。

## 前轮修复：本空间内容入口与继续工作的分工（2026-09-21）

修复「工作台内容／项目内容」实际恢复上次文档的问题：显式内容入口固定打开当前空间的列表，阅读页仍保留该入口，不再换成范围不明的「所有内容」。「继续工作」打开指定最近内容，普通应用标签继续恢复该应用现场；全局「内容」仍为跨空间入口。没有复制对象、新增内容库或改变浮动输入布局。

共用 `launch-application` 命令区分省略 `artifactId`（恢复现场）、确切 ID（打开对象）与显式 `null`（打开列表），在原实例上原子更新选择，保留其他状态、权限与幂等重试。页面导航核对代次；迟到回执不抢回后来选择的页面，失败保留当前位置并允许重试。列表搜索／布局、原文与输入草稿、历史前进后退和刷新恢复均保留。

新增界面用例先复现旧版失败。修复后构建／类型检查、351/351 单元与集成、31/31 相关界面回归通过；生产 Desktop 内嵌冒烟在正常窗、760px 窄窗和真实 200% 缩放通过。窄工具栏沿用原有横向滚动，校验入口顺序及实际点击可达性，不要求滚动前后屏幕横坐标相同。证据见 `test-results/workspace-content-{before,final}/`、`/tmp/morphz-workspace-content-{unit,final,desktop-accepted}.log`。

原 Morphz.app 已正常重开加载当前构建，沿用原 profile／中心，Runtime 原进程未动。原窗口实际鼠标点验：工作台最近文档 → 工作台内容（9 项）→ 刷新仍为列表；TEST 项目旧文档 → 项目内容（6 项）；返回工作台的「继续工作」仍打开指定原文，再点击内容入口回到列表。只读前后哈希确认仅应用实例导航状态改变，原 35 项内容、63 条输入、7 部剧本、项目、会话和 Runtime Sessions 均未变。窗口留在工作台内容列表供用户查看；本轮未提交、推送或发布。

## 前轮修复：认知应用交流浮层与浏览器输入入口（2026-09-21）

用户明确要求交流面板悬浮在网页和其他认知应用上，而不是顶起画布。共用输入／近期交流现使用同一底部浮层；展开、固定、收起都不改变画布尺寸，固定只防止自动收起。浏览器恢复「向 Morphz 输入」底部入口，网页内的 ⌘J／Ctrl+J 也能回到原输入和草稿。专用对话页和用户明确展开的完整记录保留原阅读方式，不增加输入、会话或消息副本。

浏览器旧实现是覆盖 DOM 的独立原生视图，再裁切网页给输入、Dock 和检查器腾位置，无法真正叠放。现改为独立进程、原隔离会话分区的 Electron guest，参与宿主的正常图层合成；网页没有 Node、preload、宿主桥或默认协助权限。主进程只允许待打开页面的确切 URL／分区接入，并核对 guest 创建时归属，拒绝旧页面迟到挂载、额外页面和不安全首选项。可见状态仅用于协助权限撤销，不再传递布局尺寸；截图显隐更新串行并保留等待屏障。

最后的真实 200% 剧本回归还发现收起入口周围的透明 Dock 会挡住底部「提交审阅」。已修正命中规则：收起时只有实际入口按钮可接收点击，透明容器透过到画布；不是通过强制点击绕开失败。

构建／类型检查、350/350 单元与集成测试、生产内嵌 Desktop 冒烟和最终 58/58 相关界面回归通过。新增用例验证网页视口／表单／页面实例不变、浮层旁网页真实鼠标点击、固定／收起／网页快捷键及草稿、guest 权限、原生 200% 合成截图；其他回归覆盖剧本编辑审阅、截图屏障、检查器、内容、工作台和动效。证据：`test-results/browser-overlay-accepted/`、`/tmp/morphz-browser-overlay-{accepted,unit-verified,embedded-verified,click-build}.log`。全量初轮为 252/263，通过修正相关失败后进行上述聚焦回归，不声称全量已全绿：另有 HEAD 已存在的 ProductBridge 侧栏高度断言失败；原生截图前台测试解锁时通过，后来重跑又被 macOS 锁屏挡住，未放宽其断言。

原 Morphz.app 已正常退出并从同一位置重开，保留原 profile／中心；Runtime 进程未重启。原窗口实测 Google 页面的 Logo、搜索框和页面底边在展开、固定、收起前后位置不变，网页 ⌘J 恢复同一份草稿，未发送测试文字。最后一处透明命中补丁构建后 Mac 再次锁屏，首次交付明确保留原窗口加载／复验待办，不把隔离截图当作原窗口完成证据。

用户解锁后完成续验：仅刷新时原窗口仍拦截网页底部点击，正常退出并重开原 Desktop 后，同一位置的实际鼠标点击成功打开 Google 设置菜单；只打开并关闭菜单，未更改网页设置或授权。同时发现上一轮 TEST 草稿没有完整清空，本次删除后重开，核对输入为空、发送禁用。原剧本工作室也验证了目录／正文位置不变、固定时点击画布保持浮层、取消固定后点击画布收起；项目恢复为原剧本列表，未修改正式稿。只读哈希确认 63 条输入、7 部剧本、35 项内容、项目、收藏及 Runtime Sessions 未改变，仅应用实例导航状态更新，仍无在途输入，Runtime 原进程保持运行。本轮未提交、推送或发布。

续验扩充真实网页底部点击后，重复测试又暴露了快捷键焦点竞争：收到 guest 唤起事件后的动画帧中，输入节点仍未挂载，原来的一次性聚焦因此落空。诊断记录明确显示 `request` 和 `frame` 时输入均不存在，最终焦点还在网页；不是通过重试测试或放宽焦点断言处理。现将显式唤起的聚焦请求放到 React 提交后的 layout effect，并核对导航代次，避免抢走后来页面的焦点。构建／类型检查及 350/350 单元集成重跑通过，56/56 非原生界面回归通过；悬浮、真实网页／快捷键和原生截图三个用例连续三轮 9/9 通过，证据见 `test-results/browser-overlay-focus-{mount,fixed,regression}/` 和 `/tmp/morphz-browser-overlay-focus-{build,unit,fixed,regression}.log`。原 Desktop 再次正常重开加载最终构建，实测网页 ⌘J 后不再点击即可输入；清除 TEST 文字并再次收起／唤起确认空输入，窗口留在浏览器的悬浮输入状态供用户查看。Runtime、原消息和文稿未改，未提交、推送或发布。

## 前轮修复：长消息记录的重复解析与主进程阻塞（2026-09-21）

定位并复现两处实际开销：输入框每次更新、流式回复每次续写都会重新解析全部历史 Markdown；宿主发布一批消息时，又在逐条归属和权限检查中反复读取 SQLite、解析和校验整个工作空间。现仅在正文、文档标题或流式状态变化时重解析正文，权限与对象打开动作仍通过独立上下文实时更新；宿主每个同步批次读取一次新快照，批内建立输入／根执行／项目索引，下一批重新读取并校验，不新增跨批次权限缓存。

同一生产构建压力用例（64 条长回复、128 条消息，段落及表格）先复现失败，再通过：输入更新中位数从 71.1ms 降至 17.4ms，流式续写从 139.0ms 降至 18.0ms；测量窗口内超过 50ms 的长任务从 24 次降至 0 次。宿主 100 条消息的工作空间读取从 300 次降至 1 次。以上为隔离合成用例，不是所有规模／设备的帧率承诺；没有截断历史、取消动画、改变 Dock 或以全局缓存冻结权限。

构建、类型检查、349/349 单元与集成测试、40/40 相关界面回归通过。新增权限回归验证相同 Markdown 在对象失去／恢复可见性后立即更新链接，外部图片仍不自动加载；宿主下一批也不能继续暴露已撤权项目。回归覆盖消息重试、正文连续性、未读、返回最新、交流显隐及阅读入口。失败／修复证据分别见 `/tmp/morphz-message-performance-{before,after}.log`、`/tmp/morphz-message-host-{before,after}.log`，完整回归位于 `test-results/message-performance-regression/`。

原 Morphz.app 已正常退出并重开，加载当前构建，沿用原 profile／中心；Runtime 未重启。原窗口手测完整记录、上下滚动、返回最新、收起／重开和未发送中文草稿，输入框及末条回复保持可见，无虚假新消息提示。测试文字已清除，未发送模型请求或重试旧输入。只读哈希确认原 63 条输入、35 项内容、剧本与 Runtime Sessions 不变；没有在途输入。本轮未提交、推送或发布。

## 前轮修复：弹窗紧凑度、假未读与回复闪退（2026-09-20）

共用弹窗标题行由 36px 收到 32px，顶部及标题后间距统一 4px；剧本固定操作栏改用弹窗同色底面并去掉额外竖向填充，不再出现横贯底部的浅色长条。保留输入焦点边框的 4px 绘制空间、长表单滚动、关闭按钮及键盘路径。

“有新回复”改为中心／身份隔离的本机已读记录，只比较当前可展开范围内的正文、错误和真实交付；不把后台进度、工具状态、空正文、重排、刷新或流式转正式当作新回复。读到最新、窗口确实在前台且没有模态遮挡才确认已读；旧阅读位置不吞掉下面的未读，局部对象交流与角标范围一致。

第一次 61 项界面回归通过后，原窗口仍复现了刷新假未读：同一 publication 的 `chat/runtime_error`（sequence 470）和 `session/io_state`（471）被快照与实时流解释成不同正文，重连还可能拿早期文本覆盖终态。新增专项先复现失败，再让两条路径保留持久事件序号和一致 IO 终态，并禁止历史流倒退覆盖；不是只清空角标或隐藏实际错误。

同时核对用户 19:05 的真实讨论记录：内部 infer 的中间结果先流入主交流，`assistant_call` 又删除已显示正文，最后才出现根输入的正式回复。现在没有实际输入归属的内部流只留在执行检查器，根输入已显示文字在工具选择、assistant_call 和断线期间保留，正式回执按同一 publication 原位替换；断线不拼接未知后缀、不展示推理或模型请求。后台 progress 不再占用正文展示身份，终态错误仍可见。

最终构建／类型检查、348/348 单元与集成测试、63/63 界面回归通过。新增测试覆盖旧错误重放、真正未读跨刷新保留、旧阅读位置、对象局部范围、内部 infer、工具切换、断线和正式回执，并直接断言消息 DOM 节点没有被移除。回归还包含设置／截图／连接弹窗、输入 Dock、重试、四主题明暗、320px 窄窗及真实 Electron 200% 缩放。最终证据在 `test-results/unread-dialog-final/`，日志 `/tmp/morphz-unread-dialog-{build,unit,final}.log`；实机才发现的失败证据另保留在 `/tmp/morphz-unread-replay-{before,after}.log`。

原 Morphz.app 已加载最终构建，使用原 profile／中心，Runtime 未重启。正常退出后旧 Desktop 进程残留，但窗口及数据库连接均已关闭；确认无在途输入后以 TERM 结束该残留进程，再打开同一应用，没有重置数据或凭据。原窗口复验新建项目及剧本弹窗、完整焦点环、Tab／Escape，并验证收起和两次刷新不再重报已读。19:19 发送一条 **TEST 回复连续性验收 0920**，真实编剧讨论完成，最终回复仍在原交流；输入 ID 为 `08c79f3e-f674-468e-a922-601771378407`，事件完成于 sequence 2287。只新增该验收输入／回复，既有 62 条输入逐字哈希相同，内容仍为 35 项。窗口留在这条真实回复，未创建剧本、采纳候选、重发失败输入或修改既有文稿。本轮未提交、推送或发布。

另按用户提问核查小说改编：已有原创／改编设置、参考条目与同项目原文确切版本引用、固定材料生成候选；没有完整的整本小说文件导入、EPUB 解析及拆章改编入口。本轮没有新增导入功能，也不把普通消息附件等同于已实现的小说导入流程。

## 前轮修复：剧本新建弹窗焦点边框裁切（2026-09-20）

手动新建剧本的名称输入框与表单滚动区域等宽，向外绘制的焦点边框被左右裁掉。共用剧本弹窗的表单现预留 4px 绘制空间，并用等量负外边距保持字段位置、弹窗尺寸及滚动／固定操作栏不变；不取消焦点样式、不改创建流程。

新增回归检查焦点边框四边相对滚动祖先及视口的空间，旧版明确失败（表单左侧为 0px，边框需要 4px）。修复后构建／类型检查、16 项剧本界面回归全部通过，涵盖长错误、320px 窄窗、四主题明暗和真实 Electron 200% 缩放。原 Morphz.app 已刷新，目视确认完整蓝边，实测 Tab、Escape、入口焦点恢复及 Enter 重开；空弹窗保留供用户查看，未创建剧本或发送消息。失败／通过证据分别位于 `test-results/script-dialog-focus-before`、`script-dialog-focus-after` 和 `script-dialog-focus-regression`。本轮未提交、推送或发布。

## 前轮优化：剧本列表入口与项目归属（2026-09-20）

剧本不再只藏在下拉框里：工作室提供当前空间的剧本卡片列表、名称查找、真实集场／候选计数、更新时间及直接返回入口。恢复列表／编辑位置，返回保留查找条件，未保存正文继续按原剧本条目保存。创建入口直接可见；「构思新剧」仍只准备意图，不自动发送。

明确一项目可含多部剧本；工作台的「保存为项目」移到剧本工具栏，同屏不重复，并在命名弹窗说明全部剧本、其他内容与交流一起归入。复用原空间转换事务，不复制或迁移剧本；项目内新增剧本直接归属当前项目。原来实际作用于单部剧本的「项目规范与交付模板」更名「剧本设置」。不改 Harness、权限、生成／采纳／审阅流程或浮动 Dock。

原 `/Users/shafreeck/Applications/Morphz.app` 已刷新加载，使用原 profile／中心；未重启 Runtime、重发失败输入或触发模型请求。原窗口手测搜索、打开原分场（v1、5 个待决定候选）、返回保留筛选、保存整个工作台的范围提示及取消；另建 **TEST 剧本入口验收 0920**，在同一项目手动创建「TEST 入口样例 · 雨夜电台」和「TEST 入口样例 · 末班公交」，验证列表、构思输入作用范围及刷新恢复。窗口保留在该项目的两部剧本列表，用户可继续创作测试。

只读 SQLite 前后比对：原 7 项目、17 会话、5 部剧本（含正文／候选）、35 内容及 61 条输入逐项不变。仅新增上述测试项目、其默认会话、两部空测试剧本和工作室实例；原工作室实例仅更新导航状态。哈希记录在 `/tmp/morphz-script-entry-acceptance.3sVwt7`，不包含账号密钥。本轮不提供跨项目搬移／部分选择保存，也不宣称重新完成编剧模型质量验收。

最终构建、336/336 单元／集成和 16/16 剧本界面回归通过。回归覆盖整工作台多剧本保存／取消／刷新不复制、未保存稿件恢复、项目隔离、键盘往返、原有生成准备／候选审改／锁稿／Word 导出、四主题明暗、320 px 窄窗及原生 200% 缩放。截图复核发现的搜索控件样式冲突、保存说明贴边，以及列表打开后的异步焦点抢占均已修正；按钮常态／悬停对比度至少 4.5:1。16 项在焦点修复后连续两轮通过，最终证据在 `application/test-results/script-entry-accepted/`，构建及测试日志在 `/tmp/morphz-script-entry-{build,unit,accepted}.log`。保留此前失败证据，不把早期通过或隔离截图当作原窗口验收。本轮未提交、推送或发布。

## 前轮修正：Yao 编写体验与编剧 1.3.0（2026-09-20，未发布）

Yao 使用统一的 `infer (returns T)` 表达模型求值结果；T 不再与任务 BODY 静态类型比较。
错误引入的第二套结果声明已删除，不保留别名或兼容模式。保留严格普通 JSON 转换、
`json-object` 构造语法糖、三引号长文本，以及不安装、不执行的 `harness check`／`harness format`。
统一语言卡和中英文规范同步；完整 BODY、captures 与权限边界保留。
直接修正尚未发布的 1.3.0，不为错误实现新建历史包；工作流仍由 Yao 组织。

下列数量是修正前的测试记录，不能作为本轮验收。当前修正及新增回归结果见
[Yao 修正记录](../../docs/yao_infer_correction_20260920.md)。

Yao 66 项、Runtime 最终 1389 项（10 跳过）、CLI 31 项、应用 336 项通过；
12 个合成流程及两轮 16 点恢复矩阵通过，六类真实模型案例逐字复核。
原 Morphz Desktop 已加载新版，普通讨论不写内容，显式生成只新增一份待决定候选；
正式稿、旧候选、其他项目及旧输入／执行历史保持不变。窗口停留在原验收剧本的
“候选 4”。完整证据、默认并发测试超时的复核及既存日志检查告警见
[1.3.0 验收记录](./28-script-studio-executable-yao.md#130-编写体验改进2026-09-20)。

## 前轮修复：Host 工具恢复与启动时序（2026-09-20）

修复上一轮复现的恢复停滞：同机已退出 Runtime 的任务不再被未过期租约永久挡住，
周期恢复处理启动之后失效的任务；保留活进程、跨主机租约与版本 CAS。只有 Host 明确
声明且已有持久幂等契约的编剧读取／提交可重放，其他操作和历史任务不升级为可重试。
另修复真实重复测试发现的启动竞争：先开放已认证的执行查询接口，再恢复工作器，
防止 Host 查不到原输入而回退到项目级身份后被拒绝。不修改 1.2.1 Harness 或任何 UI。

最终连续两轮完整中断矩阵均 16/16，12 个正常分支、336/336 应用回归、55 项相关 Rust
测试及 31/31 CLI 测试通过，应用／Runtime 构建与验收脚本严格类型检查通过。
断点覆盖全部模型阶段、五次 Host 读取、提交前及提交后丢回执；原输入／原 Plan／原
job/call 保留，完成阶段不重跑，候选唯一、提交回执逐字相同、正式稿不变。
初轮修复的 14/16、15/16 失败证据保留，没有用后来一次通过掩盖启动竞争。
详细机制、边界与原始证据见[恢复修复记录](./28-script-studio-executable-yao.md#恢复修复与重复验收2026-09-20)。

00:55（Asia/Shanghai）已在双库备份、确认无在途任务后正常重启原 18089 Runtime 和
原 Morphz.app，加载本轮二进制及 Host 清单；原模型配置、凭据、Context 与 profile 保留。
比对确认 5 部剧本、56 条输入、全部会话／投递和执行历史未改；原分场 v1 与 3 个
待决定候选可见。未重发旧输入、采纳候选或调用真实模型，未提交、推送或发布。

## 前轮专项补测：编剧 Yao 分支与中断恢复（2026-09-20，修复前）

针对前轮明确欠缺的初稿／修订主动阻塞、第二轮再次修订及阶段中断补测。12 个正常分支场景通过，实际 55 次合成模型调用；两轮修改确实进入唯一候选，阻塞不提交，错误 Bool 按预期失败而不重派。335/335 应用回归重新通过，3 个验收脚本严格类型与格式检查通过。

真实隔离 Runtime 的 16 个 `SIGKILL` 断点仅 9/16 通过：全部 9 个模型阶段能恢复原 Plan；5 个 Host 读取断点和提交前／提交后丢回执这 2 个断点均未恢复。延长至持久租约过期后再等 30 秒，工具任务仍为 running、流程仍为 waiting。最关键场景是候选已真实保存，但成功回执未回 Runtime，重启后依然不能交付；没有重复候选或正式稿改写。缺陷在本地 Host 工具任务的恢复衔接，不能靠把全部 Host 操作设成可重试来绕过。

新增可复跑中断矩阵及前后 SQLite 快照，失败用例保持失败。这里只完成验证，未修复该恢复缺陷；本轮未改业务／Runtime 逻辑，未重启原应用或调用真实模型。详细原始证据、定位与复现命令见[专项补测记录](./28-script-studio-executable-yao.md)。未提交、推送或发布。

## 前轮修正：可执行 Yao 编剧 Harness 与自由讨论（2026-09-19）

新输入绑定 `morphz.script-studio@1.2.1`；此前实际使用过的四个包按原字节保留。入口改为 Runtime 拥有的 Yao `eval`，以函数、类型和条件分支组织创作、实际自审、按问题修订和提交。Host 只读取固定材料和提交领域结果，不另写应用工作流调度器。普通消息直接讨论；即使附带固定目标，明确说“先别写”也不生成；下一条消息不继承生成授权。保留原目录、生成准备入口、共享输入与 Dock，只纠正一条自审说明。

本轮联测同时修复 Yao／Runtime 的 `Map<T>` 静态读取、注释解析、入口私有函数权限、失败入口重复派发、子 infer 精确 Harness 继承和完整 captures。最终 335/335 应用回归、Yao 54/54、Harness 35/35、Plan 23/23、eval 55/55，构建及脚本严格类型检查通过；7 个合成 Provider 持久流程覆盖讨论、暂缓、0/1/2 轮、条件修订、阻塞、类型错误及重开幂等，专项 UI 回归 1/1 通过。

1.2.0 六类真实模型案例逐字核对后，发现状态说明导致空转修订，以及影响交付漏报未选下游；另发 1.2.1 修正，并完成改写、改编、影响三案复测。最终三案通过自审后直接提交，无不必要修订；影响案保存意见及回复都明确一项下游未检查。保留原失败日志和误报校正，不将模型输出称为独立专业质量认证。详细分支、代码边界、版本和原始证据见[可执行 Yao 验收记录](./28-script-studio-executable-yao.md)。

原 Morphz.app 与 Runtime 已正常重开、加载最终版本，配置及凭据保留。原窗口五次真实验收覆盖自由讨论、固定目标但暂缓、发现问题后修订、生成后回到讨论及无问题直接提交；持久 Plan 和 UI 结果一致。当前窗口留在 **TEST 专业编剧 Harness 验收 0919 → 场1：两个人的操作台 → 候选**，顶部为 1.2.1 的新候选。原 7 项目、17 会话、35 内容、51 输入和 5 部剧本原稿保留，仅新增五条验收输入及两份待决定候选；正式稿、父集、旧候选不变。未提交、推送或发布。

## 前轮推进：专业编剧 Harness 方法与质量复验（2026-09-19）

编剧包更新到1.1.1，保留1.0.0及本轮曾安装的1.1.0原始包。10个只读Mind方法覆盖故事因果、人物声音、场景、分集、改编、定向改写和连续性／影响审阅；单infer自主组织，未增加UI、权限或多角色流水线。Host增加绑定实际输入的结果读取，补足超时后核对；影响分析的固定目标计入依赖范围，不要求重复选择。

330/330单元／集成、类型检查、构建和实际Runtime合成Provider联测通过；本轮前段14/14剧本UI回归通过。两轮六类真实模型案例及改编定向复测分别保留完整证据；发现并修正审阅连带误判规则及测试脚本的工作流／关键词误判，不宣称批量一遍全绿或专业审美认证。各案全文核对和失败边界见[专业编剧Harness记录](./27-script-studio-professional-harness.md)。

原Runtime已正常重开并确认同时加载三个版本，配置和凭据保留。解锁后正常重开同一Desktop，准备输入逐字保留；18:53—18:55实际发送一次，持久请求确认绑定1.1.1，五次真实Host操作成功，保存一份待决定候选。窗口已打开 **TEST 专业编剧 Harness 验收 0919 → 场1：两个人的操作台 → 候选**，完整双人单场正文可见，正式稿仍为空白v1、父集v2未变，无批准或导出。原7项目、17会话、35内容、50输入／投递、4部剧本逐项保留，仅新增本次测试及浏览状态，旧失败输入未重发。本轮实现与既定验收已完成；独立编辑评价、排演及制作方验收不在本轮证明范围内。未提交、推送或发布。

## 本轮修正：剧本手测 F01–F06 与原窗口复验（2026-09-19）

统一修复准备失败丢要求、导出提示跨剧本残留、同一失败重复提示、内部标识直接展示、键盘／成功及失败操作焦点、检查修正与保存入口过远。保留原创作目录、共享输入及悬浮 Dock；生成成功才关闭弹窗，未发送输入不被覆盖；追溯标识在界面按需展开，Word 正文与文末附录分开；过期引用可直接定位，长表单与文稿保存按钮持续可达。

最终构建／类型检查、324/324 单元／集成、14/14 剧本界面回归通过，包含隔离内嵌 Electron 四主题明暗、真实 200% 缩放、失败审批焦点和旧草稿冲突恢复。在原 Morphz.app 正常重开后完成鼠标／键盘、原生取消保存／历史重试及 Pages 分页复验，未重启 Runtime、改凭据或发送新模型输入。可见结果为 **TEST 剧本 UI 修复验收 0919**，父集和分场 v3 锁稿，实际导出 9835 字节 DOCX。

原有剧本、内容、项目、会话、输入、投递、附件和命令均只读核对保留。详细失败复现、修复、实机记录及文件见[手动验收报告](./26-script-studio-manual-acceptance-2026-09-19.md#修复与复验2026-09-19)。本轮未提交、推送或发布，不等同全平台、Microsoft Word 打印或模型创作质量验收。

## 本轮修正：剧本审批、原文读取、设置与部分交付（2026-09-19）

修复审计确认的四条断点：审批／退回／解锁弹窗固定打开时的正文和工作流版本；`script/read-source` 按固定材料版本分页读取原文，非空引文不扩大范围；未变化设置不增版本，改名／排版不撤销批准，创作要求／许可／审阅人变化仍失效且改回不复活；Word 选择有效锁稿的分集／分场交付，未完成集不再阻塞。材料预算包含实际获准原文，不只是引用 ID。

Runtime 的已认证 capabilities 增加进程实际加载的精确 Harness 列表；应用投递前检查，缺失／版本不符／旧服务未提供检查时保留原输入并说明原因，不发起模型请求、不自动重试、不回退普通聊天。未改已安装的不可变 `morphz.script-studio@1.0.0` 包内容。

319/319 单元／集成、10/10 剧本界面回归、类型检查和生产构建通过；新增 Runtime 就绪检查专项 1/1，通过真实 Runtime＋内嵌 Host 联测与正式 Electron 导出／收尾脚本。原用户 Morphz.app、profile、中心已正常重开，兼容 Runtime 保留原配置／凭据更新，重启前无在途工作且双库已在线备份。

在原窗口留下 **TEST 剧本修复验收 0919**：第一集 v2 审批锁稿后重复保存规范、改字号仍有效；第二集未完成时，已通过真实系统选择器只导出第一集（8006 字节 DOCX）。独立合成输入经真实 gpt-6-astra、`read-source` 及持久工具回执，准确读取只存在于原文的编号／刻字，保存一份待采纳候选；正式稿不变。原所有剧本、内容、项目、会话、输入、投递、命令和附件逐项保留；只新增本次测试记录及内容／工作室浏览状态。未重发原两条失败请求。详细 ID、文件与验证边界见[剧本工作室记录](./26-script-studio.md#2026-09-19审计修复与原窗口验收)。本轮未提交、推送或发布；真实写作质量、Microsoft Word 视觉／打印与合作方验收仍不据此视为完成。

## 本轮修正：发送重试焦点与本机编剧连接恢复（2026-09-19）

「重试发送」在投递状态更新后会被移除；若焦点仍停在该按钮，未固定的交流面板会把失焦误判为离开而整体收起。现于发起重试前将焦点交给原输入框，使用 `preventScroll` 保留阅读位置；不在异步返回后重新聚焦，不改变原消息身份、未发送草稿、展开模式、悬浮 Dock、固定及真正离开时的自动收起行为。

新增回归先复现原消息区消失，再覆盖最近／完整记录中的鼠标、Enter、Space 重试，以及直接失败、再次失败、慢响应后离开。当前工作树最终 22/22 相关界面回归、315/315 单元／集成、类型检查与生产构建通过。编写测试期间修正了共享测试中心残留打开对象导致的消息筛选、错误回执夹具格式和定位；没有放宽产品行为断言。各轮记录保留在 `test-results/message-retry-before`、`retry-regressions`、`retry-final`、`retry-verified`，最终结果在 `retry-acceptance`。不是全量界面套件复跑。

本机 18089 Runtime 已由另一排查流程持久安装 `morphz.script-studio@1.0.0`，但原进程没有热加载。核对实际进程、原启动参数、配置和凭据，并确认无正在执行或排队的工作后，在线备份原中心和 Runtime 数据库，正常重启同一二进制／数据目录／IPC 工具清单，未改账号或模型配置。原 Desktop 加载新前端后发送独立的 `TEST 编剧连接恢复 0919`，仍绑定该 Harness；01:27（Asia/Shanghai）真实收到「编剧连接正常」，账本显示接收一次且完成。原两条失败请求没有重发，原剧本、内容、事项与历史输入逐项相同，仅新增此测试输入和相应执行／回复。

连接恢复是原 Desktop、原 profile 与原 Runtime 的实机证据；重试失败转成功的交互由隔离的自动化夹具验证，没有为验收重放用户原请求。备份与本次重启日志位于本机私有临时目录 `morphz-script-runtime-reload.*`；此为本机恢复，不代表包支持热加载或发布了新 Runtime。按用户要求，本轮提交仅含重试交互、回归与本记录，不混入其他进行中的剧本功能改动，不推送或发布。

## 本轮修正：剧本创作目录与正文工作区（2026-09-19）

按用户确认的组织方向，将剧本内部导航重组为「概览／全剧大纲／分集剧本（集 → 场）／设定与角色／参考资料」。复用既有六类条目与 ID／排序／父集关系，不迁移数据，不强制创作顺序；未归属分场保留入口。提供分组／集旁的上下文新增、按剧本保存的折叠状态、选中祖先展开和键盘导航。概览优先展示创作入口与简报，正文为主，检查和导出历史按需展开，权限与模型处理许可继续保留。

使用宿主紧凑控件及主题，修正旧选中态过渡造成的双选错觉；窄工作区与 200% 缩放下，目录默认收为当前位置行，按需打开并在选择／Escape 后收起及恢复焦点，不再持续挤占正文。保留共享输入、项目／Session、正文草稿、版本 CAS、候选／人工审阅锁稿和导出的既有语义。

01:15:47（Asia/Shanghai）产品类型检查、生产构建、315/315 单元／集成、8/8 剧本界面回归、正式 Electron 入口及收尾通过；01:19:55 补强测试截图同步与可见正文断言后，8/8 界面回归再次通过。实际 200% 原生截图中目录已收起，正文及未提交文字可见，仍需纵向滚动。首次回归的瞬时提示断言和正式入口旧定位曾失败，修正为持久状态及语义入口后重跑，未移除业务断言；详细证据和截图见[剧本工作室记录](./26-script-studio.md)。

这些是隔离合成夹具的工程证据，不是全应用 E2E、真实模型质量或用户当前窗口验收。另一个输入格式修复流程于 00:59:32 正常重开了同一用户 Desktop，但不证明其已加载之后的导航构建；本轮未再次重启、自动重发输入、提交、推送或发布。

## 本轮修正：剧本共用弹窗与构思输入（2026-09-19）

针对用户截图中的粗白直角边框、独立标题分隔和松散短表单，剧本弹窗接回宿主共用容器／控件／主次按钮及 `useModal`，统一紧凑标题、圆角和边框，按短表单／复杂表单选择共享宽度 token，保留权限信息、长错误、键盘循环及关闭后的焦点返回。

「构思新剧」与空态入口改为可移除的共享输入意图和 placeholder，不再反复追加固定话术。原正文、换行、附件与所在项目／会话保留；点击不发送、不创建对象。已有固定版本生成或其他专用请求时不改绑；之前已写入草稿的文字不自动删除。

本轮 00:35（Asia/Shanghai）类型检查、生产构建、315/315 单元／集成及 7/7 剧本界面回归通过，包含隔离内嵌 Electron 的四主题明暗、原生 200% 缩放、输入／编辑恢复和弹窗几何。不是全应用界面套件复跑，也不是用户当前窗口验收。未调用真实模型、重启用户应用／独立 Runtime、提交、推送或发布。新 `script` 输入校验需在正常重开同一 Desktop 时随内嵌宿主加载，单刷新前端不够；详见[剧本工作室记录](./26-script-studio.md)。

## 本轮收尾：名称、现行说明与兼容边界（2026-09-18）

按用户要求暂停提交／推送后，完成全仓名称审计并统一处理：现行产品／工程说明使用 Morphz 与 `morphz-application`，普通测试使用新工具名和 CSRF 标头；Runtime 的停止原因改为不绑定客户端的通用英文。README 与本机接入文档按已实现的目录授权、成果索引、事项顺序、实时听写、内嵌 Desktop 和 Web HTTP 适配更新，不恢复已移除的导入／来源同步入口，也不新增产品功能。

旧配置别名、数据与 profile 路径、不可变输入定义、已安装包协议、登录态、草稿键及工具幂等身份保持；历史验收路径和回执不改写。普通测试与专门兼容用例分开，新增真实 HTTP 新旧标头重试去重／冲突拒绝、新格式不含旧名称、Runtime 停止原因持久化断言。保留旧名称的分类与理由见[整合记录](./25-repository-integration.md#canonical-names-and-deliberate-legacy-references)。

验证：255/255 单元／集成、类型检查与生产构建、Runtime 停止专项 1/1 和 SDK 专项 4/4、生产 Electron 内嵌宿主专项通过。全量界面首跑 227/228 通过；“返回最新”几何用例的交互断言已完成，但关闭浏览器时后台模拟请求读取已释放的响应，报 `Response has been disposed`。保持原用例与行为断言不变，连续复测 5/5 通过；首跑失败与 trace 保留在 `application/test-results/`，复测输出在其 `naming-recheck/` 子目录，不称为全量一次全绿。本轮改动脚本／测试的格式、差异检查及 96 个本地文档文件链接检查通过；未重新验收真实麦克风、其他操作系统或公开部署。

本轮命名清理只改文档、测试、脚本说明和一条 Runtime 提示，不改应用页面／业务实现，不替换或重启原用户 Runtime，不移动原数据或修改应用包签名。新 Runtime 提示由测试构建验证，不声称原运行实例已热更新。命名清理验收时按用户要求保持未提交、未推送。

随后用户授权提交／推送，并要求将旧目录标记废弃、从新仓库重开 Desktop。已在旧 checkout 的 README、AGENTS 和 DEPRECATED 文件标明新入口；旧源码与仍被引用的私有 `.env` 保留。新仓库重新构建后正常退出并重开同一 Morphz.app，实际进程 cwd 为 `Morphz/application`，原项目、消息、完整未发送草稿和模型连接均可见。独立 Runtime 未重启，数据库业务字段与命令记录不变；备份位置与逐项对比见整合记录的后续重启章节。

## 前轮整合：并入 Morphz 主仓库（2026-09-18）

MorphzWork 的 29 个原始提交以不压缩历史的 subtree 合并进入 `Morphz/application/`，后续开发以该目录为准；原 checkout 留作回退，未删除或修改。Runtime、Dashboard 与应用继续独立构建，未改产品页面或业务模型，Mobile 仍待开发。

已修正联测二进制发现路径，加入独立应用 CI、原启动器配置保留回归和第三方清单。新目录生产构建、253 项单元／集成、真实 Runtime 的 IPC／定向补充／身份隔离专项，以及生产 Electron 宿主和模型设置专项通过。全量界面首跑 227/228 通过；一项原生侧栏用例最后读取数据发生连接重置，原用例连续复测 5 次通过，保留失败记录，不称为一次全绿。模型设置旧脚本改用已有的真实展开输入辅助步骤，未放宽行为断言。

原 Morphz.app 正常退出、备份、切换源码后重开；仅启动器源码根目录变化，原 center、profile、配置文件引用和 Runtime 保留。实际核对原项目、会话、未发送草稿和 v3 文档，窗口留在原验收成果。数据库逐项对比确认原内容、历史、附件和 Session 不变；本轮查看内容产生两条应用状态回执，只有原内容应用实例的修订／时间元数据变化。详细提交来源、备份、测试例外与验收证据见[仓库整合记录](./25-repository-integration.md)。不推送或发布，不将本机验收扩张为 Linux、Mobile 或正式安装包验收。

## 前轮收尾：完整工作流与原窗口验收（2026-09-18）

按用户“作为整体完成”的要求，先将已实现的定向补充分仓提交：应用 `a702949`、Runtime `0227fbf8`，均为本地提交，不推送或发布。本轮不再改动已确认的页面布局、悬浮 Dock、事项视图或产品范围；通过原 Morphz、原 profile／center 和现有 gpt-6-astra 连接串联真实操作，自动化夹具与原窗口证据分开记录。

可见验收项目为 **TEST 完整工作流验收 0918**（`228499df-ee48-4a31-865d-50dc59d8efd4`），会话 **试用准备验收**（`cf9b8381-c948-4d48-9722-a6fd2d505589`）。测试只用合成资料，不联网处理素材、不执行命令、不对外发布，也不触发真实试用。实际走通：

1. 新建会话先留草稿，切到内容页后可恢复；第一条真实输入才建立会话。智能体按要求只保存“TEST 确认试用范围 0918”和“TEST 起草试用清单 0918”两件事项，不提前启动。
2. 原安排仍在运行时，从实际入口补充“6 人／约 600 字改为 8 人／不超过 300 字”。界面显示“补充已送达”，真实事项要求更新到 v2；账本保留原 root `msg_1789716269210687000_11872_2`，补充只有独立 acceptedEventId，`rootId` 为空，没有第三件事项或新的补充执行。
3. 实际切换清单／看板，日期分组和四状态列均保留。启动智能体事项后明确显示“等我提交结果”，未提前产出文档；项目归档被待执行事项阻止并指出具体事项。通过“查看前置事项”提交合成确认结果后，人工事项完成，智能体自动接续一次。
4. 智能体交付 **TEST 试用清单 0918**（`4fc1c9e4-3547-56f2-b817-68d447700e7b`），关联为事项成果并完成事项。实际模型期间发生服务恢复，界面保持真实运行状态，随后原执行自动完成；没有人工重发、重放或将产物已生成冒充整项执行已结束。
5. 从成果入口打开 v1，人工增加“人工补充：所有反馈当天汇总。”并保存 v2；继续要求智能体在同一文档添加记录首次完成耗时的条目。发送引用确为 v2，原阅读页自动显示 v3，保留人工补充和其他正文，没有另建文档。内容目录仅显示这一项成果、不混入两件事项；搜索人工新增句子能命中同一份 v3。
6. 会话改名后归档，归档历史及交付仍可读，输入不能误发；恢复后重回同一会话。留下一条明确未发送的“TEST 重启草稿 0918”，正常退出并重新打开原应用，再进入该会话，草稿逐字保留。原 Runtime 不重启；最终窗口停在可阅读的 v3 成果，项目、事项、会话及草稿继续留在原应用供查看。

自动化验证：生产构建与类型检查通过，250/250 单元／集成通过；定向补充 6 项连续复测 12 轮通过。全量界面首跑 228 项中 226 项通过，两项失败经定位后连同相关用例复测 9/9 通过，即本轮 228 项分批通过，不称为一次全绿。其一是人工验收与隔离的原生截图测试竞争前台窗口，停止并行操作后原测试通过；其二是会话测试转发 `/api/commands` 时漏带必需的 Origin，现补齐真实页面来源并断言请求成功，没有放宽产品来源校验。首轮单测也暴露测试将后台 `tick()` 误当刷新屏障，已改为有界等待真实 root，原行为断言不变；修正包含在应用提交中。

Runtime Registry 11 项、typed IO 12 项通过，typed IO 的 PostgreSQL 专项 1 项忽略，本轮未重新验收 PostgreSQL。真实 Runtime＋生产内嵌 IPC 的定向补充专项通过（可控制合成模型、隔离数据）；生产 Electron 宿主专项通过，涵盖安全 preload、直接 SQLite、旧 PDF、原文件读取、原生浏览器隔离和退出恢复，没有本机应用 HTTP 监听器。日志前缀 `/tmp/morphz-workflow-closeout-`，原生及界面结果分别为 `embedded.log`、`ui.log`、`ui-recheck.log`。

操作前使用 SQLite 在线备份保留 WAL 中的数据。与该备份逐项比较，所有原有业务对象和顺序不变，原命令、成果回执、附件、所有权、PDF 及中心标识记录仍完整且逐行相同；新增的项目、会话、两件事项、一份文档、关联和输入均可归属于本轮测试。未修改账号、凭据、模型或外观偏好，没有删除原数据。

真实麦克风下的口音、噪声、准确率与主观延迟仍需本人试用；本轮没有采集环境声音，不将先前合成音频的真实服务验证扩张成真人听写验收。

## 前轮修正：运行中工作的定向补充（2026-09-18）

从进行中的工作旁或执行详情点击“补充要求”，才会将原输入框指向该项工作；显示可移除的目标，保留原草稿。只查看执行、切页面或只剩一项执行，不会改变发送方式。同一输入的多个分支须明确选择，普通输入仍独立并行，悬浮 Dock、布局、附件与听写入口保持原位。补充沿用原工作模型、Harness、对象与权限，当前页面新增目录／模型选择不扩大它的权限。

领域命令增加有类型的 `record-input.continuation`，共享业务层按实际身份和原输入检查项目、会话、根执行、Thread／Objective 及代次。`message`／`input.send` 经 Desktop IPC 或 Web HTTP 走同一投递账本。独立的 steering 接收事件不成为新 root，回复、成果及工具权限仍归原工作；消息只声明“补充已送达”，不冒充已采用或已完成。新输入格式 `morphz.application.input` v4 保留 v1–v3 原定义和已有 outbox 请求。智能体读取后续请求时也能得到原请求关联；原生 Runtime `steer` 仍只可转交真实用户输入，不允许应用工具伪造人工补充或绕过审批。

目标结束／暂停时返回 `work_closed`，不另开执行；保留草稿并提供明确的“作为后续请求继续”，切换后仍需用户发送。`work_changed` 不静默追随新代次。未知回执保存同一命令与不可变请求，界面冻结本份投递，仅允许核对；刷新、宿主重开和目标后来结束后，重试仍恢复原回执。失败不清空草稿，已发生的操作不撤销或重放。

真实联测发现 Runtime 的 Registry 仍拦截 directed typed input，已在 Runtime 仓库接通原有原子 ingress 路径，并声明 `directed_input` 能力；保留身份、代次、终止竞态与请求幂等约束，拒绝模型／Harness 等覆盖。Desktop 仅在 Runtime 声明能力且安装 v4 格式后展示补充入口，旧版本没有假按钮。

验证：250 项单元／集成、33 项相关界面回归，含亮暗／窄窗口、目标选择、取消、草稿恢复、未知回执同命令重试、原 Dock 与焦点、项目独立会话。Runtime Registry 11 项、typed IO 12 项、steering 6 项通过；两组 PostgreSQL 专项各有 1 项忽略，本轮未重新验收 PostgreSQL。`scripts/continuation-runtime-smoke.ts` 使用真实 Runtime 和内嵌 IPC、合成的可控制模型、隔离数据验证两个并行 root、A 接收补充而 B 不变、原 root 回复、无补充新 root 和重开不重复；不把它当作原窗口验收。

生产构建、类型检查、本轮改动文件格式与两仓库差异检查通过。Runtime 全仓 `cargo fmt --all -- --check` 仍报告既有 `objective.rs`、`provider/auth.rs`、`web.rs` 格式差异；这些文件不属于本轮修改，未顺带重排，也不声称全仓格式检查通过。

原窗口另外使用现有 gpt-6-astra 连接真实发送“TEST 定向补充验收 0918 A”，在美元长文生成中明确补充“人民币、取消长文”，实际返回“验收 A：人民币”。界面显示补充已送达并恢复普通输入；账本保留原 root 和单独 acceptedEventId，没有新补充执行。测试记录留在对话可见。更新前确认无进行中工作、备份原 SQLite 与 Runtime 配置，正常重开原应用和同配置 Runtime；原账号、数据、草稿和 Session 保留，未采集环境音频。旧二进制保留，未提交、推送或发布。

## 前轮修正：输入框实时听写（2026-09-18）

输入框麦克风改为真正的双向流式听写：AudioWorklet 连续产出 200 ms／16 kHz／单声道 PCM16 音频帧，同一条豆包 Agent Plan 优化双向 WebSocket 持续收音和返回累计文本；不等待首个服务响应才发送音频，也不再攒 10 秒或等停止后才显示文字。按[豆包官方流式协议](https://www.volcengine.com/docs/6561/1354869)处理音频顺序、累计结果和负序号结束帧。输入框只替换本次听写拥有的文字尾段，服务端修正不会叠加成重复句子；既有草稿不替换，文字不自动发送。手动改字、显式关闭或离开当前输入现场立即取消听写，迟到结果不覆盖用户编辑；正常停止先关麦克风，再补齐已采集尾段及最终标点。

共享业务层增加有类型及范围校验的 `speech.stream`（open／push／read／finish／cancel）。Desktop 仍是内嵌业务层与 IPC，Web／远端通过同一业务接口传输，没有新增 Desktop HTTP 服务。服务密钥只在宿主；逐次检查身份与来源权限，撤权、身份切换、关闭窗口和宿主退出关闭流。PCM 帧顺序校验、同帧幂等、五秒发送积压上限、无音频连接到期与有界收尾，防止失败后继续采集或自动重播。接口允许传入已授权音频，不授予智能体打开用户麦克风的权限。

保留现在的麦克风按钮、悬浮 Dock、授权提示、真实音量和停止入口。不支持流式的服务明确不可用，不悄悄退回十秒录音。旧独立转写、已有长文本保存及朗读保持兼容；本轮未恢复新入口或改变内容定位。

已验证：最终生产构建和类型检查、244/244 单元／集成、18/18 相关界面回归；覆盖停止前显示、累计纠正、草稿编辑、重新开始、关闭／切页、迟到系统许可、撤销与服务变更、断流、权限／身份隔离、无音频到期、发送背压，以及既有长转写和朗读。补测了停止后等待尾句期间隐藏窗口：取消旧流，迟到最终结果不改稿。协议层把官方空音频码 45000002 转成空结果，保留用户草稿并显示未识别到文字；45000081 等包超时仍是失败，不伪装为空语音。

全量首跑 225 项中 222 项通过，3 项仍用旧整段转写模拟接口，未声明 streaming，因而无法开始新听写。迁移整体流程及空语音场景到流式协议，保留原稿、停采和不自动发送断言；原“无语音错误码”覆盖移到协议单测，界面验证归一化空结果和失败后重新开始，不重播旧录音。受影响测试已包含在最终 18 项整组复测内；最后收尾修正后未再跑一次全量套件。内嵌 Electron 宿主专项通过，包含安全 preload、IPC、数据库／旧内容兼容、刷新和关闭重开；无本机 TCP 监听器。

真实服务验收脚本 `scripts/realtime-dictation-smoke.ts` 使用豆包生成的合成音频，不采集环境声音。最终实测首批服务结果 739 ms；经生产 Electron AudioWorklet、内嵌 IPC 到输入框首次可见 2008 ms（包含连接及合成源 500 ms 起播等待），完整句子在录音中持续可见，停止后收到最终标点并关闭全部采集轨道。时延是这次样本，不是所有网络和设备的保证；尚未以用户真实麦克风验证口音、噪声及识别准确率。自动化使用隔离 profile／center，不冒充原窗口验收；日志 `/tmp/morphz-realtime-live-final.log`，截图目录 `/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-realtime-acceptance-FN3cbM`。

原 Morphz 使用原应用路径、profile、center 正常退出重开，未重启 Runtime。事先执行 SQLite 在线备份，重启后检查历史消息、原空草稿、真实模型／连接状态、Dock 和输入入口；未打开用户麦克风、发送消息或改动账号及偏好。与备份比较，仅工作空间顶层 revision 随宿主恢复变化，全部工作空间业务字段和命令数量相同。验收收尾停留在原对话页。按用户要求，将本轮实时听写及配套测试独立作本地提交，不推送；提交前再次通过类型检查和 244/244 单元／集成测试，真实麦克风体验不因提交而视为已验收。

## 前轮修正：设置独立于账号菜单（2026-09-17）

按本轮确认的取舍，侧栏底部左侧保留头像、名称和真实连接状态，右侧固定设置齿轮，一次点击直接打开原统一设置。个人模式没有账号操作时，身份改为静态信息，不显示展开箭头或空菜单；启用团队登录时，头像菜单只提供真实的退出登录。窄屏保留同一组紧凑身份与独立齿轮，长身份文字不挤走设置。外观快捷按钮、模型／通知／连接业务、输入草稿和权限边界未改。

关闭设置返回实际触发齿轮，打开期间改变宽窄布局时返回可见的等价入口；保留账号菜单的键盘、外部点击关闭及退出后的身份隔离。更新现有设置测试辅助入口和旧菜单断言，没有删掉身份、草稿、几何及恢复路径的验证。

验证：生产构建和类型检查通过，最终 **32/32** 相关界面回归整组通过，涵盖真实测试身份的退出／重新登录、320／380／760／1380px、长名称／大量项目、亮暗、状态更新、分类与表单保留、键盘和跨宽度焦点恢复。首跑两项失败是新测试误要求模型设置聚焦关闭按钮（实际按原行为聚焦内容），以及模拟账号能力的请求未去掉 ETag 导致 304 空正文；修正为验证焦点确实在模态内和完整读取测试响应后整组复测通过。生产 Desktop IPC 连接专项通过，包括原生 200% 缩放、静态身份与直接设置入口、草稿与业务数据保留；该专项使用隔离数据。

原 Morphz 窗口通过 View → Force Reload 加载新构建，未重开桌面或 Runtime。现场截图确认左下身份／连接状态与右侧齿轮；使用实际鼠标坐标点击齿轮直接打开设置，再验证 Escape 回到齿轮和 Enter 再次打开。收尾关闭设置，恢复原对话页，未修改原账号、模型、偏好或消息。未提交、推送或发布。

## 前轮修正：用户菜单不重复常驻身份信息（2026-09-17）

恢复底部状态后，菜单仍重复显示名称和连接状态，形成两个相邻的信息块。现改为常规侧栏入口保留身份与状态，展开菜单只显示真实操作；仅窄屏图标入口没有常驻身份文字时，菜单才显示身份摘要。保留设置、实际支持的退出、外观快捷按钮、连接异常和原焦点行为，不填充无用菜单项。

生产构建及类型检查、15/15 相关界面回归、生产 Desktop IPC 连接专项和差异检查通过。回归明确检查打开菜单后状态文字仅有一份、单操作菜单不留摘要占位、窄屏身份可见、状态变化、设置返回与原生 200% 缩放。原 Morphz 刷新后使用鼠标点击底部状态，对照实际展开截图确认只有紧凑「设置」操作；进入设置、Escape 返回均正常，未改账号、偏好或工作数据。日志前缀 `/tmp/morphz-profile-menu-dedup-`；尚未提交或推送。

## 本轮修正：恢复身份入口的常驻连接状态（2026-09-17）

统一设置时不应同时隐藏原有连接信息。侧栏底部恢复名称在上、真实连接状态在下，头像与两行信息居中；仍是一个完整用户菜单入口，点击名称或状态均打开同一菜单。模型配置继续放在设置，外观快捷按钮保留，不恢复重复的常驻设置行。连接正常、异常、未配置和应用断线沿用原状态来源；窄屏紧凑入口保留可访问描述、提示及断线标记。

验证：生产构建及类型检查、237/237 单元／集成、22/22 相关界面回归、改动文件格式及差异检查通过。覆盖无需打开菜单就看到实时状态变化、状态与菜单一致、长名称／大量项目、320／380／760／1380px、亮暗、键盘／外部关闭及设置返回焦点。生产 Desktop IPC 连接专项验证通过，包含真实原生 200% 缩放、恢复后的常驻状态、同一菜单入口与草稿／数据保留。构建时补正上一轮新测试的 textarea 类型标注，不改变其光标或行为断言。

原 Morphz 只刷新前端，实际看到「我」下方的「智能体已连接」，使用鼠标坐标点击状态打开用户菜单、进入设置、Escape 返回原入口；当前停留在原对话页供查看。未发送消息、改动模型账号或重启 Runtime。日志前缀 `/tmp/morphz-profile-status-`；尚未提交或推送。

## 本轮完善：保留外观快捷入口并补齐日常设置（2026-09-17）

按用户要求，恢复侧栏顶部的「外观设置」按钮，不用统一设置取代已有快捷操作。快捷菜单仍可切换明暗模式和主题色，并提供「更多外观设置」；与设置页共用同一份偏好及控件。模式选择保持菜单打开，选定主题色后关闭并返回触发按钮；进入完整设置后也能正确恢复焦点。

新增阅读字号（标准／较大／更大）、动画效果（跟随系统／减少动画）及独立「输入」分类中的发送快捷键（Enter／⌘ 或 Ctrl + Enter），列出已有搜索、输入框与关闭菜单快捷键。字号只调整消息和文档正文，不改 PDF、网页或导航控件；减少动画即时取消正在播放的回复文字渐入，正文不丢失。默认值保持原行为，输入法选词确认、Shift 换行和按键重复不会误发送；偏好在本机保存，不修改工作空间业务数据、账号或已有草稿。未扩展运行服务、权限或成员能力。

验证：生产构建及类型检查、237/237 单元／集成测试、最终 37/37 相关界面回归、改动源码格式及差异检查通过。覆盖快捷入口与设置双向同步、持久化、实际正文大小、流式动画取消、输入法与发送组合键、焦点及 320／380／760／1380px 布局。首轮界面回归的两项失败分别是重载后的测试光标位置假设和隐藏／可见同名区域定位；修正测试定位与光标准备、保留原行为断言后完成最终整组复测。

最终构建的两套 Electron 回归通过：原生外观按钮点击、新增偏好、Enter 换行不发送与刷新持久化，以及真实 Runtime＋生产 Desktop IPC 的模型管理、账号保留、草稿和原生 200% 缩放。自动化使用隔离数据。原 Morphz 窗口只刷新前端，实际点击外观快捷按钮、完整设置和输入分类，并确认字号调整即时生效；检查后恢复原来的跟随系统、电光青、标准字号、系统动画和 Enter 发送。原账号、默认模型和消息未修改，当前停留在设置页供查看。

本轮未提交或推送。验证日志前缀 `/tmp/morphz-settings-options-`，最终界面日志为 `ui-final.log`，两套桌面日志为 `desktop.log` 和 `models-desktop.log`。

## 本轮修正：用户菜单与统一设置（2026-09-16）

按用户给出的菜单关系，将侧栏底部收敛为单行身份入口。点击后弹出用户菜单，再进入「设置」；不再常驻「模型与账号」或额外设置行。菜单仅使用真实能力，本机默认身份不提供无意义的退出按钮，已有身份登录仍可从菜单退出。窄屏使用同一菜单的紧凑入口，断线提示、通知铃铛与输入框的本次模型选择保留。

设置集中现有模型与账号、外观、通知和智能体连接，复用原业务调用，不引入服务、账号模型或权限。分类切换保留未提交的账号及连接表单；变更提交期间禁止切换和退出，关闭不保存未提交密钥，未完成的第三方登录仍按原协议取消。通知列表与偏好分开，偏好保存后刷新铃铛；旧已读／待补记回执和旧提醒范围需要本人确认的边界不变。

设置窗口按可用高度保持稳定，导航和关闭不随不同分类内容上下跳，长表单在内容区滚动。菜单使用既有顶层弹出组件、外部点击和键盘行为；模态关闭复用公共焦点恢复，窗口调窄后原入口隐藏时返回可见的等价用户入口。没有修改事项视图、成果范围、消息布局或悬浮 Dock。

本轮代码尚未提交或推送。原应用使用同一 profile 和中心，只刷新前端，不启动第二个手工测试实例；原 Desktop PID 47771、独立 Runtime PID 16959 及启动时间未变。现场已验证用户菜单、真实模型账号、外观、通知与连接分类；未修改原账号、默认模型、提醒偏好或凭据，也未发送测试消息。

验证：最终生产构建、类型检查、235/235 单元／集成测试、改动源码格式和差异检查通过。全量界面首跑 216/217 通过，唯一失败是旧用例仍寻找已撤下的常驻重连按钮。同步为当前断线提示和连接详情恢复路径后，最终源码的 57 项相关回归中 55 项通过；两项测试问题分别是恢复后的旧提示文案、在弹窗入场动效结束前采集几何。只修正测试入口、文案和动效等待，保留草稿、恢复、保存锁和稳定几何断言；包含两项的 15/15 复测通过。连同新增宽窄窗口焦点测试，本轮 218 项界面用例分批通过，不冒充一次全绿。

最终构建的三套 Electron 验证通过：真实 Runtime 加生产 Desktop IPC 的模型管理、生产入口连接失败与恢复、远端兼容宿主及原生交互。覆盖账号持久化、原生 200% 缩放、模型权限、连接错误、草稿、通知偏好、隔离渲染与退出恢复；使用独立测试数据，不重启原 Runtime，不冒充第三方真实 OAuth 授权。原窗口最后再核对四个设置分类的框体、导航和关闭位置保持一致，真实模型仍为 gpt-6-astra。日志前缀 `/tmp/morphz-profile-menu-`，最终界面回归日志为 `ui-final.log` 与 `ui-recheck.log`，三套桌面日志为 `native-models-final.log`、`native-connection-final.log`、`native-remote-final.log`。

## 前轮尝试：侧栏与公共设置界面（2026-09-16）

以下是用户进一步明确菜单结构前的中间方案和当时验证，不再作为当前侧栏布局。该批代码已随 `174d8e8` 本地提交；后续统一入口以上节为准。

用户指出底部身份、连接和设置入口排列混乱。本轮纠正公共布局及控件一致性，不改变已确认的事项列表／看板、内容分类、统一交流面板或悬浮 Dock：

- 身份与智能体状态组成同一个完整可点击行，头像改为人物图标，与两行文字居中；「模型与账号」单独一行，与上方文字和图标对齐。断线重试与身份退出仍是明确动作，不把状态文字伪装成按钮。
- 导航独立滚动，顶部工具和底部身份区域不随项目数量被挤走。补齐窄窗下连接、模型及必要的退出入口。几何回归发现滚动区负下边距会侵入底部 2px，取消该负边距，保留焦点边框所需的内部空间。
- 模型设置中的读取、重试和取消统一为次要按钮；添加账号按内容定宽，不再被 Grid 拉成无意的整行横条。长账号名、模型 ID 限制为两行，完整语义及提示保留，不能把实际操作挤出。表单操作可换行，窄窗和缩放时可滚动到保存按钮。

原 Morphz 窗口已刷新并通过实际鼠标点击核对侧栏两行、项目目录、对话和工作台、模型设置及添加账号；关闭弹窗焦点回到原入口。原 profile、凭据和独立 Runtime 未替换或重启，未新增消息或执行。在线 SQLite 备份：`/Users/shafreeck/Library/Application Support/MorphzWork-development/center/backups/workspace-2026-09-16T13-28-33-469Z-196f04c8.sqlite`。收尾恢复内容页时 Mac 锁屏，已请求用户解锁，未用另一应用代替原窗口验收。

## 本轮修正：跨页面一致性收尾（2026-09-16）

本轮只收敛整体审计确认的四处问题，不重做事项视图、内容分类或浮动 Dock：

- 通知撤下高／普通／低优先级标签、排序和筛选，按真实事件时间展示；提醒范围只有全部提醒／不提示。文字、排序及旧优先级字段修改不产生新的未读阶段。旧已读和待补记回执映射到当前通知；一次断线后仍继续同步。旧「仅高优先级」偏好不静默扩大提醒范围，保留原存储、暂不提示，通知入口显示待确认，用户明确选择后生效。
- 项目目录计数标明使用中／已归档／已删除；空搜索区分当前范围，可清除搜索或回到使用中，操作后焦点落在仍存在的搜索框。保留原筛选和排序，不在导航时偷偷重置；窄窗筛选按钮也直接显示范围。
- 本机侧栏增加「模型与账号」直达已有设置，模型页根部不再返回连接详情；连接诊断中的原恢复路径仍保留。宿主能力决定入口是否出现，远端和非本人无管理入口；复用原业务接口、模态焦点与提交锁，不改凭据、账号或输入语义。
- 工作便笺启动卡片说明改为实际用途。仅对该示例的精确旧说明做展示兼容，不重写已安装 HTML、协议、版本、权限或便笺状态；新示例包版本 1.1.1。

当前原 Morphz 的上述四处已现场检查；真实 gpt-6-astra 在 TEST 项目创建《TEST 整体流程验收 0916 晚间》v1，再按第二条请求修改同一文档为 v2，打开入口和可见正文均核对。只读比较在线备份：原 30 个对象、36 条输入保持逐条一致，仅新增 1 份测试文档与 2 条请求；安装包未变，内容应用的阅读状态随验收导航更新。原连接配置字节一致，独立 Runtime PID 16959 及启动时间未变。备份：`/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-embedded-cutover-hkdh0Q`。

验证：生产构建、235/235 单元／集成与最终 34/34 相关界面回归通过；覆盖模型与账号两种入口、取消和迟到响应、草稿、旧已读迁移、失败重试、项目范围、内容继续修改、应用安装和浮动 Dock。前轮回归发现测试数据拦截未处理 304、草稿断言未先重开自动收起的输入，以及示例包版本断言过时；修正测试后保留原行为断言，再完成上述整组复测。最终通知投影的线性遍历调整另通过 3/3 专项和构建。生产入口 Electron 模型专项与连接恢复专项均通过，覆盖真实 Runtime、Desktop IPC、API 接入和持久化、直接入口、760×540／原生 200% 缩放、项目空态与焦点、错误凭据拒绝和恢复；自动化使用独立测试数据，不冒充用户第三方账号的真实 OAuth 授权。截图包括 `test-results/project-empty-scope-1380-2.png` 和 `test-results/model-settings-accounts-dark-1380-2.png`。

能力边界：上述验证覆盖创建、交付、继续修改，不表示已实现运行中工作的定向补充／steering，也不新增通用导出、Office 编辑器或其他内容类型。失败恢复在隔离回归中验证，不通过破坏用户当前凭据或停止原 Runtime 制造故障。尚未提交或推送。

最终原窗口正常重开后再次核对 v2 正文及模型入口；现场从已删除空态返回使用中，实际焦点进入搜索框，再返回该测试文档供用户查看。后台 Runtime 未重启；没有自动提交或清除原会话中的其他草稿。

## 本轮修正：添加账号入口可辨识（2026-09-16）

根据用户截图，将一排无按钮样式的服务商名称改为独立的整行「登录并连接」按钮，账号登录／API Key 使用明确选中态。标题随步骤显示模型设置、添加账号、连接账号或选择模型，每层仅保留一个返回操作；移除重复的整行“模型与账号”返回。连接中显示进度，失败可原地重试；不改变已有授权接口、账号、默认模型或输入框布局。

验证：生产构建、232/232 单元／集成及 13 项模型／连接界面回归通过；覆盖键盘连接、重复提交防护、返回层级、失败恢复、四主题亮暗及 320／760／1380px 几何。真实 Runtime＋生产 Desktop IPC 隔离回归通过，覆盖 API 保存和持久化、草稿保留、五个注册入口、760×540 和原生 200% 缩放；截图改用 Electron 原生表面捕获，避免 CDP 在原生缩放下裁错范围。没有重新授权用户的第三方账号。

当前原 Morphz 已正常重开并现场验证账号／API Key 切换、两级返回与 Tab 焦点，停留在「添加账号」供查看；原模型仍为 gpt-6-astra，独立 Runtime PID 16959 及启动时间未变。重开前在线备份：`/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-embedded-cutover-b9auV4`。验证日志前缀 `/tmp/morphz-model-accounts-`；尚未提交或推送。

## 本轮完善：模型设置留在 Desktop（2026-09-16）

「连接详情 → 设置模型」改为原窗口内的紧凑设置，不再打开 Runtime Dashboard。可以查看真实账号、添加 API 连接、读取模型、选择账号的可用模型及设置默认模型；账号登录列出 Runtime 实际注册的 ChatGPT / Codex、Kimi、Claude、Google Antigravity、Grok 能力，仅第三方授权打开浏览器。授权完成后返回同一设置继续选择模型，支持轮询、手工回填、取消、过期恢复；未完成登录不是已连接账号。

新增有界 `RuntimeModelSettings` 与共享类型化 `model-settings.read/update` 调用，生产 Desktop 经内嵌 Application / IPC 使用 Runtime 已有 API。API 接入使用 Runtime 的原子 setup 与稳定请求 ID，不复制 Secret Store，不暴露原始服务端错误、请求头或凭据引用。仅本机本人具备管理权限；HTTP 与非本人拒绝管理。默认选择有陈旧值校验，账号模型保存保留既有容量、缓存设置与别名并检查版本；成功后刷新输入模型目录，不覆盖本次已选模型、不发送消息或改变既有 Session。

真实联调发现 Runtime 的账号目录刷新同时执行模型探测，故按钮明确为「读取并测试」，说明少量测试请求、不发送对话内容，取消登录后自动探测；普通查看、API 保存、默认模型切换不会触发探测。读取失败、未知提交结果与已登录后模型未就绪保持可恢复状态，过期授权取消是幂等操作。

验证：类型／生产构建、232/232 单元／集成及 26/26 相关界面回归通过，包含输入焦点、返回最新和身份隔离；既有连接专项 Electron 回归也通过。`scripts/model-settings-desktop-smoke.mjs` 使用真实 Runtime 二进制和生产 Desktop IPC，隔离的本地模型服务与合成凭据，实际完成 API 保存、账号模型启用、默认切换、Runtime 重启持久化、既有账号和输入草稿保留、760×540 与原生 200% 缩放；断言仅显式「读取并测试」产生一次模型请求，禁止桌面应用 TCP 监听。第三方 OAuth 的挑战／回调／取消有可控传输回归，但未替用户重新授权真实第三方账号，不据此声称五家真实登录均验收完成。

原应用已正常重开，实际 `morphz://app/` 窗口展示新设置、真实默认模型与账号、五种注册的登录入口和 API Key 表单，无 Dashboard 跳转。验收草稿重开恢复后已清除；未修改原账号或默认值、未重启独立 Runtime。重开前在线备份：`/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-embedded-cutover-4Gudtr`；前后工作空间字段（除修订号）、命令、身份与 Runtime Session／Thread／execution_jobs／schedules 内容一致，runtime.json／morphz.toml／models.toml 字节未变。最终验证日志以 `/tmp/morphz-model-settings-` 为前缀。当前窗口保留模型设置。尚未提交、推送或发布。

## 本轮修正：清除旧部署用语与模型重试误收起（2026-09-16）

用户追问“工作中心”和已撤下的应用 HTTP 后，本轮继续收敛界面概念，不再增加服务层或改变布局。登录改为“登录 Morphz”，登录凭据与运行服务的连接凭据区分；启动、语音服务、PDF 原文件、编辑冲突、目录授权与浏览器错误均指向实际对象，不再让用户连接或更新“工作中心”。原身份认证、内部标识、数据目录、远端 HTTP 兼容接口与独立 Runtime 保持原样。

模型推理设置区分未连接、正在读取、读取失败和旧服务缺少能力，不再把等待返回误报为需要更新。新增回归实际发现“重试”按钮移除后丢失焦点，导致未固定输入框自动收起；现在加载期间保留控件焦点，返回后移至可用选择器或重试按钮，用户已移开时不抢回焦点。未调整 Dock、消息列表或输入布局。

验证：构建、类型检查、224/224 单元／集成测试及差异、改动源码格式检查通过。首轮界面回归 20/22 通过，暴露上述焦点问题及旧状态文案断言；修复并补齐模型能力测试数据后，40/40 相关界面回归一次通过，覆盖登录失败／退出／撤销、身份草稿隔离、模型状态／重试、语音未配置／读取失败、文档冲突、PDF、Dock 焦点和返回最新。生产入口连接专项与原内嵌宿主 Electron 脚本通过；错误凭据、恢复、窄窗与原生 200% 缩放仍有回归，不依赖应用 TCP 监听。

原应用正常重开至 PID 35717，仍使用原 profile／数据；实际窗口显示应用数据可访问、智能体已连接及模型 `gpt-6-astra`，手动检查后的焦点正常。验收用未发送草稿重开后恢复，已清除并还原空输入。独立 Runtime PID 16959、启动时间未变；桌面进程无 TCP 监听。在线备份位于 `/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-embedded-cutover-dBsWxp`；前后应用身份、372 条命令、全部工作空间字段（除正常修订号）、配置字节以及 Runtime 的 Session／Thread／执行任务记录一致。没有用停止服务或破坏凭据模拟原窗口异常。

收尾核验：HTTP 未登录响应也与内嵌登录统一为“请登录后继续操作”，仅改提示，不改认证边界；最终构建、224 项单元／集成和登录专项 1/1 再次通过。日志：`/tmp/morphz-connection-language-build.log`、`/tmp/morphz-connection-language-unit.log`、`/tmp/morphz-connection-language-ui-final.log`、`/tmp/morphz-connection-language-login-final.log`、`/tmp/morphz-connection-language-desktop.log`、`/tmp/morphz-connection-language-embedded.log`。当前窗口保留连接详情供查看。尚未提交、推送或发布。

## 本轮完善：连接故障后的明确下一步（2026-09-16）

本轮只处理整体审计第 4 项，不扩展语音、导出或搜索。连接详情分别检查应用数据是否可访问、智能体运行服务是否可达和默认模型是否在当前目录中；区分未配置、无法连接、凭据失效、服务异常与模型配置不可用。左下角改为智能体实际连接状态，不再用“工作中心已连接”掩盖智能体断连；详情用“应用数据”，不把旧部署名称作为用户需要理解的新概念。

本机本人可在原连接详情中验证并保存连接，或更新同一运行服务的凭据；不允许借重连切换已有会话绑定的服务。仅支持本机 loopback，禁止重定向转发凭据，先验证再原子保存私有配置，带版本冲突、取消和身份失效检查。更新凭据保留原桥、Session、订阅及投递身份。远端和多人工作空间不开放本机配置，提示联系管理员；网关检查不越权读取管理员模型目录。模型设置复用既有 Runtime `/providers` 页面，不另造账号管理界面，不在 URL 中传递令牌。

检查接口只有 GET 诊断，不调用模型、不触发 tick、不重发输入、不重启任务或服务。“模型已配置”只表示配置目录可读且有默认模型，不代表真实推理成功。新增智能体 `connection-status` 只读接口复用诊断逻辑，不返回凭据、私有地址或设置权限。连接不会自动安装／启动独立 Runtime，初次服务接入的 Host 工具清单仍由 Runtime 的原有部署流程加载；本轮不声称实现了一键安装器。

验证：224/224 单元／集成、23/23 相关界面回归通过；补齐最终焦点修复后，连接专项 5/5 再次通过。构建、类型、差异检查通过。`scripts/connection-desktop-smoke.mjs` 从正式入口、隔离数据验证真实 IPC 配置、错误凭据拒绝、断连恢复、重开草稿、配置脱敏、760×540 与原生 200% 缩放；`embedded-desktop-smoke.mjs --production` 原有生产宿主回归通过。这两套脚本禁止应用 TCP 监听，不以测试服务冒充原应用。

原应用验收：正常重开 `/Users/shafreeck/Applications/Morphz.app` 的同一 profile／数据，桌面 PID 32728 无应用 TCP 监听；独立 Runtime PID 16959 和启动时间未变。原窗口实际检查模型 `gpt-6-astra`、只读设置地址、凭据不回显、取消设置、检查完成焦点、关闭后测试草稿保留；临时未发送草稿已清除并恢复原空输入。点击“设置模型”真实打开现有模型服务页面，未修改模型或账号，验收标签页已关闭。当前窗口不人为破坏凭据或停用服务；异常路径由独立自动化覆盖。

双库在线备份：`/var/folders/ql/kcn3hlyd0_nd3rvyqcqptc980000gn/T/morphz-embedded-cutover-YRynX9`。前后只读核对中心相同、372 条命令不变、全部工作空间字段除正常运行修订号外相同，`runtime.json` 字节相同。原项目、会话、输入、成果、凭据未变。Runtime 未重启，新增智能体操作的定义已写入 Host 清单，但本轮没有宣称旧运行实例已重新加载这项工具描述或做过付费模型验收。尚未提交、推送或发布。

## 提交复核：分批入库与兼容回归（2026-09-16）

用户要求“需要提交的文件，都分别提交”。本次按独立职责拆分项目管理、工作台继续工作、个人浏览器收藏、事项用语、PDF 附件、兼容性回归和产品／验收文档；每笔只纳入相应代码和测试，本地提交，不推送或发布。下文“未提交”等文字保留当轮历史状态，不代表本次提交结果。

在独立候选代码树完成类型检查、生产构建、216/216 单元／集成测试。全量界面首跑 192/193 通过，唯一失败是旧用例仍使用项目名称字段改名前的标签；同步为当前标签、保留原滚动／新回复／草稿断言后，包含该失败项的 13/13 用例再次通过。因此 193 项界面用例分批验证通过，不写成一次全绿。PDF 附件另补实际上传、预览、反复调宽不叠加文字、分页和草稿保持回归；原 PDF 画布、引用与批注回归继续通过。

生产入口内嵌 Electron、远端中心 Electron 和实际 Runtime 二进制 + 本地确定性 Provider 三套脚本全部通过。旧脚本同步为当前 IPC 读取、停用导入同步、个人草稿丢弃／恢复、独立通知设置及真实事项按钮；没有为了让旧脚本通过恢复已撤下的功能。远端脚本另外验证旧同步调用被拒绝、不获得本机原文件权限、不改变已有内容；已授权原文件读取由内嵌生产入口验证。Runtime 验证真实流式、成果操作、v1/v2/v3 输入、版本化目录读写、事项创建与交接、独立会话及附件，不调用付费模型。付费语音脚本本次只同步 Dock 选择器，未调用真实语音服务，不能作为该服务的新验收。

本次新增发现并修复浏览器刷新时撤权请求被连接失效操作一并取消的问题，独立记录在收藏章节；其余复核只同步过时的测试入口或等待实际布局，没有改变用户已确认的页面布局。所有改动源文件的格式与差异检查通过；全仓格式检查仍有四个未改动文件的既有告警（`conversation-feed.ts`、`microphone.test.ts`、`notification-badge.spec.ts`、`tsconfig.server.json`），未混入无关格式化。

复核日志：`/tmp/morphz-compat-commit-build.log`、`/tmp/morphz-compat-commit-unit.log`、`/tmp/morphz-compat-commit-ui.log`、`/tmp/morphz-compat-commit-ui-final.log`、`/tmp/morphz-compat-commit-embedded.log`、`/tmp/morphz-compat-commit-desktop-final3.log`、`/tmp/morphz-compat-commit-runtime-final.log`。这些隔离回归不冒充用户当前窗口的实机操作；原应用、profile、数据与 Runtime 未因本次提交重新启动。各功能原窗口验收的证据与限制按原轮记录保留。

## 本轮完善：项目页面、项目侧栏与智能体整理

2026-09-16 项目管理提交复核：按用户要求分功能提交，本批只包含项目生命周期、统一管理入口、会话／草稿整理、智能体接口及配套回归。独立候选代码树的类型检查、生产构建、207/207 单元／集成测试、27/27 相关界面回归、生产入口 Electron 项目专项、格式与差异检查通过；不依赖浏览器收藏或工作台最近打开等其他未提交改动。下述 216 项和 36 项是完整工作区的原轮验收，不冒充本批独立提交的测试数量。日志：`/tmp/morphz-project-commit-build.log`、`/tmp/morphz-project-commit-unit.log`、`/tmp/morphz-project-commit-ui.log`、`/tmp/morphz-project-commit-desktop.log`。当前应用验收沿用原轮证据，不再重启应用或 Runtime，不推送或发布。

2026-09-16：按用户确认的审计范围，统一项目目录卡片、侧栏项目行和项目标题旁的管理菜单。支持重命名、归档、恢复与可恢复删除；不增加永久删除入口，不清除旧内容、会话、附件、Session 或外部原文件。归档／删除项目退出日常列表和可写目标；目录分别查看使用中、已归档、已删除，仍可读取历史，恢复后继续原项目。侧栏的项目默认入口、命名会话、首条输入创建会话、原工作台应用和悬浮 Dock 不变。

已归档会话独立折叠，不与正在使用的会话混排；未发送草稿可丢弃并恢复正文、附件及原范围，恢复不覆盖后来已输入的草稿。项目目录保留搜索、排序和范围，最近活动计入真实输入与回复；联动回归修复后退后刷新重新打开旧项目的问题。新建、保存为项目与改名采用紧凑短表单，窄窗筛选按需展开，不挤掉搜索输入。

项目生命周期接入共享版本化命令。归档／删除在同一事务内检查排队、进行中、待确认和仍有效的周期工作，有阻塞则明确报错，不暗中停止任务。已保存但未投递的输入不能在项目归档后启动；恢复后仍用原输入。删除只修改项目状态，成果索引以独立投影排除其结果，恢复即重新可检索，不删除实际对象或历史。

智能体新增项目与会话整理接口，与界面共用权限、版本检查和持久幂等回执。授权身份取当前执行的实际用户输入，不接受工具参数冒充用户；跨项目只限同一成员边界，输入与目标归属必须匹配，授权撤销后不能重放旧回执。可以整理项目、改名／归档／恢复既有会话；不增加空会话、成员邀请或智能体注册流程。

验证：类型检查及生产构建、216/216 单元／集成测试、36/36 相关界面回归通过。新增生命周期、执行保护、陈旧版本、不同成员隔离、授权撤销、幂等、归档会话、草稿恢复、后退／刷新和窄窗失败保留测试。生产 Electron 使用独立临时数据、真实 IPC／协议验证创建、改名、归档、恢复、重载、控件命中，760×540 与 200% 缩放的紧凑弹窗通过，不依赖应用 HTTP 或 Vite。组合回归首轮发现收藏测试在共享夹具留下沉浸浏览器，使后续用例无法点击空工作区；已由该测试通过界面退出并关闭自己的浏览器，保留产品原应用恢复行为，重跑全部通过。

原 Morphz 使用同一应用、profile 与中心实际完成：创建「TEST 项目管理验收」、改名、归档、可恢复删除、恢复；未发送草稿丢弃后原文恢复；真实智能体按请求将项目临时改名再恢复，并把会话改名为「项目整理验收」。执行 Thread `thread_c20a3d0abfe34c93b5230d52` 实际 completed／delivered，三条整理回执持久保存；随后从界面归档／恢复该会话，再正常重开应用，原回复、会话及项目仍在。没有手工代替智能体写入成功结果。Runtime 为加载新的 Host 工具清单，在确认无在途工作后正常重开，沿用原数据库、配置、凭据与 Session。

与操作前一致性备份对照：原 5 个空间、13 个会话、30 个内容对象、35 条输入及原书签、事项顺序、应用状态、关系、批注、人工答复均保留；原 361 条命令、8 份附件及权限、12 条成果交付记录全部保留。只新增一个验收项目及其默认／命名会话和一条测试输入。备份为当前中心 `backups/workspace-2026-09-16T06-00-40-833Z-fb18ae22.sqlite`；日志为 `/tmp/morphz-project-build-final.log`、`/tmp/morphz-project-unit-final2.log`、`/tmp/morphz-project-ui-final.log`、`/tmp/morphz-project-desktop-final.log`。原窗口留在验收项目的真实回复，可直接继续检查。未提交、推送或发布；这是本次项目管理范围验收，不宣称全产品或全仓界面已全部通过。

## 前轮修复：工作台的继续工作与应用分区

2026-09-16 分批提交复核：本批只提交启动页分类、真实最近打开记录及配套测试。基于已提交的项目管理代码独立构建，210/210 单元／集成、17/17 启动页／内容／应用界面回归和生产入口 Electron 内容专项通过，格式检查通过。日志：`/tmp/morphz-launcher-commit-build.log`、`/tmp/morphz-launcher-commit-unit.log`、`/tmp/morphz-launcher-commit-ui.log`、`/tmp/morphz-launcher-commit-desktop.log`。未包含后续浏览器收藏，不推送或发布。

2026-09-16：按用户反馈，将工作台／项目启动页中无说明的内容按钮改成“继续工作”和“应用”两个明确分区。继续工作显示本空间最近明确打开成功的四份内容，标注真实类型、名称和打开时间；应用仍单击启动，输入、悬浮 Dock 和已有导航行为不变。访问记录只存本机当前中心／身份的对象 ID 和时间，显示时取当前有权访问的原对象；任务、当前理解和其他空间内容不混入，旧版本、正文、草稿与内容目录排序不变。没有历史记录时显示空态，不用新建时间或存储顺序凑数。

联动回归发现，直接监听“当前可见对象”会把自动恢复的旧应用误记成刚打开，使最近顺序跳动。现改为在明确打开内容成功后记录，失败、迟到且已放弃的打开、后台修订、智能体读取和自动恢复应用均不更新顺序；打开新内容前仍核对当前授权快照。该修复保留原应用恢复逻辑，没有修改其他按钮的作用。

验证：生产构建、类型检查、210/210 单元／集成测试及 43/43 相关界面回归通过；补充自动恢复不乱序断言后的启动页 5/5 再次通过。生产入口 Electron 脚本增加了启动页分区、真实打开、刷新持久化、760×540 与 200% 缩放验证并通过；没有应用 HTTP／Vite 依赖。日志：`/tmp/morphz-workspace-launcher-build.log`、`/tmp/morphz-workspace-launcher-unit.log`、`/tmp/morphz-workspace-launcher-ui.log`、`/tmp/morphz-workspace-launcher-final-ui.log`、`/tmp/morphz-workspace-launcher-desktop.log`。首轮自动化先在旧构建复现无可见分区；另修正了新测试把带事项计数的导航名称当作固定文字的问题，原行为断言保留。

原 Morphz 窗口已刷新，实际打开原有文档、PDF 和表格，核对 PDF 原第 2 页恢复、文档重开后排序前移及刷新后的记录保留。窗口停在新工作台，可见三类内容与下方应用的独立分区。没有编辑／复制原对象、发送消息、创建会话或重启 Runtime；未提交、推送或发布。

## 前轮修复：内容起草、归属与连续修改

2026-09-16 提交复核：本次本地提交包含内容目录及起草归属／连续修改修复所需的查找、预览、就地整理、类型化智能体操作和回归测试。浏览器个人收藏、旧网站创建接口退役及事项称呼等独立改动仍保留在工作区，未混入本提交。选中的代码在独立候选目录构建，类型检查、201/201 单元／集成、35/35 相关界面回归和两项生产入口 Electron 脚本通过，格式与差异检查通过；下文 207 项和原窗口验收是完整工作区的前轮记录，不作为本次独立提交树的测试数量。未推送或发布。

候选验证中发现一个旧来源测试仍期待外部文件被全文索引，已同步为不索引但直接读取原对象和暂停状态，保留旧数据、版本与来源生命周期断言。候选日志：`/tmp/morphz-content-commit-build.log`、`/tmp/morphz-content-commit-unit.log`、`/tmp/morphz-content-commit-ui.log`、`/tmp/morphz-content-commit-directories.log`、`/tmp/morphz-content-commit-desktop.log`。

2026-09-16：在原 Morphz 内容页复现“选中 TEST，起草和手写仍属于工作台”。根因是目录范围保存在列表内部，输入和创建使用另一套目标。现由同一范围驱动列表与真实输入归属；动作名为“起草文档”，点击只打开同页输入，不跳转、不自动发送或创建。具体范围的起草和手写都留在该范围；全部范围的原工作台兜底、草稿与旧数据仍保留，不把全目录查看权解释为跨项目工具权限。保留原页面布局与工作台应用能力，没有新建分类或删除功能。

真实智能体验收又发现：从内容继续处理时，界面被隐式固定在历史版本，导致修改成功后正文仍是旧版。本轮同时修复：当前内容跟随真实更新；输入仍记录精确引用版本，显式历史和基于旧版的未发草稿保留旧引用。筛选切换使目录授权重新按真实范围读取；文字、附件及手写草稿不跨范围搬移，迟到回执不覆盖后续导航。

原应用使用 TEST 范围生成《TEST 内容流程验收 0916》，连续修改同一份报告至 v3，正文实际自动显示最新内容，未复制文档或手工替代智能体交付。三条真实输入与三个持久交付回执均归 TEST，沿用原默认会话；原有 29 个对象、32 条输入及其他业务数组的内容哈希一致，仅新增这 1 份测试报告和 3 条测试输入。原窗口留在该报告、最新回复及悬浮 Dock，用户可直接查看；未另开手工测试配置、重启 Runtime、提交或发布。

验证：类型检查、生产构建、207/207 单元／集成测试、30/30 相关界面回归通过；生产入口的隔离 Electron 目录脚本补充了内容范围切换、重载、授权隔离及实际输入持久化验证并通过。新增用例先复现两条错误归属；补测连续修改、历史固定与旧版草稿恢复。中间一次用例误等待提交期间被禁用的输入获得焦点，改为先检查草稿、回执返回后再验焦点；另一个旧用例仍断言错误的工作台归属，更新为所选范围，保留原会话与空态断言。日志：`/tmp/morphz-content-workflow-build.log`、`/tmp/morphz-content-workflow-unit.log`、`/tmp/morphz-content-workflow-ui.log`。这些是本次专项验收，不是全产品可用性或全仓 UI 已通过的声明。

收尾补测：短标签视觉与 Agent-first 入口 5/5 通过，连同上述 30 项共 35 项相关界面用例，分两批运行。生产 Electron 目录脚本及 207 项单元／集成重新通过，格式与差异检查通过。补测日志：`/tmp/morphz-content-workflow-actions.log`。

## 前轮修复：返回最新的位置与控件移除后的焦点

2026-09-15 提交复核：按用户要求，将返回最新的位置／焦点修复，与尚未入库且被本次修复依赖的连体交流面板、悬浮 Dock、目录授权、附件粘贴及共用执行侧栏纳入本地提交。内容目录重构、浏览器收藏、成果索引调整及其他未相关改动保留在工作区，不推送或发布。提交内容在独立候选代码树中构建，不依赖未暂存文件。

候选代码树类型检查、生产构建和 193/193 单元／集成测试通过；60 项相关界面用例分批通过，其中组合复核为 59/60，补齐拆分时遗漏的原批注入口后，包含该项的侧栏／返回最新／输入连续性 19/19 重新通过。拆分时同时补齐了侧栏控件容器位置与旧内容页测试选择器，不改变原工作区界面。两项生产 Electron 脚本、格式和差异检查通过。下述 207 项等数字是前轮完整工作区验收，不能作为本次独立候选树的测试数量；原窗口验收沿用前轮实测，本次未重启应用或 Runtime。

2026-09-15：在原 Morphz 事项窗口复现“返回最新”离 Dock 过远、点击后整个输入区消失。前者来自消息区底部 padding 与 sticky 偏移重复避让；后者来自聚焦按钮被移除后焦点落到页面，误触未固定输入的离开收起。原回归主要覆盖纯对话或固定面板，且有用例只断言按钮消失，没有断言输入仍在，漏掉了这条真实路径。

本轮仅修复位置计算和焦点交接，不再调整已确认的连体面板、悬浮 Dock、按钮顺序或功能。返回最新在移除聚焦按钮前回到原输入，普通滚动不抢其他控件焦点；底部避让只保留消息区的一份。补测发现移除附件、撤销目录权限也会留下无用焦点，一并交还稳定控件；撤销目录须先提交重新启用按钮的渲染，再恢复焦点，仍保护后续输入和不同范围。真正离开时的自动收起未禁用。

原窗口已刷新：实测近期／完整记录上滚后按钮贴近 Dock、点击后保留输入及焦点，记录显隐、展开／返回、固定／取消固定正常；真实附件与目录选择器均取消，返回各自原按钮。保留原看板、TEST 筛选、消息和空草稿，未发送消息、授予目录权限或重启 Runtime。自动化证据包含新增未固定事项页近期／完整记录鼠标、Enter、空格操作；320px 至宽屏、长草稿、滚动高度、复制兼容路径、附件移除；生产入口隔离 Electron 的真实长消息与 760×540／200% 缩放及目录撤销焦点。生产构建、类型检查、207/207 单元／集成测试、54/54 相关界面回归及单独的 1/1 模型／推理选择与失败保留回归通过，两项生产 Electron 脚本通过，格式与差异检查通过。原窗口留有可直接试点的“返回最新”和输入区；未提交、推送或发布。

## 前轮微调：输入与消息的视觉衔接

2026-09-15：按用户确认，仅拉近输入与消息的底色、减弱中间分隔线。输入底色使用现有纸面色与抬升表面色混合，分隔线改用既有轻边界色；CSS 和原生增强对比度仍保留清晰边界。不改 Dock 的位置、尺寸、显隐、按钮动作，不改正文高度、消息避让、范围或数据协议，不加渐变或阴影。

生产构建及类型检查、21/21 相关界面回归、格式和差异检查通过。新增明暗模式的颜色差缩小、正文／占位文字对比度、系统增强对比度回归；原位置、连续 Tab、选择器取消、草稿和收起行为用例继续通过。原 Morphz 事项窗口刷新后实际查看同一段消息与输入的衔接，保留原看板与筛选；未发送消息、变更权限或重启 Runtime。未提交、推送或发布。

## 前轮修正：保留连体面板，恢复原始悬浮 Dock

2026-09-15：用户确认“这就是我最初的想法”：记录和输入仍共用外框，原按钮恢复为输入上沿的独立悬浮 Dock，移除常驻工具栏。附件／目录／截图／语音与记录／展开／固定／收起在同一 Dock 内分组，按钮原动作、顺序、快捷键与权限不变；模型、推理和发送保留在输入框内。桌面沿用悬停及焦点显示、触控常显；命中桥避免小间隙闪隐，减少动态关闭过渡。纯对话仍不新增工作页的重复固定／收起控件。

Dock 不参与输入高度计算，收起记录后只有输入本体，不留顶栏或底部工具行。展开记录按 Dock 实测高度保留末尾阅读空间，消息和“返回最新”不被遮住；窄窗按钮可换行，历史显隐、完整记录和固定不挪动工具命中位置。原生网页在不重开或改变协助权限的前提下让出 Dock 边界。原窗口复核又发现裁剪后露出白色占位底板，已去除网页占位容器的白底／边框，确认收起态不再出现整条底板。

验证：类型检查、生产构建、207/207 单元／集成通过。58 项相关界面回归分批通过，包含位置、连续 Tab、零占位、末尾消息不遮挡、320／390／760／1440 明暗窗口、触控、附件粘贴、截图、听写、草稿与消息控制；最后底板修复后的 25/25 相关用例再次通过，不宣称全仓 UI 验收。独立生产 Electron 的面板和目录两项脚本通过，覆盖真实持久消息／草稿、取消与失败、760×540 和 200% 缩放；原生截图窗口用例本次也通过。首轮新增零占位测试因主动隐藏正聚焦的未固定 Dock 而触发合法失焦收起，测试改为固定状态下测量，未修改失焦语义或放宽高度断言。合成视觉消息仅用于隔离测试。

原应用验收已补齐：Mac 解锁后，仅刷新原 Morphz 前端，无另开手工测试配置、无重启 Runtime。原内容页实际验证展开／收起、完整记录／返回、固定／取消固定、隐藏／重开和连续 Tab 到达八个按钮。真实附件与目录选择器均取消，输入不消失、焦点回原按钮，未上传、授权目录或发送消息。浏览器原网址与收藏状态保留，原生网页不再盖住 Dock；返回项目后实际核对 TEST／对话 3 的原文及 `attachment.txt` 均恢复。未提交、推送或发布。

## 前轮修正：输入面板的按钮稳定性、焦点与视觉层级

2026-09-14：用户指出 InputBox 与消息记录不美观，按钮安排及行为也与原来不一致。本轮保留已确认的连体面板，不新增功能、改变权限或重做其他页面。原 Morphz 内容页实机复现：消息显隐时顶部面板按钮随历史高度上下跳；输入后的 Tab 路径跳过顶部控制；目录原生选择器取消导致整个未固定输入收起；附件选择取消没有返回原按钮。两次选择均取消，没有新授权、上传或发送。

将现有输入工具与面板控制分组放在输入附近同一操作行，保留原图标、动作、快捷键及草稿范围；历史伸缩不挪动按钮，键盘按 DOM 顺序连续可达。输入和记录共用一层边框及克制的焦点色，取消下半区独立高亮框；顶部无范围按钮时不留空栏，空记录与短消息按内容紧凑占位，正文仍全宽、至少两行，保留明暗、触控和窄窗。语音、截图、发送、模型及执行协议均未修改。

目录选择在调用原生 IPC 前同步暂停原范围的自动收起，取消或失败仍保持面板；附件和目录结束后仅向仍有效的原入口恢复焦点，不抢走后续输入／导航。迟到结果不清除另一范围的等待状态。新增位置回归同时检查 x/y 与命中尺寸；键盘回归不再直接跳焦点到待测按钮。三个新回归先在旧构建全部失败，修复后通过。

验证：类型检查、生产构建和 207/207 单元／集成通过。首批 66 项界面测试有 61 项通过：另 1 项暴露窄窗高度超预算 4px，已收紧非正文留白；3 项检查器用例假设共享夹具仍停留在空对话，现显式导航到待测场景，原行为断言保留；1 项原生截图回归因 macOS 锁屏无法取得前台焦点。上述修正后 31/31 布局、焦点、检查器和动效回归重新通过，合计 65 项非原生前台用例分批通过，覆盖附件、截图、听写、消息控制、会话草稿与内容范围，不宣称全仓 UI 通过。隔离生产 Electron 的目录 IPC／存储回归通过，包含模拟原生失焦后的取消与失败、原权限边界、草稿、刷新和 200% 缩放。明暗／窄窗截图来自真实组件加独立合成消息，不是原窗口或真实模型交付证据。

原窗口验收未完成：修复构建后尝试刷新时 CUA 明确返回 Mac 锁屏，停止操作并请用户解锁；另一项原生 Electron 面板回归同样未能完成焦点操作。未绕过锁屏、重启原应用／Runtime 或另开手工验收环境。当前不能声称原窗口已加载新版、原生选择器修复已实机通过或全部行为已无回归；解锁后需在原窗口继续取消选择器、展开／收起、固定、键盘及草稿检查。未提交、推送或发布。

## 前轮修正：浏览器基础收藏与智能体接口

2026-09-16 分批提交复核：本批只包含独立个人收藏、Human／智能体共用操作、旧网站兼容与相关回归。候选代码树类型检查、生产构建、216/216 单元／集成测试、13 项相关界面回归及两项隔离 Electron 收藏／浏览器脚本通过；不依赖剩余事项文案或 PDF 兼容改动。补跑旧浏览器脚本暴露刷新时先关闭页面、再取消连接会连同撤权请求一起取消，现先取消旧连接，再在新连接上报告关闭状态；原脚本先失败，修复后连续两次通过，并新增 2 秒内主动撤权的断言，不靠 10 秒租约过期。日志：`/tmp/morphz-bookmark-commit-build.log`、`/tmp/morphz-bookmark-commit-unit.log`、`/tmp/morphz-bookmark-commit-ui.log`、`/tmp/morphz-bookmark-commit-workflow.log`、`/tmp/morphz-bookmark-commit-desktop.log`、`/tmp/morphz-bookmark-commit-browser-regression.log`。原应用收藏验收沿用下述原轮证据；这次未重启原应用或 Runtime，不推送或发布。

2026-09-14：纠正将“撤下网站内容类型”扩大为“取消浏览器收藏”的范围错误。收藏成为独立的个人浏览器数据，地址栏可收藏当前网址及打开收藏列表；支持搜索、打开、编辑、移除和撤销。Human 与两个 Host 工具名称共用同一版本化命令与持久回执，智能体提供 `bookmarks` 的 list/add/update/remove/restore，不要求模拟点击或先获得网页控制权限。所有者来自当前 Human 或实际发起输入，模型不能指定用户；共享项目不暴露其他人的个人收藏。相同规范网址重复添加不覆盖旧名称；修改、删除和恢复均检查版本，失败保留编辑内容。

收藏只保存名称和网址，不联网抓取、不创建 Artifact、索引或会话。旧 website 内容对象、版本、历史请求回执仍可访问，但不再新建；公开理解退出普通内容目录、计数、最近成果与成果索引，检查器和历史保留。图片／PDF 与认知应用扩展能力保留，本轮不建设新的图片编辑器。用户另指出 InputBox Dock 悬浮按钮不见：已查明是前轮合并交流／输入面板时拆分到顶部与底部，不是本轮收藏改动；已说明该取舍未单独确认，本轮未再变更或宣称恢复 Dock。

原应用验收：无在途执行时备份原中心／Runtime 及退出后的 desktop profile 至 `/tmp/morphz-browser-bookmarks-AgFiqw`，使用原 Morphz 包、原数据路径与 Runtime 二进制正常重开，未启动第二个手工验收环境。原 TEST／对话 3 的原文和 attachment.txt 实际核对保留。真实自然语言请求先调用 bookmarks/list 再调用 bookmarks/add，两条工具均 succeeded，生成「TEST 智能体收藏验收」`3144ad17-c216-5930-9620-2ff40b99fbf8`；没有页面访问工具或成果对象创建。原生坐标鼠标点击收藏按钮生成「TEST 手动收藏验收」`7caf2b1c-65f3-49de-b933-f8d74d9a5220`，实机编辑、移除、撤销为 v4；两条在同一收藏列表可操作。点击智能体书签打开准确带片段网址，重载原应用后网址、收藏选中态及列表仍保留。原 29 个对象和 31 条旧输入逐条不变，只增加 2 条书签和 1 条验收输入；旧工具任务逐行保留，最终没有在途 Thread。

类型检查、生产构建和 207/207 单元／集成测试通过。24/24 相关界面回归覆盖收藏全流程、并发冲突与失败、内容目录、旧网站、理解检查器、表格、应用和草稿；正式入口隔离 Electron 另外验证真实网页、IPC、刷新、760×540 和 200% 缩放。首轮发现收藏弹窗继承地址栏布局，已移到共享弹窗层；真实浏览器还发现标题刷新滞后，收藏时改为核对当前原生页面再取标题，页面已切换则不误存另一页。首轮测试的直接缩窗断言改为等待实际布局，独立连跑用例适配既有浏览器实例恢复，不删除持久化或权限断言。上述隔离回归不冒充原窗口验收。原窗口最终留在收藏列表，名称和网址分行显示，保留两条可操作 TEST 书签。未提交、推送或发布。

## 前轮修正：内容交付边界与表格命名

2026-09-14：按用户确认的有限调整，保留内容页、卡片／列表、查找、整理、预览、版本和批注，不接入 Office 套件或替换表格引擎。撤下“制作表格或报告”混合创作入口，保留共享输入起草及手动写文档。旧 `interactive` 输入意图仍可读，提示改为制作表格；不清空旧草稿。所有交互对象在目录和详情中统一为“表格”，内部视图改为“表格／记录／统计”，原 `table/form/report` 数据键、标题、数据与版本不变。

Human 和智能体仍使用原共用对象操作。两个 Host 名称的说明均明确：书面报告、分析、说明、一次性比较默认 Markdown 文档；持续维护、逐条编辑和交互筛选的记录才创建可编辑表格，继续编辑旧表格不改其类型。统计仅为已有数值的计数、合计、均值，不是书面报告；三种视图不拆成三个对象。明确格式或交互页面要求先核实工具能力，不能用内部表格冒充 Office 或可执行 HTML。本轮没有加入文件格式库、导入、同步或外部索引。

验证：类型检查、生产构建、201/201 单元／集成和 16/16 相关界面回归通过。新增旧三种布局兼容、视图切换不改历史、真实工具创建文档／表格、人改版本冲突和稳定重试检查。首轮界面测试读取了旧构建；重新构建后原断言全部通过。正式入口隔离 Electron 验证 IPC、PDF 像素、表格记录、正文搜索、整理撤销、草稿范围和 200% 缩放。工具说明的字符串测试只验证配置，不作为真实模型交付证据。

原窗口验收：确认没有在途执行后，备份原中心和 Runtime 到 `/tmp/morphz-content-boundary-hsAqfj`，正常退出并备份原 desktop profile，再以原应用、原数据路径和原 Runtime 二进制重开加载新说明。原窗口已看到仅保留手动文档的次级菜单、三个旧表格统一分类，以及“表格／记录／统计”与原合成数值。真实请求不指定内部类型：报价分析请求通过 `create-document` 交付「TEST 报告交付验收」`4402db1d-d9f0-5dda-9941-51aa51121897`；持续维护、逐项编辑及筛选需求通过 `create-interactive` 交付「TEST 持续报价清单」`aeb2bf2d-5280-5e70-b75a-1d587dbf4c7a`。两次 `list` 与两个创建工具均 succeeded，原窗口实际打开两份成果，确认报告正文和表格记录。表格筛选“甲”得到 1/2 条，清除后统计显示合计 270、均值 135；两个对象仍为 v1，查看不增版本。两例验证不等于所有自然语言请求均能正确选择格式。

数据核对：原 27 个对象（含所有旧版本）和 29 条输入逐条不变，只增加上述两份测试成果及两条测试输入。原 58 个工具任务、123 个 activation、44 个 Thread、1159 条事件全部逐行保留；13 个 Session 无删除／新建，仅接收测试输入的既有 Session 更新活动信息。应用实例仅随正常导航更新；无在途 Thread。没有清理草稿或附件。最后尝试核对原 TEST／对话 3 草稿、准备将窗口留在内容目录时，Mac 锁屏，停止界面操作；本轮不能声称原草稿已再次实机核对或最终目录位置已恢复。锁屏前原窗口已展示两份新成果和表格统计，解锁后可从 TEST 项目访问。未提交、推送或发布。

## 前轮修正：内容目录的查找、预览与就地整理

2026-09-14：按已确认的内容页问题统一修正，保留卡片／列表、类型／空间筛选与原返回路径。顶栏仅放内容创作入口，按钮直接显示实际起草位置（全局目录为工作台）；范围筛选不重定向创作。正文搜索复用现有 Agent 原生产物索引，合并当前可见对象的标题匹配，支持翻页、失败重试和查询隔离；人工文档、旧导入副本仍可按标题找到，不新增外部索引或导入流程。PDF 按需显示真实首页，表格／表单／报告显示实际字段与记录，文档摘取原文而非编造摘要；正文命中不重复显示同一段预览。

卡片与列表补充原始创建者／导入来源、真实事项关联和最近修改／最近创建／名称排序。内容旁可以重命名、移动、撤销或让智能体继续处理。`organize-content` 是 Human 与 Host 共用的类型化命令：显式当前版本、相同成员边界、稳定重试回执；同一对象追加版本，不复制正文或重写旧输入。有关联的内容不允许单独移动，成员范围不同也拒绝移动。Host 的整理调用仍限定实际输入授权的项目，不能借新操作跨项目提权；`list(contentOnly=true, sort=...)` 提供相同可读状态。继续处理只展开当前会话输入并引用所选对象，保留其他草稿，不自动发送或访问网站。

验证：类型检查和生产构建通过，198/198 单元／集成测试、61 项相关界面回归最终通过（分批运行，非全仓界面测试声明）。覆盖正文检索／分页、旧副本可见、重命名／移动／撤销、并发冲突留草稿、目录返回、应用、事项、输入、附件、截图、语音和窄窗。更新创作菜单后的旧测试入口同步为真实菜单操作；离开手动编辑后显式展开输入，保留原持久化及会话断言。正式入口隔离 Electron 验证本地 IPC、PDF 实际像素、表格数据、搜索、撤销、760×540 和 200% 缩放。

原 Morphz 实机：确认无在途执行后，一致性备份到 `/private/tmp/morphz-before-content-Li9wtl`，正常退出后备份原 desktop profile。原应用及原 Runtime 二进制／18089 地址正常重启，读取新 Host 定义，没有启动另一手工测试环境。原窗口实际操作正文搜索、重命名与撤销、移动到工作台与撤销、从内容展开输入；测试文档 `74dee1d3-935f-5bb7-bb93-28a42f93aaf4` 的名称／TEST 归属恢复。真实智能体再执行 `list`、`read` 与两次 `organize-content`，全部工具 succeeded，v5→v6 临时改名、v6→v7 恢复原名，原窗口显示完成回复。原生鼠标验证顶栏菜单、右侧栏开关与菜单外点击。原 TEST／对话 3 草稿原文及 `attachment.txt` 附件实际核对仍在。

数据核对：原 27 个对象仍为 27 个；唯一变化为上述测试文档追加 6 个版本，正文、原版本、作者、名称及归属保留。原 28 条输入逐条一致，仅新增 1 条本轮测试请求；项目、会话、关联、批注和参与者未改变。Runtime 的原 46 个工具任务、95 个 activation、33 个 Thread、903 条事件逐行保留；9 个 Session 均保留，仅本轮接收测试请求的既有 Session 更新活动时间。原窗口最终停在内容页卡片视图、全部范围、空查询，收起交流与右栏，供用户直接查看。未提交、推送或发布。

## 前轮文案：事项中的智能体称呼

2026-09-16 分批提交复核：事项用语作为独立提交，候选代码树的类型检查、生产构建与 7/7 事项界面回归再次通过，覆盖宽／窄窗负责人筛选、状态、安排和看板。日志：`/tmp/morphz-task-label-commit-build.log`、`/tmp/morphz-task-label-commit-ui.log`。只改用户可见称呼，不改真实身份或历史原文，不推送或发布。

2026-09-14：按用户要求，事项负责人筛选统一为“我的／智能体／全部”，窄窗筛选、事项编辑的负责人类型及执行连接提示同步使用“智能体”。保留 `agent` 内部键、真实 Morphz 名称、事项标题和历史原文，不改变筛选、身份或执行行为。类型检查、生产构建与 7/7 事项界面回归通过；原 Morphz 窗口刷新后实际显示“智能体”，原看板和 TEST 筛选保留。未提交或推送。

## 前轮修正：交流记录与输入共用面板

2026-09-14：按用户确认的合并方案，将交流记录和输入区连为一个面板，中间只保留细分隔线。查看范围留在顶部左侧，历史显隐、完整记录、固定与收起归入右侧；附件、目录授权、截图、听写与临时批注进入输入底部，模型与发送仍在右侧。工具不再依赖悬停发现，空交流只保留一行提示；窄面板允许底部工具换行，正文仍有两行起步的全宽空间。

沿用同一 Conversation、输入组件、草稿、范围与 Session，不改消息、附件、目录权限或执行协议。原近期记录浮层与输入占位、固定／短窗／原生浏览器占位、完整记录展开和纯对话常驻规则保留。整个面板计入内部焦点区域，左右留白仍属外部；移除会短暂拉开分隔线的独立历史位移动画。

验证：类型检查、生产构建、195/195 单元／集成与 26/26 相关界面回归通过，覆盖草稿与阅读位置、键盘、固定、展开／收起、窄窗、附件粘贴、截图恢复及减少动态等。正式生产入口隔离 Electron 验证真实本地保存的消息、刷新恢复、原输入工具、760×540 与 200% 缩放；没有将未配置 Runtime 的本地保存冒充模型执行。

原 Morphz 窗口只刷新前端，未重启应用或 Runtime；在原「TEST 记录一个灵感」事项实际看到连体面板，并展开原完整历史、返回原事项。原对象仍为 v13，当前空草稿未被填写或发送。随后系统锁屏，停止实机操作；固定与收起的本轮证据来自上述自动化验证，不冒充原窗口操作。本轮只调整布局和交互归属，不修改事项视图，不提交、推送或发布。

## 前轮修正：清单与看板的状态操作入口

2026-09-14 提交复核：按用户要求提交已修复的事项功能。提交范围包括原日期分组清单、独立四列看板、Human／Agent 共用排序与安排接口、真实等待／执行／交接和上述状态入口修正，以及必要的共用审批组件、规范与测试；对话重构、目录授权和附件粘贴等其他工作区改动不混入。通过独立候选代码树核验，不依赖未暂存文件才能构建或运行。

候选代码树的类型检查、生产构建和 184/184 单元／集成测试通过；完整界面回归首跑 142/145 通过，另外三项分别是两个旧事项按钮选择器及拖动测试在保存期间手柄禁用时提前操作。同步选择器，并明确等待保存结束后再拖动，保留持久状态、刷新、撤销与草稿断言；相关 23/23 界面回归重新通过，包含首跑的全部三项。正式入口隔离 Electron 的状态修改／撤销、完整按下跨列拖动／撤销、760×540 与 200% 缩放通过。此处是提交候选版本的回归，不替代下述原窗口验收；本轮没有重启原应用或 Runtime，只作本地提交，不推送或发布。

2026-09-13：用户指出看板可跨列拖动却常驻状态下拉，而清单的状态操作反而藏在安排弹层。保持原日期分组、紧凑行及四列看板，只调整入口：本人事项的状态下拉直接放在清单行内；安排弹层不重复放置；看板卡片移除状态下拉，以跨列拖动为主要方式，既有详情保留非拖动／键盘状态操作。清单拖动仍仅调整同日期组内顺序，提示明确区分；Agent 事项不提供手动进度选择。所有修改复用既有命令、版本检查与撤销。

构建、11 项事项逻辑回归和 7 项事项界面回归通过。正式 Electron 验证清单直接修改／撤销、看板完整按下拖动／撤销、760×540 与 200% 下状态控件可达；界面回归另验证看板详情的键盘入口、状态跨视图保存及没有重复选择器。原 Morphz 窗口刷新前端后，实际操作「TEST 确认事项页交互」从待处理改为进行中，切换看板核实所属列及无状态下拉，再撤销并返回清单。该事项 v3→v4→v5，最终内容恢复；27 个对象、28 条输入、原顺序及其他对象完整保留。备份与审计位于 `task-state-control-20260913-dT1BaW`。本轮未重启 Runtime，原窗口停在清单供用户查看；先暂停前一条提交请求，尚未提交或推送。

## 前轮继续优化：等待原因、当前操作与真实交接

2026-09-13：按“继续优化”要求，保留原清单日期分组、紧凑行和独立四列看板。本轮不增加视图、成员、自动排程或新的事项字段。纠正原投影将执行失败、执行结束但事项未完成、普通执行安排错误混入等待的问题；这些现在进入待处理。真实等待显示相关负责人、前置事项及等待原因，并可直达前置事项；待审批关联准确的当前 Thread。旧 waiting 标记没有实际原因时明确说明缺失，不由标题或错误字符串猜测。

Agent 行／卡片按状态突出开始、重试、处理确认、查看进度或查看结果；停止／撤回仍直接可见，重新执行、取消和历史记录等次要操作在事项菜单中保留。单一成果直接打开真实文档。Agent 读取／安排结果增加可读项目、负责人和共用实际状态；排序返回已保存的当前顺序摘要，原权限、版本检查和持久回执不变。

验证：195/195 单元／集成、19/19 相关界面回归通过，覆盖等待→前置事项、失败／执行结束分列、审批与停止、单一成果直达、菜单键盘返回、错误不伪装成功、原清单、排序、输入草稿和粘贴附件。正式 Electron 清单／看板、完整按下拖动／撤销、760×540 和 200% 缩放回归通过；类型检查与生产构建通过。未制造真实权限审批或故意破坏真实执行来展示失败；这两类状态由自动化夹具验证，不冒充原窗口验收。

原窗口真实验收：一次自然语言输入创建本人负责、9 月 14 日截止的「TEST 确认素材」，排到原有「TEST Agent 等待素材确认」前；其余 TEST 项目事项的相对顺序不变。原 Agent 示例改为真实依赖并显式开始，窗口显示“等我提交结果：TEST 确认素材”，没有提前交付。点击查看前置事项，通过原共享输入提交测试答复 `51052d5c-ab38-4da0-a039-d9ab2226443a` 后，Agent 自动继续；Thread `thread_6acfdd7ed6dba271ed2df1db` 实际 completed，事项 v4 完成并关联文档 `4004e185-7912-5037-954f-289c012651a0`「TEST 素材交接结果」。原窗口逐项看到等待→进行中→已完成，并通过查看结果打开正确正文、Morphz 作者、v1 和事项关联；旧成果和执行记录入口也实际核对。

原应用使用同包、同 profile 正常重开加载后端更新；Runtime PID 96764 未重启，本轮未改工具参数清单。备份与只读审计位于 `/Users/shafreeck/Codes/.worktrees/desktop-capture-backups/task-status-20260913-KJ7lV5`。原 25 个对象、旧版本与 27 条输入保留；除明确用于本轮的原 Agent 示例外，其他旧对象完全一致。本轮仅新增 1 条 TEST 人工事项和 1 份 TEST 成果，共 27 个对象、28 条输入、顺序版本 8；真实答复单独保留。应用实例的导航状态随正常重开恢复，不宣称该视图状态字节不变；实例身份、原附件、旧回执、Session 和 Runtime 历史保留。最终无在途执行，不提交、推送或发布。此轮是已有交互的修正，不宣称达到“最优”。

最终原窗口刷新到生产构建，清单日期分组与紧凑行再次目视核对；随后留在看板、全部负责人／全部状态、搜索 TEST，显示 9 条真实可操作事项。TEST／对话 3 的原未发送文字和 attachment.txt 在原窗口实际核对保留，没有发送或替换。

## 前轮完成：新增看板、Agent 操作与恢复原清单

2026-09-13：在既有清单基础上新增四列看板、共享筛选、就地安排／撤销和真实执行操作。用户随后明确：优先级用顺序表示，Agent 也能排序，所有操作接口必须对 Agent 友好。已新增版本化共享排序及 Agent 的读取、安排、启动、状态、控制与成果接口；仅使用现有本人和 Morphz，不新增成员管理。

本轮曾错误地将原清单日期分组删为平铺、默认展开每行所有字段，用户指出这是未经要求改变原视图。随后提出并短暂实现的字段列式表格也已撤回。现已根据原清单代码恢复已逾期／今天到期／之后到期／未设截止日期／已完成／已取消分组和紧凑摘要，安排字段在行内弹层中使用；看板独立切换。共享顺序在各视图分组内呈现，拖动不隐式改截止日期。恢复版本的 4 项界面专项通过，原窗口已刷新并实际显示恢复后的清单。没有据此宣布整个目标验收完成。

此前实际执行证据：通过原窗口 AI 输入创建 TEST 确认验收范围和 TEST 汇总验收结果；开始后等待真实人工答复，收到答复后 Agent 生成 TEST 事项验收结果文档并关联完成。随后重新执行并停止，Runtime 的第二次 Thread 已确认 cancelled，原结果保留。真实 Agent 也已调用新接口保存测试事项顺序及 9 月 17 日截止日期，未因此启动事项或创建提醒。全部原 TEST 内容保留。

最终验证：**193/193 单元／集成、17/17 项相关界面回归、正式 Electron 清单／看板、持续按住鼠标跨列拖动及撤销、760×540 和 200% 缩放检查通过**。执行记录范围文案的最后修正后，7 项事项／执行专项和 193 项单元／集成再次通过，类型检查及生产构建通过。已取消事项独立列在看板下方，不增加第五列、不冒充已完成；取消筛选仍保留原对象。日期快捷项、保存错误不伪装成功、终态执行记录不依赖活动列表均有回归。

原应用／profile／中心保持；Runtime 为加载新 Host 工具清单，在无在途工作时正常重开，PID 96764。完整 profile 和一致性双库备份保留于 `/Users/shafreeck/Codes/.worktrees/desktop-capture-backups/task-board-20260913-ZpGFib`，其中 `audit-final.mjs` 只读核对原数据。最终原窗口停留“清单＋全部负责人＋全部状态＋搜索 TEST”，显示 8 条可操作事项；顶部看板独立切换。本轮不提交、推送或发布。

### 目标逐项验收

| 要求                                 | 证据与结果                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 保留原清单，新增四列看板             | 原窗口实际点击顶部两种视图；清单仍按日期分组、紧凑展示，筛选保持 TEST；`task-list.spec.ts` 验证清单没有默认展开字段，看板固定四列，包括有已取消事项的情况。                                                                                                                                                                                                        |
| 项目、负责人、日期安排与撤销         | 原窗口将 TEST 记录一个灵感改为明天截止、改派 Morphz、移到无项目，分别核对持久版本并撤销。对象 ID 不变，最终恢复 TEST／本人／无日期，未新增输入或复制对象；Agent 指派时 `runRequested=0`。单位测试额外验证陈旧版本、权限、依赖与成果引用保护。                                                                                                                      |
| 顺序即优先级，Human 与 Agent 共用    | 原窗口键盘排序及撤销持久保存；原窗口早一版本的组内手柄拖动也产生了真实排序回执，随后撤销。最终共享顺序版本为 7，恢复本轮验收前相对顺序。真实 Runtime 的 `list-tasks`、`reorder-tasks`、`arrange-task`、`task-status` 工作均 succeeded；Agent 将下周计划设为 9 月 17 日，纯安排不启动执行。                                                                         |
| Agent 友好的操作接口                 | `agent-tools.test.ts` 与 `task-arrangement.test.ts` 覆盖同一领域命令、身份、项目作用域、对象／顺序版本、幂等回执、拒绝冒充人工答复。当前只提供既有本人和 Morphz，不加入成员或其他 Agent。                                                                                                                                                                          |
| 真实创建、开始、等待、人工交接、成果 | 原窗口共享 AI 输入创建两条 TEST 事项；真实人工答复 `f8e241bb-8ad8-46d0-a654-fa49cb3a3fb3` 解锁依赖；执行 Thread `thread_0b6ebcab1340d9b37290754d` 为 completed，事项 v3 为 completed，并交付文档 `20a9eb91-3245-5c21-9a6b-f1eb49c12eed`。实际原窗口从工具回执打开文档，正文、Morphz 作者、v1 和反向事项关联均可见。                                                |
| 进度、补充、停止、再次执行及失败反馈 | 原窗口第二次执行 Thread `thread_90957c029ba00de4f4ecedfb` 为 cancelled；事项显示已停止、第 2 次执行、重新执行和成果入口。停止不会删掉 v3 成果。补充按钮实际展开共享输入，明确标注当前事项及 v4，不自动发送。停止丢回执恢复、运行中禁止改派／重复开始、提前声明完成不覆盖真实运行状态由集成测试验证；失败记录与重试请求失败由界面回归验证。                         |
| 执行记录准确且可读取                 | 原窗口打开已停止任务的执行记录，显示其第 2 次执行的两条真实工具记录；结果可读取并导航至已交付文档。标题范围修正为“本次执行”，不误称当前对话。                                                                                                                                                                                                                      |
| 逾期清楚，不自动改期                 | 原清单显示红色已逾期分组及 9 月 12 日截止；今天／之后／未设日期独立，已结束事项不标逾期。原窗口与日期、时区、分组回归共同验证；没有增加提醒或自动延长截止日期。                                                                                                                                                                                                    |
| 数据、草稿、会话历史保留             | 最终审计：原 22 个对象及其旧版本、25 条输入、273 条命令、8 份附件及权限、595 条 Runtime 事件完整保留；非 TEST 对象逐对象一致。仅新增两条 TEST 事项和一份结果文档，总计 25 个对象、27 条输入。旧 Session、Thread、执行请求及绑定保留；Runtime 默认 Principal 仅正常重启更新时间变化，其身份字段不变。原窗口 TEST／对话 3 未发送原文及 attachment.txt 实际核对保留。 |

实机与自动化证据边界：当前原生操作工具的横向拖动事件出现 `down(buttons=1) → lostpointercapture → move(buttons=0) → up`，不构成持续按住鼠标的拖动，**未把该次操作算作原窗口跨列验收通过**。临时事件诊断已移除；没有为了通过而允许松开鼠标后的移动提交排序。正式 Electron 的完整按下／24 步移动／松手跨列、状态保存和撤销通过，且丢失捕获会清理拖动状态。原窗口的安排、切换、执行、人工交接、结果及草稿验收不依赖该手势。当前无在途任务、没有新权限、成员、日历、甘特图或自动催办。

## 前轮补充：事项清单的成熟交互与可见验收

2026-09-13：按用户要求调研 Things、Todoist、Apple Reminders、Linear 的官方交互说明，应用清单优先、直接完成、负责人／状态独立筛选、日期分组与按需详情。来源和取舍见[事项清单设计](./25-task-list-design.md)。默认“我的＋未完成”，可搜索标题、描述和项目；截止日期按本地日历区分逾期、今天、之后与未设置，已结束事项独立展示。不新增看板、日历、计划日期或另一套创建表单。

本人普通事项支持行内完成、撤销和重新打开，通过版本化命令保存；Agent 和他人的事项不提供代为完成的勾选。有后续依赖的人工事项继续要求提交结果，前后端同时保护真实交接，不伪造 TaskResponse。完成不发送消息，不改结果或执行账本。顶栏、窄窗筛选弹出层、键盘焦点、刷新与详情返回保留筛选均已验证。

构建、185 项单元／集成、17 项事项／协作／输入／附件／顶栏相关界面回归通过；正式 Electron 隔离夹具验证完成／撤销、刷新、760×540 与常用窗口 200% 缩放。截图目视检查发现自动化在主题过渡中截取混合帧，已改为等待实际文字颜色稳定后截取，而非把中间帧当成暗色终态。

原 Morphz 使用同一包、profile 和中心正常重开；Runtime PID 79155 未重启。原生鼠标验收完成勾选→撤销、右栏开关与菜单、菜单外一次点击聚焦、新建输入意图、窄栏筛选、搜索、刷新和详情返回。原 16 个 Artifact、旧命令与资产、25 条输入及 TEST／对话 3 原文与 attachment.txt 核对保留；本轮只增加 6 个明确 TEST 事项，完成／撤销留下真实 v1→v2→v3。完整 profile 与一致性双库备份为 `task-list-20260913-QSLSFr`。

用户明确要求测试过程与状态可见，不再只报告自动化结果。原窗口现停留事项页，筛选为“全部负责人＋全部状态”，搜索 TEST，保留 6 个可操作的示例，展示逾期、今天、之后、无日期、Agent 等待及已完成。Agent 等待条目是明确标注的状态示例，不是实际执行成功的证据。示例不清空，供用户继续体验；未提交、推送或发布。

## 前轮补充：粘贴消息附件与精简目录授权说明

2026-09-13：输入框支持粘贴实际复制的多个文件与图片内容，复用文件选择的附件上传、预览、移除和草稿保存流程。普通文字保留原生粘贴、光标与撤销，不解析文字中的本地路径或下载图片网址；不监听后台剪贴板、不自动发送、不创建 Artifact。沿用每条消息 8 个附件、单文件 20 MB 和既有格式校验，部分失败保留成功附件和正文；上传期间重复添加有明确提示，迟到结果仍归原草稿。未增加新按钮或目录授权。

原生目录选择器长说明缩为“允许此对话中的 Agent 读写文本文件，可随时撤销。”权限与撤销机制不变，不再堆叠索引、同步等内部说明。

构建、183 项单元／集成回归、11 项粘贴／焦点／弹窗相关界面回归及正式 Electron 目录授权回归通过。原 Morphz 同包、同 profile 与中心正常重开，Runtime PID 79155 未重启；重开前核验无在途工作、旧数据审计通过并完整备份退出后的 profile 至 `paste-attachments-20260913-31v4NA`。原窗口实际验证 Finder 多选复制文本和图片→两个附件，Preview 复制图片像素→图片附件，普通文字粘贴与撤销、刷新保留以及简短原生权限说明；权限选择已取消，三个合成测试附件已从草稿移除，未发送消息。TEST／对话 3 原正文和 attachment.txt 核对保留。未提交、推送或发布。

## 前轮纠正：目录读写授权，不再提供通用文件浏览入口

2026-09-13：用户明确区分消息附件与 Agent 工作目录。已撤下通用“打开文件／打开文件夹”菜单、启动台入口与原位文件画布，不再按当前可见文件隐式引用到后续输入。附件流程保持。输入工具新增明确的“授权 Agent 读写目录”，系统选择器说明作用对话、读写后果和不含删除／命令执行；输入框旁显示可撤销的持续权限，不创建对象、会话或自动发送。

目录授权绑定本机中心、Human、工作空间、对话及根目录身份。每次输入固定当时授权，实际 Runtime root/input 决定 Host 可用目录；旧输入不能借新授权扩大范围。支持按需目录列表、原文件读取和带版本的新建／修改 UTF-8 文本；单次写入最多 500,000 字符，必须核对原版本，新增文件显式使用 null。越界、凭据路径、链接、目录替换及撤销均拒绝，修改具备持久幂等回执，重试不覆盖之后的人类编辑。不提供删除、Shell 或自动索引／同步。旧只读授权不升级；v1/v2 和两份旧格式不改，目录输入新增 v3。

验证完成：183 项单元／集成检查通过，完整界面回归 143/143 通过；最终输入框／对话／检查器相关 14 项和新增 Web 无本机桥回归 1 项另行通过。正式 Electron 入口验证真实目录授权、作用域隔离、重开恢复、草稿保持、撤销和 760×540／200% 缩放；没有用前端假数据替代授权。真实 Runtime 二进制与本地合成 Provider 完成 v3 输入→按实际 root 授权读取→使用返回版本写原文件→真实工具回执；既有 v1/v2、附件、对象交付和事项链路仍通过。没有调用付费模型或采集声音。Web 即使连接具有目录服务能力的中心，也必须有本机目录桥才显示入口，不能因缺少本机桥阻止普通输入。

原应用于 15:32:37 正常重开（PID 79090），Runtime 于 15:33:03 用原二进制、地址、数据库及凭据重开（PID 79155）加载新清单。之前确认无在途工作，一致性双库／配置备份及退出后完整 profile 位于 `agent-directories-20260913-60CU9R`。原窗口用真实鼠标和系统选择器仅授权其中的合成 TEST-agent-directory，验证不切走对话、不自动发送、刷新恢复、切工作台不继承、返回撤销，以及菜单外点击、右栏展开／收起；验收权限现为零。原 TEST／对话 3 未发送文字与 attachment.txt 实际核对保留，未编辑或发送；旧数据、命令、附件、Session、Runtime 历史、凭据和原输入格式逐项审计通过。未提交、推送或发布。前轮文件浏览器验收记录仅作为历史保留在下方。

缩放边界：最小窗口 760×540 与常用窗口 1380×920 的 200% 分别验收，使用原生 compositor 截图，避免 Electron CDP 在非默认缩放下裁剪。最小窗口叠加 200%（有效视口 380×270）时，现有整页导航高度使输入区超出可视区；这一组合未通过，不把它纳入本轮已完成项，也未借此扩展修改整个导航布局。

## 前轮纠正：外部原文件与 Agent 产物分离

2026-09-13：按用户确认的边界撤下通用“资料导入与来源”入口，停止旧来源后台同步，保留原对象、版本、批注和历史引用。索引仅收录 Agent 创建且不是外部导入的 Artifact；人工后续编辑仍保留产物来源。重开时只清理旧搜索投影，不删除资料或附件。图片／PDF 的资产访问权限独立维护，不能因不再收录全文索引而变成不可读。

本机桌面提供“打开文件／打开文件夹”：系统选择器确定读取范围，按需列目录或读取原文件；不复制、不扫描入库、不自动发送。本机记录仅保存授权路径与身份／项目边界，输入保存文件引用和内容版本指纹。Agent 的 `local-file` 工具根据实际执行对应的已持久输入授权，不能自行指定另一条输入、越出引用目录或读取符号链接、凭据路径。发送前和读取时校验版本，变化／撤销／读取失败都明确报错并保留草稿；关闭引用可撤销读取。原位文件草稿与原页面隔离，重载只恢复匹配版本，不偷偷替换原文。

范围限制：当前原位预览支持 UTF-8 文本／代码、PDF 和常见图片，单文件不超过 20 MB；目录按需读取，不是完整代码编辑器。Agent 工具可分段读文本、按需提取 PDF 文字，不自动上传图片；图片需要用户作为消息附件提供。EPUB 暂不支持，不复制到内部库；Web／远端中心不展示本机文件入口。未新增托管副本、书库、双向同步或外部文件知识库。“当前理解”和语音交互不属于本轮修改。

已通过 180 项单元／集成检查和真实 Runtime 二进制 + 本地合成 Provider 联合验证：新增 v2 输入携带引用，实际 Host 回调读取原文件并返回工具结果，没有新增 Artifact 或全文索引；既有 v1、两份旧输入格式及已排队请求不改写。正式 Electron 入口隔离回归覆盖目录、文本、PDF、独立草稿恢复、陈旧引用拒绝、选区、撤销及 EPUB 明确拒绝；旧导入 PDF、百万字文档和批注仍从既有内容入口使用。

完整界面回归 **143/143 通过**。搜索交互夹具改为在隔离中心通过真实 Agent 身份创建产物，没有放宽生产 API 身份校验；旧导入改为兼容性夹具，继续验证阅读、引用和批注而非保留已撤下的入口。通知窄窗测试等待实际重排，保持原有边界断言。原生验收发现 PDF 附件复用组件在调宽时叠加文字层，已按页面和宽度重新挂载渲染层，并补入原位 PDF 的右栏展开／收起去重检查。

最终 PDF 去重修正后重新构建通过，PDF／弹窗／检查器的 9 项相关界面测试与正式 Electron 原位文件隔离回归再次通过；原窗口刷新后用真实鼠标展开／收起右栏，文字层不重复。最终原数据审计通过，临时文件授权为零。本轮未提交、推送或发布。

原应用于 14:34:23 正常重开（PID 74733），Runtime 于 14:34:39 用原二进制与原数据库重开（PID 74802）以加载新 Host 清单；没有重新签名、更换 profile、改模型凭据或系统权限。重开前已确认没有在途执行，一致性数据库／配置备份及退出后完整 profile 位于 `file-boundary-20260913-HQejw5`。原窗口实际鼠标通过系统选择器打开合成 PDF 和测试目录，验证分页、按需读取代码、右栏及菜单外点击、关闭撤销；原 TEST／对话 3 草稿和 attachment.txt 保持，未编辑或发送。逐项审计确认原 16 个对象、2 条批注、25 条输入、263 条命令、5 份附件、8 个 Session 及 Runtime 历史均保留。旧来源授权记录只改为停用，未删除；手工验收的临时文件授权全部撤销。

## 前轮纠正：右栏原生鼠标点击失效

2026-09-13：用户在前轮交付后指出右栏无法收起、菜单打开后几乎所有按钮失效。原“本轮已完成”的结论过早：浏览器／渲染层点击与可访问性按钮激活没有覆盖操作系统的鼠标命中路径。此缺陷是本轮引入且验收遗漏，不归因于用户操作或 Runtime。

已在原窗口使用坐标鼠标复现，且新增回归在修复前检出两处根因：检查器标题的 `drag` 矩形覆盖独立叠放的右栏开关；标题内菜单及其全屏透明 `::backdrop` 继承 `drag`，使窗口层吞掉菜单外的鼠标点击。修复将标题拖动矩形从几何上避开右侧控制区，并让共享菜单和背景明确使用 `no-drag`，背景保持指针穿透。没有修改执行、投递、审批或会话逻辑。

原应用于 04:21:03 正常重开，仍是同一安装包、profile 和中心，Runtime PID 41088 未变。修复后已用真实坐标鼠标验证：展开／单击收起；菜单打开时直接收起；菜单内选择执行记录；菜单打开时单击工作台直接导航；工具记录展开与固定／取消固定；菜单打开时直接聚焦既有输入。原 TEST／对话 3 的草稿原文与 `attachment.txt` 保持，未编辑或发送；随后恢复原来的只读验收会话。原 profile 退出后另存 `native-hit-testing-profile`，逐字节对照一致。

本次纠正的类型检查、构建及 **20/20 专项回归**通过，覆盖侧栏、菜单材质、输入焦点、执行／审批和并发回复控件；隔离 Electron 检查包含宽窗、窄窗及 200% 缩放下的拖动区域边界和菜单／背景计算样式。没有将这些渲染层检查称作原生鼠标验收，后者以上段原窗口实际坐标点击为准。本次未重跑前轮整套界面回归。最终只读数据审计通过：原项目、对象、输入、附件、Session、Runtime 历史及私有配置未丢失或改写；本次没有新增输入。没有提交、推送、发布或修改系统权限。

## 前轮：执行入口、审批与真实流式反馈

2026-09-13：用户指出把通用右栏开关替换成执行按钮违背三栏设计，随后恢复了显隐与内容选择的职责分离，并完成下述回归、构建和流式检查。其后用户发现原生鼠标点击仍失效，因此这些检查不足以支持当时的整体完成结论；具体遗漏和修复见上节。下面保留自动回归与原窗口流式实测各自的证据。

纠正后的设计恢复通用右栏开关：图标和位置固定，只控制显隐并按工作现场恢复上次查看的内容；右栏标题旁提供内容切换。进行中／待审批状态是相邻的独立条件入口，点击进入执行记录，不再兼作折叠，也不随状态更新自动切换理解或批注。无工作时不显示空的执行状态按钮，执行历史始终可从内容菜单或空间菜单进入。打开执行不抢输入焦点、不切换会话。当前执行概览按实际连续对话范围筛选，不把同项目的独立会话混入。

消息不再默认带绿点和箭头。Runtime 调度快照保留 `ThreadKind`，只有已连接、快照可用、生命周期开放的 `execution` 线程才使对应消息出现环绕光效；普通 `dialogue_turn`、投递排队、停止、完成、断线及旧服务缺少类型均不伪装成后台执行。光效不阻挡文字选择，“后台执行中”可进入准确输入的执行记录。减少动态时保留静态状态。

审批快照每轮统一读取一次，由实际 Session / Context / root / thread 与持久输入回执确定归属，再按项目权限过滤；跨项目共享 Session 缺少精确输入归属时不猜测、不泄露。消息下方和执行概览直接显示同一审批、操作及新增权限，完整请求可展开。仅允许这一次／拒绝仍调用原有精确作用域和指纹复核；重复界面共享提交锁，失败或不确定结果不自动批准、不重试，不扩大持续权限。缓存不持久化为有效审批，重开与断线必须重新确认。

流式文字参考 [Streamdown 的新增文本节点动效](https://streamdown.ai/docs/animation)，在现有安全 Markdown 渲染器上按真实新增源码范围实现逐词淡入、轻微模糊消退，不缓冲或拖延 token，不替换渲染器或新增依赖。重新挂载、历史回看、非追加修正不重播；Markdown 重建继续原时间线，代码和数学节点不包裹。自动验收既检查实际 Web Animation 的透明度／模糊值变化，也保存并目视比较新增文字到达后 60ms 与 460ms 的像素画面；历史文字保持清晰，减少动态及流结束／断线会停止动效。

自动验证：**175/175 单元与集成回归、141/141 完整界面回归、类型检查及完整构建通过**。最终补齐触控侧栏开关的 44px 命中区后，最新构建另通过 **9/9 侧栏、审批、执行与流式专项**，包含同形同位、各工作现场的内容记忆、对象默认批注、状态更新不抢占面板、重复状态点击不收起、窄窗口和 200% 缩放。原生截图前台检查在解锁后已通过；未放宽前台保护或删除断言。正式入口隔离 Electron 的本机 SQLite、PDF、只读来源、浏览器、沙箱、重载存储与关窗生命周期已通过。实际 Runtime 二进制 + 本地合成 Provider 的联合检查再次通过，覆盖真实流式文字／工具参数、准确交付、事项、独立会话、附件及后续执行链路。联合脚本新格式断言为规范中的 `morphz.application.input` v1；未修改实际协议。

锁屏期间补充安全复核：审批权限摘要同时校验字段名与值类型，未知字段或非标准格式显示原始权限内容，不简化为“不额外授权联网”。新增已知完整权限与六类未知／异常字段回归，全部通过；没有改变批准方式或放宽权限。

原应用实测：同一 `/Users/shafreeck/Applications/Morphz.app` 于 04:02:51 正常重开，仍使用原 profile 和中心；Runtime PID 41088 保持原运行实例。窗口中已确认“当前理解”收起／恢复不跳到执行，标题菜单可切换内容；TEST 的“对话 3”原草稿和 `attachment.txt` 保持。仅新增名为“执行体验只读验收 2026-09-13”的项目对话及一条明确标记的输入。使用现有模型配置实际搜索、读取既有《桌面能力验收》v1 并流式回复；Runtime 两条 `host_morphz` 回执分别为成功的 `search` 和 `read`，没有写对象、Shell、网站或提醒操作。原窗口连续画面显示真实 `execution` 线程运行时的环绕光效，以及新文字去模糊、旧段落清晰保留；完成后光效、停止按钮及顶栏进行中提示消失。当前没有真实待审批事项，审批失败与重复提交保护由上述隔离回归验证，没有人为触发额外权限请求。没有采集现场声音。

保留与备份：原应用及 Runtime SQLite 一致性备份、私有配置和退出后的完整 profile 位于持久备份目录 `execution-experience-20260913-utr2QL`；侧栏纠正后的退出备份另存 `sidebar-correction-profile`，逐字节对照一致。最终只读审计确认原 5 个项目、12 个会话、24 条输入、16 个对象、252 条命令、5 份附件、7 个 Session、24 个 Runtime 消息请求、54 个 activation、26 个 thread、18 个 job、567 个 event 及授权配置均未丢失或改写；新增项仅为验收对话、输入及其实际执行记录和正常来源检查回执。没有重新签名、更换 profile、修改系统权限、提交、推送或发布。

## 前轮：Morphz 名称统一与兼容升级

2026-09-13：用户明确要求继续统一代码与工程名称。根包和锁文件改为 `morphz-application`；产品、当前文档和新配置使用 Morphz / `MORPHZ_APP_*`。新应用包为 `morphz-app/v1`，消息为 `morphz-app:*`；便笺示例升级到 1.1.0，不覆盖原 1.0.0。新输入格式为 `morphz.application.input` v1，新对象工具为 `host_morphz`，HTTP 标头、登录 cookie 和终端存储使用 Morphz 名称。Runtime 与 Application 的模块边界不变，本轮没有合并仓库，也没有移动当前 checkout。

兼容并非批量删除旧字样：旧环境变量继续可读，新值（含显式空值）优先；旧数据中心、profile 与 Chromium 分区原位复用，新旧两份数据并存时拒绝猜测。新旧工具名使用原来同一幂等命令命名空间，清单升级保留 token、endpoint 和授权 Context。两份旧 `morphzwork.input` 定义的序列化 SHA-256 与修改前完全相同，排队请求不改格式、不重放。已安装旧 UI 包保留原协议和 HTML；旧 cookie 保持有效，显式无效新 cookie 不回退为旧身份；新旧 CSRF 标头冲突被拒绝。草稿仅复制当前认证中心／身份的存储键，原字节保留，新值不被覆盖。

当前原 Morphz 已在同一安装包、profile 和中心正常重开；原 Runtime 也用原二进制和原 18089 地址重开以加载新清单。重开前验证无在途 activation/job/待发输入，并一致性备份应用及 Runtime SQLite；桌面退出后完整备份 profile。实际窗口已确认工作中心与 Agent 已连接，TEST 的“对话 3”草稿原文和 `attachment.txt` 附件仍在。应用安装器实测接受旧启动器的精确兼容字节，没有重新签名：CDHash 仍为 `416b1e83ed9698c2f39660ddeec580401ef8738d`。没有重置系统权限或请求麦克风。

数据对照：原 240 条命令回执、21 条投递请求、7 个 Session、21 个 Runtime 消息请求、18 个工具 job、51 个 activation、23 条 Thread、2 个认知 Context，以及附件原字节、PDF 元数据和交付引用均保持。工作快照只有 revision 与两条原来源连接检查时间变化；Runtime 默认 Principal 只有启动刷新时间变化，身份和授权字段不变。备份位于持久工作树备份目录的 `name-unification-20260913-NTYW6n`，未清理原数据。

最终验证：**170/170 单元与集成回归、138/138 完整界面回归、类型检查及构建通过**。正式入口隔离 Electron 的直接 SQLite、PDF、来源、浏览器、沙箱及重开检查通过；实际 Runtime 二进制 + 本地合成 Provider 已完成 `host_morphz` → Unix 回调 → Agent 对象及精确输入交付回执，重开重试不重复写入。首次内嵌接入也已覆盖旧 Web cookie 恢复、无效新身份不回退、显式退出后不重新导入旧登录。没有调用付费模型或采集现场声音。

回归中首次出现一次模态创建点击未到达宿主的失败，轨迹中没有创建请求、焦点落在后台 iframe；已显式移除模态背后 iframe 的鼠标命中区域，并加入新旧包加载期间各 8 次单击创建检查。新增协议测试曾污染共享测试中心的卡片位置，导致旧测试的固定背景坐标点击到应用卡片；现改为逐测试独立中心。PDF 几何轮询在画布尚未挂载时继续等待，不再抛出空值异常；保留原草稿和几何断言，最终完整重跑全部通过。本轮修改文件的格式与差异检查通过；全仓格式检查仍有 5 个未改动文件的既有警告，没有扩大范围重排无关代码。2026-09-13 按用户要求，将本轮名称统一、截图与弹窗空间整改及配套回归纳入当前应用仓库的本地提交，不推送、合并仓库或发布。

## 前轮：弹窗空间利用、修饰键截图与权限恢复

2026-09-13：根据用户再次指出的弹窗空间浪费，修正了通用 `460px` 宽度覆盖媒体弹窗、固定预览高度和底部重复间隔的问题。图片预览按原图比例、自然尺寸和可用窗口定宽高；横图获得足够宽度，竖图不撑开大片横向空白，小图不被强制放大。截图重选与关闭并入标题行，名称与确认共用紧凑底栏，窄窗时确认按钮整体换行。图片附件复用同一尺寸机制；短表单保留紧凑宽度，连接检查移入标题，转写面板删除多余留白。宽度变体统一使用共享 token，不再用后加载的固定宽度互相覆盖。

新增几何回归覆盖横图、长图、横条、小图、320–1440px 窗口、长名称、失败后保留预览、键盘焦点循环及真实隔离 Electron 的 200% 缩放。测试发现原生模态末尾 Tab 可落到浏览器外壳，公共焦点钩子已补齐首尾循环。空间利用与这些回归检查已写入项目规则和 UI 规范；不以截图看起来能打开代替尺寸验收。最新 **136/136 完整界面回归、162/162 单元与集成测试、类型检查和前端／服务构建通过**；最后调整截图底栏按钮分组后，另完整复跑 **17/17 截图、模态几何及输入焦点回归通过**。改动代码／测试格式和差异检查通过，横图、竖图、横条及小图的隔离截图已目视检查。

截图修饰键已经接入：macOS Option／其他平台 Alt 状态按每次点击独立读取，普通截图保留 Morphz 窗口，修饰键截图在进入选区前隐藏本窗口，成功、取消、失败及超时后恢复；期间主动关闭的窗口不复活。原生读取仍要求实际划定范围，确认前不上传、不发送。当前原生截图后端仍只支持 macOS，Windows／Linux 的修饰键识别不等同于其原生采集后端已经实现。

本轮从临时工程根迁回主目录时发生过 ad-hoc 重新签名，系统日志明确报告 ScreenCapture 的既有代码要求与当前应用不匹配，导致设置开关开启却反复提示。已只重置 `ai.morphz.desktop` 的 ScreenCapture 授权，并在系统设置重新加入同一安装包；原窗口重新取得真实截图，用户明确确认恢复。未修改麦克风和其他应用权限，旧 Electron 关闭条目保留。此结果证明当前授权恢复，不声称未来 ad-hoc 身份更新已有长期签名方案。

本轮 UI 构建不修改或重新签名应用包、不重启 Runtime。随后用户明确要求“直接刷新”，原窗口已刷新并核对紧凑连接弹窗和新截图预览；测试预览已取消，未上传、保存或发送。旧对象、输入、Session 及原命令回执核对保持一致；工作快照只有 revision 和两条既有来源连接检查时间更新。名称统一随后继续实施，最新状态见上节；未提交、推送或发布。

## 前轮：Dock 图标与同配置内嵌桌面

整体验收补充：最新完整 **129/129 界面回归**、**149/149 单元/集成**通过；此前 **6/6 Runtime 本地工具传输**、正式入口隔离 Electron 与实际 Runtime IPC 联合验收通过。切换前备份的原数据库/附件/Session/线程/命令/投递及权限控制已逐项核对；policy digest 的路径差异有精确重算证明。macOS 已解锁，原窗口已完成附件/PDF/搜索/来源/浏览器/语音未录音状态、截图取消布局及关窗后激活恢复检查。来源恢复状态和跨项目搜索返回范围的两项缺陷已修复，并在同一原窗口生效。

系统身份修正已在原环境生效：主程序、Helper、包及签名标识统一为 Morphz / `ai.morphz.desktop`，同一应用现安装于当前用户的 `Applications/Morphz.app`。原临时包已移入备份；数据、profile、草稿、附件和 Runtime 保持原位。系统“录屏与系统录音”列表已实际显示 Morphz、品牌图标及开启的开关，真实划区截图进入预览并取消恢复通过。旧 Electron 关闭条目未动。最新 **152/152 单元/集成测试**通过，重复启动不重写签名，运行中的包拒绝修改。用户明确要求本测试环境内修复与必要重启直接执行，已写入项目规则，不再重复确认。详见[统一应用层验收记录](./24-shared-application-host.md)。

原配置真实验收已完成：Agent 通过本地 IPC 创建一份明确标记的 TEST 文档，原窗口交付卡片能打开并显示准确的作者、正文与 v1；两条纯文字请求实际并发，原窗口可见回复逐步增长，B 在 A 结束前独立完成；真实麦克风采集、非零音量、豆包非空识别、停止及尾段处理通过，文字仅留为草稿，未发送。原数据保留审计通过，三条新测试输入、两条测试对话和一个测试文档单独核对，旧消息没有重发。用户实际点击 Dock 后明确确认恢复，随后原窗口的 TEST 草稿和附件再次核对通过，桌面和 Runtime 进程及启动时间均未变化。最后一项验收关闭，本轮统一应用层与品牌整改完成；未提交、推送或发布。

2026-09-12：用户明确批准后，Web 与 Desktop 正式入口已切换到共享应用业务层。原 Morphz 窗口使用 `morphz://app/` 内置页面和本机 SQLite，不再使用 65419 的 Vite 或 65424 的本地应用 HTTP 服务；独立 Runtime 仍使用原配置和 18089 API。完整功能验收仍在继续，不把入口切换等同于所有能力验收完成。

根据用户的 Dock 反馈，实际截屏确认旧图标是比相邻应用更大的直角方块：主进程直接把方形头像传给 `app.dock.setIcon()`，覆盖了系统正常处理的包图标。现移除该覆盖，使用 `CFBundleIconFile`；在当前 macOS 26.5.1 上，由系统完成应用图标的圆角与尺寸归一化。原有电光青蝴蝶形 M 的路径、比例和颜色不变，新增可复现的矢量到 1024px 导出，不再放大 512px 头像。打包器按图源摘要更新已有应用包，10 组 ICNS 图源尺寸及本地包签名检查通过。遵循 [Apple 当前图标指导](https://developer.apple.com/design/human-interface-guidelines/app-icons) 与 [既有 Mac 图标适配说明](https://developer.apple.com/videos/play/wwdc2025/220/)，不额外叠一层手绘圆角蒙版，也不声称这是多层 Liquid Glass 图标。

原应用菜单退出时还复现了清理已完成但原生退出未继续的问题。清理完成后的 `app.quit()` 改为下一事件循环再调用；同一原应用已验证一次菜单 Quit 即结束进程，随后仍从同一包、同一 profile 和中心重开。未终止或重启 Runtime。旧版没有窗口标记时恢复唯一有未发送内容的窗口草稿；原 TEST 项目中的“对话 3”、未发文字与 `attachment.txt` 附件已在原窗口恢复，未替用户发送。

最新 **147/147 单元与集成测试**、正式入口的真实隔离 Electron 检查、格式与差异检查通过；Electron 回归禁止原始 Dock 图标覆盖，继续验证无应用 TCP 监听、真实 PDF、子框架隔离、幂等与重载存储。实际 Dock 与菜单退出／重开另外在原用户应用核对；其他 macOS 版本与完整远端桌面验收未完成。未提交、推送或发布。

## 前轮：删除常驻解释性文案

2026-09-12：按用户要求，删除截图预览中的拖动教学和“确认前只在本机／不发送给 Agent”等段落；选区浮层也仅保留“截图”与取消控件，暗幕、十字光标、真实选框和尺寸反馈不变。同步清理录音、朗读、导入、搜索、当前理解、批注、事项空态、连接、执行和应用安装中的重复说明、开发术语与操作教学。标题与动作简短直述；格式／容量／服务信息按需展开，首次录音服务及费用告知、权限范围、未保存文字丢失、版本冲突和实际错误仍明确保留。

界面构建、类型检查、本次修改文件的格式检查及 **34/34 项相关界面回归通过**。测试保留并补充截图确认前不上传、引用不自动提交、语音未授权不采集、单次审批与停止待确认，以及草稿、版本、焦点和窄窗布局断言。首跑误用了旧前端构建；重建后更新三处仍期待旧文案的断言，完整重跑通过。一次沙箱内运行因 Chrome 启动权限被拒绝而未执行，之后获准在沙箱外隔离复验；没有调用真实麦克风或外部模型。全仓格式检查仍报告四个本轮未修改文件，未为此改动无关代码。

另外 **3/3 项自由选区回归通过**，验证删除操作教学后截图状态、取消入口、正反拖动、真实选区和松手确认保持。该选区页面每次打开读取本地文件，不需为本轮文案重启桌面壳。

原窗口通过热更新加载了简短听写提示。用户反馈看不到应用时，核验原“对话 — Morphz”窗口仍在；仅将该窗口带回前台，没有退出、重启、换 profile 或中心，没有改写历史及草稿。未逐一打开用户窗口中的全部弹窗，也未替用户重新截图或保存内容；隔离回归不替代这部分实机验收。未提交或推送代码。

## 前轮：恢复自由划区，并在原窗口落地

2026-09-12：用户明确要求点击后直接拖动划区，而不是系统截图工具栏的预设矩形／四角调整。先只读核验到原桌面壳仍执行 `screencapture -i -x`，新增参数未加载；获准重开后，系统 `-U -J selection` 虽显示控件，但改变了用户要求的手势。本轮撤回该交互，改为 Morphz 自己的透明选区窗口：进入即有暗幕、十字光标和“拖动划区／松开截图／取消 Esc”；没有默认矩形或调整手柄，从任意位置按下拖出矩形，松手直接进入预览。拖动时选区内部透亮、边框及尺寸随实际鼠标更新，反向拖动同样有效；单击或不足 8px 的区域不取图，可重新划区。

选区阶段不读取整屏图片。隔离、无 Node 权限且禁止导航的选择器只能提交其所在显示器内的有效矩形；主进程核验来源窗口与主框架，关闭全部选区窗口并等待合成器撤掉遮罩后，才使用系统区域取图读取用户所选范围。取消、显示器变化、主窗口关闭和迟到回执不会触发截屏；PNG 大小与格式校验、预览确认前不上传、不自动发送、对象关联和原草稿保持不变。当前每次选区限于一个显示器；负坐标与多个显示器入口由单元测试覆盖，跨屏拖拽和多屏实机尚未验收。

最终 **132/132 Node 测试、11/11 项相关界面回归、类型检查及差异检查通过**。新增验证包括暗幕和无预设框、正反向拖动、松手确认、点击无效、Esc／按钮取消、越界与非有限坐标拒绝、非选择器来源及子框架拒绝、先撤掉遮罩再交回矩形，以及确认前不读取像素。

用户明确允许后续同范围、保留数据的必要重启不重复询问。原应用、原 profile、65424 工作中心和 18089 Runtime 保持；本轮桌面壳已真正重开。一次正常退出／SIGTERM 后进程仍驻留，强制终止被自动审查拒绝，未绕过；随后通过应用菜单 Quit Morphz 正常退出，确认旧进程消失才重开。原窗口已出现本轮区域截图的真实待确认预览，图中没有选区遮罩或系统工具栏；用户操作期间自动化停止写操作，保留该预览，没有替用户取消、保存、上传或发送。此次不将隔离截图说成原窗口实操，也不将截图落地等同于真实麦克风验收完成。未提交或推送代码。

## 前轮：采集反馈、一键听写与入口归位

2026-09-12：针对单击截图后缺少视觉反馈，系统截图命令加入交互工具栏并以选区模式开始（`-i -U -J selection`）。保留取消、临时 PNG 校验及确认前不上传；桌面壳改动仍需原窗口重开后实际验收。

用户明确允许点击麦克风后持续分段发送至豆包识别，直到停止，并在本机记住授权。一键听写已实现：首次确认具名服务，本机授权按中心、身份及 Provider 隔离；以后点击麦克风直接收音，再点同一按钮停止。行内只显示状态、时长、真实采样音量及操作入口；授权可撤销，服务改变需重新确认。文字只追加草稿，不自动发送。关闭、隐藏或切换现场结束采集，迟到配置和系统权限结果不会重新启动；听写与独立转写之间切换也销毁旧采集与队列。

声波入口从悬浮输入工具移到工作空间选项中的“录音转文字”，与资料导入相邻；它是独立转写、审阅和保存文字的工具，不是通话或 AI 撰写文档。对象范围、完整长转写、保存文档与手动插入草稿能力保留。

最终 **30/30 项相关界面回归、128/128 项 Node 测试、类型检查、前端构建及差异检查通过**。覆盖首次拒绝不采集、授权持久化、单击启停、真实音量与 320px 布局、撤销与服务变更、迟到授权取消、切页不重启、超过一分钟连续合成语音及尾段、长文保存、截图预览／取消、草稿和焦点。组合测试的触控数量前提已修正：截图测试留下打开对象时会多出批注预留位，触控基线测试明确回到工作台内容列表后完整重跑通过；没有移除几何和焦点断言。录音回归均使用合成音频与本地请求替身，没有调用真实麦克风或豆包。

当前原窗口没有重开，真实麦克风与系统选区工具栏尚未验收。退出桌面壳的操作被自动审查单独拒绝，已询问用户是否允许保留原 profile／草稿／历史重开窗口；没有改用终止进程绕过。中心与 Runtime 未重启，没有新发消息、改写内容、提交或推送代码。

## 前轮：截图一键进入选区

2026-09-11：按用户要求，点击悬浮截图按钮直接进入系统选区，不再先显示确认弹窗并要求再点“选择窗口或区域”。初次取消直接回到输入区；选完才显示预览，添加到消息或保存到内容仍需明确确认。失败显示真实错误并等待手动重试，不自动循环采集；重新选择失败或取消保留已有预览。非桌面环境仍提示使用桌面截图或导入图片。

初次取消先恢复输入与原生网页布局，再关闭模态并恢复触发位置焦点。完整对话的消息保留可见，截图输入和遮罩继续让出画布；原生网页布局完成前不打开选择器，等待期间取消可阻止迟到的采集调用。

最终 **13/13 项相关界面回归、类型检查、前端构建及格式／差异检查通过**。首轮发现取消后触发按钮仍隐藏，导致焦点不能返回，现已修复；自动启动还使测试误将隐藏的模态视为已卸载、漏放行后续布局等待，测试改为核对 DOM 卸载及明确放行布局，原有权限、上传、草稿、预览和焦点断言保留。一次沙箱内重跑因 Chrome 启动权限失败而未执行，获准在沙箱外完整复测通过。语音回归使用合成音频，未开启真实麦克风或向识别服务发录音。

原 Electron 同一窗口通过热更新核对了单击进入截图状态、画布让出及 Esc 恢复。首次自动操作未激活窗口，被原有前台窗口校验拒绝；明确激活原窗口后重试，没有放宽采集权限。未进行新的实际选区确认、上传或保存，这些路径由隔离回归覆盖；没有重启窗口／中心、发送输入或提交代码。

语音一键启动与入口合并尚未实施：当前两个入口共享录音识别，麦克风入口追加到输入草稿，声波入口独立审阅并可保存转写，不是双向通话。自动安全审查要求用户明确确认点击后持续分段录音并发送至当前配置的豆包识别服务；在获得确认前保留原行为，不开启麦克风，也不把截图交付描述为全部悬浮按钮已经完成。

## 前轮：原生侧栏闪烁与残影

2026-09-11：用户报告左侧栏持续闪烁。首次检查发现 `nativeTheme.updated` 无条件重新设置 vibrancy／背景并广播状态；已加入目标状态与发布状态去重，在调用原生 API 前记录完整目标，阻断通知重入，前端同值属性也不重复写入。该项通过回归，但原窗口仍能看到背景分块、外观菜单已关闭而图像残留，**没有将首次修正视为完整解决**。

进一步对照 [Electron 44.2.0 的窗口创建实现](https://github.com/electron/electron/blob/v44.2.0/shell/browser/api/electron_api_browser_window.cc#L37-L47)：原窗口以不透明背景创建，之后才开启 vibrancy 和透明背景。现由同一个 `windowAppearanceOptions` 在创建 `BrowserWindow` 时配置 `sidebar`、`followWindow` 与透明背景，控制器沿用已设置状态；减少透明／高对比度及其他平台仍从创建时使用实色。没有关闭原生磨砂、硬件加速或菜单模糊，也没有用定时强制重绘掩盖问题。上游旧版透明背景／模糊问题只作排查线索，不作为本机问题已经修复的依据。

在原应用、原 profile、同一测试中心重载桌面壳后，亮色和暗色下打开／关闭外观菜单不再留下残影，侧栏背景不再出现之前的分块；最后恢复“跟随系统／电光青”和原事项页。中心与 Runtime 未重启，没有发送测试输入、创建或修改对象。窗口关闭后残留的桌面进程经精确命令核验后以 SIGTERM 退出，再重开同一应用，没有并行的第二套手动验收应用。

最终 **128/128 Node 测试、6/6 项相关界面回归（含真实隔离 Electron）、类型检查、前端构建及格式／差异检查通过**。原生事件重复 100 次不再调用材质／背景 API 或广播相同状态；单元测试覆盖 1000 次重复通知与原生设置同步重入；前端重复通知不重写四个材质属性。相关悬停测试从过期的实色数值改为当前共享 hover／selected token，仍验证整行单层背景、内层按钮透明、真实选中归属、键盘焦点与触控入口。未提交、推送或发布。

## 前轮：输入工具稳定性、模型来源与推理设置

2026-09-11 整体验收后的修正：完整记录按钮在收起交流时仍保留，批注按钮在同一对象内保留不可交互的占位，常用按钮不再随状态变化横向跳动。附件、截图、短句听写和长录音相邻，执行／记录／固定操作之间使用小间隔分组，仍是独立浮动按钮，无连体底板或省略号；默认隐藏、直接进入按钮区域浮现、焦点和触控规则不变。

右下角模型与推理设置均接入真实链路。`record-input.reasoningEffort` 在输入中持久化，通过 Session IO 的 `activation.reasoning_effort` 固定到这次请求，不修改 Runtime 默认值、其他工作或旧 outbox 请求。默认不额外绑定；明确的模型能力列表限制可选档位，未知能力只提供 Runtime 通用词汇、不声称所有 Provider 均支持。切到不支持原档位的模型时提示重新选择，不静默替换；旧中心没有能力数据时禁用控制。失败与重载保留草稿设置。

模型目录保留实际物理模型与路由名称，补充已配置账户的来源名称；仅暴露名称，不转发密钥、凭据引用、服务地址或请求头。可选择的是 Runtime 已配置的模型路由，不在桌面虚构备用 Key，也没有新增凭据管理或额度查询。当前测试中心只有 `gpt-6-astra / development` 一条可用路由。

最终 **125/125 Node 测试、32/32 项相关界面回归、类型检查、前后端编译和格式／差异检查通过**。32 项初轮 30 通过，另外两项仍按旧工具顺序断言 Tab 顺序与“长录音紧邻收起”，已改为验证新分组的顺序和间隔，并完整重跑 32 项；没有移除原有焦点或几何约束。

在同一 Electron 应用、测试 profile 和工作中心完成真实模型／推理下拉及发送。测试输入 `7a1ad37d-5f03-4a10-b806-9a2c61f4e4ab` 持久记录 `model=gpt-6-astra`、`reasoningEffort=high`，outbox 中的实际 activation 同样为该模型与 `reasoning_effort=high`。Provider 返回 HTTP 429 `usage_limit_reached`，所以只确认真实参数投递和失败呈现，**不声称获得成功模型回复**；未反复重试或切用其他中心的凭据。该明确标记的测试消息保留，原有 15 个对象未增加或修改。

更新前在线备份了工作中心和 Runtime 数据，并核对原有对象、附件、命令、会话及投递完全保留。共享构建目录里的 Runtime 已被后来的普通构建替换，启动时报 `Unknown { name: "session-io" }`；已使用经 `experiment list` 验证的既有兼容构建，固定到此测试中心自己的 `bin/morphz-session-io-0f7a4584812a41d1`，不覆盖共享构建文件。测试中心仍为 `1523f4a5-85a6-4710-9a45-99d2645ebe12`、端口 65424／18089；后续启动应继续设置 `MORPHZWORK_RUNTIME_BINARY` 指向这份独立副本。备份与重启记录位于本机 `/private/tmp/morphz-before-composer-center-7EklLm`。

真实刷新还复现了此前的主进程 `write EPIPE`：原桌面进程已脱离启动者，Electron 的 IPC 错误日志写入关闭的 stdout/stderr，产生阻塞异常弹窗。桌面与开发启动器现只处理标准输出的 EPIPE，不吞其他错误；真实子进程关闭管道测试通过。旧窗口被弹窗阻塞且正常退出无效后，沿用原应用、原 profile 和中心重开，未启动并行的第二套应用；再次刷新正常、旧消息和输入设置均可读取。协议扩展后的旧热更新闭包一度仍用旧 schema 拒绝 `reasoningEffort`，完整刷新已恢复；这不等于此前所有前端服务退出情形的根因都已解决。未提交、推送或发布。

## 前轮：紧凑独立悬浮输入工具

2026-09-11 后续修正：补齐最初要求的默认隐藏，输入区悬停／聚焦以及鼠标直接进入按钮位置均会浮现；离开且失焦后隐藏，触控保留可见。工具区的透明命中带持续存在，跨越与输入框之间的小间隙不会闪退；显隐不改变布局。模型与推理状态已移到右下角、发送左侧，作用范围仍在左边。

随后按用户要求移除输入区省略号：执行记录、长录音转写、工作页的历史／完整记录／固定等全部改为独立按钮，有选区时直接提供批注。使用稳定的工具标识保持切换焦点，取消固定仍聚焦输入；转写使用声波图标区分普通听写。窄窗口自动换行并实测预留高度，避免更多按钮覆盖画布。只移除输入区菜单，空间等其他用途仍复用原菜单组件与焦点规则。

原窗口已核对最新五按钮展开、失焦隐藏及右下角模型布局，最后恢复对话页未聚焦输入的隐藏状态；未启动录音、截图、发送、重启或提交。直接进入隐藏按钮区域的悬停、跨间隙连续命中和触控换行由隔离浏览器检查，不冒充原窗口鼠标实操。

最终 **24/24 项相关界面组合、类型检查、前端构建及格式／差异检查通过**，含输入显隐、右侧布局、触控、纯对话、执行、检查器、语音批注与对象／草稿流程。此前扩展组合为 42/43：保存批注后右侧栏自动聚焦标题，触发输入区收起；已定位并修正为保存后在输入恢复可用时聚焦，自动展示批注不抢焦点，主动打开右栏仍正常聚焦。该失败项及焦点／右栏相关检查均纳入最后 24 项重跑；不宣称重新跑完扩展 43 项。另有更早的 16/16 项布局／焦点组合通过；下文 32 项为此前保留省略号阶段的记录。

2026-09-11：按用户确认的最终预览，实际输入区改为附件、截图、语音和“更多”独立悬浮在输入框上方；28px 底面、16px 图标、32px 桌面命中区、4px 间隔，紧贴输入框。没有连体底板，悬停只轻微放大上移底面及图标；触控命中区为 44px，减少动态时取消变换。输入正文保持原有两行全宽和随文字增长；布局预留工具高度，不覆盖工作画布。工作页的固定／收起控件、纯对话常驻、截图暂时让出画布以及草稿／引用／附件归属保持原语义。

模型选择改为底部常驻，接入真实模型目录；区分默认继承与明确指定，发送失败和重载继续保留选择，不修改已提交的工作。事项自身的模型设置保留原有完整控件。推理强度目前仅显示模型默认状态及不可调整说明，尚未接入强度接口；目录无来源元数据，不虚构 Key 来源、额度或切换能力。

原 Electron 窗口已热更新并目视核对布局，实际底部模型菜单与上方“更多”均可打开、Escape 返回触发器；检查后关闭临时菜单。没有发送消息、启动录音／截图、改写内容、重启窗口／中心或提交代码。

最终 **32/32 项相关界面回归、类型检查、前端构建及格式／差异检查通过**。覆盖 320–1440px 明暗布局、全宽正文、悬停不移动命中区、44px 触控、减少动态、菜单焦点、真实模型字段发送与失败／重载保留、附件、听写关闭、截图让出画布、项目草稿和消息滚动。初轮 31/32，触控用例未显式切到对话，继承事项页面而将五个按钮误断言为四个；现明确验证对话四个和固定工作台六个，重新跑完全部 32 项。另目视检查隔离 320px 暗色截图；不把隔离数据测试称为用户中心的录音、截图或模型发送验收。

## 前轮：全高宿主检查器

2026-09-11 文案补充：空间菜单“执行”及右栏概览标题统一改为“执行记录”，表示查看而非启动执行；进行中工作、等待中的分支和最近结束记录保持原行为。当前活动投影来自 Runtime scheduler 的非终态线程，按持久输入／Session 绑定和授权过滤。尚未接入独立 Objective 列表、目标正文或完成状态；不能把线程标题／intent 或执行设备 Target 当作完整 Objective 展示。

本次 9/9 项相关界面回归、类型检查、前端构建、格式及差异检查通过。已在原 Electron 窗口核对新菜单项和右栏标题，检查后恢复原收起布局；当时当前工作显示 0 项进行中，活动线程行为由隔离并发回归核对。未发送输入、停止任务、重启中心或提交代码。

2026-09-11 后续：按用户“跟左边用一样的”反馈，左右显隐按钮改为共享 `SidebarToggle`，同为 32×32 CSS px 控件及 18 px 同族图标，右侧使用镜像的 `PanelRight`。原执行列表形状的顶栏开关和检查器里的关闭叉号不再承担显隐；主工具栏最右侧与已展开检查器标题栏互斥呈现同一款开关，统一“显示／隐藏右侧栏”、展开属性与关闭后的焦点返回。同一现场重开恢复刚才的执行详情、当前理解或批注；具体执行入口仍在输入选项中，并收入空间菜单“执行”，没有新增标题切换器或另一套菜单样式。

2026-09-11：按用户确认，将执行、当前理解和对象批注从内容区内侧栏提升为宿主全高检查器。三类面板共享标题、上下文、关闭、滚动和调宽规则，与中央画布并列；普通页面标题为 48 CSS px，与浏览器工具栏对齐时为 52 px。窄窗按工作区实际可用宽度切换为非模态覆盖，宽屏优先保留中央 640 px，首选宽度兼容原执行宽度并在三类面板间复用。

- 切换面板会替换而非叠加；关闭不会重新冒出上一个批注面板。统一 Escape 与焦点返回。当前理解仍只准备草稿，执行固定、真实输入／线程归属、流式前缀、审批和单项停止语义不变。应用及对象画布保持原节点，未增加第二个输入框或新的应用协议。
- 原生网页覆盖场景改为裁短已有显示边界，监听检查器的模式与宽度，不重新打开页面、改变授权或重定向导航。自动回归以桌面桥接模拟验证此契约，不称为原窗口真实网页端到端验收。
- **34/34 项相关界面回归、121/121 项 Node 测试、类型检查与前端构建通过**。覆盖三类全高面板、共享宽度、最小画布、收起侧栏后恢复停靠、320–1440 px 窗口、固定执行、单次批准、停止待确认、项目会话、对象编辑／草稿、浏览器、弹出层与辅助功能。首轮发现覆盖层仍引用第二网格列导致宽度被压为 1 px，已修复；新增测试按真实 280 px 侧栏准备断点，并显式重新展开已有草稿。原批注头测试迁移至共享上下文和 48 px 对齐基线，原有语义断言保留。

原窗口通过热更新目视核对了全高“当前理解”及中央对话／输入布局；未发送输入、改写对象、重启窗口或工作中心。该窗口先出现主进程 `write EPIPE` 提示，关闭后恢复；随后自动化读取与画面更新不同步并一次返回无可用窗口，原 Electron 进程和 65419 前端／65424 中心经只读检查均仍存活。最后只读检查已恢复正常“对话”画面，临时菜单和检查器均关闭，输入仍为空。此问题未标记已修复，因此执行／批注／网页的完整原窗口交互验收尚未完成，隔离回归不替代这一边界。本轮未提交、推送或发布。

## 前轮：弹窗与轻菜单材质统一

2026-09-11 后续：修复外观模式选中态被抹平的问题。原因是暗色菜单的底槽与 `--surface-raised` 同为 `#303030`，前轮只检查了面板材质与文字，没有检查选中面相对底槽的区分。现为外观分段控件使用独立选中底面（暗色 `#555555`、亮色白色），亮色底槽调整为 `#e5e5e5`，选中文字稍重。用户明确否决白色细框后，移除持久描边和环形阴影，只保留底块；键盘焦点继续独立显示。模式存储、跟随系统语义和菜单尺寸不变，不改变用户当前主题或重启窗口。

本次最终 **8/8 项相关界面回归、类型检查、前端构建及格式／差异检查通过**。新增检查三种模式、系统亮暗变化、鼠标选中无框、与底槽／悬停区分、文字对比度、Tab／Enter 焦点与持久选择、增强对比度及重载保存。中途修正测试的动态选项定位和鼠标／键盘焦点准备；用户撤回白框设计后，相应边框断言改为无框断言。带框初稿曾在原 Electron 中核对；用户继续自行操作后没有再次打断，最终无框截图核对来自隔离回归，不冒称已在原窗口重新验收。

2026-09-11：按用户确认，搜索、通知、连接详情、导入、授权／确认与预览等共享对话框改用约 98% 不透明的中性厚材质；外观、空间、输入菜单及选中文字工具采用约 95% 不透明的轻材质。暗色主填充、选中行和内部次要填充均去除人工蓝／紫偏色，亮色同族统一。两级表面共用细边界，分别使用柔和投影；减轻模态遮罩。保持现有尺寸、标题／正文排版、焦点、关闭逻辑和点击区域，四种主题强调色与危险语义不变。

- 只让底面微透，文字和控件不整体降透明度。减少透明、增强对比度（CSS 媒体偏好与桌面状态）以及原生网页上方回退为实色并关闭 CSS 模糊；增强对比度的边界不会被局部中性色覆盖。不将 CSS 模糊宣称为原生 Liquid Glass，不改半开交流自身的材质。
- **15/15 项相关界面回归、119/119 项 Node 测试、类型检查、前端构建、服务端编译及格式／差异检查通过**。覆盖四主题亮暗、搜索文字层次与 4.5:1 对比度抽样、三类对话框与菜单共用材质、辅助功能／原生网页样式回退、选中文字工具、菜单键盘焦点与命中区域，以及原有长标题、窄窗、引用、侧栏和半开历史。原生网页回退为宿主状态契约的隔离样式测试，不冒充当前窗口已打开原生网页实测。
- 首轮读取了构建前的旧样式；重建后修正新增测试中的重复“连接详情”定位，以及不能将普通页面顶栏／输入视为原生网页控件的准备前提。最终完整重跑上述 15 项，未放宽材质、对比度或交互断言。

已在用户原 Electron 窗口目视核对搜索、外观菜单和连接详情，退出后保留“内容”的 PDF 筛选、卡片布局及跟随系统／电光青设置。没有刷新或重启窗口／工作中心、发送消息或改写对象；通知与选中文字工具的截图来自隔离回归。原生侧栏主进程仍等待用户许可重开，不把本次前端热更新算作原生磨砂验收。本轮未提交、推送或发布。

## 前轮：原生磨砂侧栏与导航层次

2026-09-11 后续：用户指出暗色侧栏偏蓝。仅将暗色实底、原生材质罩色和渐变下缘由冷灰改为 RGB 等值的中性烟灰，保留透明度、选中态、边界及亮色模式；不重开窗口或工作中心。新增回归约束四主题下的暗色底／渐变中性，以及原生罩色无人工蓝色偏移。3/3 项相关界面回归、类型检查、前端构建和差异检查通过；已在原 Electron 的“我的项目”页面截图核对热更新后的中性灰，未切页或修改其草稿。

2026-09-11：按用户确认的方向，保留当前侧栏布局和所有工作语义，新增 macOS `sidebar` vibrancy、柔和中性罩色、材质边缘，以及主导航／项目／子会话统一的细亮边选中面。正文区及侧栏收起后的画布保持不透明，品牌四主题不变。依据 [Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials) 与 [Electron vibrancy](https://www.electronjs.org/docs/latest/api/browser-window#winsetvibrancytype-options-macos)，此项为原生系统磨砂，不宣称完整 Liquid Glass。

- 桌面外观只接受跟随系统、亮色、暗色三种模式；沿用受信主窗口校验，不向嵌入网页开放 IPC。前端订阅过滤迟到状态、卸载时解除监听，旧桌面壳没有桥接时正常使用实底。
- 材质随窗口激活变化；系统减少透明或增强对比度时停止 vibrancy 并使用实底。CSS 媒体偏好与原生状态都有回退，正文和控件本身不降低透明度，侧栏收起／显示不产生空白透明区域。
- **119/119 项 Node 测试、17/17 项相关界面组合、类型检查、前端构建和服务端编译通过**。包含隔离的真实 Electron 模式同步、监听清理、非法参数拒绝、子页面不能访问桌面桥接、四主题亮暗、键盘焦点、320–1440 CSS px 窗宽、辅助功能，以及原有对话、项目会话、半开历史和搜索／通知回归。首轮 15/17，两个新增测试分别缺少键盘焦点来源与空 iframe 正文；补齐测试准备后重新跑完全部 17 项，未放宽产品断言。

前端选中态与边界已在原窗口热更新。当前用户正在使用外观设置，已询问是否可以重开原桌面壳；尚未把原窗口的原生磨砂标记为验收通过。计划沿用原 Electron 应用路径、`MorphzWork-development/desktop` profile、65419 前端和 65424 中心，不启动第二个手工验收窗口、不重启工作中心，不发送消息或修改历史对象。本轮未提交、推送或发布。

## 前轮：对话阅读与常驻输入修复

2026-09-11：用户确认对话页保持紧凑输入框常驻。纯对话画布不再随失焦、Escape 或 Cmd+J 隐藏输入，Cmd+J 改为聚焦；固定／收起的重复控件移除。打开对象及其他工作页面仍沿用原显隐与固定行为，不改 Session、草稿归属、历史或后台执行。

- 消息按本地日期分隔（含年份），同一真实输入的相邻回复／交付保持紧凑，不同工作增加间距；顺序仍由发布时间决定，迟到回复不插回旧问题。
- 离开底部即显示“返回最新”，之后有新回复才附加未读说明；回看历史不抢滚动。入口采用零高度定位层，出现和消失不改变历史滚动高度，避免悬停消息时页面跳动。交付卡片突出已保存内容、当时标题与版本，仍只来自真实 Host 回执，不从旧回复中的标题、路径或对象 ID 猜测补链。
- 历史消息对象引用传递保存的版本，标签使用当时标题，不再以 v1 标注打开当前版本。历史原文不改写。
- 共享 Markdown 接入锁定版本 `remark-gfm@4.0.1` 和 `remark-cjk-friendly@2.3.1` 的只解析入口，处理表格和中文标点强调；表格内部滚动，代码／转义／复制原文和 HTML／外部图片限制保留。采用上游解析扩展而非正文正则改写，依据 [remark-gfm](https://github.com/remarkjs/remark-gfm) 与 [CJK 扩展说明](https://github.com/tats-u/markdown-cjk-friendly/tree/main/packages/remark-cjk-friendly)。
- 窄窗测试额外发现原执行入口位于气泡右侧外缘、让阅读区溢出 13 CSS px；入口改到右对齐气泡前方空白处，不裁掉操作或关闭横向滚动来掩盖问题。

**116/116 项 Node 测试、最终 18/18 项相关界面组合、类型检查、前端构建、服务端编译及格式／差异检查通过**。新增覆盖常驻输入与跨页草稿、320–1440 CSS px 窗宽、日期和迟到回复、回看时新消息不抢滚动、返回入口不改变滚动高度、明暗模式与键盘表格滚动，以及真实隔离数据中修订／重命名后仍打开旧版引用。中文强调、表格、代码／转义、不完整流式文本和 Markdown 安全边界另有单元回归。

本轮全量首次为 102/106，发现并修正返回入口改变布局的问题；其余为旧的全局输入显隐断言和浮点宽度精确比较。随后组合为 32/33，剩余用例受工作台恢复对象筛选影响，已在断言跨页面共享历史前显式切换“查看全部交流”，保留停止／重试与真实输入标识断言。修正项全部纳入最后 18 项组合复测，不宣称 106 项全量已重新通过。沙箱内浏览器启动受限时测试未执行，获准在沙箱外重跑；流式与停止测试使用隔离数据，没有操作用户的在途任务。

原 Electron 同一窗口已热更新并核对：实际中文强调、日期分隔、交付卡片、翻阅后返回最新、Cmd+J 聚焦、Escape／失焦仍保留输入、菜单不再重复固定／收起。没有发送新消息、改写内容对象或手动刷新／重启中心；自动界面回归与原窗口验收分开记录。本轮未提交、推送或发布。

## 前轮：行内 AI 交互入口实际落地

2026-09-11：用户选择 A 行内方案，并指出“问 AI”不能涵盖围绕内容与 AI 交互的用途。此前两轮独立预览没有修改实际应用；本次已将 `SearchDocuments` 改为引用气泡图标＋AI，移除问号、问 AI 文案和青色底面／边界。桌面入口跟随当前选中行，鼠标与键盘选择一致，控件出现不挤动文字；无悬停设备直接显示并保留 44px 触控目标。原文、版本、PDF 页码、现有输入框和草稿归属不变，不自动发送。

**15/15 项相关界面回归、类型检查、前端构建与服务端编译通过**，含四主题亮暗、鼠标／Tab／方向键、长标题／窄窗口、触控、PDF 原文及跨对话草稿。沙箱内首轮 Chrome 启动受限、测试未执行，获准在沙箱外重跑后全部通过；Vite 使用 `--configLoader runner` 避免向链接的依赖目录写临时配置。原 Electron 的同一搜索面板已自动热更新并截图核对：只有选中行显示新入口。没有刷新或重启用户窗口／中心、修改内容对象或发送消息，未提交、推送或发布。此项取代下述青色“问 AI”阶段方案，不代表审美已获最终确认。

## 前轮：统一文字层级与次要操作

2026-09-11 后续：用户指出“引用”虽简短但丢失 AI 交互含义。搜索操作现改为对话问号图标＋“问 AI”，用现有主题色浅底、细边界和清晰前景与普通资料操作区分，仍在标题同行。可访问名称包含具体对象；提示明确先将片段加入输入框，不自动发送。**17/17 项相关界面组合、类型检查、前端构建及格式／差异检查通过**，覆盖四主题亮暗可读性、键盘、长标题／窄窗、PDF 原文与跨对话草稿。原 Electron 窗口已实看“测试”四项结果后返回原内容页，保留 PDF 筛选；未发送消息或重启中心。此项替代下文首次采用中性“引用”按钮的阶段方案，未扩大到其他 AI 入口。未提交。

2026-09-11：按用户要求，将搜索里的问题扩展为共享视觉规则整改。常用次要操作统一为图标与短标签、稳定底色及细边界；搜索“引用”与标题同行，归属、页码和来源不另占行。标题／动作、摘要／辅助正文、元信息采用三层文字色，搜索与菜单使用实色表面，选中背景独立于悬停。内容目录、文档、事项、项目及来源界面的同类操作接入统一规则，完整提示与关键操作后果保留；不改会话、执行或存储语义。

**113/113 项 Node 测试、最终 35/35 项相关界面组合、类型检查、前端构建及格式／差异检查通过**。四种品牌主题的亮暗模式验证文字对比度、控件外观、键盘与窄窗口；搜索片段仅做展示清理，不改变真实引用。此前全量为 100/101，发现并修正内容创建按钮的旧 CSS 覆盖后，相关项纳入最后 35 项组合复测，未宣称全量重跑通过。原 Electron 窗口已热更新并检查主要界面，用户开始自行操作后不再切页；原跟随系统外观已恢复。本轮未重启中心或发送输入。准确覆盖与失败修正记录见[产品流程与视觉体验审计](./23-product-experience-audit.md)。未提交、推送或发布。

## 前轮：搜索多关键词与结果点击修复

2026-09-11 补充：用户指出去掉泛化来源后，“工作台”等真实归属仍独占一行。已将最近修改和搜索结果的归属、页码及真实路径统一放入标题同行右侧；长内容各自省略并保留完整提示，摘要与引用语义不变。**10/10 项相关界面组合、类型检查、前端构建与差异检查通过**，包含长标题／项目名／路径及 760×540 窗口。原 Morphz 窗口已热更新目视确认默认列表、多词结果和真实路径同行，退出后恢复原对话页；未重启中心、修改对象或发送输入。未提交。

2026-09-11：完成用户确认的三项搜索问题：空白分隔的字面关键词按 AND 匹配；无具体来源时移除重复的“工作空间内容”；标题、摘要与来源统一为可打开区域，保留拖选及独立引用操作。**111/111 项 Node 测试、9/9 项相关界面组合、类型检查与前后端构建通过**。原开发中心在线备份后更新，同一桌面窗口实测多词返回 6 项并能点击摘要打开，既有对象、输入、会话、资源与回执保持，未发送新消息或重放任务。中文短词扫描、大规模容量、PostgreSQL 适配及其他候选视觉调整仍未解决；高亮并非本轮必改项，未新增。完整问题、决策、实现边界与备份证据见[产品流程与视觉体验审计](./23-product-experience-audit.md)。未提交、推送或发布。

## 前轮：首条输入才建立项目会话

2026-09-11：点击新建只准备可恢复的本机草稿，不立即创建空会话；第一次有效文字或附件提交时原子创建会话与输入，回执丢失后用同一命令重试，不重复首发。旧空记录隐藏但不删除，有内容的旧草稿仍可恢复；同项目反复点击、刷新与导航不丢草稿。补齐首发结束及重复新建时的输入焦点。**109/109 项 Node 测试、最终 27/27 项相关界面组合、类型检查、前后端构建及格式／差异检查通过**。全量初次为 95/97，两项前置状态修正后纳入上述组合复测，不冒称全量重跑。经用户明确授权，原中心与 Runtime 在线备份后更新，原数据、附件、Session 和回执保持，未重放。原热更新前端随后退出，已恢复同一前端并在原窗口重载一次；实测空白不建条目、临时草稿恢复／清除及旧草稿和附件保留，未发送消息，最后返回原工作区。详情及退出问题边界见[持续会话与并发执行](./17-continuous-conversation-and-execution.md)。尚未提交。

## 前轮：项目本身作为默认对话入口

2026-09-11：移除项目下自动映射的“持续对话”子项。点击侧栏项目或项目目录中的项目，明确进入默认持续对话；点击显式创建的子会话才选择独立 Session，刷新保留当前选择，展开箭头不改变会话。父项与子项选中态互斥，同项目应用／对象和各自草稿保留。旧记录、历史和在途工作不修改、不重放。**14/14 项相关界面回归、107/107 项 Node 回归、类型检查、生产构建及差异检查通过**。已在用户当前 Morphz 窗口往返切换 TEST 与其“对话 3”，核对默认历史和原有草稿、附件恢复，随后回到原内容页；未重启、发送消息或新建会话。详情见[持续会话与并发执行](./17-continuous-conversation-and-execution.md)。尚未提交。

## 前轮：视觉与动效升级

2026-09-11：参考 Apple HIG Motion / Materials，建立共享材质、边界与动效层；临时半开历史覆盖真实 HTML 工作画布，固定、短窗口及原生浏览器保持占位，完整记录保持平面呈现。减少动态、减少透明和增强对比度有对应样式。PDF 取消重复标题与作者区，分页并入现有工具栏，正文紧接顶栏。已按现有功能清单复核用户原窗口的主要页面和入口，未刷新、重启、重新录音或发送消息；最终 **95/95 项界面回归、107/107 项 Node 回归、类型检查、生产构建、格式与差异检查通过**。未提交或发布。原窗口与合成回归的具体覆盖、截图及边界见 [视觉与动效升级](./22-visual-motion-upgrade.md)。

## 前轮：现有功能体验复查

2026-09-11 本轮整体体验整改已完成：用户当前窗口的实际路径复核与最后 **92/92 项界面回归、107/107 项 Node 回归、类型检查、生产构建及差异检查通过**。按现有能力范围验收，不宣称新增专业认知应用、任意语音引擎切换或识别质量全面验收。证据、失败修正过程及剩余能力边界见[整体整改目标](./21-desktop-ux-goal.md)。依用户要求在 `codex/desktop-ux` 分支本地提交，未推送、合并或发布。

2026-09-11 截图补充：用户在原窗口提交的实际截图暴露了弹窗／遮罩挡住 PDF 的问题，不能再把剩余工作仅归为控制工具无法框选。已改为系统选区前临时隐藏截图与输入浮层，等待浏览器原生布局回执及绘制后启动选择，结束／取消恢复确认和草稿；不自动上传、发送或保存到内容。完整对话页的消息本身属于工作画布，仍保持可见，只暂时移走输入与确认层；PDF、网页及完整对话的选区前画面与取消恢复已在原窗口检查。用户随后完成系统选区并附加到草稿，代理复核干净的 PDF 图片，未新增消息或内容对象。真实复查还修正了附件放大预览误用 72 px 缩略高度的问题，大图现在按视口和原比例呈现。最终回归与准确边界见整体整改目标。

2026-09-11 补充：原窗口完成约两倍放大，以及 PDF 原生导入、第二页选区批注、页码与版本持久化检查。经用户明确授权进行一次短听写，实际完成采集、停止与识别请求，结果为空；据此补齐空结果说明，并修正点击关闭听写时输入跟着收起的焦点问题。没有重复采集、发送聊天消息或改动模型配置。此时尚未完成系统截图完整选区，后续结果见上文和整体整改目标。

2026-09-11：统一在用户当前窗口（65419 前端 → 65424 中心）继续实操，不另开手工验收应用、profile 或中心。已在原窗口走通真实文档创建、编辑、版本与批注、网页保存与恢复、表格／表单／报告、人工事项结果、项目草稿与原生附件选择、来源连接及可编辑副本、输入固定／收起和执行详情。修复了附件组件 key 冲突引起的按钮残留、取消固定失焦、网页保存状态丢失，并压缩版本／来源信息与窄窗口操作。进度、服务更新数据核对及系统截图／麦克风实测边界统一见[整体整改目标](./21-desktop-ux-goal.md)，不把另一环境或模拟接口的结果称为当前窗口实测。

2026-09-10：继续检查现有功能，不扩大专业应用范围。当前理解改用非模态侧栏和统一草稿；空间菜单统一顶层呈现；长文保存移入已有工具栏并支持快捷键；表格筛选／新增／可选设置、来源错误重试和画布点击收起输入一并调整。朗读收为紧凑控制带，短句使用真实音频时间，章节和原文按需展开。详情及验证边界见[体验复查记录](./20-experience-review.md)。前半程 Mac 锁定，解锁后已用 Computer Use 检查当前窗口的朗读布局与展开／收起；其余页面尚未完成本轮逐页手工验收，不能将自动回归通过等同于所有界面已好用或审美验收通过。

## 历史：用户路径整改与认知应用呈现

2026-09-10：本轮按用户路径调整现有桌面功能，详情见[用户路径整改记录](./19-workflow-ux-implementation.md)。认知应用的 UI 契约仍是 Desktop 临时探索，不是 Runtime / HNS GUI 标准。

- 浏览器作为内置认知应用直接启动，不先创建网站对象；有地址栏、前进后退、刷新、显式保存、协助授权和网页相关输入。默认工作空间模式，保留侧栏及其手动显隐偏好，主区以一行地址工具栏替代外层标签栏；宿主提供返回工作空间入口，不强制进入操作系统全屏。同一工作空间返回、重开保留原生页面，隐藏时撤销临时协助授权。
- 截图默认添加到当前消息草稿；“保存到内容”是另一项明确动作。文件附件支持就地预览、移除、草稿恢复和附件-only 发送，不自动生成 Artifact。新请求使用不可变的 `morphzwork.input@2` 格式，以字段携带可选网页引用；保留 v1 定义和已排队请求，不修改或重发旧消息。
- 文档／PDF 选区可就地提问、批注或朗读。批注与发给 Agent 明确区分；对象／浏览器现场默认展示相关交流，仍可查看完整历史，不创建新 Session。短听写在输入框内，长录音转写独立保留；朗读使用非模态紧凑控制，不再遮住原文。
- 执行列表区分当前／全部工作并弱化普通聊天；结果先展示精确成果链接，技术回执折叠。人工事项使用面向人的状态，通知设置与通知列表分开；来源连接、最近成果、相邻页签回退、保存项目命名及内容区弹窗定位一并调整。
- 类型检查、构建及 104 项 Node 测试通过。真实 Electron 浏览器验证直接浏览、协助／接管／逐次批准、账号存储隔离和返回后的表单保留；真实 Runtime 配合本地确定性模型验证流式正文与工具、对象回执、独立项目会话及附件-only 原字节交付。界面全量回归结果见整改记录。
- 功能验收使用隔离中心与合成资料。用户确认原窗口同样是测试用途后，完整备份并更新该测试中心、Runtime 与原桌面 profile，关闭额外验收窗口；4 个对象、15 条输入、8 条会话、原 Session 绑定及投递逐项保持不变，没有重放。保留该测试 Runtime 已配置的本机模型代理，结构化消息与资源能力已启用。代码仍在开发分支工作区，未合并或发布。
- 浏览器改为工作空间模式后，类型检查、6 项数据／Session IO 专项、2 项界面专项及真实 Electron 浏览器回归通过，包含侧栏手动收起与恢复、单行工具栏和原生页面边界。半展开交流增加中性半透明底、细边界和柔和阴影，完整对话页保持原样；不降低文字透明度或改变输入区尺寸。

## 历史：结构化 Session IO 接入（实验）

- 新文字输入改为 `morphzwork.input@1`：用户原文、输入／工作空间／Actant 标识、意图、选区和精确对象版本均为字段。删除逐条拼接的规则前缀；稳定行为放入一次安装的 Host 格式／工具契约，对象正文通过版本化读取获得，不再截断后拼入用户消息。
- 宿主仍从真实 Runtime Thread/root 解析作用域。`read-input` 只读取当前调用对应的原输入，不接受模型指定任意输入 ID；数据中的身份与空间不是权限。实际对象入口继续来自真实工具回执。
- 保留已存在 outbox 的原格式、ID 和请求，不迁移重发。新文字和图片均使用 `/io/messages`，旧 Runtime 或缺少 Work／资源能力时明确失败并保留输入，不退回长提示词。图片原字节保存在私有 outbox，经固定 ID 的暂存上传后由结构化附件字段引用，不暴露到 UI 快照。
- 2026-09-10：102 项 Node 测试、类型检查及构建通过；真实 Electron／隔离中心／Runtime／Host 链路验证了结构化原文、文档与事项落库、对象回执、公共理解、协作调度、独立会话、文本／工具流式展示及刷新去重。新增真实图片上传、原字节进入模型请求和授权资源下载验证；另有上传／输入各丢一次回执后不重复上传、不改 ID 的恢复测试。使用确定性本地模型，无付费模型调用。
- 同日以补齐资源交付并发互斥、Objective 精确回复调度互斥后的 Runtime 二进制再次完成整条 Electron 验收；文本和工具参数均在模型完成前可见，截图已检查。此轮没有修改桌面布局、会话归属或个人中心。
- 配套 Runtime 为默认关闭的 `session-io` 实验能力，不是正式标准。资源接口、类型化分页和显式数据库写入防护均已通过 SQLite／PostgreSQL 验证；旧版二进制及保持运行的旧 HTTP 服务在防护切换后写入被拒绝，备份恢复路径通过。
- 2026-09-10 最终复测：`test:runtime-tools -- --stream-ui --storage-fence` 仅在本轮新建测试库显式安装防护，随后完整 Electron／中心／Runtime／Host 链路通过，包括文本／工具流式、文档与事项、协作调度、项目会话和图片资源。截图已检查。普通启动不安装防护，未切换日常中心、重放已有工作、修改现有实例或发布。

## 历史：内容目录与事项分工

- 侧栏固定入口为对话、事项、内容、工作台、项目。内容用于查找当前身份有权访问的文档、图片、PDF、网站和表格报告；事项统一承载工作安排与进度。事项从全局及工作空间内容列表、分类、数量和创建快捷入口中排除，旧的事项筛选状态恢复为全部内容。
- 两个入口仍使用同一套 Artifact 数据。事项关联的成果继续出现在内容中，关系与归属不改变；搜索和明确的对象链接仍可打开事项，不复制或迁移对象。内置通用资料不再作为启动台上的应用卡片，工作台／项目保留本空间内容入口。
- 内容目录默认跨空间，可按所属空间过滤；工作台／项目内容只显示本空间。打开、返回、刷新保持目录现场与原入口，不新建 Session，不切换已有会话，也不改新输入的归属。内容目录中的草稿与工作台草稿分别恢复。
- 修复搜索先返回新对象、界面轮询快照尚未同步时点击无响应的问题：补取授权快照后打开；后续导航优先，无法读取时明确提示，不扩大权限或自动重放工作。
- 构建、类型检查、98 项 Node 测试、最终 26 项相关界面组合回归与隔离的真实 Electron 检查通过。覆盖事项排除与准确计数、旧筛选恢复、关联成果、权限、快照滞后时搜索打开、事项回应与刷新、明暗／四主题和窄窗口。测试创建事项改走事项入口，保留原有编辑、提交及归属断言；搜索的索引版本不冒充当前可编辑对象。
- 早期全量界面运行是 64/67，之后修正通知角标选择器、恢复视图的测试准备及异步搜索问题，最终相关组合通过；没有把相关组合复测说成重新跑过全量。原生内容目录截图已检查，当前用户窗口已热更新，内容总数为 2，不计入侧栏的 2 个事项。尚未发布，用户中心和原有任务未重启或重放。

## 历史：资料列表的跨空间可见范围

- 修复“对话里已保存的文档，在工作台资料页显示 0 项”的路径缺口。内置资料应用默认展示当前身份有权访问的全部空间，并提供空间筛选、条目归属和准确的局部空态；无需先知道文档保存在哪个空间。
- 范围、类型、搜索及布局按浏览现场恢复。打开对象、返回列表、重载均保留查找路径；筛选不移动文档、不切换 Session、不改变新输入／创建位置。第三方应用权限与服务端 Principal 过滤保持原样。
- 构建、98 项 Node 测试与最终 24 项组合界面回归通过，覆盖跨空间文档、返回／重载、范围过滤、身份隔离、应用与项目会话、四主题和窄窗口。首轮新增测试的正文选择器写错已修正，原局部列表用例改为明确选择所属空间；保留原有数量与归属断言。侧栏悬停测试改用确定的宿主控件作为移出目标，避免落入已恢复的第三方 iframe。
- 已在用户当前 Electron 开发窗口中核对“工作台 → 资料 → 文档”显示两份实际文档，包含《极客部落签约仪式｜备用材料与现场清单》，并从列表打开后返回。仅热更新界面，未重启中心、修改原文档或发送模型请求；尚未提交或发布。

## 历史：统一交互审计修复

- 后续侧栏细节：项目和会话行的悬停／选中由整行统一绘制，移除内部按钮叠加背景。新建会话按钮仅在项目行悬停或键盘聚焦时显示，保留占位防止名称跳动；无悬停能力的设备直接显示。
- [桌面交互审计](./18-desktop-interaction-audit.md) 的 13 项已实施：真实交付入口、安全链接与图片、可恢复导航、直接导入、焦点恢复、通知已读重试、明确搜索范围、图标与文案、实际模型目录、显式网站打开和紧凑连接详情。
- Host 工具创建／修订对象时，将对象、版本、命令回执与真实输入关联并在同一事务中保存。界面从回执打开结果；没有来源的旧文字不猜测补链。共享 Session 的项目权限与执行根验证保持不变。
- 模型选择只限定新输入或事项后续执行，不改全局模型、不改已经提交的任务。Agent-first 快捷入口不自动发送；浏览器、文件和 Principal 授权不因减少步骤而省略。
- 修复组合回归发现的文档创建迟到回调抢走新会话，以及窄窗口对象工具遮挡“所有资料”的问题。下方旧验收记录按时间保留，本轮验收见审计文末。
- 构建、97 项 Node 测试、最终 61/61 项完整界面回归，以及真实 Electron、内置浏览器、Runtime 流式工具链验收全部通过。开发中心已先备份再更新，原对象、输入、会话、回执与定时事项保留；桌面已用原 profile 重开并目视核对真实模型菜单。未提交或发布。

## 历史：项目侧栏会话与交互审计

- 项目行右侧使用方框笔形图标直接新建会话，移除顶部会话选择器；已有会话嵌套在项目下，管理动作归条目菜单。不是加号，也不增加全局新建对话。创建成功聚焦输入，保留应用、对象与各自草稿，迟到回执不抢走后续导航。
- 修复旧对象打开与新会话选择之间的时序干扰。构建与类型检查、最终 5 项会话界面专项通过，隔离中心真实 Electron 会话新建、应用保留、归档／恢复和草稿流程通过；日常窗口 HMR 已显示新入口，未重启用户中心。
- 完成[桌面交互审计](./18-desktop-interaction-audit.md)：记录 13 项，1 项已调整、12 项待处理。区分源码确认、实际截图、自动复现和待决策项，附操作路径、验收条件与实施顺序。
- 综合回归仍复现关闭弹窗后输入框意外收起的问题，见审计 A06；没有把其他专项通过写成该问题已修复。其余审计项本轮未改造，未提交或发布。

## 历史：持续会话与并发执行面板

- 修正持续会话合并后“对话／事项”输入关联错误回退到工作台的问题。关联跟随当前视图，打开具体事项则携带该对象 ID 和版本；只影响下一次 activation，不切换默认 Session，不改写已提交输入或后台执行。构建、共享 Session 执行范围测试与 10 项界面回归通过；新增用例覆盖列表、对象、返回列表及旧输入不变。实际 Electron 已热更新，确认“对话”“事项”和具体事项名称按所在位置显示，未发送用户中心测试消息或重启服务。
- 个人默认交流贯穿对话、事项、工作台及未选择内部命名会话的项目；命名会话继续独立，团队 Context 权限不合并。旧 Session、投递与历史不改绑、不重放，场景草稿及固定状态仍独立恢复。
- 输入项目与传输 Session 分离。共享 Session 的对象工具按 Runtime 真实线程根查找持久输入，再验证原项目权限；右栏查看与控制按输入根或具体分支限定，拒绝同 Session 中其他工作的执行、结果和审批。
- 右栏支持工作概览、单项分支、实时工具、审批、结果、停止、固定及宽度调整。原输入有轻量运行入口；回复已交付但分支仍运行时保留标记。调度读取失败保留最后记录并标明待确认，不冒充已结束。
- 主消息按发布时间独立排列，迟到交付不插回原输入；流式消息持久保存首段位置与展示 ID，终结不跳位。主消息区与右栏共用流式订阅，避免打开右栏时丢失参数前缀。
- 导航不再随对象创建来源跳转；打开新对象期间暂停旧对象工具栏，避免快速操作误用旧内容。全部行为及验收记录见[持续会话与并发执行](./17-continuous-conversation-and-execution.md)。本次仍为本地开发交付。
- 构建、类型检查、94 项 Node 测试及真实 Runtime／Electron 验收通过。最后全量界面回归 51/52 通过，剩余一次焦点偶发失败在串行的应用与输入交互 8 项组合复测中通过；完整边界记录见上文链接，不宣称所有偶发问题已根治。
- 独立开发服务已在在线备份后更新，原对象、输入、操作回执、Session、投递及未来定时安排逐项保留，没有重放任务。Mac 锁定时无法核对用户前台窗口，明暗与窄窗口检查使用隔离的真实 Electron。尚未提交代码。

## 历史：简洁消息与实时执行进度

- 消息不再重复显示排队、发送中与处理中，也移除列表末尾的处理状态横条。停止从人类消息气泡移到对应 Agent 回复末尾，用紧凑的“■ 停止”与原操作行合并；首段尚未到达时仍在 Agent 一侧可操作。并发按真实输入标识分别停止，等待确认期间禁用，失败可重试；不改调度、审批或草稿规则。
- 流式正文末尾和正在生成参数的工具名称旁增加轻微呼吸光标，只跟随实际流状态；结束、参数已生成或断线后停止动效。遵守减少动态效果偏好，不伪造文字输出。当前桌面通过 HMR 更新，未重启用户中心，也没有取消用户工作。
- 本次构建与类型检查通过。最终停止／流式专项 3 项通过，另外消息复制与留白、输入布局、执行审批 4 项回归通过；独立 Electron 桌面回归通过，明暗／窄窗口及当前桌面截图已核对。取消接口和流事件的界面测试使用隔离测试数据，不是对用户任务进行停止或新增模型请求；修复了动效在“减少动态效果”下的样式优先级问题。尚未提交代码。
- 截图入口按后续评审换为“虚线选区＋剪刀”，仍紧邻语音；不改变系统选区、确认上传与取消规则。全宽输入及明暗／窄窗口截图已核对，构建、真实 Electron 回归通过。全量 48 项界面测试中 46 项通过，2 项在菜单点击呈现与资料视图恢复处偶发失败；菜单测试补充等待实际绘制后，应用、输入、执行与事项的 12 项组合复测全部通过。未据此宣称所有偶发时序问题已根治。个人中心和 Runtime 未重启，没有发送用户测试消息或调用模型；尚未提交代码。
- 输入框改为全宽正文与单排底部操作，移除占正文宽度的右上工具组；范围与意图合为轻量组合，正常模型信息与执行／历史／固定操作收入“更多”，固定后保留可取消标记。焦点只使用细边框，不叠光晕。消息列表隐藏滚动条，滚动、阅读位置与返回最新保持原行为。此项替代下面保留的早期布局尝试。

- 根据后续评审取消输入框独立顶行，正文与工具从同一上沿开始，范围／意图移到底部；恢复两行起步、最小 60 CSS px 的书写空间，长文继续自动增长，工具不覆盖文字。此项替代下述上一轮“一行起步／32 px”的布局试验。当前 Electron 已截图确认，正文不再被工具顶行下压。
- 移除会挤动页面的底部状态栏，不再提示普通保存／排队／同步／安装成功。发送失败显示在原范围输入框旁，草稿保留；连接状态与重连沿用侧栏，其他必要异常使用不占布局高度的紧凑提示。输入正文从一行起步随文字增长，最小高度 32 CSS px，压缩行距、内边距与底部间隔。构建与 13 项相关界面回归通过，包含保存、断线和关闭失败前后主区位置不变；当前 Electron 已截图核对并热更新。
- 针对“未看到流式输出”复核当前实际模型与协议：隔离 Runtime、中心及 Electron 实测收到 115 次文字增量，桌面在回复结束前呈现 18 次递增正文；已保存中途截图。另一次同配置测试首段等待约 28 秒，说明首段等待时长与开始后的流式输出需分开看待。本次未复现用户先前那一条只在结束时出现的情况，不据此宣称其具体原因已经查明；未改动流式协议或伪造打字动画，测试不进入用户中心。
- 移除消息区的“交流记录”整行，把“执行记录与审批”移到输入框右上工具区；打开时固定当前项目、对话与对象范围，关闭后恢复焦点和草稿，归档对话保留执行入口。输入框顶行、标签与图标按钮统一为 24 CSS px 高，减少顶部留白，不增设第二行。
- 本次构建与 12 项相关界面回归通过，覆盖执行范围、审批入口、草稿、焦点、意图标签和窄窗口排列。已在当前 Electron 截图确认热更新生效，并实际打开、关闭执行记录面板；未重启中心或修改用户对话。
- 本人的消息靠右，Agent 回复靠左。普通消息不显示“我”、Morphz 名称或 Logo；时间与复制按钮置于正文下方，仅在消息悬停或键盘聚焦时显示，不改变消息高度。多人协作时保留其他参与者的身份；未发送、失败、取消等必要状态不随悬停隐藏。
- 修复本人消息为隐藏操作保留整行空白的问题：时间与复制悬浮在气泡外下缘，正常已完成消息只按正文与内边距计算高度，必要状态和错误仍在正文之后。构建与 6 项相关界面回归通过，覆盖单行、多行、1440／760／390／320 像素宽度、悬停、键盘和复制失败。已在当前 Electron 截图确认气泡收紧并热更新，无需重启中心。
- 复制只取该条正文，保留原始换行与 Markdown，不混入时间或状态。成功短暂显示勾选，失败明确提示并可重试；不读取系统剪贴板。没有悬停能力的设备保留可见入口。
- 参照 Dashboard 的真实事件链路，中心连接 Runtime 的 Session WebSocket，通过带身份与项目权限校验的 SSE 向界面推送正文增量、工具参数、执行状态和结果；凭据留在服务端。工具参数生成完成不等于执行成功，后台任务继续显示实际状态。工具详情默认折叠，长参数和结果有预览边界，完整内容仍可从执行记录读取。
- 流式消息按物理模型请求及输入归属更新，并与持久历史合并、去重。断线重连补读持久记录；缺少开始事件的增量不伪装成完整消息，取消后的迟到片段不重新出现。保留原阅读位置、主动跟随和未读规则，不展示模型隐含推理。
- 构建、类型检查、89 项 Node 测试、45 项完整界面回归通过。新增测试覆盖悬停、键盘复制、失败重试、正文准确性及窄屏两侧布局；复制测试隔离剪贴板，不改用户剪贴板。隔离的真实 Electron 与 Runtime 通过本机确定性模型验证：供应商尚未结束时就能看到文字和工具参数，完成后最终回复只出现一次，刷新可恢复工具与回复。未调用付费模型。
- 独立开发中心与 Runtime 在线备份后更新，现有桌面已重新连接并实际显示工具记录。逐项比较原项目、对话、2 个对象、4 条输入、应用实例、全部命令回执、Session 与投递均保留，投递仍为 completed，没有重放工作。日常中心未改动。当前为本地开发版，尚未提交代码或发布版本。

## 历史：固定对话入口与项目多对话

- 侧栏首位增加固定“对话”，用于不属于具体项目的长期交流。每个 Human 各有自己的持久空间；不提供全局新建对话或聊天列表。工作台仍是原来的工作现场，保存为项目不会转移全局交流。
- 项目默认有一条对话，现有顶栏提供紧凑选择器，可新增、切换、重命名、归档和恢复；不叠加标题栏。默认对话不可归档，进入项目即可工作。归档保留历史与草稿，不删除对象、不停止后台执行。
- 消息、未发送草稿、引用、输入固定状态和未读按对话区分；应用及项目对象共用，切换不卸载正在使用的应用。草稿和选中的对话保存在本机，历史和对话元数据保存在中心；阅读位置在本次窗口生命周期内保留，尚不跨设备同步。
- 新对话使用独立 Runtime Session，继续共享原授权范围的 Context，不创建新的 Agent 或执行线程。默认对话沿用旧 Session；旧输入、命令回执、应用实例及 Runtime 投递保持原样。持久格式升级至 12，旧消息归入默认对话，不重新发送。
- 输入、回复与执行查询按对话路由；浏览器操作回执、Agent 创建事项后的持久安排和来源变更接续仍回到原对话。切换或归档后到达的回复不会挤入当前对话。团队模式继承项目成员权限，对话不是成员之间的私聊或新的认知权限边界。
- 补齐输入区快速展开的竞态保护：重新聚焦会取消旧失焦回调，主动打开输入时一次展开历史，不再连续改变嵌入应用尺寸、造成可见按钮的点击落进旧 iframe 区域。固定、外部点击收起、草稿保留规则不变。
- 工作台保存为项目期间固定原工作空间，中心快照先于保存回执返回时，也不切入新空白工作台或卸载原应用。补测主动延迟回执，验证原 iframe 仍然连接、应用内容及对话随项目保留。
- 构建、类型检查、83 项 Node 测试通过。已执行 44 项界面回归；焦点竞态修复，以及测试的模态呈现和新对话切换等待补齐后，17 项相关组合复测全部通过，未删除或放宽原断言。真实 Electron 验证全局入口、项目对话、独立草稿、应用保留、归档恢复及窗口生命周期；真实 Runtime 使用本机确定性模型实际创建事项，验证独立 Session、共享 Context、工具回执与回复归属，不调用付费模型。
- 独立开发中心已在线备份并升级；逐项比对原项目、2 个对象及版本、3 条输入、应用实例、全部命令回执和 Runtime Session 均保持一致，原投递仍为 completed，没有重放任务或调用用户模型。日常中心未改动。
- 当前为本地开发版交付，不是发布版本；尚未提交代码。

## 历史：事项详情与紧凑内容区

- 事项默认显示正文和紧凑属性，不再把只读文本、负责人、状态等画成禁用表单。人工事项隐藏模型框；安排元数据按需展开，成果与已有关系仍可打开。手动编辑与版本冲突保护保留。
- 事项取消居中窄版纸张与大卡片套表单，主体边距收至 20–24 CSS px，属性、结果与正文沿同一内容边缘排列。事项目录内的详情标题合入现有工具栏，不再重复正文大标题。应用页签内仍保留对象内容标题。
- 移除独立回应输入框，普通补充／调整与明确的结果提交复用底部输入。沿用中心实际语义：只有“提交结果并完成”调用 `respond-task`，按本人身份和草稿捕获的事项版本提交；普通补充不自行完成事项。草稿按原范围保存，错误和版本冲突不会丢失输入。
- “安排事项”等意图标签移到范围标签右侧，同一行居中对齐，不再增高输入区。窄窗口标签收缩，工具按钮与移除操作保留。
- 构建和类型检查、8 项事项／协作／统一输入相关回归、6 项标签布局与输入焦点回归通过；隔离中心的真实 Electron 回归通过。补测覆盖 760／1440 像素宽度同排布局、结果提交失败保留草稿、版本冲突、普通补充不完成事项。全量界面回归发现一处测试误把外部弹窗关闭后的输入持续展开当作要求，现已改为验证焦点回到原按钮、重新打开后草稿保留，并通过专项复测；未因此改变失焦收起规则。
- 本轮仅改桌面交互，不变更 Runtime 协议或任务调度语义；未向模型发送新请求，未完成或删除用户的测试事项。代码尚未提交。

## 历史：Agent-first 统一输入与通知角标

- 事项、文档、网站与交互产物的创建快捷入口改为唤起现有 AI 输入框，携带可移除的意图提示；不弹出必填表单、不覆盖草稿、不自动发送，也不提前创建空对象。直接输入同样可以创建或修改对象，不要求先选类型。输入意图与原空间、应用、对象版本一起保存，并在历史中可见。
- Runtime 输入明确当前 Actant，指导 Agent 通过真实 Host 工具整理和写入结果，不把字段填写转交给用户；仅记录与请求执行区分，失败和未连接不冒充成功。原有版本、审批、身份和调度边界不变。“自己写文档”保留为次要的 Human 创作路径，导入与直接编辑仍可用。新建项目、保存工作台为项目暂保留直接组织操作，没有冒用 Human 身份扩充 Agent 的空间管理权限。
- 修复创建入口的显式展开与先前失焦收起之间的竞态；固定操作也取消旧收起回调，相关模态期间暂停自动收起。没有通过强制固定输入来掩盖问题。
- 通知数字改为固定 18 像素高度的居中角标，单数字圆形，多位数字横向扩展；超过 99 显示 99+，可访问名称保留完整未读数，零未读不显示。角标不参与按钮布局或抢占点击，使用原有主题色与侧栏底色描边。
- 构建、80 项 Node 测试、38 项全量界面回归、真实 Electron 回归通过；覆盖通知角标明暗外观、多位数字、零隐藏，以及输入、固定、草稿、弹窗和原有长文档／语音等能力。统一输入经隔离的真实 Runtime 与确定性模型创建事项、落库并在 UI 中打开的端到端验收通过。另已在当前用户 Electron 中用真实 Astra 输入一条不执行的测试事项，Agent 实际创建“验收统一输入交互”，作者为 morphz-agent，输入投递已完成。没有发布外部内容或执行该事项。
- 开发中心更新前完成 SQLite 在线备份，原有 1 个对象、2 条输入与已完成投递保留；服务端已加载新协议，桌面已恢复同一配置的 65419 热更新连接。测试事项作为可识别的验收记录保留，未删除用户数据。代码尚未提交。

## 历史：应用卡片单击打开

- 正常关闭应用不再生成“应用已关闭”的常驻状态栏，避免旧操作提示被误解为当前状态。关闭失败的错误和断线提示保留。构建、4 项应用回归及真实 Electron 回归通过，覆盖正常关闭无提示、重新打开、关闭失败保留应用及重试；当前用户窗口残留的旧提示已通过关闭提示控件清除，未刷新或重启中心。
- 启动台应用卡片改为单击打开，使用原生按钮语义；Tab 聚焦后按 Enter 或空格同样可打开。去掉选中态、重复的“打开应用”按钮和双击提示，安装完成提示同步修改。
- 打开过程中禁用重复触发，失败显示真实错误并恢复可重试状态。现有页签、关闭重开、应用状态及工作空间归属不变。
- 构建、7 项应用与布局相关回归、隔离中心的真实 Electron 回归通过，覆盖单击、键盘打开、防重复请求、失败重试、状态恢复和权限隔离。当前用户桌面已实测单击打开“资料”；未重启中心、发送 Agent 输入或提交代码。

## 历史：输入区聚焦、固定与外部收起

- 移除输入区上方重复的“交流记录／工作台”整行。输入框内保留一处范围提示，右侧集中完整记录、固定、历史与收起按钮；历史紧邻收起。截图换为相机图标，与语音紧邻。
- 聚焦输入展开本空间历史，离开后自动收起；输入框和历史两侧的布局留白也算外部区域。固定后不因失焦收起，仍可手动收起；固定状态按中心、身份和空间保存。草稿、引用、阅读位置及后台工作不受收起影响。
- 操作内部按钮、阅读历史、拖选文字、打开语音／截图等相关弹窗不会误收起。外部点击先完成目标动作，键盘离开不抢焦点；输入发送时的临时禁用不视为主动离开。
- 执行与审批弹窗按主内容区水平居中，排除展开侧栏；垂直方向按窗口居中，窄屏保留边距，长记录内部滚动。
- 构建通过；输入区首轮调整后的全量 32 项界面回归通过，补充两侧留白后 11 项相关回归通过，另有独立中心的真实 Electron 回归通过。覆盖两侧点击、固定、草稿恢复、键盘、模态焦点和 390／760／1000／1440 像素宽度下的审批居中。实际用户窗口刷新后已确认左右留白点击收起；仅刷新界面，未重启用户中心或 Runtime，未发送测试消息、调用付费模型或采集现场语音／截图。本轮尚未提交代码。

## 历史：标题与内容一体化

- 事项、项目目录、应用启动台共用一层标题与操作区。保留醒目的页面名称，移除重复的小标题栏、内容大标题和开场说明；筛选、搜索、新建与安装收进同一行。顶栏与内容同底色、无分隔线，下方直接开始实际内容。
- 文档编辑、版本等对象工具，以及新建文档的标题与关闭动作，放入现有顶栏；文档正文自己的标题保留。窄窗口用紧凑选择器与有可访问名称的图标操作，不重新堆叠标题区。
- 通知的标题、提醒选项和关闭按钮合为一行；短对话框使用统一紧凑标题规则，必要的授权、隐私、错误信息继续可见。
- macOS 上沿保留原生拖动区域，移除顶栏弹性布局容器整体的不可拖动设置；普通页面标题不再是无意义的按钮。搜索、选择器、按钮、菜单与实际标签区域独立排除，标签不占据整行空白。
- 全量 28 项界面回归通过；新增单层布局回归及通知／侧栏相关回归、构建和真实 Electron 回归均通过，覆盖 1440／1000／760 像素窗口和 200% 缩放。用户窗口已热更新，通知、项目页已目视检查，顶栏原生双击缩放与恢复已实测。自动鼠标拖拽未确认窗口位移，暂不计入真实拖动验收；可拖动区域与控件排除已有 Electron 自动检查。没有重启用户中心、改变提醒设置或提交代码。

## 历史：单行应用标签与固定画布

- 搜索与通知统一为中性色层次。搜索移除叠加的彩色外框、下划线和选中竖线，保留输入光标与键盘控件焦点；通知改为紧凑的三段提醒范围，选中不染品牌色，说明与空态压缩，未读改为小圆点及可访问名称。设置仍以中心保存结果为准，失败明确显示，已读与跳转语义不变。
- 本次构建、9 项相关界面测试通过，覆盖四主题亮暗外观、设置持久化、保存失败、键盘与焦点恢复、窄窗口和搜索居中。真实 Electron 回归及 200% 缩放的搜索／通知截图检查通过；当前用户窗口已热更新并目视检查，未重启中心或修改用户提醒范围。
- 折叠按钮保持标签栏高度，横向移到侧栏内部右缘；收起后在标签栏恢复展开入口。搜索面板按主内容区居中，宽度不包含侧栏；侧栏收起或窄屏改为顶部导航时自动适配。
- 搜索移除关闭图标，点击面板外或按 Esc 关闭，恢复原输入焦点与选区；面板内操作、从输入框向外拖选不会误关闭，关闭点击不会穿透到背后的导航。构建、7 项相关界面回归和独立端口的真实 Electron 回归通过；当前热更新窗口已实测居中、无关闭图标及外部点击关闭。
- 桌面开发入口现已接入 Vite：`desktop:dev -- --center=...` 只启动界面热更新与桌面壳，`dev:center --desktop` 使用同一入口。现有独立中心 65424／Runtime 18089 未重启，真实桌面已切换到开发界面；临时修改品牌文字后窗口自动变化，再还原，未按刷新。CSS／React 组件修改无需重新构建；主进程、preload 和服务端仍需要分别重启对应进程。
- 热更新专项使用隔离源码副本与中心，实际修改 CSS、React，验证没有整页刷新、未发送草稿和窗口身份保留，原生 IPC 可用，文档写入通过原有 CSRF 校验，退出桌面后中心继续运行。没有向模型发输入。开发窗口的 API 指向原中心，原生来源授权仍使用原中心地址。

- 宿主工具栏与应用页签合为一行，移除应用空间的重复位置标题。打开的应用横向排列，标签较多时只在标签区横向滚动；应用启动、关闭、保存为项目与空间选项仍可操作。
- 只保留底部 AI 输入入口及其收起控制，快捷键不变；移除右上角重复聊天按钮，收起后焦点能回到原对象或底部入口。外观和通知移到侧栏品牌区右侧；侧栏收起后可通过标签栏按钮重新展开。
- 内置资料页移除大标题、欢迎说明和大尺寸创建卡片，保留紧凑创建、筛选、搜索与布局控件。工具区固定，资料列表独立滚动；对象阅读位置按实际滚动容器恢复。
- 自定义应用填满标签栏和输入区之间的可用画布，不再使用 520 像素最小 iframe 高度。宿主不强制改变第三方应用自己的 UI；展开交流、切应用不会停止后台任务。
- 构建与类型检查、77 项 Node 测试、24 项全量界面测试通过。新增验收覆盖资料列表滚动时工具区固定、六个应用标签在小窗口切换、侧栏外观与通知的位置、底部输入入口与焦点恢复；原有四主题、PDF、语音、百万字导入和编辑冲突回归保留。
- 真实 Electron 的单行标签、画布边界、窗口拖动区、760×540／200% 缩放、窗口恢复和内置浏览器授权回归通过。视觉检查使用隔离中心与本地资料，不调用付费模型；更新运行窗口只需刷新 UI，无须重启中心。

## 历史：公共 UI 统一

依据 [UI 设计规范](./16-ui-design-standard.md) 完成宿主公共交互首轮整理，不扩展专业认知应用。

- 输入、紧凑交流、完整记录和隐藏状态统一管理；发送不切走工作对象。每个空间恢复自己的交流状态与阅读位置，收起后新回复只提示，不抢焦点。原有输入草稿、选区和版本固定机制保留。
- 回复补充真实输入和执行链标识；并发内容按输入归组，执行进度可折叠。旧消息和无法唯一归属的合并回复独立展示，不按到达时间或数组顺序猜测。单项停止与幂等重试沿用已验收协议；运行中定向补充尚未接入。
- 搜索采用上方稳定的快速打开面板，最近修改、范围、结果、键盘选择与引用共存；关闭恢复输入焦点和选区。短对话框共用模态焦点钩子，菜单发起的对话框回到菜单触发器。
- 顶栏与侧栏移除旧的内容／对话切换和重复的最近对象区；导入、当前理解收入空间菜单。工作台保留应用启动，项目目录提供检索与排序，事项提供状态筛选、负责人、优先级及时间。
- 新建文档在主画布中完成，文档草稿取消后仍可恢复；这是基础文本编辑，不是专业小说编辑器。公共样式集中到 `ui.css`，保留 Dashboard 四主题，对小字和按钮使用更清晰的前景色。成功提示可关闭，断线仍有明确状态。
- 构建、类型检查与 **77 项 Node 测试、23 项全量界面测试通过**。新回归覆盖不抢阅读位置、隐藏后的未读、搜索焦点与选区、内联文档草稿、保存工作台为项目和消息可靠归属。全量仍包含真实时长的连续采样、百万字导入、身份、PDF、批注与版本冲突。
- 真实 Electron 回归通过：快捷键、隔离应用、来源同步、760×540 最小窗口、200% 缩放下搜索完整可达与焦点返回、窗口关闭后再打开及正常退出中心继续可用。缩放视图用原生窗口截图目视核对。内置浏览器的授权、填入、接管、一次性确认提交、Cookie 与 Node 隔离回归通过；全部使用本机测试资料，不发外部帖子。
- 独立开发实例 65424／18089 已备份后更新，原有文档、输入和已完成投递保留，未重放任务、未替换日常中心或发布版本。规范与 `AGENTS.md` 已建立后续修改约束。

仍待后续：运行中定向 steering、交流记录全文检索、可拖拽面板尺寸、项目固定、非模态当前理解检查器和专业应用界面。不能将本次公共 UI 交付描述为完整设计规范所有目标均已验收。

## 历史：认知应用宿主与空间级 Session

现行设计见[认知应用与工作空间](./15-cognitive-application-host.md)。以下是四轮能力之后完成的框架更新；本文后面的四轮记录保留为历史验收，不再表示工作台与 Session 的当前组织方式。

- 工作台、项目、事项分别有持久工作空间；事项替代“收件箱”的界面名称。工作台不再聚合其他项目的内容。
- 工作空间内多个应用与对象共用稳定 Session。工作台保存为项目时不改 ID、不复制历史，并生成新的空白工作台。旧对象 Session、投递、回复和执行记录保留兼容读取，不重放。
- 应用有图标、确切版本、启动台、页签与实例状态；支持双击／回车启动，关闭重开、刷新、中心重启后恢复已保存状态。
- 自定义 HTML/CSS/JavaScript 界面通过隔离 iframe 与宿主协议访问本空间对象、保存状态或准备 AI 输入。不能直接访问 Node、桌面 IPC、文件系统、网络或账号；不能通过对象写入绕过确认启动任务。
- 每条应用输入固定 Harness 引用，通过 Runtime 消息接口传递，显式并行调度，不切换整个 Session 的全局 Harness。不同应用的引用与重启后的路由已有持久协议测试；具体专业 Harness 将在逐项认知应用建设时验收。
- 构建与类型检查通过，Node 测试 **75 项通过**，全量界面回归 **20 项通过**。真实 Runtime 的对象工具、上下文事务、任务接续和双身份隔离回归通过，使用确定性模型。
- 真实 Electron 已验证应用包安装、双击启动、鼠标保存状态、刷新恢复以及 Node／桌面 IPC 隔离。内置浏览器回归通过。修复了异步打开文档覆盖后续导航的竞态，以及独立 iframe 首帧尚未就绪时点击落到外框的问题；首帧握手后连续五轮应用测试通过。
- 独立开发中心 65424 已先做一致性备份再升级到数据库格式 11，Runtime 18089 重新连接；原有 1 个文档、1 条已完成输入保留。安装了“工作便笺”宿主示例，实际桌面已双击打开并目视核对。没有替换日常中心、调用付费模型或发布版本。

“资料”复用既有对象能力，“工作便笺”只是协议示例。本轮没有把简单便笺当作专业编辑器交付，也没有开始建设小说、代码或剪辑应用。

## 1. 资料、对象工具与执行

- Markdown／文本／图片副本导入、来源与历史版本；目录先预览，排除凭据、隐藏项、依赖与构建产物。
- PDF 原件、分页画布、中文文字层、按页检索与版本引用；解析线程有时间、内存、体积和页数限制。不支持 OCR；加密／损坏文件明确报错。
- 桌面选择目录后进行只读同步，授权绑定中心、身份、项目和路径 inode。不扫描系统盘／家目录，不跟随越界链接；暂停、恢复、重启、丢回执和删除保留历史均有测试。
- 持久 SQLite 检索索引与对象修订原子更新，授权过滤先于命中计数、摘录与模型读取。
- Agent 通过真实 ExecutionJob 调用对象查找、读取、创建、修订、关联和批注工具；身份来自 Runtime，不接受模型伪造。版本冲突不覆盖，操作按持久执行 ID 去重。
- 执行详情、结果读取、单次批准／拒绝、精确版本停止；按输入停止只取消对应 root，不影响其他并发输入。旧 Runtime 不支持时明确禁用。

真实 Runtime + 独立中心 + 确定性模型的对象链路已通过；另有真实 gpt-6-astra 两轮创建／人工批注后修订验证。PDF、执行弹窗及批注截图已检查。Poppler 的独立渲染因本机字体配置问题未通过，应用内 PDF.js 渲染已检查，二者不混算。

## 2. 持续关注、协作与当前理解

- 正式 Session Schedule API 复用 Runtime SchedulerKernel：持久时间／周期／依赖、具体模型策略、按修订暂停／恢复／取消。
- Work 事项以持久 outbox 记录安排，收到 Runtime 回执才显示生效；未知回执重试原请求。人工答复校验负责人、版本与身份，然后解除等待。
- 改派、结束和取消事项时冻结后续来源事件与安排；再次交给 Agent 使用新的执行序号，不复用旧取消记录。
- “当前理解”只投影 Agent 用 `context_tx` 提交的公开 `public-summary` 帧，并校验帧和版本。人提出纠正，再由 Agent 更新；不展示隐含推理。
- 通知按身份保存已读、全部／仅高优先级／关闭提示设置；普通文字修订不重复提醒。当前为应用内通知，不是系统推送。

真实 Runtime 已通过定时触发、人工答复后调度执行、两轮公开上下文事务与纠正验证。暂停和取消控制后续触发；**已经派生的工作需要在执行记录中单独停止**，没有实现一键停止整个周期安排的全部在途线程。

## 3. 浏览器与交互产物

- 网站对象由 Electron WebContentsView 承载，浏览器存储按中心和 Principal 分区。网页无 Node、无应用 preload；快照有大小上限，忽略密码／文件字段。
- Agent 使用短期控制授权与快照引用填写；点击逐次确认。人操作、导航、隐藏、断线使旧授权失效。执行前保存回执；重启后未知结果不重发，重新快照后才能继续。
- 浏览器结果以持久、幂等输入通知 Agent；已读结果不重复唤醒，等待原工作轮次结束后接续。丢回执、重启、对象版本变化的 outbox 测试通过。
- 表格、表单、数值报告支持编辑、筛选、排序、版本、批注与 Agent 读写。未完成草稿可恢复；不执行生成的 HTML、脚本或任意网络请求。

真实 Electron 浏览器回归已通过：读取、填写、人接管后拒绝旧点击、重新授权、逐次确认、只提交一次、中文结果确认，以及 Cookie 与 Node 隔离。重新加载桌面后再打开网站，登录 Cookie 保留，但旧控制权不保留。测试网页曾漏写 UTF-8 响应头，已修正测试夹具。另修复了可信桌面渲染器刷新／崩溃时原生网页未主动关闭的生命周期缺口；现在会撤销权限、关闭网页并取消待处理的麦克风授权与截图。交互报告及浏览器端到端测试也已通过。

## 4. 语音与现场输入

- 语音输入没有 60 秒总时长限制。开始前说明语音会发送给豆包；单一 AudioWorklet 连续采集并自动分段识别，停止时保留尾段并立即释放麦克风。文字可修改后放入原对象版本输入框或保存为文档，不自动发送给 Agent，也不静默截断长转写。网络积压或失败会暂停采集，保留已识别文字及待处理段，允许重试或明确放弃；关闭取消请求并丢弃临时语音。窗口隐藏时停止采集并收尾已采集的语音。
- 长文自动分段连续朗读，没有 2000 字的整篇朗读限制。只合成当前段并预加载下一段，支持暂停续听、停止、语速、章节和进度跳转；进度按中心、身份、对象版本及文本指纹保存在本机，重开可恢复。暂停保留已生成音频，停止或关闭释放音频；切换应用不自动停止朗读。供应商请求仍有独立分段大小、超时和内存边界，并不一次合成整本书。
- TXT／Markdown 导入及文档存储支持百万字长文，单对象当前边界为 8 MB／200 万字符；这不是取消所有存储和请求上限。已实测 108 万字符 TXT 的完整导入、连续播放、章节跳转和刷新后恢复，长文测试用合成音频响应，不将整本书提交给供应商。EPUB 专用解析和更大文档的按需分页存储不在本次修改内。
- Electron 麦克风采用可信主窗口一次性短期授权。网页、子框架与视频请求不能继承。
- macOS 使用系统手动选区截图，保存前只本机预览；确认后保存图片与对象关联。取消不上传，不持续采集。
- **真实 TTS → ASR 回环已通过**：豆包生成约 4.2 秒中文合成音频，再由 Plan 识别接口正确返回全文，采用 200ms 音频分片；没有上传现场声音。
- 先前的 TTS 401 是接入路径错误，并非已经确认的账号权限问题。[官方 Plan 接入文档](https://www.volcengine.com/docs/82379/2516286?lang=zh)的完整正文明确要求 `/api/v3/plan/tts/unidirectional`；之前阅读器只提取了 ASR 部分，导致误用通用 TTS 路径。路径与结束帧 `data: null` 解析均已修复，现有 Key 无需更换。同时校验成功结束码，拒绝将中断流中的部分音频当作完整结果。
- **真实桌面朗读已通过**：在独立 Electron 窗口里，通过实际服务合成、播放音频，确认播放时间前进；点击停止后播放器暂停，原文档版本不变。
- **桌面语音批注已通过**：已知合成语音经 WebAudio 注入 Electron 的实际 AudioWorklet，结束采集后自动完成真实豆包识别、确认文字、保存为文档 v1 的批注全链路通过；没有创建 Agent 输入。这里不声称把真人录音上传给了供应商，真实硬件采集与释放另行验证。Chromium 的文件型假设备未产生可识别语音，测试使用显式 WebAudio 样例，不修改产品采样算法。

真实 Electron 麦克风已在新的 getUserMedia／AudioWorklet 路径重新验收：采集、停止、继续输入、关闭对话框，全部音轨均已结束。音频仅进入本机无网络测试替身，没有传给供应商，也没有创建 Agent 输入；此项不与合成样例的真实 ASR 验证混算。另已验证真实豆包可以合成实际分段长度的文档并开始播放；原生测试需要显式聚焦窗口后申请麦克风，失焦时仍然拒绝，不放宽权限条件。

截图的模拟服务测试已通过，包括在途取消、临时文件清理、拒绝并发选择及取消后重新选择。实际 macOS 验收也已通过：`npm run test:native-input -- --capture-only` 先取消在途系统选择，再由用户在系统界面选取测试区域，核对本机预览，点击保存后生成一个图片对象。确认前没有对象写入，全程没有 Agent 输入或供应商调用；保存后的图片已打开并目视检查。原生测试结果为 `captureCancellation: passed`、`capture: passed`、`noProviderCalls: true`，本次未重复采集麦克风。此前人工选区未完成的超时记录不计为成功；没有用全屏静默截图替代手动选择。

## 身份和中心连接

个人高熵连接凭据映射到 Principal／Human，中心只保存凭据和登录会话的哈希；支持退出、过期、撤销。HTTP、对象授权、通知、输入队列、Runtime 路由与工具授权使用同一身份边界。界面切换身份时卸载旧工作空间，草稿按中心／身份／窗口隔离。

中心启用身份认证后持久记录该边界。身份配置丢失时，即使重启也拒绝回退到单用户模式；旧版已有认证会话记录的数据库同样受保护。缺配置拒绝监听与跨数据库重开测试已通过。

团队模式为每个项目分配 Context，同项目成员共享 Session 与认知；不同私有项目不共用模型上下文。Runtime 的可信网关密钥只在服务端，HTTP 客户端不能自行指定 Principal。撤销后旧登录失效，尚未发送的输入不会进入模型。

真实 Runtime 双身份测试已验证三个项目 Context、共享 Session、私有模型输入隔离、撤销和重启。团队 Host 工具注册已补上显式命名空间范围；两个身份分别经真实 ExecutionJob 创建对象、落入各自项目、对方不可读取的集成测试已通过。

## 回归与本机运行

- 构建与类型检查通过；Node 测试 **70 项通过**，包含百万字分段与导入、连续采样逐样本完整性、识别重试、朗读暂停和迟到响应取消。
- 全量界面回归 **17 项通过**，另新增长转写完整保存专项已通过（共 18 项）。包含实际超过 63 秒的合成声源连续采集、108 万字符 TXT 导入与朗读恢复，以及原有登录、通知、PDF、截图、交互产物、并发冲突与窄屏布局。
- 合成录音夹具显式启动音频时钟并确认样本产生后再停止，避免偶发空录音；两项语音界面测试连续三轮、共 6 次通过。损坏录音的解码失败改为中文提示。
- Runtime Host 注册与命名空间权限测试 3 项通过，开发二进制已重新编译。
- 最新开发二进制的 `test:runtime-tools` 与 `test:runtime-identity` 全部通过。默认模型是本机确定性服务，不加载个人 `.env` 或付费模型。
- 本机 Work 中心已经先备份再更新到数据库格式 10，5 条原有输入、4 条已完成投递及 Runtime 连接保留。旧单用户草稿／偏好只向原中心迁移，保留原值，不重放待执行命令。
- 用户正在运行的 Runtime 未被替换。原有空闲 Electron 已正常关闭以定位新测试窗口，中心和历史数据未动；日常桌面已用最新界面和原生壳重新打开，确认连接原中心且 5 条对话保留。新的 Runtime API 已构建，不等于正在运行的旧 Runtime 已具备这些能力。
- 原 Work 中心已再次完成一致性备份并重启，加载 Plan TTS 修复；5 条输入和 4 条已完成投递保留。原 Runtime 的多机协调与配置未改动。
- 配套开发 Runtime 与独立中心现已启动，桌面明确连接 65424。复用既有的 gpt-6-astra 模型端点与指定凭据，不复制原数据库／会话／协调网。已在真实 Electron 窗口输入请求，经真实模型与 Host 工具创建《桌面能力验收》，随后打开核对正文、Agent 作者与 v1 版本；不是预设回复或仅前端保存。
- 独立中心重启后，1 条已完成输入与该文档仍在，没有重放投递；桌面恢复到同一对象。启动器兼容 Runtime 将模型配置拆分到 `models.toml` 的正常迁移，并在启动 Work 前核对有效模型端点。桌面与中心生命周期分离；真实 Electron 正常退出后中心仍可访问的回归已通过。未把 Electron 的 POSIX 信号退出当作可靠清理协议。
- 本次语音与长文改动已加载到独立开发中心 65424 和配套 Runtime 18089，更新前完成数据库备份；原有 1 个文档、1 条已完成输入保留。已正常退出旧桌面并用原开发配置重开，目视核对新朗读控件与中心连接，未改动日常 Runtime。
- 修复 macOS 关闭窗口后重复启动访问已销毁窗口的问题：关闭时清空窗口引用，重复启动按需恢复窗口。真实 Electron 回归验证连续两次重新唤起只恢复一个窗口，正常退出后独立中心仍可访问。

## 本轮交付结论

四个里程碑在本轮约定范围内已完成。资料与对象操作、调度协作、双身份连接、内置浏览器、交互产物、真实语音服务及 macOS 麦克风和截图均有通过记录。真实硬件采集和合成语音识别分开验证，不将测试替身或合成音频描述为真人语音实测。

本轮不包含签名安装包、商店、公开云部署、Mobile、浏览器扩展、自动外部发帖、推送代码或发布版本。
