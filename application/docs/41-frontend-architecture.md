# Morphz 前端整体架构

日期：2026-10-03 · 版本：0.9 · 状态：分阶段实施中，整体迁移尚未完成。

阶段清单更新：2026-10-04。

目标：明确共享宿主、状态、数据、组件及样式所有权，减少页面独立复制同类逻辑。保留已有共享设施、数据与授权；不推倒 Runtime／Platform，不为状态展示增加 LLM 请求，不另做 Desktop 前端。本工程设计独立于已撤回的视觉探索，不采纳其数值或审美规则。下文保留完整目标，具体生产实现及验证分别记录，不能据此宣称整体架构已迁移完成。

### 已落地的边界

| 阶段                 | 生产 owner 与消费方                                                                                   | 工程约束与范围                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工作面解析           | `host/work-surface.ts` 的 `deriveWorkSurface`；`App.tsx` 消费只读派生值                               | `frontend-architecture.test.ts` 检查类型与依赖、禁止消费方重新计算 scope/key；保留原持久键、领域归属与 default/named 会话区别。提交 `10b19994`。                                           |
| 交流意图与焦点       | `host/use-exchange-controller.ts`；App 保留发送、草稿及页面组合                                       | `exchange-controller-boundary.test.ts` 与 controller 回归约束显隐、固定、伸缩预览和焦点恢复；不更改 Runtime 输入或权限。提交 `b1e37aa2`。                                                  |
| 导航状态与回执       | `host/use-workspace-navigation.ts` 的 state／commands／commit；App 保留唯一 prefs writer              | 四个原导航命令、同一 generation 与原 trail／焦点顺序；76 项相关 Node／门禁、44 项 Host 浏览器回归通过。只迁已审查边界，不把保留的其他业务入口称为已拆完；原窗复验待解锁。                  |
| 草稿生命周期         | `host/exchange-drafts.ts` 的三 state hooks／五 local commands；App 保留发送、导航与原退休 effect      | 原本机键、初始化位置、ref／render snapshot、逐步写入失败及 ID 保留；16 项逻辑、6 项有限 AST、4 项实际 React 挂载、31 项未改旧 Host 回归。不是新 store 或原子事务，原窗复验待解锁。         |
| 发送协议编排         | `host/submit-exchange-draft.ts`；App 保留准备锁、草稿反馈与焦点                                       | 原四分支、Profile flush→scope→当前工作面复核、补充原身份与冻结重试字节、同步 receipt/catch/finally 端口；有限协议与实际接线门禁，不新增授权或发送入口。                                    |
| 共享工作区顶栏       | `shell/WorkspaceTopbar.tsx`；App 保留原三个 portal target state/ref 与语义动作                        | 一个原生 header、原面包屑／显隐／导航按钮与三个常驻插槽，无新包装／key／样式；固定旧 markup、实际挂载及真实 App 导入／消费门禁，不接管领域画布或路由。                                     |
| 会话历史查询         | `data/conversation-history.ts`；Client 持有唯一实例，workspace view 消费 head 策略                    | 原 scope／缓存／分页 promise、head 复用与合并实际迁入；身份、epoch、catalogVersion、授权清理及 Boot 发布仍在 Client。固定旧实现对照及有限依赖门禁，不是全查询层或新的授权 owner。          |
| 回应等待事实         | `conversation-presentation.ts` 的 `isPendingResponse`；Conversation 与 subject Logo 消费              | 纯事实组合与两个旧谓词等价；输入归属、流式来源与取消策略仍由原消费方负责，不生成回复或执行事实。51 项 Node／SSR 与 31 项 Host 浏览器回归通过，原窗最终复验待解锁。                         |
| 登记图形与透明按钮   | `design/control-icons.tsx`、`ui/IconButton.tsx`；SidebarToggle、ComposerToolButtons、ExchangeControls | 原七图形／两 role、单 native button、原 props/ref/key/compact 焦点。13 项 Node／门禁与 5 项实际隔离挂载通过；当前契约的相关矩阵 60/60 通过，有限治理，不包含全部菜单／按钮或原窗最终验收。 |
| 应用图形与 Dock 手势 | `ApplicationIcon.tsx`；`application-dock-interaction.ts` 与 `use-application-dock.ts`                 | 图形共用身份，手势沿用既有本机固定偏好，不卸载、不启动或发送；这是用户另行要求的交互增强，不是“外观不变”迁移。提交 `21fee71a`、`33bd788b`。                                                |

交流伸缩的首段样式 owner 也已迁入 `exchange-layout.css`，原 23 项几何与 9 项绘制声明保持；`exchange-css-ownership.test.ts` 治理唯一入口与已知竞争规则，非全产品 CSS 门禁。该阶段的原 App 原生命中复验仍待系统解锁。

发送协议与共享顶栏阶段已提交 `d45cf84d`。补充重试的原命令匹配修复另以
`28cecd4a` 提交：`local-saved-inputs.ts` 仅在双方 supplement 时认可候选省略
原已保存 parallel 标记，
严格全字段比较后返回原 operation；不更改首发默认、权限、发送入口或 UI。
该修复不是新持久化格式或整层 query facade。当前原页面矩阵仍有三条真实
项目新增／权限失效红项，完整前端工程及原 App 最终验收不能据此称为完成。

