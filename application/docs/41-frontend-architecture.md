# Morphz 前端整体架构

日期：2026-10-05 · 版本：1.19 · 状态：分阶段实施中，整体迁移尚未完成。

阶段清单更新：2026-10-05。

目标：明确共享宿主、状态、数据、组件及样式所有权，减少页面独立复制同类逻辑。保留已有共享设施、数据与授权；不推倒 Runtime／Platform，不为状态展示增加 LLM 请求，不另做 Desktop 前端。本工程设计独立于已撤回的视觉探索，不采纳其数值或审美规则。下文保留完整目标，具体生产实现及验证分别记录，不能据此宣称整体架构已迁移完成。

### 已落地的边界

| 阶段                 | 生产 owner 与消费方                                                                                                              | 工程约束与范围                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工作面解析           | `host/work-surface.ts` 的 `deriveWorkSurface`；`App.tsx` 消费只读派生值                                                          | `frontend-architecture.test.ts` 检查类型与依赖、禁止消费方重新计算 scope/key；保留原持久键、领域归属与 default/named 会话区别。提交 `10b19994`。                                           |
| 交流意图与焦点       | `host/use-exchange-controller.ts`；App 保留发送、草稿及页面组合                                                                  | `exchange-controller-boundary.test.ts` 与 controller 回归约束显隐、固定、伸缩预览和焦点恢复；不更改 Runtime 输入或权限。提交 `b1e37aa2`。                                                  |
| 导航状态与回执       | `host/use-workspace-navigation.ts` 的 state／commands／commit；`use-workspace-navigation-host.ts` 持有唯一 prefs／recency writer | 原 generation／trail 与焦点顺序保留；同身份刷新可接续已发起的导航，私有 UI、草稿与 DOM lease 仍退休。只迁已审查边界，实际 HTTP 资产与门禁证据见阶段 17；不是完整 App 拆分或原窗验收。      |
| 应用导航与实例切换   | 同一 navigation commands owner；App 的应用入口与 ApplicationHost 的启动／关闭消费 typed actions                                  | Reader／剧本库／内容／Browser／激活／普通导航及原捕获邻居迁入；同步 prepared operation 保留原 Promise、Host 等待和 busy 清理，不新增状态、存储或 effect。有限旧实现对照与实际消费门禁。    |
| 内置应用界面接线     | `host/builtin-application-adapters.tsx`；App 在原 render 中构造，ApplicationHost 消费 renderer／recent 两端口                     | Browser／Reader／ScriptStudio 的完整原 props recipe 与 recent routing 归可信组合 adapter；Host 保留实例 key、显隐、顶栏与独立 sandbox 协议。无新 hooks、writer、请求或权限，不是第三方 SDK。 |
| 应用输入准备         | `host/application-compose-preparation.ts`；App 在原 render 位置构造，builtin adapter 与 sandbox Host 借同一个命令 | 完整原剧本／对象／普通三分支及同步回执不变，借原 scoped 草稿 writer、真实 flushSync 与焦点端口；不增加 state／effect／请求，不改沙箱权限，不是第三方 SDK。 |
| 草稿生命周期         | `host/exchange-drafts.ts` 的三 state hooks／五 local commands；App 保留发送、导航与原退休 effect                                 | 原本机键、初始化位置、ref／render snapshot、逐步写入失败及 ID 保留；16 项逻辑、6 项有限 AST、4 项实际 React 挂载、31 项未改旧 Host 回归。不是新 store 或原子事务，原窗复验待解锁。         |
| 发送协议与宿主命令   | `host/submit-exchange-draft.ts` 与 `host/exchange-submission-commands.ts`；App 保留原注册与 DOM 焦点端口                         | 原四分支、Profile flush→scope→当前工作面复核、补充原身份与冻结重试字节、准备锁与 staged 反馈；有限协议、完整旧算法与实际接线门禁，不新增授权或发送入口。                                   |
| 本机输入投递与确认   | `data/local-input-delivery.ts`；Client 直接消费保存／投递、重试及刷新确认                                                        | 完整冻结载荷、身份范围、同步准备与原 Promise 顺序；storage lazy 端口、发送 refs 与身份／刷新权威仍在 Client，不建第二份 store，不重放旧输入或改请求策略。                                  |
| 共享工作区顶栏       | `shell/WorkspaceTopbar.tsx`；App 保留原三个 portal target state/ref 与语义动作                                                   | 一个原生 header、原面包屑／显隐／导航按钮与三个常驻插槽，无新包装／key／样式；固定旧 markup、实际挂载及真实 App 导入／消费门禁，不接管领域画布或路由。                                     |
| 会话历史查询         | `data/conversation-history.ts`；Client 持有唯一实例，workspace view 消费 head 策略                                               | 原 scope／缓存／分页 promise、head 复用与合并实际迁入；身份、epoch、catalogVersion、授权清理及 Boot 发布仍在 Client。固定旧实现对照及有限依赖门禁，不是全查询层或新的授权 owner。          |
| 回应等待事实         | `conversation-presentation.ts` 的 `isPendingResponse`；Conversation 与 subject Logo 消费                                         | 纯事实组合与两个旧谓词等价；输入归属、流式来源与取消策略仍由原消费方负责，不生成回复或执行事实。51 项 Node／SSR 与 31 项 Host 浏览器回归通过，原窗最终复验待解锁。                         |
| Thread 状态图形      | `ExecutionStatusIcon.tsx`；ExecutionSidebar 与 ExecutionDialog 的原外层 span 消费                                                | 七状态图形与缺省回退共用，原状态权威／标签／静态尺寸及运行波形保留，无新 DOM、effect 或请求；固定旧 oracle、实际 StrictMode 及有限门禁 7/7，原旧 Host 29/29，新合并回归 61/61。            |
| 登记图形与透明按钮   | `design/control-icons.tsx`、`ui/IconButton.tsx`；SidebarToggle、ComposerToolButtons、ExchangeControls                            | 原七图形／两 role、单 native button、原 props/ref/key/compact 焦点。13 项 Node／门禁与 5 项实际隔离挂载通过；当前契约的相关矩阵 60/60 通过，有限治理，不包含全部菜单／按钮或原窗最终验收。 |
| 交流控件样式         | `features/exchange/exchange-controls.css`；实际 main 在 visual 与 exchange-layout 之间加载 | 原完整 16 条／63 声明及唯一 runtime phase；早 phase 的 Dock 仍独立。有限 owner 门禁与完整 selected compiled flow／余流对照，不改状态、DOM、图形、材质或尺寸，不代替原窗验收。 |
| PDF 渲染样式         | `features/pdf/pdf-reading-base.css` 与 `pdf-reading-adaptive.css`；实际 main 保留两个原 phase | 完整 23 条／76 声明、双源实际加载与有限 writer 门禁；Topbar／Host 六条 packing 保留。Reader／Attachment／历史 PdfReader 消费不改；来源、编译、页面及原窗证明分别记录，不是第三方 SDK。 |
| 应用图形与 Dock 手势 | `ApplicationIcon.tsx`；`application-dock-interaction.ts` 与 `use-application-dock.ts`                                            | 图形共用身份，手势沿用既有本机固定偏好，不卸载、不启动或发送；这是用户另行要求的交互增强，不是“外观不变”迁移。提交 `21fee71a`、`33bd788b`。                                                |

输入工具的原三组状态／ref、退休 effect、early close 与完整媒体命令现归
`host/use-exchange-input-tools.ts`，真实 App 的 12 个消费 callback 已接线。
草稿／焦点／导航／授权 writer 仍借原端口，不移动注册顺序，不恢复独立
转写入口；完整旧 App／Host 树、原算法与有限实际接线门禁共同约束。
原采集／ASR、上传和目录权限不归这个 owner，原 App／硬件最终验收
仍未完成。冻结旧新页面与同一听写视觉红项的界限见阶段 18 实施记录。

主体检查器的生产状态、按工作现场的详情记忆、纯派生展示和完整语义动作现归
`host/use-subject-inspector.ts`。四组注册与记忆 layout effect 仍在 App 的原
相对位置，不新增 store、请求、偏好键或 effect；close 命令仍在 startup
return 前可用。App 借用导航 Host 的唯一 prefs writer，保留授权批注读取、实际 DOM 焦点与
导航／输入的原清理端口；SubjectSidebar、活动／目标列表、Logo 与顶栏消费
同一动作 owner。图标、原 JSX、CSS 及真实数据来源不因此迁移或更改。

这不是把所有右栏强行合并为一个领域：全局 subjectTab 与按现场记忆的
ExecutionScope、对象批注、摘要和移动端显隐保留原有区别。固定旧 Git
oracle、有限实际接线门禁和旧新编译 Host 对照分别记录在实施记录；当时
锁屏挡住原 App 复验，不能把隔离自动截图视为用户窗口验收。

交流 frame 的样式 owner 现为 `exchange-layout.css`：原 56 条规则、144 项
声明的上下文、值、权重及选定的实际编译顺序保留，统一承载画布避让、阅读／
输入排列、控制区与 Dock 外部锚点、断点和伸缩命中几何。Dock 内部显隐、
拖拽／放大、材质／运动、通知和截图生命周期仍归原 owner；不是把全部交流
CSS 归入一个大文件。`exchange-css-ownership.test.ts` 使用固定旧版本 tuple
约束这条有限边界及实际入口，不能据此宣称全产品 CSS 完成。原 App 原生
命中复验尚未完成，具体旧新资产与渲染证据见实施记录。本轮原窗已可
操作，随后遇到启动读取错误与原生退出清理卡点。10 月 4 日已在备份和
Human 明确批准后恢复同一 App，真实窗口与开关响应已检查；退出清理根因
及整体原生验收仍未完成，不再把历史锁屏或已恢复的窗口当作当前阻断。
独立 Runtime、profile、center 与数据保留。

