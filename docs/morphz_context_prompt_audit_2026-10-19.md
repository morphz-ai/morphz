# Context 提示与执行契约审查

状态：源码审查、相关自动回归与真实 DeepSeek 核验完成；原应用切换必须另核实际运行版本，不能以源码或本文代替。

## 审查范围

检查的是最终请求的组成，不仅是一个 System 字符串：三个已有 System profile、
Reality/Epistemic 公共契约、Yao Language Card、Context protocol 与动态 evaluate、
Context 操作和工具说明、Custom 规则、Harness profile/binding、infer 类型指令、
Session IO 格式、工作续接、维护／收尾／日程回执／拒绝恢复及协议纠正提示。
另沿实际来源 Event 和原生调用回执核对提示所承诺的行为是否可实现。

## 已确认的冲突与整改

| 问题 | 当前整改 |
| --- | --- |
| 旧的正文 JSON 封套、尾段与专用 reply，和正常正文规则并存 | 移除执行解析及专用工具；正文与独立类型化注解使用现有 Session IO |
| 通用规则称正文只回当前 Session，infer 指令却要求返回父 Plan | 明确实际 caller；内部 infer 有独立的模式、类型返回说明，不冒充第二次用户回答 |
| IO 载体 `morphz.chat` 容易被误当成返回类型，普通讨论规则可能遮蔽内部 record 返回 | 明确 caller/type 优先；即使嵌入的用户话题是普通讨论，infer 也必须返回完整声明值，由父 Plan 确定性投影，不能先抽出 reply 字段 |
| 虽允许隐式正文，后文却优先要求两个原生工具消息，把长正文再次放进 JSON 参数 | 原应用多段正文验收确实触发该路径，完整原响应已捕获；取消这个不必要偏好，默认普通正文＋同响应独立注解，保留等价显式 IO，而不放宽 JSON 校验 |
| 纯 infer／不调用外部工具／只返回声明 JSON 的要求，可能被读成连 Session IO 注解都禁止 | 区分业务效果、业务正文与通信消息；共同契约和内部 infer 的动态 tool-gate 同时明确启用时同响应交付注解，不额外工作或补推理；真实验收曾抓到省略，未按“正文没报错”冒充注解成功 |
| “工具调用后总再推理”把消息载体与工作混淆 | 工作才有必要工具往返；绑定返回与伴随注解提交后直接结束 |
| Delivery／维护／收尾分支移除 IO 工具，而提示仍要求交付注解 | IO 保留；阶段可执行权限与工具定义分开 |
| 临时阶段重建提供给模型的工具列表 | 同一能力路由的工具定义固定，当前阶段由 Runtime admission 强制检查 |
| 每次返回绑定被放进 Context 前缀，会破坏长前缀复用 | 移至 evaluation-environment 动态尾部；新增相同前缀／Inbox 字节与 cache key 回归 |
| 文本声明的 Context 顺序漏掉实际 Custom／格式定义／能力区 | 按实际编码顺序说明，不另造布局规则 |
| 语义 System profile 后又追加裸文字，破坏单 S 表达式 | 公共 IO／回执规则只装入 System 对应节点一次；Custom 规则也在根内 |
| “结果后必须再维护一次”与无多余推理、Mind 已准确的情形冲突 | 只有确需保留的状态变化才做 context_tx，不为结束回复或注解额外往返 |
| critical 先维护与 finalizing／维护额度用尽的指令互相阻塞 | 明确后两种 Runtime 阶段优先，不能再陷维护循环 |
| 恢复、冷却、收尾和中断续接仍使用“另一个工具／只返回剩余正文”等过宽排他要求；VM 注释核也残留只回 Session 与必须维护后结束 | 全部统一到实际 caller、业务／控制边界和独立通信消息；续接只补正文后缀但仍同响应交付注解，VM 核不再强制多做一轮维护 |
| evaluate.thread.id 使用了 Session／root 路由；部分协议路径不存在 | 使用真实 Thread ID，未知不猜；修正当前线程／交付模式的路径说明 |
| context-tx 的 reason-required-for 漏 retire-session | 与操作实现及工具说明对齐 |
| 新消息可以生成，但部分原生续接会过滤掉其调用或遗漏回执 | 按真实 call ID 保留调用／回执，不把显示元数据变成 Observation、Job 或工作唤醒 |
| 原生 IO 回执被通用工具回执错误赋予 Observation 引用 | IO 回执只关闭自己的调用；不生成 Recall 引用，也不允许作为工作结果注解来源 |
| 模型流事件没有实际 model_attempt_id，Session IO 草稿关联无法建立 | 从真实物理请求携带该 ID；用真实 DeepSeek 的提前到达增量核验，不以终态重放代替流式显示 |

