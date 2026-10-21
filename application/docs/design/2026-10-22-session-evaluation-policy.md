# Session 模型选择：持久边界与接线审查

状态：按用户要求修复默认继承；以下为实现前的数据与失败边界审查，
不是已交付声明。保留既有控件布局和模型工具定义。

## 唯一权威与身份

模型、强度的持续默认属于 Runtime 既有 Session.model_alias 和
Session.reasoning_effort；null 继续表示继承 Runtime 默认。任务、目标、
调度的显式覆盖独立保留，实际请求事实仍由物理调用记录拥有。
Host 不建模型设置表，不把 renderer 草稿、启动快照或已准入消息当成默认。

共享应用增加有类型的 session-evaluation.read/update，Desktop IPC 与 Web
HTTP 共用同一路径。输入只接受 projectId/conversationId，规范 Session 和
Context 由已授权 Platform 路由推导；不接受任意 Session ID、Principal 或
节点。读取前后复核范围，已有账本 Principal 也必须匹配。
写入采用实际 Human 消息范围授权；不能借 Runtime operator token 扩权。
尚未实现团队模型策略管理，团队／远端当前只读，不把个人设置覆盖进去。

## 事务、并发和失败

复用 Host 每个 Session 的在途串行队列，与 Session 准入、权限修改同锁。
读取返回范围和模型两字段的指纹；写入先核对指纹，再以 Runtime 原 PATCH
同时更新两个字段，最后读回确认。不声称这是 Runtime 原子 CAS：其他直接
Runtime 操作者仍可能并发修改；失败、失联或读回不符只报告未确认，重新读取
实际状态，不乐观成功、不自动重放修改或重新提交业务输入。

每次写入校验模型目录、强度和两者组合。null 转为空字符串仅用于 Runtime
已定义的清除覆盖语义；不能把 none 和默认混同。此 Session 入口只开放现有
五档和 null；不把任务层的显式 provider_default 塞进将其解释为清除的旧
Session PATCH。仅修改模型／强度，不夹带
审批、目录、Provider 密钥、工具参数或任务重启。

## 首次输入与生命周期

读取、打开菜单、导航和未发送草稿均不创建 Runtime Session 或 Platform
会话。尚未开始的选择只保留为当前草稿，首条有效提交才允许初始化默认。
首次初始化必须属于原持久发送命令，只在新建 Session 时使用；重试和响应
未知时不得覆盖已存在的 Runtime 默认，也不得改写已准入信封及指纹。
此首建接线独立实现验证，不能由 read/update 专项通过推定完成。

首次源码核对发现 Runtime `CreateSessionRequest` 和 `NewSession` 原来没有
模型／强度字段，不能把字段偷偷放进 POST 并假设生效。现在首次选择通过
Runtime 的原 Session／Principal 首建事务一起落库；不得以 POST 后再 PATCH
替代原子初始化，否则响应丢失后无法区分初始默认与用户后改的显式清除。
优先在原首建存储路径增加有类型的可选初始策略，旧调用仍以继承创建；两个
数据库共用同一语义、不增表、不修改旧 Session、不重置其他客户端选择。

Runtime 首建接线采用 `initial_evaluation`：两个值仍属于原 Session 列，
与 mount 和首个 Principal 绑定在原事务内 INSERT；相同 ID 仍冲突，不升级为
“存在就修改”。模型目录和组合在创建前验证，HTTP 在挂载新 Context 前先作
同样的预检。`/api/runtime/inference.initial_session_evaluation=true` 明确
声明此确定性能力，后续 Host 不会向旧的宽松请求解析器发送字段并猜测生效。
这不属于 LLM 工具或正文协议，不增加模型调用。

