# Responses 与 Session IO：实际链路调研结论

日期：2026-10-20。本文是研究证据及后续实施边界，**不是完整修复或原应用验收报告**。
最初的隔离探针未切换正式 Runtime。04:29 的候选部署和后续原窗口长
Context 失败另见 [验收记录](session_io_unified_return_acceptance_2026-10-20.md)。
**05:06 更新：原窗口未通过；已抓到上游返回非法 JSON 的逐字节证据。
不能再以短 Context 探针通过，宣称这一方案已经解决可靠性问题。**

**12:31 后续结果：用户批准的原生工具＋普通 Chat 正文路径已在完整隔离 Runtime、
相关应用集成和原应用验证并部署 `70f59264`。见
[分阶段门禁与交付](session_io_native_candidate_gate_2026-10-20.md) 和
[原应用证据](session_io_native_deployment_evidence_2026-10-20.json)。**
本文的旧方案失败保留，不将这些早期失败覆盖成成功；实际交付没有采用最终 Chat
Schema、自动格式修复或注解伴随调用。

## 先把三件事分清

1. HTTP 接口返回 JSON，不代表模型正文是结构化的。Responses 的 HTTP 外层
   有 output、usage 等字段，里面的 output_text 仍可能是普通文字。
2. `text.format.type=json_object` 是 JSON 语法模式，不等于业务字段都符合 Schema。
3. `text.format.type=json_schema` 才把实际输出 Schema 作为 API 参数提交。
   OpenAI 文档说明，支持的模型及 Schema 子集可以使用 Structured Outputs；
   仍需区分拒答、截断、传输失败与正常完成。正确字段也不等于正确事实或工具授权。