原生弹窗表面的生产 owner 现为 `ui/dialog-surface.css`，由 main 在
workflow 与 visual-system 之间唯一导入。它承接原八条规则／十八项声明的
填充、边框、圆角、阴影、模糊及 backdrop；保留 app／非 app、create／search
及复合类名的原 fallback cascade，不只搬最后获胜的值。实际设置、项目、
执行记录、搜索、附件和剧本表单继续原生 dialog／`useModal`，没有新增 DOM
封装。该 owner 只承接材质，文字颜色仍在原 owner；公共 frame／字段控件几何由下述
`dialog-frame.css` 承接，领域变体、动效、主题与辅助模式 token 不混迁。截图
进行中的透明 backdrop 是 workflow 的显式强选择器例外，不能被普通材质盖掉。

`dialog-surface-ownership.test.ts` 按固定实际 Git `d6555b2a` tuple 约束这一
有限表面边界、原 token／混合规则余项和真实入口。门禁登记十九个现有原生
变体类，检查 shorthand／longhand、escaped／quoted／unquoted class、
is／where 及保守隐式 subject；不误把 footer／input 或伪元素内容当成表面。
这不是任意 CSS 选择器／cascade 定理，也不是全部 Button／Menu／Dialog
完成；实际旧新编译页面、辅助模式及像素证据另见阶段 25，原 App 整体验收待完成。

原生弹窗的公共 frame／字段控件 owner 现为 `ui/dialog-frame.css`，main
在 styles 与 ui 之间唯一导入。原 30 条规则／107 项有序声明完整承接：
27 条公共 recipe 与三条必要 cascade 邻居，包含原 fallback 与最终几何、
header／title／footer、共享文档草稿顶栏、字段行／控件／焦点、窄屏和粗指针。
Library／Install 顶底栏与 Connection 居中宽度保留原顺序，不把 Search
并入 create；领域宽度、primitive、token、材质、运动、DOM 与 `useModal`
不改变。这是既有控件的职责迁移，不是新设计数值或全产品 Dialog 平台。

`dialog-frame-ownership.test.ts` 治理有限 recipe、实际 runtime 入口和两个
明确邻居 writer；合法独立 feature／primitive／type／注释及无关 JSX 继续
可演进。旧 surface 门禁的两份完整几何及原反例按职责交接，原材质／token／
入口／截图保护仍保留。当前完整 React 挂载验证 16 个原生消费节点、两个
非模态负例、实际粗指针与 reduced-motion；严格历史 CSS 比较仅显式迁移
开关启用，普通 CI 不读 Git／临时目录或锁完整 renderer。单列 dormant
Library footer 探针不冒充第十七个真实消费方。完整编译、源证明、原页面
矩阵与全量结果分别见阶段 35；这仍不代表原 App 已恢复或全产品原生验收。

非模态浮层表面的 owner 现为 `ui/popup-surface.css`，main 在 ui 后
唯一导入。它承接原五 CSS 中七条规则／28 项材料声明，保留 Launcher
强选择器、非 app／复合 fallback 与 body portal 选文的原 cascade；
原组件、几何、子控件、token、动效和辅助模式不迁移或改变。
`popup-surface-ownership.test.ts` 治理这一有限表面及真实 runtime 入口，
不锁无关 feature／控件。挂载普通 CI 验证现行八场景合同；完整旧新
快照对照通过显式迁移开关执行，固定旧 CSS 来源不依赖 CI 调用 Git。
194 份 renderer 整文件未改、实际编译规则、十份完整页面与真实组件
旧新对照分别见阶段 31；这些不是原 App 或全产品样式验收。

剧本编辑十二个读取／同步 getter 及原 64／512 FIFO 缓存操作现归
`data/script-editor-reads.ts`。Client 保留原 ref 初始化与唯一身份／代次
检查，借出明确语义端口，三个原清理 seam 同步调用该 owner；构造无
I/O、effect 或订阅，公开方法无额外异步 wrapper。固定旧 oracle、真实
Client HTTP／SQLite 与有限旧新编译 Host 对照已记录；综合页面红项、
原窗验收及剩余查询 family 仍须继续，不是完整 query facade 已实现。

Reader 的原文、目录、状态、分页标注四个完整读取算法现归
`data/reader-reads.ts`，Client 直接消费，借同一身份／撤权 refs 和逻辑
transport，不新增缓存／订阅或 Boot writer。不同查询的 schema、迟到
检查及取消顺序保持；OCR、import 和写命令未混迁。固定旧 Git、实际
Client／SQLite 与旧新 Reader 页面对照及能力限制见阶段 19，尚不代表
全领域 query facade、Electron 或原 App 最终验收。

Reader 的文件导入、OCR 交互和持久阅读命令现归
`data/reader-interactions.ts`，Client 借原身份 ref、逻辑 transport 和
导入确认动作，直接公开三个完整原算法，构造不读取身份或 storage。
导入在目录确认前保留文件提交 ID；OCR 借调用方 signal、不增加超时；
阅读命令保留原指纹、12 秒请求和 4xx／408／5xx 不同的重试处理，
不套用导入的 refresh 或新增响应后 guard。原 Reader／OCR 控件、
位置队列、标注选择与目录观察仍由各自完整 feature 拥有。
阶段 38 的迁移证明、真实 Client／私有 SQL、完整旧新 Reader 页面及
最终验证另记实施记录；不将受控 OCR 回执称为物理 OCR 或原 App 验收。

个人书签的完整 list／durable command family 现归
`data/bookmark-interactions.ts`；Client 唯一同步构造并直接公开原两方法。
owner 借原 identity ref、logical transport 与 saved-input scope，构造不读取
身份／storage 或发请求。原 8 秒读取、schema、权限、载荷 hash、完整稳定
pending command、408／明确拒绝／未知失败政策保持；不新增 cache、订阅、
refresh、数据模型或模型调用。Browser／Bookmark renderer、CSS 与原 HTML
保持各自职责，Web URL 参数缺失另有独立修复，不混为 ownership 改动。

普通门禁约束两个 bounded 算法及真实值绑定／直接消费，不锁整个 Client，
身份退休只约束实际 borrowed current 的同步 null，不锁其它 owner 的清理。
固定旧源与完整 inverse 是单次迁移证据，严格行为对照显式启用；真实 Client
HTTP／私有 SQLite 和完整旧新页面结果分别见阶段 40，不冒称原 App 的
完整原生／硬件验收。

对象评论与关联的完整读取及写入叶子现归 `data/object-interactions.ts`。
Client 借原 current／platform refs 唯一同步构造，直接公开两个方法；原
dispatch 分支调用完整叶子并借同一 source、receipt 和未发送错误 class。
100 页／100 条批注、ordinal schema、游标／溢出／signal 策略和关系
独立分页保持；原 captured Objects source、历史 revision、quote、page、
返回原件 ID 及 relation receipt 均保留。身份／代次、generic command、
pending／hash／错误／refresh 权威仍归 Client，不复制存储或读写层。

普通门禁约束完整 bounded 算法与实际构造／retirement／消费，允许独立
Client state／effect／cleanup 增长，不加跨 owner inverse。固定旧实现、
真实 HTTP／私有 SQLite、全页面旧新和原 App 只读检查见阶段 43；SSR
Storage、已存 PDF 种子、受控 Runtime 与真实原窗证据各自区分。旧 UI
批注 whole-App 门禁尚须独立治理，不称整个数据层或原生验收完成。

事项的跨页资格复核、Runtime snapshot／control 与回应读取现归
`data/task-interactions.ts`，Client 直接消费三个完整原算法；按事项读取
代次、身份清理和 refresh 仍借原 Client 权威，成功投影仍 current-before-React。
各自不同的超时、迟到返回／发布和分页合同保持，不把列表与 Schedules
的 observation 策略强并。固定旧 Client、真实 HTTP／SQLite 与旧新页面
证据见阶段 21；控制请求的真实拒绝不冒称成功执行或整层查询迁移完成。

引用回跳、内容继续处理、Reader 旧兼容准备与显式意图现归
`host/exchange-reference-commands.ts`，真实 App 在原命令位置直接消费。
每 render 借原 state／Client 与命令端口，保持各自不同 guards、版本、
等待与草稿／焦点顺序；不增加状态、请求或订阅。当前 Provider 的
textQuotes、ReadingContext 和剧本域 compose 仍归原 owner，旧 Reader
兼容回调未被真实 UI 调用。完整固定旧算法／树、有限实际接线、旧新
编译页面与明确未验收边界见阶段 20，不将端口证明冒称原生验收。

阶段 55 的 Reference 当前检查跟随迁入可信 builtin adapter 的两个真实
借用端口，核 runtime factory／Host renderer／Reader 与 Script 叶子的
实际值来源与消费；原 direct、身份及完整历史反例保持。它不复制 builtin
的完整 recipe、恢复旧 App JSX 或增加跨 owner inverse。具体完整回归首红、
有限当前／历史证明、定向通过及尚未验收边界见实施记录，不据此声称整个
前端架构或第三方认知应用接入完成。

发送准入、准备锁与分支回执反馈，以及显式补充的作者检查、草稿和焦点顺序
现归 `host/exchange-submission-commands.ts`，真实 App 直接消费两个完整
原命令。原 feedback state／refs 的注册与 effects 仍在 App；每 render
仅借原事实、Client／Profile 与 writer，不新增 store 或 latest 镜像。
构造明确在 startup return 和 inspector 别名初始化之后、消费者之前，
避免原 hoisted 函数借用晚声明动作的 TDZ；DOM rAF 仍是 App 的 lazy
端口。完整旧 Git 树、原门禁基准和旧新编译页面对照见阶段 22，
不把有限 source 或受控端口证明当作真实 Runtime／原生验收。

本机消息的保存、发送中投影、冻结投递、重试和历史确认现归
`data/local-input-delivery.ts`。Client 保留原发送 Map／身份 refs、其注册
位置、共享 scope、非输入命令和刷新权威；构造不访问 storage 或发请求。
同步 record 准备直接返回原 submit Promise，公开重试也是直接方法别名；
发布时另外读取最新本机记录，仅同 ID、principal、actant 的真实历史项
能够确认移除。原异常边界、身份切换和微任务顺序保持，不增加自动重放、
轮询、缓存或权限。固定原 Client 全字节逆展开、真实 HTTP／SQLite 与
相同编译页面的旧新对照见阶段 23；不冒称原 App 或全命令层完成。