详细测试、原 App 验收与尚未验证的边界见[实施记录](./13-implementation-status.md)。上述提交只证明对应阶段，尚未替代下文所有目标；完整 query facade、跨领域 presentation 和全产品样式 owner 仍未完成。本文未规定新的图标尺寸、间距、色彩或动效审美标准。

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

Client 仍拥有 typed gateway、实际授权、outbox、首次会话事务与投递幂等；App
仍拥有准备锁、原 key 的 functional 草稿消费、错误分类、staged 迟到失败保护、
界面与焦点。receipt／rejected／settled 在原 execute continuation 内同步调用，
不是返回后再 await 清理；本机保存回执不冒充已执行成功。阅读类型迁到纯
`reading-context-model.ts`，原组件继续 re-export；宿主不导入领域 JSX。
这不是已完成全部 Exchange，也没有新全局 store、重试循环或额外模型请求。

### 3.3 NavigationController

统一导航意图、打开成功回执、返回现场及 generation 竞争。实例恢复与显式打开内容分开；全局目录与项目目录不创建 Session；来源版本引用与 live head 不混用。

首段生产迁移已落地：`useWorkspaceNavigationState` 只拥有原状态／ref，无 effects；
`createWorkspaceNavigationCommands` 是无构造副作用的四命令闭包；
`useWorkspaceNavigationCommit` 在原 trail／快捷键位置注册原 effects。
同一 generation 仍由 exchange 与 ApplicationHost 消费，原 prefs writer 仍在 App；
不通过整个 setter bag、latest 快照或新增 store 镜像宿主。偏好 patch 与返回的
raw spread 语义分开。`workspace-navigation-boundary.test.ts` 约束这条真实 seam，
`workspace-navigation.test.ts` 验证原回执／错误／历史契约，不覆盖所有 App 业务入口。

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

UI state 是 props 的显式值，材质是 role／variant；不能 DOM 多套一层就变尺寸或变色。主题／motion／contrast 在根策略统一决议，循环动效由事实 presentation 明确激活，基础样式不偷偷决定是否运行。

### 6.2 依赖门禁（拟实现）

- AST import 检查：presentation 不导入 transport／React 页面，ui 不导入 data／features，feature 不导入他域内部或 App 私有实现；访问业务只走 typed gateway。
- CSS AST 检查：受治理 selector/property 登记唯一 owner；新增裸色、非标尺寸、全局动画及跨域 selector 必须有显式例外。
- 契约检查：图标 role／可访问名称、状态槽完整性、无回复样例、motion 开停及 fallback 必须进入测试矩阵。
- 旧模块有确切 allowlist，门禁先作用于新／已迁移区域；每批缩小债务清单，不以全量报错迫使删除合法局部 state。

工作面、交流 controller、首段导航 owner 与首批登记图形／透明按钮的有限 AST 门禁已随各自阶段实现；其他条目仍是迁移目标。已治理范围必须由具体测试登记，未迁移模块不能因这份文档存在就被描述为已有 CI 约束。

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

当前已有工作面解析、交流意图／焦点、回应等待事实、首段导航 owner、草稿生命周期、发送协议编排、共享工作区顶栏、首批登记图形／透明按钮和对应有限门禁的生产迁移；App 尚未完成整体拆分，新 query facade、跨领域 presentation、全产品 role 型组件和 token／样式迁移也未完成。图示和文档不代替代码、生产测试及用户设计评审；不把工程拆分自动等同于审美改善。每一批需要分别记录代码实现、自动回归、原 App 验收与未完成边界。

## 9. 源码审计入口

- Web／Desktop：`apps/web/src/main.tsx`；`application-transport.ts:40`；`apps/desktop/application-host.ts:87`；`apps/service/src/http.ts:107`。
- 实时／读取：`apps/web/src/useConversationStream.ts:14`；`conversation-read.ts:42`；`useObservedRead.ts:4`；`packages/core/src/workspace-changes.ts:10`。
- scope／draft：`apps/web/src/local-preferences.ts:9`；`composer-drafts.ts:75`；`App.tsx:747`、发送分支 `1977`；`ScriptStudio.tsx:148`；`ObjectCollection.tsx:71`。
- 展示事实：`packages/application/src/response-annotations.ts:14`、`:73`；`runtime.ts:4493`；`apps/web/src/execution-activity.ts:24`；`Conversation.tsx:302`；`TaskRunPanel.tsx:118`。
- 样式：`apps/web/src/styles.css:1643`；`visual-system.css:1`、`:449`；`composer-compact.css:1`；`main.tsx:4`。

以上行号为审计时定位，未来会变化，语义 owner 才是长期约束。[统一宿主边界](./24-shared-application-host.md)、[认知应用协议](./15-cognitive-application-host.md)及[存储权威](./35-application-storage-model.md)保持有效；提案不修改其安全和持久化契约。
