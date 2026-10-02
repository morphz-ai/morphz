# 人格化个人助手：Profile 与 Custom

当前机制名为 **Custom（自定义上下文）**。第三方调用方拥有 Schema、嵌套结构和正文；Runtime 提供持久版本、身份范围、只读挂载和缓存契约，不解释人格或行业业务字段。Profile 只是应用定义的一个 Custom Schema，不是 Runtime 的人格内建设置，也不是 Mind 记忆或可执行插件。完整 Runtime 机制见[Custom 设计](../../docs/context-custom.md)。

## 应用边界与数据权威

Agent 名字、人格和风格由实际 Agent 的 Custom 版本保存；Human 名字与称呼使用同一实际 Agent 下、精确 initiating Principal 的私有范围。名字不重命名 Agent ID、Principal、Session 或 Thread，不搬移历史。头像仍由 Platform 与中心 ManagedArtifactStore 保存，独立修订，不进入 Custom，不因人格关闭而删除。

本机单用户 Host 可确认主 Agent 的 Profile 修改；Team Human 只能修改自己的资料，Team Agent 在尚无明确管理员边界时只读。Host 使用私有 operator 凭据访问 Custom，gateway 凭据只登记真实 Human。模型只获得有效 Profile 读取或待 Human 确认的建议，不获得通用 Custom 写入权。关闭整份或停用自定义风格，不以清空内容冒充关闭，不将 retained 文字通过工具结果交给模型。

## Schema 与兼容边界

Profile 消费者的 canonical 导出为 `profileCustom`、`compileProfileCustom`、`parseProfileCustom` 和 `profileAuthoringProjectionMatchesCustom`。旧 `*Rom` 导出仅为 deprecated source alias，不产生第二份权威或不同 BODY。

下列持久身份与格式保持原样：

- Agent：`morphz.profile.agent`，新写 `morphz-agent-profile/v2`；原 `morphz-agent-profile/v1` 继续可读。
- Human：`morphz.profile.human`，新写 `morphz-human-profile/v2`；原 `morphz-human-profile/v1` 继续可读。
- BODY 仍使用 `(agent-profile …)`／`(human-profile …)`；作者状态仍为 `(profile-authoring (version 1) …)`。正文编码、内容哈希域、CAS、command receipt、原资料及历史 Thread 不为改名而重写。

Host 的实际 GET list／GET record／PUT record 统一请求 `/api/agents/:agent_id/custom` 及 `/custom/:namespace`，Human 带真实 `principal_scope`。不在 Custom 404 后偷偷回退旧路由，以免把不支持的 Runtime 当成成功；旧 `/rom` 路由的兼容由 Runtime 自身提供，指向相同持久数据和授权边界。

## 有效配置与编辑状态

业务字段 `null` 表示不设置，编译时完全省略，不转成数值 0、默认风格或 UI 回退名字。四项数值均为 0–5 的明确行为偏好，保留实际数值及量表解释；不是模型权重、temperature 或能力评分。数值 0 仍是有效设定。

默认 Profile 全空、关闭，查看不写入。Agent 总开关可以直接启用／关闭，即使当前全空也保留用户明确选择；空 v2 Agent Profile 的精确 BODY `(agent-profile (version 2))` 不绑定到新 Thread。Human 的既有全空关闭规则保持。关闭整份保留所有显式字段，新工作不选择它；旧 Thread 仍使用原已绑定版本。

自定义风格单项关闭保留原文和 `customStyleEnabled=false`。有效 BODY 完全省略该项；operator-only `authoring_state_sexpr` 在同一版本、CAS 与 SQL 事务中保存编辑内容。Host 核对作者状态的有效投影与 `canonical_sexpr` 相同；Thread、Context、模型请求和 Agent 读取只包含有效内容。重新开启恢复原文，清空文字才规范为 `null`。

名字、称呼继续原位编辑和自动提交；显示回退不写入配置。普通新输入在 staging 前确认当前身份队列的待保存意图，失败保留消息草稿，不用新工作绑定尚未确认的设置。新 root Thread 绑定当前有效版本；已有工作续写、工具调用和恢复使用已冻结版本。

## Context 与缓存

新 Thread 挂载 `(custom …)`，位于稳定 prefix 内、动态输入之前。空配置保持旧请求和缓存契约；已绑定旧 Thread 的 `agent-rom` 编译版本、原 Context 字节和旧缓存契约保持，不能因术语迁移重绑。规范内容、排序、精确版本、manifest 和 compiler hash 共同确定缓存契约；这不是供应商缓存命中率保证。界面折叠、头像 URL、随机值和作者编辑文字不进入模型 prefix。

## 验证与历史记录

`profile-custom-client.test.ts` 的 HTTP 协议端点只提供 `/custom`，验证实际 Client list／get／put 请求、真实 Agent／Principal 选择、CAS、幂等、完整 0–5 数值、关闭保留、作者状态核对及凭据脱敏。它是受控协议测试，不冒称真实 Rust 持久化或模型遵循。

`profile-actual-transport.spec.ts` 验证实际 UI → typed Host → 隔离 SQL → Rust Runtime → Provider 请求，使用 Custom 新槽并检查默认／关闭零内容、冻结版本、Human 私有作用范围和停用原文隔离；Provider 回答受控，不能当成主观人格质量或付费模型验收。本轮命名修改不调整 UI 或重启原应用。测试结果由本轮实施记录单独记录。

此前产品迭代、被否决交互与验收数字保留在[历史 Profile／ROM 设计记录](39-profile-rom-production-design.md)，不把旧实验描述当作当前界面或本轮新增证据。