执行 snapshot／result、精确控制、输入取消与共享审批尝试记录现归
`data/execution-interactions.ts`，Client 唯一构造并直接公开五原方法。
原审批 Set／反馈 state 与 current 注册位置、身份和 refresh 权威不移；
构造没有读取、订阅或请求。两个审批 surface 沿同一 ledger 保持失败后的
重复提交保护，原指纹／身份 key、超时、schema 和刷新顺序不改；页面
observation、busy、焦点与展示仍各属原 owner。完整旧 Client 字节对照、
实际 HTTP 拒绝及旧新编译页面证据见阶段 24，不视为完整执行 presentation、
真实批准成功或原 App 验收。

执行详情的完整 UI 生命周期现归
`features/execution/useExecutionInspection.ts`，既有 `ExecutionDialog`
直接消费六个事实与三个动作。它借原 Client、scope、dialog ref 和
embedded 值，持有原局部状态、读取观察、模态注册、scope 退休、
完整 control／readResult 以及当前 render 的成果链接投影。原第一个
dialog ref 与整棵 DOM、Job／Thread 展示、审批禁用和打开／关闭动作
仍归 renderer；三条原真实挂载路径不改。

这是完整 feature controller，不是查询 broker、第二份授权／审批
ledger 或新的状态机。原捕获 scope 与最新 API 的区别、控制 finally
只在当前范围清 busy 后不等待刷新、结果读取不刷新、同 key 离线保留
投影等语义不归一化；原 action、期限、身份与刷新权威仍在 Client／
data owner。完整原算法、17 个展平注册／依赖与实际 React 阶段分别
验证，静态注册数不冒充运行时 hook 计数。原 CSS、动效、请求和
模型调用不新增或改变。

有限门禁只治理该生命周期、同步声明、实际参数符号与直接消费，
不锁 App／Client 或完整 renderer；合法无关 JSX、CSS、pure 增量及
真实 import alias 继续允许。完整旧源逆证明只属独立迁移证据，
严格旧新挂载比较通过显式 migration 开关运行，普通 CI 验证当前契约。
编译页面、源证明、受控 Client 挂载与全量检查见阶段 33；这些不代表
Runtime 执行、真实授权成功、全部查询治理或原 App 验收。

既有 Thread 图形门禁仍检查原状态、heading／span 树和真实图形消费；
不再把详情的原 hook 物理位置锁在 renderer。原完整 hook 摘要由固定
历史档案另证，scope 退休的原指定负例由实际 inspection owner 门禁
承接，不能以职责迁移为由删除行为约束。

Thread collection 的两种完整展示投影现归既有 `execution-activity.ts`。
`Conversation` 直接消费 `inputExecutionActivityPresentation`，以原输入、
Runtime 和短路读取的 online 值决定关联分支与原 running／unknown／paused
优先级。`ExecutionSidebar` 直接消费 `executionActivityOverview`，沿原
授权范围、实际父子关系与日期分组，返回活动根、近期分组、根计数和
读取质量；完成父项有未完成子项时仍归进行中，不用 Thread 数冒充活动数。

范围概览的计数文案由 `executionActivityOverviewSummary` 在原
`threadSummary` 之后消费，保留两阶段读取顺序。不可用、截断但零计数
仍显示待核对；截断正计数只称“至少”。两种用途的状态优先级、可用性
与范围不能强并成另一套统一 enum，当前输入目标、steer、审批控制和
原 JSX／CSS／图形／动效均未迁移。owner 不引入 React、Client、IO、
订阅或模型请求。源证明与完整旧新编译页面见阶段 34；普通 CI 的有限
消费约束与真实组件行为验证另记实施记录，不冒充原 App 验收。

`thread-collection-presentation-boundary.test.ts` 约束这三个完整纯入口、
真实 core 类型借用、原 scope／family／质量算法及两个真实消费方；
合法无关 JSX／CSS、value／type import alias 和 pure 增量仍可演进。
当前完整 React／SSR 消费合同默认执行，固定旧 collection recipe 的
严格对照以显式 migration 开关执行。原源码 hash／批准逆展开仅留作
独立历史证据，不为普通 CI 增加整文件锁或跨 owner inverse。

交流读取的共享纯投影现归 `conversation-read.ts`；提示与历史的不同范围、
消息数组引用合同及原回执排序仍由真实消费方显式指定。已读初始化、稳定
acknowledgement 与两个提交 effects 归 `host/use-exchange-read-receipts.ts`，
App 保留原身份范围的唯一存储端口与失败提示。默认实际 React 挂载覆盖
状态／存储／可见阅读生命周期；原生前后台激活另有显式能力测试，当前
根环境尚未通过，不把浏览器模拟或隔离 Host 对照算成原 App 验收。
这不是新的订阅、镜像状态、默认回复事实或统一查询 broker。

Human 手写文档／项目创建的完整生产 feature 现归
`features/creation/CreateDialog.tsx`，App 的两个原消费点直接导入该组件。
草稿捕获／恢复／持久化、提交与 busy、错误、成功清稿、卸载后的回执、
文档顶栏 portal 及项目原生弹窗均由这个稳定的 module-scope 组件持有；
创建选择、项目／对象导航和 Host prepared continuation 仍归宿主。
原七个 props、十个注册、document key／project 无 key、原存储 scope
及完整 submit 顺序不改，Client 依赖只用原 execute 方法的 type-only Pick。
没有第二份草稿 owner、store、wrapper DOM、样式、查询、请求或授权。
完整固定旧函数／真实新组件挂载、actual Git 源证明、编译页面及全量
检查分别见阶段 28；受控 Client 挂载不冒称真实事务或原 App 验收。

对象批注的完整读取／取消生命周期、原 ID 投影和整棵展示树现归
`features/content/ObjectAnnotations.tsx`，真实 App 在原注册／展示位置
消费 `useObjectAnnotations`、`objectAnnotationItems` 和
`ObjectAnnotationsPanel`。原两 state、五依赖 effect 和稳定 React
刷新 setter 保留；隐藏面板不退休状态，成功回执仍借该 setter。
Client 保留原身份、分页与授权读取入口，SubjectInspector 保留显隐，
InspectorPanel 保留宽度、焦点及 Escape 权威。作者名称借当前 render
state 的窄函数，没有 latest 镜像、额外 store、查询或请求。
原完整 DOM／CSS、历史版本标记与原始文本展示不改；只有原作者和
focus 表达式的显式参数映射。具体生产接线、有限门禁、实际挂载与
完整旧新页面证据分开记录于阶段 29，不代表原 App 已恢复或整体验收。

搜索选文、现件选区和逐段评论的草稿准备、评论焦点与引用 reveal 生命周期
现由同一 `host/exchange-reference-commands.ts` 拥有。App 原位注册 state
与退休 effect，并直接把四个返回方法交给 SearchDocuments、ArtifactEditor
与 TextQuoteProvider；既有四个回访／准备方法逐字保留。搜索沿原捕获草稿、
generation 和条件焦点，现件选区只清理原字段，评论沿原 functional update
与 preventScroll 焦点，不能因共用 owner 而归一化这些不同合同。
scope、草稿、权限、导航与实际 DOM writer 仍归原宿主；SearchDocuments、
TextQuoteProvider、SelectionActions、Reader 与现件编辑仍是各自的完整组件。
不新增 store、缓存、查询、请求、DOM、CSS 或模型调用。完整 Git 源证明、
旧新编译页面与隔离挂载分别见阶段 30；原 App 和原生验收仍未完成。

阶段 44 将这个 owner 的普通当前门禁与历史迁移证明分开。当前直接核
实际 module／runtime phase／symbol 来源、捕获端口、注册相对阶段与
八命令实际消费，不锁整个 App／owner 或全局 React 数量。独立有 JSX
消费的 React 增长及合法别名可演进；固定旧全文／二十六原反例和旧
inverse API 仅作为明确历史合同保留，不暗改成另一种语义。四个同名
但错误实际来源的误接受反例已由根独立复现并修正。其它旧页面／owner
的全文门禁与 inverse 链尚未整体治理，不能由本阶段宣称全部完成。

阶段 45 将导航的普通当前工程合同与旧整体树证明分开。当前直接核
actual App／Host 的真实值来源、身份／权限／lifetime、原 prepared
operation 与稳定消费，而非锁整件 App／Host 或调用其它 owner 的
inverse。actual Git 十份独立档案保留原十四测试组、一百零四反例与
cb 全文 metrics；九十三项交接当前，十一项无关全文增长限制仅历史。
独立且实际消费的 React feature 与合法真实别名继续可演进；镜像、
生命周期副作用和同名错误模块仍拒绝。两个旧 helper 默认合同不变，
新 current verifier 独立命名；其它 peer 的 inverse 债务未由此消失。
根三文件 32/32 与严格类型、实际 Git 和来源探针通过，范围是有限源码
合同，不是整页／原 App／Runtime 证明；R5 共同旧 iframe 红项单列。

授权内容读取的六个完整算法现归 `data/content-reads.ts`：目录分页／计数、
当前理解、目录记忆、原件与确切目录项解析。Client 借出原 refs，保留身份／
撤权清理、refresh 和同步 current-before-React 发布权威；剧本读取使用同一
remember 消费，没有第二份算法、构造请求或额外 await。固定旧算法与真实
Client HTTP／SQLite 的迟到、版本及授权合同通过。旧新页面最初各 6/8 的
相同旧入口／定位失败证据保留；按明确撤下入口与现行精确输入关联校准
两项测试后，同三份原页面用例各 8/8，原数据、版本、草稿及无发送断言
仍在，实际 HTTP 资产逐例核 SHA。该对照冻结在新导航接线前，不把这一
family 或局部回归说成全查询层、原 App 或整体验收。

