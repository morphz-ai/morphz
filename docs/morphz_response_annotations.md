# 响应、返回值与注解：Session IO 当前契约

2026-10-19。状态：实现、相关自动回归与真实 DeepSeek 已核验；原应用仍须核对实际运行版本。
核验范围和整库测试的已知缺口见 [Context 审查记录](./morphz_context_prompt_audit_2026-10-19.md)。旧载体的历史记录见
[历史记录](./archive/2026-10-17-response-annotations-history.md)；
本轮之前的完整文档可从 Git 的 d98f4e4c 版本读取，不构成当前执行接口。

## 一条返回机制

每个 Evaluation 的实际调用方由 Runtime 决定：用户求值返回当前 Session；
内部 infer 返回父 Plan 的声明类型值。父 Plan 按原续接继续，尾位置直接传递，
不再请求一个模型来改写或转述。返回一个子值不等于完成父工作或 Objective。

Runtime 为真实 Thread ID、generation、Evaluation 创建返回绑定，冻结实际格式和
注解选择。绑定位于现有 Context 的 evaluation-environment.session-io-return，
不放进缓存前缀、用户正文或工具定义。模型不能选择另一个调用方。

正文有两种等价表达：

- 普通 assistant content：原文就是隐式返回值，绝不扫描控制标记。
- 既有原生 deliver_message：使用 Runtime 给出的 delivery_id 和格式返回相同值。
  message.format 只有 id/version；encoding 属于 content，不复制绑定的内部哈希。

其他 delivery_id 仍是普通发布，不会自动结束 Evaluation。绑定的文本返回不能
混入工作或控制调用；中途文字随实际工作调用出现时仍是进度，不是假终态。
仅有注解没有正文不是一个回答。no_reply 仍保持真实静默／有限等待的原约束。

Yao 声明的 Bool、String、Json、具名数据或 Program 值继续通过原类型边界；
其合法 JSON／Yao 传输是业务值，不是把 Markdown 与注解再包成一个文本 JSON。
本轮没有 entry-result、模型专用关键字或正文里的隐式指令协议。

## 注解是独立消息

注册格式：morphz.response.annotations，版本 1，仅 JSON 数据。
使用既有通用 deliver_message；没有注解专用工具，不在业务参数里注入字段。

消息内容为：

- execution：整项执行的 title、当前 progress、实际 result。
- calls：本次原生调用数组中的 index 与该调用的 intent。ID 和权限不由模型提供。
- observations：仅解释这次请求实际提供且当前执行有权使用的 ref。

默认使用普通 assistant content 返回完整正文，并在同一次 Provider 响应中发送
独立的原生注解消息。不能仅因开启注解就要求把长篇 Markdown 放进工具的 JSON
参数；内部 infer 也直接返回其完整声明值，不重复包裹。显式绑定正文消息仍是
等价的 IO 选择，不是默认偏好或强制格式。没有第二次求摘要、标题、改写、
补正文或修复元数据的推理。

格式和元数据有界校验独立于业务值。注解缺失、字段无效或越界时保留诊断，
不伪造标题／结果、不掩盖已有合法正文。非法主返回、歧义返回、混入工作、
不合法业务类型、资源导入及权限问题仍必须阻断，不能借显示元数据放行。

工具轮的注解也走同一消息。Runtime 在实际来源旁保存其原生交付回执，
下一次必要工作请求保留原调用与回执的准确关系。回执不是认知证据、工作结果、
新 Job 或唤醒源；注解 result 也不能证明工作成功或结算 Objective。

## 一个开关，工具定义不变

设置仅接受 off/on。省略时在准入处取 Runtime 默认值，随后冻结在真实 Thread。
定向补充、子 infer、已准入日程和精确重试继承原选择；新执行才采用新默认值。

稳定系统契约始终相同，当前开关在动态返回绑定中表达。关闭时模型不生成注解，
Runtime 也不将误发的注解接受为活动说明。普通正文和业务类型不受开关影响。
没有 auto、版本枚举、旧名别名或按模型偷偷切换。

Desktop 既有设置写 orchestrator.response_annotations，热更新准入默认值。
GET/PUT /api/runtime/response-annotations 仍由管理权限、预期值和落盘事务控制；
更改设置不重启 Runtime、不唤醒工作。