Host 首建命令：普通输入以可选、严格的
`initialSessionEvaluation` 保留原选择，禁止与任务 `model/reasoningEffort`
或定向补充混用。它只进入原输入／持久 outbox 的初始化收据，不成为新模型
权威，不进入 Runtime 激活覆盖字段；同命令的不同选择必须冲突。只有确认
Runtime Session 不存在时才用于支持该能力的原子 POST；一旦 Session 存在，
重试和后来的消息都尊重实时设置，不把旧收据改成一次 PATCH。响应丢失后
再次读取原 Session，不能重建其他 ID、重发已接受工作或重设已经更改的默认。
此 Host 字段已实现，发送失败、首次响应未知后重启、已存在 Session、
显式任务覆盖与权限初始化专项已验证；UI 与最终原应用验收仍未完成。字段限于两个标量，
复用既有 outbox 单行事务、主键查询、授权和生命周期，无新表、索引或双写。

现有 Runtime 表、索引、授权和删除生命周期不变；Host 此阶段没有新增持久
实体或 SQL 迁移。SQLite/PostgreSQL 都经相同 Runtime Session 接口。
后续若首建命令需增加字段，必须先扩充本文的账本／幂等设计与测试，不能
以临时 renderer 数据库或双写绕开。

## 输入框接线与失败反馈

本机模型管理能力的内嵌 Desktop 使用上述 Session 设置；团队和 HTTP 不借
此开放写权限，原有任务显式选择接口不变。已有会话不读取旧草稿模型作为
设置权威。未发送命名草稿不读 Session、不预创建，未开始会话只把选择留在
既有草稿字段中；首次有效输入通过初始策略收据交付。普通输入在此模式下
不再发送任务 `model/reasoningEffort`，显式事项／目标／调度覆盖仍保持。

界面保留现有两组控件与底部权限／目录位置，不增常驻状态行。保存中显示
真实 busy 状态和说明，但不禁用正在拖动的原生 range；同一范围的连续选择
合并为最新意图，串行写入只使用刚确认的指纹。发送前等待全部最新意图，
再核验身份／范围并提交原输入；切换范围或身份后迟到回执不污染新范围。

刷新和菜单重开重新读取实际设置。读取失败、冲突、回执丢失或不匹配时，
阻止按未知选择误发，保留正文和选择，提供重新读取；不自动重放写入或业务
输入。明确的写前参数拒绝允许继续改选，但未改正前也不重复尝试。重新读取
只确认权威，不把旧编辑意图重新覆盖；显式清除与 `none` 保持不同语义。
此编辑器只持有可丢弃的显示／在途状态，不增加表、存储、模型请求或工具。

## 验证要求

覆盖未开始只读零创建、默认共享路由与命名会话隔离、身份／范围变化、
错误 Context／Principal、非本人和团队拒绝、未知模型／不兼容强度、
过期指纹、同 Host 并发写冲突、PATCH 失败／失联／读回不符、清除覆盖。
真实 Host→Rust 验证改变 Session 默认不会中断或重放原请求，正常续接采用
新默认，显式任务保持原配置。UI 必须按确认回执显示，迟到结果不能污染新
范围，错误保留草稿并可重新读取。最后需真实 DeepSeek 和原应用验收。

## 历史任务解除错误固化：实现前边界审查

原 profile 的长期任务已核对原始 schedule_tx：spawn 与 objective.create 都
没有 model／reasoning_effort，Thread 却复制了 Human 普通输入的 GPT/max。
后来的循环 Schedule 明确设置 high，这个显式值必须保留。不能改写已接受的
输入、模型请求事实或完成记录，也不能用 supersede 来“换模型”：现有
supersede 会换代并取消调度，违反继续原任务的要求。

计划复用 Runtime Thread 的既有 model_alias／reasoning_effort 两列作为任务
覆盖权威，补齐 operator 控制面和修订号核对；null 表示恢复正常继承。
不增表、索引、Host 设置库或 LLM 工具。增加一个可空的 Runtime 控制修订列
evaluation_policy_revision：旧行保持 null，不回填或重新解释旧任务；只有
本次明确 operator 更新与两字段、Thread revision 在同一事务中写入该标记。
这是控制面选择与原任务默认／已准入调度参数的区分，不是新的模型设置来源。
未修改的任务保留原显式调度参数优先级；operator 明确修改的当前任务以新
策略约束后续请求。新调度子任务仍按原规则保留其自己的显式 high 等设置。
命令只接受确切 Context／Thread、
expected_revision 与完整的两个可空设置，原 Thread 必须仍 open；同一事务
只更新两字段、revision 和 updated_at，身份、generation、调度、作业、输入
及收据不变。响应未知后读回核验，不自动重试，不重新提交业务输入。