授权目录记忆随后修复了一个旧正确性缺口：确认剧本目录时同步发布同一
有界 cache 的 scriptLibrary，Client 持有 current-before-React writer；旧
刷新若撞上更晚确认的 value，通过原 drain 重读。刷新最终权限／版本与
epoch／范围守门先于确认写入。非 head 剧本确认引用不成为 recency、偏好
或权限；按活跃打开优先和原 200 项共享读取预算保留最新确认引用，等值
冷剧本再次确认也沿原 150 项 cache 上限保留原件。独立真实版本／撤权／
并发与容量红绿证据、旧新编译页面及全量 Node 检查已通过；原窗验收仍未
完成，具体通过／能力跳过及两轮完整门禁证据见实施记录。
该修复单独记录，不把修复前后的行为差异说成纯架构等价，也不改列表排序。

当前 Task batch、目录分页和 Profile 已有真实共享 owner；Schedules 与 TaskList
的 deadline／重试／取消及 Boot 发布合同不同，不新增一层 broker 强并。
完整 query facade 目标需要按合同与实际请求测量推进，不等于每个页面都重造
读取缓存。Thread 图形共享也不改变 Task／Job／消息 delivery 的独立语义。

非输入操作的完整 durable delivery 现归 `data/operation-delivery.ts`。
它只借原 current／platform refs、local input 的 record 方法、域分发与
刷新端口；构造无副作用，Client 原位直接交付 execute 引用。唯一 Unsent
constructor、可能已提交的错误分类、完整 pending 身份／实例与存储、
发送、清理、刷新及异常顺序不改；record-input 仍同步交接原五参数。
域分发、授权、protected projection 退休与刷新权威仍归 Client，不新增
锁、镜像、broker、轮询或 UI。根当前 28/28、明确旧新 6/6、类型／构建
与完整实际 Git 来源核对通过；原完整页面对比仍有双方共同的旧 iframe
红项。有限门禁核真实来源，迁移全文证明不锁普通当前 CI；此阶段不
等同 Runtime、原 App 或整体完成，具体证据与边界见阶段 46。

发送协议与共享顶栏阶段已提交 `d45cf84d`。补充重试的原命令匹配修复另以
`28cecd4a` 提交：`local-saved-inputs.ts` 仅在双方 supplement 时认可候选省略
原已保存 parallel 标记，
严格全字段比较后返回原 operation；不更改首发默认、权限、发送入口或 UI。
该修复不是新持久化格式或整层 query facade。此前项目新增／关联及权限
失效红项由后续阶段分别复现、修复和复验；历史失败报告保留，不追写为成功。
完整前端工程及原 App 最终验收不能据局部页面矩阵称为完成。

导航生命周期的唯一宿主现为 `host/use-workspace-navigation-host.ts`。
它只保留 center／principal／CSRF 三个身份原语，沿用原 preferences、recency
与 navigation 注册，不缓存 Boot、正文、草稿、授权目录或 pending 请求。
同一登录身份的保护投影清空会卸载完整私有工作树，Host 不因此退休；登出、
身份／CSRF 更换或 Host 卸载则退休。两个零 DOM sibling 在真实布局提交时
分别启用 Host 和 private origin，不能在 render 中修改 active 代次。

已发起导航的 continuation 必须检查当前授权目的地与实例／对象版本，并在
函数 updater 执行时重新检查 lease。旧 private 的草稿、焦点、弹窗与提示回调
不能移接到新树。项目新建回执只允许接续原 default-conversation 位置，
不自动建 Session、带走另一份草稿或伪造完成。普通切页也不能取消已选择的
图片创建；它只阻止迟到结果抢回导航，真实命令仍由 Client／服务核权限。
这批的自动证明、明确测试校准与原 App 未完成验收边界见实施记录，不增加视觉规范。

完整对话阅读视口生命周期现归 `features/exchange/useConversationViewport.ts`。
state／commit 两 hook 在原渲染时点登记，私有 Symbol 承接内部 refs／writers；
renderer 只消费两个 DOM refs、三个展示 facts 和三个语义动作。原位置 Map／
工作面 key 留宿主，timeline／范围筛选／receipt 计算／取消留 Conversation；
真实历史查询与授权／发布不移交给视口。恢复、跟随、前插、可见已读、引用补读／
定位及焦点交接完整迁移，不增加 state、effect、轮询或 LLM 请求。
阶段 36 的固定旧源、有限当前所有权、完整 mounted 与原页面对照分别证明，
不能将它们等同原 App、OS 焦点／硬件验收或全产品迁移完成。

完整事项执行面板 controller 现归 `features/tasks/useTaskRunPanel.tsx`。
它拥有原 scoped 两观察、六 states／两 refs、完整操作及菜单 recipe；
renderer 只直接消费十八 facts／recipe 和五语义动作。详情独立观察与
清单父层批量观察不合并，Client／core／数据发布权威不迁入 controller。
读取借最新 API，已发动作及随后刷新捕获原 Client；原 null、去重、资格、
错误与焦点／检查器组合保留，不增加 scope reset、请求或轮询。阶段 37 的
旧新页面和完整挂载证据不替代实际 Runtime、原 App 或整体迁移完成。

完整剧本工作室生命周期现归 `features/script/useScriptStudioWorkspace.ts`。
它拥有原 70 个前置语句、40 次注册和 18 个完整命名动作，renderer 在原位置
直接消费 59 个只读事实／refs／命令；原四表单及行级组合仍归 renderer。
原读取顺序、Client 捕获、偏好与焦点、错误及原生导出交接不变；不新增
状态、存储、请求、权限或模型调用。阶段 39 的旧新完整页面、有限当前门禁及
完整真实组件挂载分别提供证据，不替代原 App 或真实 native 端口验收。

详细测试、原 App 验收与尚未验证的边界见[实施记录](./13-implementation-status.md)。上述提交只证明对应阶段，尚未替代下文所有目标；剩余数据／样式职责、有限测试治理及全产品验收按第 8 节清单继续。本文未规定新的图标尺寸、间距、色彩或动效审美标准。

## 1. 当前事实及需要解决的组织问题

审计基线：生产 HEAD `0f864e9e`，2026-10-03；另有无关未提交工作，本提案不触碰它。以下是源码审计，不是本轮原窗口验收。

| 已有共享基础    | 当前实现                                                       | 继续使用                                            |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| 同一 React UI   | `apps/web/src/main.tsx`                                        | Web／Desktop 共享领域及呈现逻辑                     |
| 逻辑业务接口    | `application-transport.ts`；Desktop 受限 IPC／Web HTTP         | 身份代次、取消、旧响应抑制；Desktop 不依赖本地 HTTP |
| 共享 Session 流 | `useConversationStream.ts`、`conversation-read.ts`             | 正式历史＋实时前缀，同范围共享、重连去重            |
| 事件失效读取    | `useObservedRead.ts`、`observed-read.ts`、workspace changes    | 事件驱动、有界读取；失败退避不是周期轮询            |
| 本机偏好和草稿  | `local-preferences.ts`、`composer-drafts.ts`、`interaction.ts` | 身份／中心／窗口及工作面范围；旧键与请求 ID 保留    |
| UI 基础         | `useModal.ts`、`NavigationIcon`、`SafeMarkdown`、共享 tokens   | 复用而不是为新体系再做另一份                        |

不是“完全没有架构”。欠缺是明确所有权与依赖规则：

- `App.tsx` 约 4,639 行同时负责导航、Session、草稿、发送、steer、对象关联、布局、弹层和页面组合；`client.ts` 同时聚合快照及操作。
- ScriptStudio／内容目录／App 对选择与持久化有镜像；部分页面各自手写读取生命周期。局部筛选合法，但共享选择的优先级不够集中。
- 消息、主体、活动、工具、事项各自决定状态优先级及文案。不同领域需要不同语义，不应压成同一个 `isRunning`，但映射规则需要可追溯的统一入口。
- `styles.css`、`visual-system.css`、`composer-compact.css`共同修改交流几何。视觉层注释说只管材质，实际却决定定位与断点；结果依赖加载顺序与选择器权重。

## 2. 架构边界与依赖

采用六个职责层，先迁移所有权，不为搬文件而拆分。下列模块名与目录均为提案，并非当前已存在接口。

| 层                 | 职责                                        | 允许依赖                                                 | 不允许                                        |
| ------------------ | ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| design foundations | token、图形登记、运动策略、密度／材质       | 纯静态定义及宿主辅助偏好映射                             | Runtime、业务 API、领域页面                   |
| UI primitives      | 可访问控件、Surface、overlay／focus 基础    | foundations、React、图标库                               | 查询任务、读数据库、生成状态 prose            |
| presentation       | 五类事实的只读展示模型                      | core 类型、纯格式化／映射                                | 网络、写命令、页面偏好或 JSX                  |
| data access        | typed query、命令 gateway、订阅、缓存／恢复 | 现有 client／transport、core                             | 组件 DOM、页面持久化、主题                    |
| host controllers   | 工作面解析、导航、交流／草稿编排            | data、presentation、scoped persistence                   | 领域样式、直接 HTTP／IPC、复制权限数据库      |
| features + shell   | 领域画布、主体面板与窗口组合                | controllers、presentation、data query facade、primitives | 跨 feature 内部导入；绕过 gateway；写宿主路由 |

Shell 负责组合和几何，feature 负责领域内容。共享业务权威仍在 Platform，执行权威仍在 Runtime；renderer 只持有有范围的读取投影与 UI 状态。

上表是本工程的目标职责和依赖，不依赖已撤回视觉探索中的原型图，也不表示代码已按层拆完。具体已迁移 owner 以阶段清单和生产入口为准。

### 2.1 建议目录（逐批迁移，不预建空骨架）

```text
apps/web/src/
  design/         tokens、icon registry、motion policy
  ui/             Button、IconButton、Surface、Menu、Dialog
  data/           observations、queries、commands、transport adapter
  presentation/   input、thread、job、approval、task 的纯映射
  host/           WorkSurface、Navigation、Exchange controllers
  shell/          WindowShell、Navigation、Canvas、SubjectSlot
  features/
    exchange/     Composer、Conversation、引用／输入反馈
    subject/      activity、authorization、schedules、profile
    tasks/        列表／板／详情，Task-specific 操作
    content/      目录、预览、对象与版本
    applications/ 安装／打开实例、领域工作画布
```