工具名称、Schema、说明与顺序一次性清理后，在同一能力路由内保持稳定。
开关、普通问题、维护、最终交付等临时阶段不重写工具定义；当前可执行操作
由独立 Runtime admission 检查。真实静态能力／requires／授权边界仍然有效。
Session IO 是消息交付能力，不借此增加文件、网络、目标或业务操作权限。

定义字节稳定不等于已经测得 Provider 缓存命中率，不作这种推断。

## 持久化与关联

权威仍是现有 Event、Thread、Activation、Plan；不新增表、SQL 列、索引、
Renderer 数据库或注解拥有的业务对象。

实际响应来源保存原始 Provider adapter 输出、冻结返回绑定、提取记录及诊断。
伴随消息的 Event ID 从真实来源 Event 与实际原生调用位置派生。Session、
Principal、root、Thread、generation、Activation、model attempt 和正文关联
全部来自 Runtime，而不是模型字段或当前界面。

SQLite／PostgreSQL 在同一来源 Event 写入事务追加其伴随消息／拒绝回执，
重试用相同身份且不重复。消息使用原 Event 顺序、游标、授权与保留生命周期。
它们不增加 Observation、认知时钟或工作唤醒。原生回执与工作回执按准确
tool_call_id 关联，不能凭数组第一项推定某个业务操作成功。

正文返回与真实执行终态仍走原 outcome 原子边界。元数据先提交不代表正文、
工作或目标已经成功。两阶段间崩溃从原响应、原绑定和原调用回执恢复，
不得重新请求模型、重放副作用或跟随当前设置改写旧请求。

控制失败保留有界原响应捕获、完整性状态、字节数和摘要。它不是上游 HTTP
原包，不含认证头或隐藏推理；不能根据清洗后的正文推定模型没生成注解。

## 流式与呈现

普通 content 的 text_delta 按原样转发，协议示例、代码、花括号都只是文字。
原生绑定正文只对标准工具参数 JSON 的对应文本叶子增量解码；
处理正常 JSON 转义、分块 Unicode 和有界缓冲，不猜测正文中的控制语法。
只有绑定身份、格式和编码吻合后才发布正文草稿；最终完整内容仍严格校验。
注解参数不进入正文流。

保留既有草稿身份、顺序、失败状态、断线快照及终态去重。infer 返回终态
清理同一草稿，晚到片段不能复活。活动说明只解释真实执行，不改变事实。

应用的正文直播直接读取既有 Session IO SSE。完整草稿快照携带 Runtime 实际
Thread／Activation／model attempt／infer 来源和首次可见时间；随后以同一
output_id、delta_seq 接续。应用不再依赖是否恰好收到 WebSocket 的一次性
started，WebSocket 只继续提供工作与持久事实，不作为第二份正文增量。
重复序号丢弃；缺口重新取得完整快照，不拼接未知前缀的后缀。授权、Session
隔离、撤销、取消、终态和内存上限仍逐层检查；显示草稿不是业务返回已通过校验。

discuss-script 已是单个逻辑 infer；Yao 后续直接取其 reply 字段。
应用已有根据真实 Harness 声明投影该字段的呈现，不靠模型 JSON 恰好有
reply 键来猜测。此链路需同时验证正文增量呈现与最终去重；读取资料造成
的正常工具往返不等于第二次 infer，也不能冒称一次物理请求。

不显示元数据 JSON、“求值结果／已用于回复”等内部标签，不恢复复制原请求
的“处理：xxx”兜底。不因注解开关屏蔽正常正文或失败后的原输入。
后续输入从真实失败状态理解未回答请求；不匹配“继续”等关键词重放工作。

## 切换与验收门槛

当前仅实现最新载体：删除退役文本解析器、尾段协议和专用工具定义，
不添加旧调用执行分支。已有身份、正文、草稿、回执、历史和未来安排必须保留。

原应用切换前先核对在途模型／工作／等待边界，按原位置安全排空并备份；
不重发用户工作。Runtime 与原 App 必须实际更新到已验证提交，不能只交源码。

需分别验证：原生／隐式正文、元数据局部失败、严格业务类型、流式分块、
同一路由开关及阶段下的工具字节、来源与授权、补充／等待／取消／崩溃恢复、
SQLite／PostgreSQL 的同事务与幂等、单 infer Harness 和 discuss-script，
然后用实际可用的 DeepSeek 路由复验，并检查原应用。合成测试不能代替这些证据。