原应用的最新只读核对进一步确认：该行是循环 Schedule 的模板 Thread，
不是 Objective primary；Objective 正在等待包含它的真实 Thread Group，
不能把这个等待清除为一次“模型恢复”。此模板没有待释放的 Provider 依赖。
原 Schedule.model_alias=null、reasoning_effort=high，下一次触发时间及每小时
间隔必须保持。更正只针对已证实误复制的模板默认；未来 occurrence 使用
原有独立 Thread 路径，继承新模型并保留显式 high。专项必须走真实 Scheduler
到物理请求，校验零更正请求、一次实际执行、原 Schedule ID／时间规则未改，
不能只检查模板数据库列或在原任务上强行提前触发。

每次物理模型请求读取当前 Thread 的控制标记、覆盖与 Session 默认，不能让
旧触发 Event 的快照盖过 operator 已确认清除；无控制标记不改原行为。
初次显式值仍按原准入写入 Thread，infer 的
同任务显式继承及目标覆盖优先级必须由真实联测守住；已发出的请求不改变。
仅唤醒此 Thread 的旧模型资源等待，不取消其他等待或并发工作。Runtime
控制面严格 operator 授权，Host 不把它暴露为 Agent 工具或新增任意范围入口。

SQLite／PostgreSQL 验证 CAS、清除／显式设置、终态拒绝和生命周期字段保持；
真实 Provider 受控测试验证在途不打断、后续继承、旧触发值不复活、单次工具
和原模型调用数，以及重开与权限拒绝。通过后才备份原数据并纠正已证明误复制
的确切存活 Thread；不按“用了 GPT”或同 Session 批量清除其他显式任务。

SQLite 启动迁移完成后，在本连接池尚未对外提供服务时，持有所有现存连接。
每个连接先执行一次固定单列的 sqlite_schema 读取，使 SQLite 在 step 时安全
刷新自身 schema，再清除 SQLx prepared statement 元数据，防止新增列后
复用旧 `SELECT *` 列描述；只清 SQLx 缓存不足以刷新 SQLite 连接本身。连接
不重建，正常运行仍使用语句缓存；不是跨进程通知、轮询或对其他 Runtime 的
操作。回归在两个独立连接池、每池两个同时持有的连接上缓存旧列结构，再并发
迁移、逐连接读取新列，并保留旧任务／调度及原值，不能靠选到未缓存的连接通过。

### Session 默认变化与显式任务隔离：补充审查

隔离反例已确认：旧的全局配置查询会把其他 Session 的设置 Event 当成本次
请求的全局配置改变。并且仅凭“同 Session”不能证明一次显式固定模型／强度
的失败请求会被默认设置改变修复。不能无差别唤醒、补一次模型请求来试探。

权威新增材料仅是原物理请求的 Runtime 快照，写入既有失败／等待 Event 的
`session_evaluation_policy` metadata：请求开始时两个可空 Session 默认各自的
固定长度 SHA-256 指纹，以及模型、强度各自是否实际继承 Session 的两个 bool。
指纹区分 null、空字符串与显式 none，不复制任意长度的设置文本；缺项、未知
字段、非规范指纹和类型错误均拒绝作为恢复证据。它不由 LLM 返回；
不进工具定义、正文协议、Host 设置表或新 SQL 表／列，不含密钥或正文。
Owner、Context／Session／Thread／Activation／Evaluation 和代次仍由原路由
与持久 cause_event_id 验证。快照随既有 Event 同事务持久化和原保留策略存续，
复用 Event ID／因果索引；不双写当前设置，不回填旧记录。