不增加新公开 Runtime 协议、第三方应用 SDK 或另一套数据库。第三方 sandbox／browser guest 继续既有协议和权限隔离，不把宿主 React controller 注入它们。

### 2.2 认知应用与 Morphz 本体

同仓库／同发行包的内置应用不等于共享业务所有权。Morphz 拥有窗口、工作面、
实例与生命周期、共享输入和授权；认知应用拥有自己的领域数据、操作与画布。
应用 UI 应是领域能力的可选入口，Agent 不应靠模拟点击才能访问该能力；这条
目标不意味着当前实验 UI 包已实现完整的无界面第三方认知应用定义。

阶段 54 的 `builtin-application-adapters` 是可信内部组合层，不是状态
controller 或权限 gateway。它只借原 render 捕获的 Client／语义端口，
返回原真实组件；Reader／Browser／ScriptStudio 继续拥有自己的生命周期。
通用 ApplicationHost 不再 import 这三个专业组件或携带其专用 props。
App 保留原草稿／导航／焦点权威；阶段 56 将完整原 compose 算法交给
`application-compose-preparation`，在原 render 位置借原端口构造，并将
同一个同步准备命令提供给内置 adapter 和 sandbox 消费方。它不新增
状态、effect、请求、注册、存储或执行入口；对象分支的实际 flushSync 回执
与普通／剧本分支的原排队发布区别保留，不把准备草稿等同于发送输入。

第三方 UI 继续通过现有 opaque-origin iframe 与受限消息桥接入，不获得该
内部 factory、完整 WorkspaceClient、React controller、Node／native ports
或凭据。可信 BrowserHost 与它承载的不可信网页也属于不同信任范围。
共享的是实例／版本／工作面及动作语义，不是把所有应用强行换成同一个 renderer。

当前 `morphz-app/v1` manifest 的 `ui` 必填，它是实验的界面安装包，不是完整
认知应用定义。已有界面安装／启动与受限桥；安装并不自动注册第三方业务服务、
Tool／Harness 或数据权威。公开的薄型 author SDK、完整的领域接入与可选 GUI
合同仍未交付，不能把内部源码类型和手写 postMessage 示例当作已稳定的外部 SDK。
实际 `record-input` 应用激活仍只解析四个内置 manifest 与已注册领域实例；
第三方界面包声明 Harness 不等于已经打通自身身份的业务／执行接入。
这轮保留原协议／权限，不借前端重构扩充第三方能力。

## 3. 状态所有权：不是把所有东西放进一个全局 store

| 状态种类       | 权威或 owner                            | 生命周期与持久化                                   |
| -------------- | --------------------------------------- | -------------------------------------------------- |
| 领域事实       | Runtime／Platform／认知应用对象存储     | 真实版本、权限、事务与回执；renderer 不持久化副本  |
| 可重建读取投影 | 有 scope 的 data observation            | 内存、可失效、可重建；身份变化立即撤下不再授权内容 |
| 宿主工作面 UI  | WorkSurface／Navigation／Exchange owner | 明确路由与现有本机偏好；不改变执行 scope           |
| 未发送草稿     | scoped Draft adapter                    | 原中心／身份／窗口／工作面持久化；未发送不交 Agent |
| 临时局部状态   | 页面或控件                              | 过滤、折叠、拖拽、弹层及局部选区可保留本地         |