另查到提示承诺与应用实际接线不符：Host 原本仍依赖 WebSocket 的一次性 started，
订阅稍晚便丢弃 infer 后续正文。已改用现有 Session IO 完整快照与增量作为唯一
正文直播来源；工作和持久事实继续沿原事件流。新增真实 Runtime＋Host 的迟订阅
测试：先生成正文前缀，再订阅应用，断言完整前缀和后续文字都在生产 Activation
仍运行时可见，终态只保留一份回答，不补推理。

对原应用当前启用的 Agent Custom（revision 87）也作了只读核对：人格、表达和
主动性要求没有注入退役回复协议；其约束明确不改变权限、事实或协议。没有替用户
改写自定义资料。本次也未修改 script-studio 2.3.0 的工具能力或另加讨论特例。

discuss-script 源码仍为一个逻辑 infer，后面确定性投影 reply；没有加入第二次模型
润色。现有应用呈现依赖经授权的 Harness 声明，不从任意模型字段猜业务语义。
正常资料读取产生的物理往返须与重复 infer 分开计数。

## 不以提示代替的边界

工具可见不等于当前允许执行；Principal、静态能力、Thread generation、资源导入、
返回类型、目标结算、取消与幂等均由代码和真实持久状态检查。
注解不能改变这些事实。公开正文没有新的文本分隔符、关键词或隐藏可执行协议。

## 必须核验的最终请求矩阵

- 开关 on/off：稳定 System／工具定义相同，仅冻结的动态绑定和格式数据不同。
- 普通正文、原生正文、内部 typed infer、单 infer Harness／discuss-script。
- 工具续接、日程回执、目标 finalizing、维护、恢复和缺失／无效元数据。
- 实际 caller、Thread 与 root 分离；取消、撤权、并发及重开不串来源。
- 草稿增量、恢复、终态去重；真实 DeepSeek 同响应交付正文和注解，不补推理。

## 已执行的核验

- 上一轮完整 `cargo test -p morphz --lib -- --test-threads=1`：1562 通过、0 失败、
  13 原有忽略；新增 IO 草稿来源／快照／终态的 3 项定向测试通过，完整重跑另核最终日志。
- response_annotations 的 Runtime／ingress／steer／store 集成：32 项实际断言通过；
  PostgreSQL 用独立临时实例另跑 store conformance，来源／伴随消息的原子回滚与幂等通过。
- 经 `npm test -- <相关文件>` 的实际 Runtime＋Host：15 项通过，0 跳过；
  Session IO、应用注解／活动、类型值呈现、设置与错误呈现等领域回归另有 53 项通过。
- IO 草稿、Host Feed、授权／撤销／断线／缺口与历史读取：47 项通过，0 跳过。
  实时来源测试的夹具已补齐生产代码实际使用的 exact-root 读取；没有修改生产权限规则。
- 实际 script-studio Harness 的合成讨论：无资料读取时 1 次物理请求；项目分段读取时
  4 次物理请求；两种均为 1 个逻辑 infer、无创作写入、无外层模型改写。
- 本机已配置 `deepseek-flash`、OpenAI Responses 路由真实调用：普通 on/off 均为
  1 次模型请求、0 工作 Job，分别有 152／130 个终态前正文增量；工具定义的顺序与
  完整字节哈希相同。discuss-script 为 1 个 infer、1 次模型请求，
  本轮实际产生 155 个生产 infer 终态前增量、应用正文 5 个不同显示值；声明类型
  验证通过，父 Plan 确定性发布 reply，标题和结果注解真实存在。

这些是提交前工作树的验证，不是 Provider 缓存命中率或对任意模型的保证。
原始合成证据和构建摘要保留在本机私有验收目录，不含请求认证头。

整库 `npm test` 没有绿色结果：本轮未改动的 UI 归属审计有失败，三个 UI 挂载
测试 worker 长时间未退出；已中止该自有测试组并由管理器回收临时 PostgreSQL。
没有删除这些断言、把未运行项算通过，或把无关 UI 改动混入本次修复。