恢复时读取当前同一 Session，只比较快照中实际继承的字段；显式 Task、
Objective 或已准入 Schedule 覆盖保持原有优先级。当前值已回到原值时不重试；
缺失、不完整或类型不符的旧快照不猜测。Global Provider 配置 epoch 仍归
Runtime-ModelConfiguration，不能把 Session 的通知借成全局 epoch。

普通 Thread 使用原 pending 依赖的 wait_event_id 验证来源，释放时带精确
依赖 ID／代次，再由消费者重读当前设置核验，避免迟到通知放行新失败。
Objective 复用已经同事务提交的 cause_event_id，通过其 primary 请求的
真实失败快照收敛；Session Event 只是唤醒收敛器的提示，不是释放任意目标的
授权。提交前后竞态和启动恢复都读相同持久事实，不依赖通知成功或新增轮询。

验证包含其他 Session／Context 拒绝、同会话继承恢复、模型与强度分别继承、
显式覆盖不动、回改原值、缺失／损坏快照拒绝、迟到通知不释放新请求，以及
失败在切换前后两种时序的真实 Runtime 续接。保持原 Thread／generation、
目标／调度／权限、原消息与工具 schema，不重放输入，不增加格式修复请求。

### Objective 模型等待的原子因果边界

若被控制的是 Objective 当前代次的 primary Execution Thread，失败请求可能
在控制提交后才结束。其请求事实显式携带 `thread_evaluation_policy_revision`
（包括 null）；只有实际请求修订早于当前 Thread 控制标记，才可释放这个旧
模型资源等待。必须同时核对 Context、Agent、Session、Principal、primary
root、Thread generation、Activation 和原 Evaluation；不改 Objective 的
显式设置，不递归修改或唤醒 infer／显式子任务。

等待的权威仍是 `scheduler_dependencies`。既有 Kernel `ControlObjective`
把 header `causation_id` 传入原 `update_objective_state` 存储事务；新产生的
pending 依赖在原 metadata 写入 `cause_event_id`，与 Objective CAS 同提交。
不新增表、索引、轮询或模型请求，不依赖提交后才追加的诊断 Event。直接调用
没有真实因果时传 null，不伪造失败来源；旧依赖不回填推测值。

同 ResourceAvailable wait 的新 cause 取消旧依赖，并以新 Objective revision 建立新依赖代次；
同 cause 的重复更新保持原边，不制造第二个等待。新请求使用当前策略后失败，
不能被迟到的旧配置通知释放。Supervisor 从确切 dependency cause 读取真实
失败 Event；缺失、错误作用域、非 primary、已换代或请求 marker 相同时保持
等待。SQLite/PostgreSQL 共享这一原子语义；remote-store 沿实际 trait 生成
接线，不引入旧签名别名或兼容执行分支。验证须覆盖两提交顺序、同 wait
新旧 cause、无通知重开恢复、CAS 冲突及非 primary／新代次反例。

旧投影 backfill 只补当前 owner generation、kind／key 没有任何结构边的记录；
已有 pending、satisfied 或 cancelled 边都保持原样，不能因为显示 revision
增加而重造等待或复活已结束依赖。缺少新边的旧坏状态保留供既有一致性诊断，
不在迁移中猜造新的因果事实。

### 周期调度模板与真实任务组等待

原应用只读核对发现，误复制模型的旧 Thread 是周期调度模板，并非 Objective
当前代次的 primary Execution Thread。Objective 仍在等待真实、未完成的自有
Thread Group；不能把这个结构等待当成 Provider 故障等待清除，也不能强制提前
触发调度。修正仅作用于已确认误复制的模板模型／推理覆盖，保留原 Thread、
Group、Schedule 身份与触发时间。Schedule 自己显式设置的 `high` 不受影响。

周期调度的每次实际触发创建独立 occurrence Thread；它取 Schedule 的显式选择，
再取模板选择，缺省字段才继承同一 Session。模板的 operator 控制标记不会复制到
新 occurrence。回归必须经过实际 Runtime + Scheduler，证明清除模板选择本身
不发起请求、不改变定时器，而原定时触发只请求一次新模型且仍使用显式 `high`。