原则：能从事实或现有 state 推导的值不另存；两个布尔值会产生矛盾就用受约束的状态模型；共享只因存在共同 owner，不因“全局比较方便”。[React 状态结构原则](https://react.dev/learn/choosing-the-state-structure)。本产品的具体分层与持久 scope 是自己的架构决定。

### 3.1 WorkSurfaceContext

由一个宿主 resolver 提供只读值：身份／中心代次、导航位置、内容实际 owner、conversation/session、应用实例／版本、对象／引用版本、draftKey、exchangeKey。它们必须分开命名，不提供含义模糊的 `currentContext` 或 `activeScope` 给业务命令猜测。

MUST：显式项目点击走默认连续会话；命名会话保持隔离；应用切换不新建 Session。领域页面只能请求 typed navigation 或 compose intent；不得自行设置全局 Session、草稿 key、审批策略或实际执行 owner。写命令仍按真实发起 input 的持久来源校验，不信任此 UI context 作为授权。

### 3.2 ExchangeController

负责输入四态、固定／自动收起、draft／引用恢复、首发、重试、明确 steer 与发送后状态。实际职责可拆成纯 reducer、draft adapter、command orchestration，而非换一个巨型 class 或 Context。

- `FOCUS_INPUT` 不改变已关闭的历史；只有显式查看、已约定发送等事件改变记录状态。
- 隐藏／焦点／菜单本身仅产生 UI 转移；应用切换不 record-input、不建 Session、不启动／取消执行。显式应用打开／关闭及实例视图状态可继续走原 typed 持久命令；原生选择器暂停自动收起但不暂停任务。
- 发送原子冻结载荷、授权引用、model/effort 和 command ID；消费发送正文不清除用户持续选择的模型／effort。
- 模型／effort 保存在原有草稿选择范围，影响下一条新输入；UI“仅下一次发送”的业务效果不意味着发送后将选择抹回默认。审批策略则是实际 Runtime Session 持续设置，不能一起存成本机开关。
- 首个有效 named conversation 输入原子落库；响应未知保留同 ID，不能先建空会话或换 ID 重发。
- 定向补充使用原 input／root／thread／generation，沿用原模型及权限，不受当前页面选择影响。
- 迟到结果只更新原命令及原范围，不清新草稿、不覆盖新导航、不抢展开。

SHOULD：专业应用编辑草稿留领域 owner；Exchange draft adapter 不管理章节正文、浏览器表单或 PDF 页面。领域 `compose` 只准备引用／意图，不自动发送。

首段草稿生产迁移：`host/exchange-drafts.ts` 只拥有原输入、新命名会话、
丢弃会话的三份本机记录及五个生命周期命令。三个 state hook 分开保留 App
初始化顺序，不注册新 effect；权威会话集合退休草稿的 effect 仍在原位置。
App 继续决定发送中 guard、实际已保存输入是否构成草稿、听写打断、成功后导航
与发送冻结载荷。创建读取当前 ref，丢弃／恢复保持原 render snapshot；不会
为了“统一”全部改成 latest。原多步 localStorage 写入不是事务，失败前缀与
提示仍按原合同保留，不借迁移增加数据库、键、回滚、网络或 LLM 请求。

发送协议编排现由 `submitExchangeDraft` 实际拥有。它接受一次 render 的有限事实、
原浅 captured 对象及语义端口，按原顺序检查阅读／目录／选区／附件，再执行
定向补充、事项结果、批注或普通输入中的一个分支。普通输入等待 Profile 保存、
复核身份及当前工作面后才构造载荷；补充使用原请求的来源及旧 pending operation，
先保留同 command ID／字节再走原 Client。不会读取当前页面参数重新绑定旧工作。

Client 仍拥有 typed gateway、实际授权、outbox、首次会话事务与投递幂等；
`exchange-submission-commands` 拥有准备锁操作、原 key 的 functional 草稿
消费、错误分类和 staged 迟到失败保护，App 保留原 state／ref 注册、writer、
界面及 DOM 焦点端口。receipt／rejected／settled 在原 execute continuation 内同步调用，
不是返回后再 await 清理；本机保存回执不冒充已执行成功。阅读类型迁到纯
`reading-context-model.ts`，原组件继续 re-export；交流／发送命令层不导入领域 JSX。
这不是已完成全部 Exchange，也没有新全局 store、重试循环或额外模型请求。

### 3.3 NavigationController

统一导航意图、打开成功回执、返回现场及 generation 竞争。实例恢复与显式打开内容分开；全局目录与项目目录不创建 Session；来源版本引用与 live head 不混用。

首段生产迁移已落地：`useWorkspaceNavigationState` 只拥有原状态／ref，无 effects；
`createWorkspaceNavigationCommands` 是无构造副作用的 render-local 命令闭包；
`useWorkspaceNavigationCommit` 在原 trail／快捷键位置注册原 effects。
同一 generation 仍由 exchange 与 ApplicationHost 消费；阶段 17 将原 prefs writer
与 recency／导航注册移入同身份稳定 Host，App 借用窄端口；
不通过整个 setter bag、latest 快照或新增 store 镜像宿主。偏好 patch 与返回的
raw spread 语义分开。`workspace-navigation-boundary.test.ts` 约束这条真实 seam，
`workspace-navigation.test.ts` 验证原回执／错误／历史契约，不覆盖所有 App 业务入口。

应用入口现继续迁入这同一 owner，而不是新建第二个 navigation hook。App 的
Reader 书库、剧本库、内容、Browser、激活及普通导航使用已有 owner；Host 的
启动／关闭接受 typed `ApplicationNavigationActions`。它同步准备原 execute
Promise 与同步 commit，Host 在原 await continuation 内激活／报错并清 busy，
不插入异步 wrapper。Host 仍持有原本地启动锁及捕获实例列表，关闭顺序仍是
下一项、上一项、null；实例命令仍由原 Client 校验授权及版本。

统一 owner 不统一旧分支策略：Dock 新建 intent，Launcher 使用 render 捕获的
generation；Reader 清空后激活仍读取当时 current generation；Browser 保留
捕获 `client.boot` 查询及第二次 await 后原来没有额外 guard 的行为。迟到语义
修正应另做显式行为变更，不能混在外观／交互不变迁移里。
阶段 26 已将原 `openUser`／`openReading` 的两个完整授权读取／意图算法
迁入同一 owner，App 直接消费返回方法；保留原 render 捕获、十个构造
端口及注册位置，只做五个绑定映射。独立固定原算法和整文件逆迁移、
同修复旧新编译页面与全量检查通过；不代表项目范围及全部页面导航组合
已经迁完。相关剧本目录同步缺陷单独修复、单独提交，不删除原授权守门。
固定旧 `cb7246a2` 八函数作为独立测试 oracle；有限 AST 门禁核对实际 App／Host
消费、旧 JSX／effects 和原等待结构，不代替真实浏览器或原 App 验收。

项目／会话的私有范围政策现归 `host/private-project-conversation-scope.ts`，
不是另一个全局导航或查询 broker。它拥有原七动作、两个纯事实投影，以及
分别原位注册的 content scope state、已提交草稿退休与会话历史选择 effects。
真实侧栏／目录／引用／创建回执共用直接方法；唯一 action factory 不在
构造时读取 ref、authority 或 storage。原草稿、导航及权限 writer 保持已有
责任，不迁入 identity-stable Host；Launcher 保留 raw setter 的原不同语义。
项目默认／命名／未提交与已启动的区别、同项目对象保留的双重判断、创建
迟到回执的原 continuation 均不归一化。旧新普通编译的原页面和实际 React
生命周期证据见阶段 27；手写创建、批注与搜索引用随后分别迁入阶段
28／29／30 的生产 owner。其他 page／overlay 责任及原窗验收仍须继续，
不能据这条 scope 边界声称 App 已整体拆完。

页面局部选择如果要持久化，声明唯一 owner 和恢复顺序，例如显式新 navigation intent → 对象确切引用 → 既有持久视图；不能 App、实例状态、localStorage 三处互相回写。迁移前需逐个确认当前优先顺序，不使用新 key 默认覆盖旧用户偏好。

## 4. 事件、查询与写操作

### 4.1 一个访问入口，不是一个全局全量快照

现有 logical ApplicationMethod、身份代次及 HTTP／IPC adapter 保留。逐页把重复 effects 收敛到 resource-keyed observed query，稳定 key 包含中心、principal／身份代次、实际资源 scope、query 语义参数及显式选定的对象版本。每次读取的 request epoch／取消代次单独保存，用于迟到守门，不加入 key 破坏共享；不同授权范围不能因为对象 ID 相同而共享结果。

MUST：

- 同 key 共享读取及订阅，生命周期有清理；不同 key 或身份必须重新核对权限。
- 事件是失效提示，不是权限、业务结果或持久成功回执；提示后读取权威版本，再发布投影。
- 旧代次／乱序响应不能覆盖新选择，撤权不能继续用之前缓存内容填页面。
- 读取有界，分页／局部历史携带完整性信息；不存在数据与不可读必须区分。
- 写操作由 typed commands 经过现有服务边界，携带 expected revision、稳定 command identity 与真实来源。UI pending 是临时反馈，未知回执不擅自重试。
- Web 与 Desktop 共用语义，Desktop 经受限桥；不直接开放任意 Node、SQL 或本地 HTTP。

首阶段复用现有粗粒度 workspaceChangeRevision，不为视觉整齐先新增事件协议。进一步的 domain／resource 失效需要平台契约及测量：当前确有扇出，不能把“已有推送”误称最优查询粒度。

2026-10-04 查询候选核验：TaskList 与 SubjectSchedules 可读取同一 task ID，
但前者的 12s deadline／失败 retry／workspace 失效／Boot 发布，与后者一次性、
无 deadline／retry 的局部读取不是相同 observation 合同。隔离实际消费者的
两种自然路径均 2 GET，一例仅约 0.3ms browser pending 重叠，另一例无重叠；
未实证候选 2→1。事项资格与连接呈现受控、实际快照 run0，不能据此宣称真实
Runtime 工作收益。285 行 pending helper 保持 `/tmp` 隔离，未加入生产；
无状态 raw wrapper 也不冒充共享 facade。其他目录／审阅的过滤及范围不同，
文稿默认历史读取为顺序且含 live metadata。既有共享对话流与剧本概览仍复用；
后续共享迁移必须先证明同语义与实际收益，本次审计不等于查询层目标完成。

会话历史的生产 owner 现为 `data/conversation-history.ts`。它统一拥有选定范围、
可撤下的内存缓存、单一分页 promise、head 复用和 timeline 合并；Client 使用
同一实例实际接入范围选择、加载更早、引用回溯、refresh 提交和授权清理，
workspace view 仍解析真实授权范围并通过该模块决定 head。既有 export 保留
为兼容 re-export，不保留第二套算法或状态。收益是完整查询生命周期的唯一
所有权与可验证合同，不声称减少原网络请求或已实现全局 query facade。

该 owner 不导入 React、UI、storage 或 transport，也不自行订阅／发布 Boot、
读取身份或开启轮询。连接及刷新通过有限 typed ports 提供；Client 仍检查
身份、epoch、原 scope 对象、catalogVersion 和最终 navigation revision。
原授权／切换中心的清理调用同步清投影，但不取消或重置原在途分页 promise；
迟到页面由原 cache 对象及身份／scope 检查拒绝。不能借此保留撤权内容。

缓存命中同步返回原对象，不能因抽 helper 增加一次 await；新 head 仍沿原
异步序列读取。单次加载最多跨四个不可见窗口，共用 15s；显式引用回溯最多
200 页，每页独立 15s。后者不新增等待 workspace refresh，前者仍先等待；
游标检查在 stale 检查前、部分提交及原错误文案均保留。固定 `9ea571d0`
旧算法为对照，新增 18 项逻辑测试；有限 AST 门禁拒绝已列出的直接副作用、
依赖与无类型合同，不是安全沙箱或对整个前端的完整依赖治理。

### 4.2 恢复与刷新

正常空闲不周期读库。首次读取、真实变更、显式刷新、重连／唤醒校准触发有界读取；断线失败可用取消及有上限退避，成功后停止。搜索 debounce、本地日期更新和业务已有确切定时需求与盲目轮询不同，不能一刀切禁 `setTimeout`。

Session 流负责实时前缀；workspace change 负责持久事实失效；两者不能互相冒充。token delta 不触发活动全量读取。重连按序号和实际持久来源校准，缺少前缀不能拼接假完整正文。

## 5. Presentation：一套规则，五种权威

不要建立新的客户端 Activity 状态机。保留 Runtime Thread 生命周期，抽出纯、可测试的展示映射，并统一每个领域自身的优先级；不是把五类事实压成 `running/completed` 一个 enum。

| 模型                 | 权威输入                                    | 输出职责                                       |
| -------------------- | ------------------------------------------- | ---------------------------------------------- |
| InputPresentation    | input delivery／steer receipt               | 本机待发、接收、等待回复、失败；送达不等于采用 |
| ThreadPresentation   | fresh Thread lifecycle／phase／controlState | 活动运行、等待、暂停、结束／失败／取消及层级   |
| JobPresentation      | 真 Job 状态、请求与回执                     | 工具步骤状态，参数生成不等于执行成功           |
| ApprovalPresentation | 原操作／授权请求及决定回执                  | 待本人处理、提交中、过期、已决定；不跨范围批准 |
| TaskPresentation     | TaskContent＋TaskRuntime                    | 事项是否完成、是否可回应、安排与依赖           |

工具步骤的完整只读展示现归既有 `execution-presentation.ts`：
`liveToolPresentation` 承接实时消息的完整 JSON parse／catch、十二状态
词表和原 title／detail fallback；`executionSnapshotJobPresentation`
借原 typed Job 投影，承接快照停止请求的优先级与原七状态词表。
`Conversation.ToolMessage` 和 `ExecutionDialog` 的真实 Job 行分别直接
消费两入口。实时参数生成不是完成，实时审批／unknown 与持久快照的
审批／lost 文案不强并；只有活动中的 Job 才由停止请求覆盖状态文案。
原四个导出算法、回执限定及返回形状不改，注解不能从原参数或邻近
步骤恢复。owner 不含 JSX、IO、React state、timer 或新业务状态。
完整实际 Git 原算法／消费接缝、有限门禁、旧新编译页面和真实组件
挂载分别记录于阶段 32；这不是五领域 presentation 已整体完成，也
不迁移详情读取、审批和结果控制的生命周期或改动现有 UI。

每个展示模型有业务状态之外的读取质量：available／stale／truncated、来源 sourceRef／scope 与本机 observedAt。权威 sourceRevision／sourceUpdatedAt 仅在实际提供时保留，允许缺失；查询代次或观察时间不冒充持久版本或最后工作时间。读取不可用不能落为 idle；历史部分已知不能变为全量计数。**状态与文字分槽**：状态由权威事实决定，注解只提供可选 prose。

### 5.1 注解与无回复路径

真实链：同次模型响应 → Runtime 校验并持久注解 → 授权 projection → Platform snapshot → presentation → activity UI。投影不调用模型。

当前 `activityAnnotationFields`：open 的 summary 取有效 progress；completed/failed 取有效 result；缺失不造摘要，取消不保留结果。scope／generation 不匹配拒绝；truncated title 不作为首标题。

回复链：真实 reply／outbound／主流式 publish → conversation read → Conversation。注解不产生正式消息。后台没有正文时 ActivityRow 仍能显示事实状态，Conversation 不构造“正在对齐…”模拟 reply。

工具 progress 可选，v2 普通终轮 reply 有标题／结果合约，但 no_reply／wait 合法，不能宣称每项活动必有结果描述。语义描述只用已有有效字段，详情明确最近观察而非实时阶段；百分比需要实际可靠分母。数据依据是现有 Runtime／Platform 协议与 §9 源码入口，不依赖已撤回探索稿的展示规则。

### 5.2 父子活动

按 Runtime supervision／family 与真实 parent Thread 关系建读取树，root 用于来源校验，同 session/project/conversation/context 内做权限过滤；不是根据同 root、相同标题、回复时刻、输入短句猜父子。节点保留稳定 ID、实际 revision、状态与子项；generation 仅在已授权来源提供时保留，当前 DTO 并不普遍暴露它。注解代次已由服务端校验，steer 使用原精确 continuation；如需新增通用 generation 字段，要独立设计 Platform 契约，不由 renderer 补造。不把 child success 强行升级父事项 completed。

UI 可组合紧凑 ActivityRow 与展开 ThreadGroup，复用相同模型；消息、主体计数、详情各有用途，但一致的事实不各写一份映射。列表选择不改输入目标；steer 必须显式选择精确工作。深树、循环／缺父、分页截断和 mixed children 状态均需测试，无法完整读取就标明界限。

## 6. 样式所有权与组件治理

一个视觉属性只有一个责任层，不靠“最后加载获胜”。提案最终所有权：

| Owner                  | 唯一职责                               | 不可越界                            |
| ---------------------- | -------------------------------------- | ----------------------------------- |
| foundations            | token 值、主题及辅助模式映射           | 不写 `position/top/height` 宿主几何 |
| primitive styles       | 基础控件及明确 role／variant           | 不按 `.task-page .subject…` 猜语义  |
| Shell／Exchange styles | 宿主区域几何、断点、叠层、可点击安全区 | 不规定剧本人物／正文编辑布局        |
| feature styles         | 领域内容布局与必要专属控件             | 不覆盖宿主输入／Dock／弹窗基础样式  |

先把三份现有交流几何收敛到一个 owner，保留当前行为和值；再讨论视觉变更。迁移不一次采用 CSS layers 改变整个旧 cascade。是否引入 CSS Modules／layers 要用一条纵向迁移检验工具链及回归后单独决定，不是本提案默认新依赖。

### 6.1 明确 role，而不是任意 ReactNode＋祖先选择器

提案 IconButton 输入为登记的 icon／role，组合 selected、pending、disabled、focus 与读屏属性。其业务动作由调用方提供，基础控件不获取 activity；StatusMark 可以显示非按钮图形，不能为统一外观全做成可点击按钮。

首批已实际迁移七个旧控制图形和两类 role：登记只返回原 Lucide 构造器；
IconButton 是不加默认属性或样式的透明原生按钮，原 pressed/disabled/ARIA
由消费方显式提供。afterIcon 当前只保留原未读标记，不是绕过图形登记的入口。
ComposerOptions 的默认、自定义、空 ReactNode 触发器与复合菜单仍沿用原接口；
不按图形来源切换 renderer，以保留实际 button 身份。没有借此实现新的 pending、
视觉密度、材质或辅助模式策略，其他控件仍需逐批迁移和验证。

阶段 42 将原完整公共控件 recipe（31 条／85 声明）归 `ui/controls`，
base／adaptive／metrics／surfaces 四载体在原 cascade 槽组合；Browser 的
完整独立输入规则（1／6）由 feature 拥有。保留原值、selector、上下文及
覆盖顺序，不以祖先包装、末尾补丁或新 CSS layers 改行为。有限当前门禁
登记实际 runtime CSS imports、唯一 recipe 及合法 feature refinement；
默认 CI 验实际当前控件，固定旧新 compiled 对照仅显式迁移启用。

UI state 是 props 的显式值，材质是 role／variant；不能 DOM 多套一层就变尺寸或变色。主题／motion／contrast 在根策略统一决议，循环动效由事实 presentation 明确激活，基础样式不偷偷决定是否运行。

### 6.2 增量依赖门禁（已治理部分持续扩展）

- AST import 检查：presentation 不导入 transport／React 页面，ui 不导入 data／features，feature 不导入他域内部或 App 私有实现；访问业务只走 typed gateway。
- CSS AST 检查：受治理 selector/property 登记唯一 owner；新增裸色、非标尺寸、全局动画及跨域 selector 必须有显式例外。
- 契约检查：图标 role／可访问名称、状态槽完整性、无回复样例、motion 开停及 fallback 必须进入测试矩阵。
- 旧模块有确切 allowlist，门禁先作用于新／已迁移区域；每批缩小债务清单，不以全量报错迫使删除合法局部 state。

工作面、交流 controller、首段导航 owner 与首批登记图形／透明按钮的有限 AST 门禁已随各自阶段实现；交流 frame、原生弹窗表面、公共 frame／字段 role 与非模态浮层表面另有各自有限 CSS AST／入口门禁。其他条目仍是迁移目标。已治理范围必须由具体测试登记，未迁移模块不能因这份文档存在就被描述为已有 CI 约束。

当前普通 Node 回归仍混有历史整文件迁移证明：无关合法 App／Client 改动
也可能触发旧全文 hash，需要年代顺序的 inverse 链。它证明某批迁移的
变化范围，不等于长期职责约束已经设计完善。后续治理须保留原始迁移
证据及所有安全反例，先补足当前 owner／消费／行为的明确规则与合法
无关变更的正例，再分离固定迁移证明和当前生产约束。阶段 31 已将
阶段 30 的相邻整文件来源校验改为不可变历史档案，并独立证明原字节；
新 popup 门禁只约束有限表面，挂载普通 CI 不锁旧新整棵历史快照或
相邻组件全文。已有其他 inverse 链尚未整体治理，不称该目标完成。
不能只改 glob、历史 hash 或删断言求绿，也不新增一个通用 AST broker。

阶段 32 的 Job 门禁仅检查自身纯算法、词表、回执和真实直接消费：
合法无关 JSX／CSS／注释、type import／pure export 与直接 import alias
可继续演进。固定完整旧源码及批准接缝的整文件逆证明只用于独立迁移
证据，不进入普通 CI；严格旧新组件对照由显式 migration 开关启用，
日常默认验证当前契约。未为本批增加旧相邻门禁适配或跨 owner inverse。

阶段 38 将 execution、local-input-delivery、task-interactions 与 script
catalog-publication 四份旧门禁从跨 owner 整文件逆展开链中分离。
完整旧算法、原反例和历史来源摘要保留；普通 CI 检查真实 workspace
消费、借用端口／ref、原注册位置、清理生命周期及 script 发布／确认
合同。身份代际失效和 approval lifetime 原先隐含在全文 hash 中的部分，
现在有有限原算法和明确反例，不以删除断言换绿。独立 React feature、
类型／export 及实际 import alias 有合法正例；不增加 Reader inverse，
不将有限绑定检查描述为任意 TypeScript 数据流或权限证明。
其余历史链仍须治理，这四份分离不代表整体测试架构已完成。

### 6.3 共享顶栏的实际组合边界

`WorkspaceTopbar` 只接受只读展示事实、有限 history／sidebar 值、三个原生 ref、
项目菜单槽及五种语义动作。它统一原 header 的 DOM、面包屑、历史 enabled、
插槽 hidden 和批注开关；不导入业务 Client、workspace、偏好 writer 或领域查询。
项目菜单是原领域组件的明确组合槽，不是基础按钮的任意图标旁路。

App 原三个 `useState(null)` 的 setter 原样传给三个常驻 div；页面及应用仍向原
portal destination 输出自己的工具栏。不能用 inline ref 包装、随 view 加 key、
条件重建 target 或新增 DOM 包装代替。当前有限门禁核对真实 import 符号、唯一
直接工作区消费和上述接线；SSR 与隔离挂载另核对原 DOM、焦点、值及卸载清理。
CSS zoom 对照不是 Electron／OS 缩放或标题栏原生命中验收；原 App 仍需复验。

## 7. 渐进迁移与证明责任

| 批次         | 做什么                                                | 必须保留／证明                                         | 不在这批做                           |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| A 职责基线   | 固定已确认交互、事实来源、状态与 owner 清单           | 当前行为与源码证据区分；历史冲突消歧                   | 采纳已撤回视觉规则、换皮、先铺新目录 |
| B 样式与基础 | 收敛交流几何；token alias、IconButton role            | 当前尺寸、原生命中、四色亮暗、焦点、减少动态           | 顺手重新排消息／输入衔接             |
| C 宿主编排   | 抽 WorkSurface／Navigation／Exchange 及 draft adapter | scope、首发事务、命令 ID、model/effort、late callbacks | 迁数据库或 Session IDs、全局新 store |
| D 事实展示   | 纯 presentation＋活动／步骤组件                       | 无回复、可选注解、父子关系、离线未知、Task 独立        | 新 LLM 摘要器、客户端状态机          |
| E 查询收敛   | 页面重复 effects／镜像迁到 scoped observation         | 取消、撤权、乱序、共享与有界恢复、healthy idle 零轮询  | 提前改事件协议或做全量缓存           |
| F 页面迁移   | 事项、内容、工作台与专业应用依次接入                  | 一致语法、领域自主、完整页面设计评审                   | 一次把所有专业画布改为表单           |

每批一次迁一个边界。先固定不变量和准确失败场景，完成后检查生产代码、自动回归、原应用行为及设计评审；接受且验证的阶段做 focused local commit。未接受试验保持隔离，不推送／发布或改用户数据。

### 7.1 最小回归矩阵

| 边界                    | 自动验证                                                           | 原应用验证                                                        |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| WorkSurface／Navigation | default/named、content owner、scope key、晚回执、旧键兼容          | 项目 A/B、全局目录、对象版本之间往返，原草稿及阅读恢复            |
| Exchange／draft         | 四态、焦点不展开、首发原子事务、稳定 ID、冻结 payload、effort 保留 | native picker 取消、长稿、刷新／重启、发送中切页、200%            |
| data／transport         | 延迟／乱序、身份切换、撤权、重连、同 key 共享、零健康轮询          | 本机 Desktop 与 Web 入口语义一致，休眠／恢复与断线                |
| presentation            | 五类全部状态、truncated、缺注解、mixed children、真假终态          | 真后台无正文、并行父子、审批／等待、steer、执行结束但事项未完成   |
| styles／components      | 状态组合、geometry、命中、ARIA、token／owner lint                  | 完整页面四强调色×明暗、窄窗、键盘、系统辅助偏好；原生区域坐标命中 |

优先复用现有 `composer-*`、`execution-activity`、`nested-thread-activity`、`conversation-read`、`application-transport`、`workspace-*`、`ui-standard` 等测试。新增用例证明迁移不变量，而不是为新文案改掉旧失败断言。技术通过与审美认可分开记录。

## 8. 成功定义与当前未完成项

采纳与迁移完成后，应能做到：一个组件语义变化有唯一 owner；一个状态规则变化无需修改五个消费页面；一个角色尺寸变化由 component token 控制；每项活动 prose 能追溯来源，缺失不造消息；新 feature 默认复用宿主与 UI primitives，同时保留领域画布自由。

当前已有工作面解析、稳定导航 Host／应用入口／内容打开、项目与会话私有范围、
交流意图／焦点、草稿生命周期、发送协议、输入工具、主体检查器、读取回执与
若干领域数据 family、Human 文档／项目创建、对象批注和搜索／引用准备的
生产 owner，以及完整执行详情、对话阅读视口和事项执行 feature controller；共享顶栏、首批登记
图形／透明按钮、交流几何、原生弹窗表面／公共字段 role 与非模态表面
也有有限门禁。已有 `ArtifactEditor` 独立拥有现件编辑、草稿、
版本冲突及保存生命周期，不与手写创建、Agent 输入或宿主导航混为同一职责。

Thread collection 的输入关联活动与范围概览两种展示投影已迁入同一
实际 owner，工具呈现与 ApprovalDetails 也有真实复用消费方。不同用途的
事实不能强并成一个状态 enum，不能因名称相近就缓存或合并不同资源。
Reader 导入、OCR 与持久阅读命令 data owner 和 ScriptStudio 完整工作室
controller 已落实；画布、分页、子组件和局部 JSX 组合仍拥有其原职责。

阶段 39 的实际来源审计登记下列五项。阶段 40 已落地 R2，阶段 41 已落地
R3，阶段 42 已落地 R1，阶段 43 已落地 R4，阶段 46 已落地 R5；五项的
生产职责都已实际交接，剩余有限治理和整体验收不因此自动完成。不是按
文件行数清空宿主，也不是必须让每个页面再加一个 hook：

| 边界                                     | 完整职责及保留约束                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 公共控件 role／样式（阶段 42 已落地） | 原完整 button／field／primary／outline／icon／secondary recipe 归 `ui/controls` 四原 cascade 槽，Browser 独立 recipe 归 feature；实际唯一来源与合法 refinement 有有限门禁。原 DOM、尺寸、颜色、图形、交互、动效及材质保持，不加 wrapper 或末尾覆盖。                                                  |
| R2 书签数据操作（阶段 40 已落地）        | 完整 list／durable command 归 `data/bookmark-interactions.ts`；能力／身份、8 秒读取、hash、完整稳定 pending 字节和原错误政策保留。Client 仍拥有唯一身份／刷新权威；当前 URL 与目录分页保持不同观察，不新增 cache／请求。                                                                              |
| R3 主体日程检查（阶段 41 已落地）        | `features/subject/useSubjectSchedules.ts` 拥有完整显式刷新、limit50 清单、至多 16 个快照／四请求串行批次及取消／质量生命周期；借原 render captured Client 三端口及三方法 logical gateway，renderer 只消费只读事实和语义 refresh。沿用原模型、四依赖、源资格和动作，不套 TaskList 的订阅、重试或超时。 |
| R4 对象评论与关联数据（阶段 43 已落地）  | 完整分页与写入叶子归 `data/object-interactions.ts`；Client 借原 refs、source、receipt、同一未发送错误 constructor，直接公开与消费。保留 100 页／100 条、ordinal／schema／溢出、signal、原迟到政策和捕获的 Objects source／revision／quote／page；关系仍借 Platform 独立分页。                         |
| R5 通用持久命令投递（阶段 46 已落地）    | `data/operation-delivery.ts` 拥有完整非 record-input execute、原失败分类及同一 Unsent constructor；五惰性端口借 Client 原唯一权威。原 pending、hash／身份、稳定 ID／字节、清理与 refresh 顺序保持；领域 dispatch 和独立 input delivery 不复制，不增加存储或请求。                                     |

每项在实施前核对完整算法、静态／实时捕获 seam、真实消费、数据权威和验收
清单。已有 ArtifactEditor、Reader／Browser feature、Client 唯一 identity／
refresh 权威、App 的 portal／布局／全局快捷键／显式文件导航桥属于合法
组合，不为凑目录新增 facade、cache、store 或第二套控制器。其余 data 入口
仍须逐项登记为已拥有职责或明确 gateway，不能只凭删除 Client 方法宣称完成。

当前生产约束与历史整文件迁移证明的测试治理也须收口，不能把不断增长
的跨 owner inverse 链作为正常新增功能的永久前提。

阶段 48 已将 Object annotations 与 Subject inspector 的当前检查交给
raw-current 有限合同：真实来源／消费、原捕获、完整自有算法和排序受
约束，独立 React feature 增长不受整份文件或 peer inverse 限制。原十个
callback／54 反例保留固定历史证明；其中两项仅属历史。旧 API/default
不变。阶段 51 将 Human／Private 的当前入口交给各自 raw-current 有限
消费合同，实际来源、捕获、完整自有算法和注册顺序受约束；独立实际消费
的 React／alias 增长不需要恢复 peer 历史。原十二 callback／28 反例完整
保留历史执行，其中三项仅属历史；旧 helper prefix／API／default 不变。
阶段 53 将 Workspace content opening／Exchange drafts 的普通入口交给
raw-current 有限消费合同：实际来源、绑定、捕获、注册顺序及完整自有算法
受约束，独立实际消费的 React／alias 增长不再恢复 peer 历史。原十三个
callback／69 反例保留完整历史执行，其中两项仅属历史；五个完整草稿
command recipe 以独立实际 Git 原件约束早退、guard、写入与发布顺序。
旧 Workspace helper prefix／API／default 不变。这批是测试治理交接，
不冒称新的生产职责拆分、完整回归或原 App 验收。

阶段 49 仅补 frame 门禁的两条相邻 writer 物理 owner 和三个已批准
control carrier 的有限入口 phase；原 recipe、callback／反例和不可变
档案不变。阶段 52 将另两份 surface 门禁交接到已批准 action carrier
的实际来源、唯一 main 入口和原相对 phase；只在核对后投影该 carrier，
其他 writer／材质／token 规则不获豁免。原十二 callback／114 反例保留，
两个原档案及生产样式不变；实际独立 React／CSS 消费增长仍合法。不把
这批有限检查或挂载绿灯当作全部公共样式或原 App 验收。

阶段 47 已将原完整剧本弹窗和四态词表交给各自共享 owner，七处表单
直接复用并保留原同 binding 兼容出口；Editor 不再 runtime 导入父页。
阶段 50 将原完整 ObjectIcon／kindLabel 交给 `ui/ObjectIcon.tsx`；五类
页面直接消费，ArtifactEditor 保留原同 binding 兼容出口。图形含义与
调用方条件不变，无新 wrapper／effect／样式。有限当前消费门禁与显式
旧新实际图形／样式对照分别证明边界和等价，不锁整页或借 peer inverse。
现件编辑仍有合法生命周期所有权；阶段 56 已将完整三分支 application
compose preparation 交给独立 owner，App 在原 render 借原端口构造，
builtin 与 sandbox 共用原同步准备命令。不因此把每个局部 JSX 或状态
再套一个 controller，也不把准备草稿等同于发送／执行。

交流样式的实际 33 源审计确认，单行底栏与交流几何已有 owner，五类旧
footer／floating class 未有当前 TSX 消费，保留合法 fallback。Dock 的早
phase 与后公共控件细化共同决定实际命中尺寸，不能整体后移以凑整理数量。
阶段 57 已把交流 controls 的完整 16 条／63 声明迁入独立 feature owner，
保留原相对 phase；九组有限 owner 检查、完整实际 compiled recipe／余流
及跨越节点收据、完整旧新页面回归分别记录。页面两 lane 各 23/24，剩余
同一原生前台前置未通过；不把来源报告或编译相等自动当成原生命中验收。
阶段 58 已把 PDF 完整 23 条／76 声明归入两条原级联承载的同一 feature
owner，Host 六条 packing 保留；严格双 owner 校验后才允许旧门禁的
单载体交接。完整 compiled recipe／未选树、统一 Node 与完整两文件
页面回归分别记录；三种真实消费者的五种独立挂载已完成 12 组环境、
247 状态／741 全量比较／1,000 次精确 CSS 响应，不以 Reader 目录路径
代替历史 PdfReader。200% 仅为视口／DPR 布局代理；受控 Client 和
隔离草稿不冒充后端或原用户资料验证。原 CSS zoom 首红保留，入口
修正不改生产值，原窗／原生验收仍独立未完成。Shell packing 仍须按其真实职责及稳定
portal 消费者继续，不为凑目录统一合并不同权限或生命周期的查询。

整体跨页面外观／交互回归及原 App 的原生焦点、硬件和系统命中验收仍未完成。
图示和文档不代替代码、生产测试及用户设计评审；不把工程拆分自动等同于审美
改善。每一批分别记录代码实现、自动回归、原 App 验收与未完成边界，目标保持
active，不以阶段编号、行数或局部测试数量计算完成百分比。

## 9. 源码审计入口

- Web／Desktop：`apps/web/src/main.tsx`；`application-transport.ts:40`；`apps/desktop/application-host.ts:87`；`apps/service/src/http.ts:107`。
- 实时／读取：`apps/web/src/useConversationStream.ts:14`；`conversation-read.ts:42`；`useObservedRead.ts:4`；`packages/core/src/workspace-changes.ts:10`。
- scope／draft：`apps/web/src/local-preferences.ts:9`；`composer-drafts.ts:75`；`App.tsx:747`、发送分支 `1977`；`ScriptStudio.tsx:148`；`ObjectCollection.tsx:71`。
- 展示事实：`packages/application/src/response-annotations.ts:14`、`:73`；`runtime.ts:4493`；`apps/web/src/execution-activity.ts:24`；`Conversation.tsx:302`；`TaskRunPanel.tsx:118`。
- 样式：`apps/web/src/styles.css:1643`；`visual-system.css:1`、`:449`；`composer-compact.css:1`；`main.tsx:4`。

以上行号为审计时定位，未来会变化，语义 owner 才是长期约束。[统一宿主边界](./24-shared-application-host.md)、[认知应用协议](./15-cognitive-application-host.md)及[存储权威](./35-application-storage-model.md)保持有效；提案不修改其安全和持久化契约。
