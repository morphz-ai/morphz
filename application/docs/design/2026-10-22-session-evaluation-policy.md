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
此首建接线须独立实现验证，不能由 read/update 专项通过推定完成。

源码核对补充：当前 Runtime `CreateSessionRequest` 和 `NewSession` 没有
模型／强度字段，不能把字段偷偷放进 POST 并假设生效。首次选择需要通过
Runtime 的原 Session／Principal 首建事务一起落库；不得以 POST 后再 PATCH
替代原子初始化，否则响应丢失后无法区分初始默认与用户后改的显式清除。
优先在原首建存储路径增加有类型的可选初始策略，旧调用仍以继承创建；两个
数据库共用同一语义、不增表、不修改旧 Session、不重置其他客户端选择。

现有 Runtime 表、索引、授权和删除生命周期不变；Host 此阶段没有新增持久
实体或 SQL 迁移。SQLite/PostgreSQL 都经相同 Runtime Session 接口。
后续若首建命令需增加字段，必须先扩充本文的账本／幂等设计与测试，不能
以临时 renderer 数据库或双写绕开。

## 验证要求

覆盖未开始只读零创建、默认共享路由与命名会话隔离、身份／范围变化、
错误 Context／Principal、非本人和团队拒绝、未知模型／不兼容强度、
过期指纹、同 Host 并发写冲突、PATCH 失败／失联／读回不符、清除覆盖。
真实 Host→Rust 验证改变 Session 默认不会中断或重放原请求，正常续接采用
新默认，显式任务保持原配置。UI 必须按确认回执显示，迟到结果不能污染新
范围，错误保留草稿并可重新读取。最后需真实 DeepSeek 和原应用验收。