依据：[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。
该能力不专属于 Responses，Chat Completions 也有相应参数；具体入口的支持程度不能
由它声称“兼容 OpenAI”来推断。

## 此前是谁说不支持

已抓到的实际链路是：Morphz 请求本地 `/v1/responses`，本地代理将 DeepSeek
请求转换并发送给 `https://api.deepseek.com/chat/completions`。后者返回 HTTP 400：
`This response_format type is unavailable now`，request ID 为
`b8e18d00-d62d-403b-b7b8-570def053044`。

所以这不是模型生成的一句“不支持”，也不是 Runtime 自己猜测的能力结论。
我们能定义自己的适配、参数和路由，但不能因此让上游任意端点接受未实现的参数。
也不能据这一次 Chat 入口的 400，泛称整个 DeepSeek 都不支持 Schema。

同一模型、同一有效凭据直连 DeepSeek `/responses`，确实接受 `json_schema`。
官方 [Responses 创建接口](https://api-docs.deepseek.com/api/create-response) 列出了
`text`、`json_object`、`json_schema`；
[兼容性说明](https://api-docs.deepseek.com/guides/responses_api#compatibility-details)
声明 `text.format` 支持，但同时说明部分不支持的参数会被忽略。
文档没有逐项列出与 OpenAI `strict` 同等的完整约束语义，不能据参数回显认定强保证。

上游原始证据及失败反例见
[原生输出研究数据](session_io_native_output_research_2026-10-20.json)。
HTTP 200、`status=completed` 甚至回显 `strict:true` 都不是我们跳过业务校验的依据：
该研究中有两次 `none` 冲突提示返回 JSON 标量 `5`，不符合要求的 object Schema。

## 本轮新增验证：最终答案正确仍不代表工作轮正确

### 原生工作调用加一条结构化消息

向 DeepSeek 明确要求同一物理响应内同时生成原生工具调用、工作标题和步骤意图。
实际第一轮仍只有 reasoning/function_call，**没有消息内容**。工具结果之后才在
最终答案中出现 `calls[0].intent`，已不对应这次响应中的实际调用。

这是两个真实请求的反例，不能用“给最终答案加了 Schema”宣称解决了执行中注解。
`text.format` 约束被返回的消息内容，不等于要求每个原生工具调用轮都生成消息。

### 单次 Evaluation 值

沿已 review 的单值方案，用同一个原生返回值承载 `body`、`effects`、`annotations`，
每个 effect 的 intent 紧邻其工作提案。实验中保持工具目录不变，明确设定
`tool_choice=none`，让模型通过 effects 提案；测试脚本只执行授权的合成文件读取。
这是**返回载体的选择**，不是关闭 Runtime 的工作能力，也不是由注解开关切换工具。

这组实验使用 `strict:false`：现有工具参数包含开放对象，不能为满足某厂商 strict
子集而悄悄裁剪、改写业务参数。因此本实验验证“单一结果的实际可用性”，
不宣称有严格受限解码保证，也没有关闭推理模式来换取结构化输出。

| 场景 | 真实请求数 | 结果 |
| --- | ---: | --- |
| max、注解开启、读取后回答 | 2 | 有工作标题、步骤意图、最终正文和结果注解；一次合成文件读取 |
| max、注解关闭、读取后回答 | 2 | 正文完整、未生成注解；一次合成文件读取 |
| none、注解开启、读取后回答 | 2 | 有工作标题、步骤意图、最终正文和结果注解；一次合成文件读取 |
| none、注解关闭 | 1 | 未通过：仍生成注解；探针在读取与第二轮之前停止 |
| 普通回复，含引号、反斜杠、换行、emoji、旧标签与 JSON 示例 | 1 | 正文逐字一致，无实际工作、无注解 |
| typed record，含 false、null、整数、String | 1 | 业务字段与类型完整保留，无工作、无注解 |

共九次请求，六个场景中的五个通过原探针断言，一个失败；九次原始 SSE 拼接均与
最终内容一致，工具目录摘要一致。脚本没有为格式错误重试或另调用模型补注解。

**单独的完整 Schema 复核不能省略：**用 ajv 6.15.0 对实际提交的 Schema 检查九个
返回，八个完全符合，一个不符合。失败值在 `max-on-work` 的显示字段
`annotations.observations`：Schema 要数组，模型给了 null。它的工作参数、标题和
步骤意图本身有效。不能把“工作成功”和“完全遵守生成 Schema”合并成同一个通过率。

上述两类不完美输出都应由已经批准的接收边界处理：关闭时不投影任何注解；开启时
只投影有效且归属正确的显示字段，缺少或错误的可选显示字段不能阻止合法工作。
这不表示可以修补正文、放宽业务参数或推测缺失的回答。

完整合成响应、Schema、独立校验结果、请求数、时延和源文件摘要见
[本轮传输证据](session_io_unified_carrier_research_2026-10-20.json)。
这里的流式证据是**原生接口 SSE**，不是原应用已能正确显示正文增量的证据。

## 历史检查点：隔离探针之后的实施判断

以下记录当时的判断；其可靠性结论已被后面的原窗口反例限制，不能作为当前交付结论。

- 不回到独立注解伴随调用，也不在正文里追加文本标记。
- 用已经批准的单次 Evaluation 值统一业务正文、工作提案和适用注解；Runtime
  构造 Session IO 身份外壳、步骤关联和实际执行状态，不要求模型编造这些字段。
- 启用时强要求适用注解；接收时容忍显示字段缺失。普通无工作聊天不要求活动摘要。
- 实际能力跟随**物理入口和冻结绑定**，不能只按模型名推断。原生 Schema 要真实
  发到支持的入口，且必须记录是否 strict；绝不把弱保证模式宣传成强保证。
- 注解开关不改变工具目录、工具参数或工作权限。关闭后的显示过滤属于确定性的
  Runtime 责任，模型偶尔多生成注解不能让关闭失效或让合法工作失败。
- 不把一次成功、HTTP 200、单元测试或 Provider 探针当作全链路验收。

## 历史检查点：部署前的交付门槛

截至本报告初次记录时，统一解码器仍是未启用候选，正式新请求准入、全局 Context 提示、原生 API
选项、公开正文流和历史冻结绑定仍要一起接通并核验。特别要验证：实际工作首轮的
title/intent、结果归属、typed infer 和 discuss-script 无重复推理、取消与不完整
响应、工具权限、稳定工具目录、无额外补注解请求。

完成隔离真实 DeepSeek **完整 Runtime** 验收之后，才安全更新原 Runtime 与原应用，
并在原窗口验收。当前不更新未通过该门槛的候选，不宣称问题已经彻底修好。
Qwen、Kimi、GLM 及量化小模型仍是待补矩阵，未用本次 DeepSeek 结果替代。

## 历史检查点：隔离 Runtime 后续验证（不是原应用交付）

同日进一步对工作区中的候选集成运行完整 Runtime：真实 Provider、调度、
临时 SQLite、工具执行和正文增量投影。此候选尚未提交为已验收修复，原应用
与原 Runtime 均未切换。测试只使用合成文件和合成 Host，不读取用户书库。

| 场景 | 真实请求数 | 本次观察 |
| --- | ---: | --- |
| 普通聊天、注解开启 | 1 | 正文流式显示，无无用活动注解 |
| 读取后回答、注解开启 | 2 | 一次读取；标题、步骤意图、结果与正文都有 |
| 读取后回答、注解关闭 | 2 | 一次读取；无显示注解；与开启时工具目录完全相同 |
| String typed infer | 1 | 中文、引号、换行、emoji 正常投影，无答案中继请求 |
| 原 discuss-script Harness、合成 Host | 2 | 真实运行 read-workflow/list，正文和适用注解交付，无额外中继 |
| Context 阅读进度保存 | 2 | 独立数据库实际版本从 0 变为 1，读取回执后交付正文和注解 |

合计六个场景、十次模型请求；各场景续接时工具目录摘要相同。不同 Harness
原本拥有不同目录，不能把跨 Harness 的不同摘要当作注解开关变更工具。
这些原生请求明确使用 `strict:false`，仍不代表服务端强制解码；接收端的
可选显示字段投影与严格业务校验仍有各自职责。

**回归并未全部通过：**`response_annotations_runtime` 当前 25 项中 21 项
通过、4 项失败，涉及缺省注解诊断、非 String 内部值流和两项旧任务恢复。
失败包含测试客户端的旧握手断言，尚未逐项确定属于测试适配还是实现问题，
不能笼统称为四个已确认生产 bug，也不能忽略。另有两项单元测试仍断言旧
提示词文字。真实 String infer 成功不能代替非 String 与恢复路径验收。

具体请求数、合成正文、正文 chunk 数、注解覆盖、日志及候选源码摘要记录在
[隔离 Runtime 检查点](session_io_isolated_runtime_research_2026-10-20.json)。
结论是统一路径已有真实可行性证据，但距离安全更新原应用仍有明确门槛。

## 04:43—05:06：原窗口与长 Context 推翻了交付判断

原应用正常刷新后，新建明确 TEST 会话，仍使用真实共享 Context（约
147,866 token）和原工具目录。两次只读书籍验收均失败：一次把 fenced
JSON 工作提案当普通正文并结束，另一次在读取前的提案中多了一个 `}`。
具体 Thread、原始响应和阶段记录见上述验收文档，未改成成功或删除证据。

随后使用同一捕获请求作**不执行任何提案**的隔离对照：

| 对照 | 观察 | 能否算任务通过 |
| --- | --- | --- |
| 原 json_schema / strict:false / tool_choice:none | 首轮 JSON 合法但 Host 参数缺 action；已拿到参数说明的一轮生成合法提案 | 否，只验证提案，不执行 |
| 只把 tool_choice 恢复 auto，仍要求 effects JSON | 两次非法 JSON；其中一次抓到完整上游 SSE | 否 |
| 只补“输出原始 JSON，不加 Markdown 围栏”的明确指令 | JSON 合法，Host 参数仍缺 action | 否 |
| 改用 json_object 语法模式 | JSON 合法，但生成不存在的顶层工具 reader.read | 否 |
| 同一 Schema 改 strict:true | HTTP 400：An object with no properties is not allowed | 否 |
| 同一已 describe 的请求改作原生函数调用对照，不要求注解 | 10.7 秒返回一个 host_morphz 调用，参数通过现有 Host 的纯解析／转换校验 | 否，未执行；也未验证新注解实现 |

一次较早的 baseline 受隔离探针 8,192 输出 token 上限截断，属于失败。
后续对照使用原请求的空 max_output_tokens 设置，没有调低原请求的 max
推理强度。表格不是可比较的成功率统计，Context 阶段和干预条件均有标注。

上游反例 `9a747390-ff96-48c3-9908-3feae77748aa`：

- 请求实际携带 json_schema、strict:false、35 个原工具定义，HTTP 200。
- output_text 中 `parameters` 之后多闭合一个对象，JSON 在位置 292 不合法。
- 原始 SSE delta 拼接、上游最终 message、Runtime Adapter 的 content
  三者完全相等，SHA-256 为 `a32768ae6244ac0eb4ea5eb692ac7547e3cc3117146c6a2f890b1617d604d2cb`。
- 因此这个反例不是我们流式拼接多插入一个括号；上游 status=completed
  也不是有效 Evaluation 的证明。另一例 fenced 提案被当正文结束，则是
  我们的隐式正文边界过宽，不能把这个责任推给模型。

官方文档声明支持 text.format，但未因此消除上述实测反例。准确结论不是
“DeepSeek 不会结构化”，而是**我们把原生工作调用搬进生成文本，又建立
在非 strict 的格式约束上，额外增加了序列化和解释风险；现有验收覆盖不足。**

复现入口是 `morphz/examples/session_io_request_probe.rs`。必须显式提供模型配置、
模型名、私有捕获请求、新输出路径和对照变体；请求的输出预算及推理强度来自捕获值。
探针不执行任何工作提案，输出文件以 0600、create_new 写入，避免覆盖已有证据。
报告中的 `decode_ok` 只代表归一解码通过，不代表工具参数、授权或业务结果通过。
本次另以原 Host 请求 Schema 及 operation 转换器做纯校验，没有调用实际处理器。
原始 Context 和 SSE 只留本机私有证据目录，不进入 Git；本轮 15 项统一解码单元测试
通过，也不能覆盖或推翻上述真实原窗口失败。

### 接收边界与 strict 限制的进一步定位

当前 `request_options` 根据物理入口能力选择原生 JSON Schema 或普通原生返回，
但 `ReturnBinding`、`unified::decode` 和 `ModelStreamNormalizer` 没有本次实际
物理编码模式这一字段。解码和流式仍按首字符／对象字段猜测。于是同一个 v2
绑定同时承诺“普通正文是数据”和“带 body/effects 的正文是工作提案”。
这不是依靠增加关键词或剥 Markdown 围栏能消除的歧义。

两个离线反例已放入 `unified_tests.rs` 的 `known_transport_boundary_regression_*`：

- 请求已选择 JSON Schema 时，fenced 工作提案不能以无工作普通回答完成；
  同时检查最终解码和公开流的 Completed 事件。
- 请求实际选择普通原生返回时，合法 JSON 协议示例不能被合成成 read 工作提案；
  普通正文也必须逐字保留。没有执行 read 或其他工具。

这些是显式 ignored 的**待修复断言**，不是绿色验收项。复现命令为：

```sh
cargo test -p morphz --lib known_transport_boundary_regression -- --ignored --test-threads=1
```

本轮实际执行结果为 **0 通过、2 失败**：第一项最终解码 accepted=true、公开流
completed=true；第二项合成了 1 个工作提案且没有逐字保留正文。这两项仅运行
解码／投影，不执行工具；第二项是离线边界反例，不是已观察到用户文件被操作。

真实上游请求的 generation Schema 中，唯一没有 properties 的 object 位于
`/properties/effects/items/properties/arguments`。其定义只有 type:object
和说明，没有 required 或 additionalProperties；工具名虽有 enum，具体参数
结构并没有按工具名纳入这个返回 Schema。因此服务端即使遵守这一 Schema，
也无法替我们判断 host_morphz 是否缺 action。原始工具参数定义虽仍在 tools
中，但当前 tool_choice:none 已让工作提案走另一处开放对象。
这与真实 strict:true 的 HTTP 400 相吻合；不能将其概括为模型不支持 JSON。

后续任何获批方案都须把**实际返回载体**和业务值类型分开冻结，并由同一份
绑定驱动请求参数、完整解码和增量投影。普通原生文本不得因内容长得像协议
而被解释为执行提案；明确请求的结构化返回不得因解码失败而伪装普通正文成功。
这是待修复边界，不是现在再给普通聊天加一层强制外壳的理由。

## 下一步候选机制：保留原生工作，Session IO 负责归一

早期阶段记录：用户已认可**先做隔离验证**，当时的候选适配器已实现但没有切入生产。
单步注解与长 Context 原生工作对照有通过样本；多步进度分流缺口已修复并重放，
但最终 Chat Schema 分支仍出现不必要的额外工作。用户已进一步批准工作后也保持
普通正文，不再单独生成最终结果注解；当时此路径仍在隔离验证。最新证据与后续门禁见
[原生候选隔离记录](session_io_native_candidate_gate_2026-10-20.md)。以下是被 review
的候选边界，不应阅读成已完成的产品行为。

这不是把正文和注解改回两次 deliver_message；整个结果仍只来自同一物理
模型响应，归一为一个内部 Evaluation。下面涉及的模型侧参数 Schema 变更
已获准做隔离验证；并未因此获准在门禁未通过时上线。

1. **输入不变。** Host 提交注册的 Session IO 输入，Runtime 校验、绑定
   当前 Human／Session／格式／权限并冻结；模型不制造这些确定性外壳字段。
2. **工作保留原生 function_call。** 不再要求模型把已支持的工具调用重写成
   正文中的 effects JSON。Runtime 使用真实 function_call 的名字、参数、
   ID，仍经过原工具参数校验、授权、调度与回执流程。
3. **步骤注解是同一原生调用里的可选结构化元数据。** 候选是一次性给模型侧
   工具参数定义增加保留命名空间，承载 intent 和适用执行摘要；不是 API
   已经提供了任意注解字段。Runtime 先拆分元数据，再把原业务参数交给原
   验证器／Host。保留字段冲突须在安装定义时拒绝，不能覆盖业务字段。
   这一调整已获用户认可；元数据拆分后的原业务参数及权限边界仍不改变。
4. **Chat 全程没有强制外壳。** 工作前、工作中和工作后，正文都走普通 message；
   如果模型选择工具，注解随第 3 点返回。无需预判用户输入属于聊天还是任务。
   不再为最终 Chat 单独要求结果注解或追加摘要请求，结果展示沿用真实正文。
   这是用户 review 后批准的变更，不是谎称上游不支持 Schema 的能力降级。
   调用方明确声明的结构化业务结果仍按原 Schema 返回，不能因失败改成普通文本。
5. **可选性只在接收端。** 开启时强要求适用工作注解，关闭时不要求／不投影；
   同一工具定义同时支持两个开关状态，不为开关增删或重排工具。缺失／无效
   元数据不阻断有效业务参数或正文，也不伪造结果。未知业务参数仍拒绝。
6. **Runtime 关联与结束。** 用真实调用、当前 Execution 和观察回执生成
   Session IO 输出事件。Chat 原生正文增量直接显示；类型化 infer 仅通过既有
   已证明的字段投影显示对外正文，不在业务值外再套 body 字段。
   没有工具且有完整正文才结束；仅注解不结束。不要额外补注解／中继推理，
   不剥代码围栏执行，不解析正文中的标签，不为格式失败自动重放已完成工作。

最初的原生调用对照仅证明了一条候选方向；早期隔离测试验证了部分第 3、4 点，
当时仍有真实失败，完整门禁没有通过。后来批准的普通正文路径及实际部署结果见文首。
原生函数参数仍来自模型，也不能免除 Schema 和权限检查；这条候选只是减少
重复序列化与路由表达，不是“原生调用永远不会错”的承诺。
当时要求的完整验证包含真实 DeepSeek 长 Context 的首次工具、结果续接、普通聊天、
关闭注解、typed infer、discuss-script、原窗口流式与终态，以及旧任务恢复。
Qwen／Kimi／GLM 保持后补。若继续要求所有工作都只通过一个文本 JSON 值
交付，则须另外 review strict 子集的无损编译或有界纠错策略，不能假装当前
strict:false 已提供这种保证。当前没有上线该额外 strict 编译或自动纠错方向。
