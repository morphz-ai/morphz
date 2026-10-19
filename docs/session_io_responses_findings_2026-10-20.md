# Responses 与 Session IO：实际链路调研结论

日期：2026-10-20。本文是研究证据及后续实施边界，**不是完整修复或原应用验收报告**。
正式 Runtime、原模型配置和代理配置未在这些探针中切换；使用现有 DeepSeek
凭据、隔离合成数据与临时文件，不读取书库或修改正在执行的任务。

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

## 对实现方向的结论

- 不回到独立注解伴随调用，也不在正文里追加文本标记。
- 用已经批准的单次 Evaluation 值统一业务正文、工作提案和适用注解；Runtime
  构造 Session IO 身份外壳、步骤关联和实际执行状态，不要求模型编造这些字段。
- 启用时强要求适用注解；接收时容忍显示字段缺失。普通无工作聊天不要求活动摘要。
- 实际能力跟随**物理入口和冻结绑定**，不能只按模型名推断。原生 Schema 要真实
  发到支持的入口，且必须记录是否 strict；绝不把弱保证模式宣传成强保证。
- 注解开关不改变工具目录、工具参数或工作权限。关闭后的显示过滤属于确定性的
  Runtime 责任，模型偶尔多生成注解不能让关闭失效或让合法工作失败。
- 不把一次成功、HTTP 200、单元测试或 Provider 探针当作全链路验收。

## 尚未通过的交付门槛

统一解码器目前仍是未启用候选，正式新请求准入、全局 Context 提示、原生 API
选项、公开正文流和历史冻结绑定仍要一起接通并核验。特别要验证：实际工作首轮的
title/intent、结果归属、typed infer 和 discuss-script 无重复推理、取消与不完整
响应、工具权限、稳定工具目录、无额外补注解请求。

完成隔离真实 DeepSeek **完整 Runtime** 验收之后，才安全更新原 Runtime 与原应用，
并在原窗口验收。当前不更新未通过该门槛的候选，不宣称问题已经彻底修好。
Qwen、Kimi、GLM 及量化小模型仍是待补矩阵，未用本次 DeepSeek 结果替代。
