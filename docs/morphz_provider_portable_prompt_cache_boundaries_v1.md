# Morphz Provider 可移植 Prompt Cache 边界设计 v1

> 状态：Platform/API 显式断点已实现；Structured ContextDelta 是默认关闭、按 Provider/模型显式启用的实验编译特性；真实 GPT-5.6 任务已验证其必要收益
> 日期：2026-08-30
> 适用范围：Context Encoding、模型请求封装、Provider Adapter、缓存用量与成本观测
> 前置设计：[Prefix Cache 友好的 Context Encoding 正式布局 v1](morphz_prefix_cache_context_encoding_layout_v1.md)

> **2026-08-30 最终证据更正：** 98.79% 来自无 tools、超长上下文的 synthetic capability
> probe，不能替代真实 Agent 请求。相同 Terminal-Bench 题的真实 GPT-5.6 请求显示：旧实现
> 预热后命中 23.81%；固定普通工作轨迹的工具 schema 后为 50.68%；固定工具并启用单 User
> message、canonical Context seed + Structured ContextDelta blocks 后为 92.93%。所以
> `implicit-prefix` 能力存在，但默认单 block 真实请求仍未达到 85% 成本线；ContextDelta
> 继续保持实验性，却已有明确真实任务收益。完整证据见
> [九模型默认 Structured Context 隐式前缀缓存实验](research/paper_evaluation/prompt_cache_nine_model_default_context_20260830.md)。

## 0. 2026-08-29 实现更新

ME-08 的后续分析确认：第一阶段只把“完整 Inbox 末端”设为显式断点，下一轮追加
Observation 后该断点会移动，因此实际命中长期停留在固定 System/协议前缀。当前实现已经
补齐这一缺口：

1. Renderer 在每条 canonical Observation 末端标记候选边界，模型可见文本逐字节不变；
2. 请求规划器保留与当前 Inbox 仍匹配的最近历史末端，并始终选择当前 Inbox 末端；
3. Planner 每次最多选择四个边界：固定协议边界、最多两个最近历史 Inbox 边界和当前
   Inbox 边界；支持公开字段的 API 路线将其编码为显式断点，Codex OAuth 路线保留相同
   `input_text` 内容块但不发送显式元数据；
4. Cache Cohort 不再由 `context_id` 派生，而由物理模型、实际缓存 wire mode、有效推理档位、
   工具合同、System Message 和稳定 Context 前缀共同哈希，因此同一策略下跨 Context 的相同
   稳定前缀可以复用，同时配对实验的 implicit/explicit 两臂不会共享缓存命名空间；
5. Retire、Restore 或较早 Observation 变化时，内容哈希不再匹配，规划器自动退回固定协议
   与当前 Inbox 两个边界并重建缓存；
6. 进程内只保存最近 256 个 Cohort、每个 Cohort 最近 50 个边界；状态丢失只造成冷启动，
   不改变 Context 语义。

确定性请求合同和完整 `morphz` 库回归已通过。API 小样本已证明显式写入、复用和前缀变化
失效的因果链；Codex 同消息 content-block 线路已有 96.6% 的真实隐式复用证据。随后确认这条
证据只证明受控请求具备缓存能力，不能代表完整生产合同。真实请求还受到 tools 集合/顺序、
Context block 边界和动态状态影响：稳定 tools 只把预热后命中提高到 50.68%，Structured
ContextDelta 才把同题提高到 92.93%。第 2.3、2.4 节因此仍是当前实验兼容路径的有效依据。

## 1. 要解决的问题

Morphz 已经把 Context Encoding 调整为下面的稳定顺序：

```text
protocol / evaluation-profile
        ↓
append-mostly inbox
        ↓
observation-state / mind / session-directory / kernel
        ↓
evaluation-environment / evaluate
```

这个顺序保证动态状态不会改写其前面的稳定字节。在支持自动前缀识别的 Provider 上，
真实 A/B 已经证明这种布局能够显著提高缓存命中率。

缺陷修复前的生产请求还有一层没有表达出来的物理边界：Runtime 先通过
`compose_context_message()` 把自然语言引导和完整 Context Encoding 合并为一个
`String`，OpenAI Responses Adapter 再把它序列化为单个 `content`：

```json
{
  "role": "user",
  "content": "固定引导文本\n(context ...完整内容...)"
}
```

S 表达式内部虽然存在稳定前缀，Provider 请求里却没有对应的内容块和缓存断点。只要
Context 尾部发生变化，某些 Provider 或代理线路就无法复用这个字符串内部已经处理过的
稳定部分。ME-08 中 GPT-5.6 Sol 路线的缓存命中率约为 16.3%，与此前自动前缀缓存 A/B
达到的约 88% 存在明显差异。

本设计要解决的是：

> 在不改变 Context 语义、不改变 Yao 语法的前提下，把 Context 已有的稳定分区映射成
> Provider 能识别的请求内容块和缓存边界。

这是请求封装层的缺口，不是 Structured Context（结构化上下文）机制本身的缺陷。

## 2. 已完成的真实验证与证据更正

2026-08-28 使用现有 `mini-m4.local` CLIProxyAPI 路线，对 GPT-5.6 Sol 做了单条
User Message 内多内容块的真实 A/B。Morphz 侧请求把 `content` 划分为两个
`input_text` 块，并在第一块末尾设置显式缓存断点：

```json
{
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "稳定前缀",
      "prompt_cache_breakpoint": { "mode": "explicit" }
    },
    {
      "type": "input_text",
      "text": "本轮变化的尾部"
    }
  ]
}
```

稳定块为 77,721 个 UTF-8 字节。验证结果如下：

| 请求 | 输入词元 | 缓存输入词元 | 命中率 |
| --- | ---: | ---: | ---: |
| 普通短请求对照 | 311 | 0 | 0% |
| 首次写入稳定块 | 24,115 | 0 | 0% |
| 稳定块不变，只修改第二块 | 24,115 | 23,296 | 96.6% |
| 修改缓存断点之前的内容 | 24,115 | 0 | 0% |
| 恢复原稳定块，再修改第二块 | 24,115 | 23,296 | 96.6% |

物理响应模型为 `gpt-5.6-sol`。后续请求捕获、CLIProxyAPI 翻译器审计和绕过 Proxy 的
直连对照确认：该 Proxy 在转发 ChatGPT Codex OAuth 请求前删除
`prompt_cache_options` 和 `prompt_cache_breakpoint`。因此这组 96.6% 结果只能证明稳定前缀
布局能够被**隐式缓存**复用，不能证明显式断点被上游执行。此前把它写成“显式断点真实
验证”是证据归因错误，现更正为：

1. 相同的长前缀和变化尾部可以在该线路获得 96% 以上的隐式缓存命中；
2. 修改长前缀会让缓存失效，恢复原前缀后可以再次命中；
3. 本实验没有隔离出显式断点字段的因果效应；
4. 显式断点的接口可行性必须在真正支持该字段的 Platform `/v1/responses` 端点另测。

`prompt_cache_key` 仍然是上游接受的缓存分组提示，但它不等于内容边界，也不能让变化字节
之前的任意位置自动成为可复用断点。

该线路没有报告 `cache_write_tokens`，但后续请求报告了 23,296 个 cached input tokens，
足以证明稳定前缀被实际复用。不同 Provider 对写入用量的报告字段并不统一，不能把
`cache_write_tokens = 0` 解读为没有写入缓存。

这只是实现可行性验证，不作为论文实验结果。

### 2.1 生产路径验证的正确解释

第一阶段实现完成后，又使用 Morphz 正常请求路径进行了隔离烟测。实际链路为：

```text
Morphz → CLIProxyAPI（mini-m4.local）→ OpenAI Responses 协议 → GPT-5.6 Sol
```

在同一个持续运行的 Runtime 进程、同一 Context 和同一 Session 中连续发送两轮对话请求，
第一轮为 20,853 个输入词元、缓存命中 0；第二轮为 21,202 个输入词元，其中 11,776 个为
缓存输入词元，命中率为 55.5%。这证明 Morphz 生产请求能够形成缓存命中，但由于 Proxy
删除显式字段，不能证明 `prompt_cache_breakpoint` 已被上游执行。

另一个紧接着完成的同激活工具回合没有观察到缓存命中。两次观测说明“字段已经生效”与
“每一次连续调用都会立即命中”不是同一结论；缓存建立时机、请求前缀变化和工具回合间隔
仍需由正式 A/B 分开测量。本文不把这组烟测当作最终成本结论。

### 2.2 ChatGPT Codex OAuth 与 Platform API 是两个能力边界

2026-08-29 对当前登录账户绕过 CLIProxyAPI，直接请求
`https://chatgpt.com/backend-api/codex/responses`：

- 不带显式字段的相同请求可以成功，并在 exact repeat 上达到约 95%–98% 命中；
- 带顶层 `prompt_cache_options` 的请求稳定返回 HTTP 400：
  `Unsupported parameter: prompt_cache_options`；
- 只带内容块 `prompt_cache_breakpoint` 的请求也返回 HTTP 400，表明该 Codex 后端没有执行
  Platform 文档描述的显式断点契约。

为排除“Proxy 原样透传、错误其实来自上游”的歧义，又对 CLIProxyAPI `v7.2.140` 做了相同
请求的三组配对探针：只带顶层 options、只带内容块 breakpoint、两者都带。三组请求经 Proxy
均为 HTTP 200；相同 payload 直连 Codex 依次返回对应的 HTTP 400。该版本的官方 tag 源码也
在 `ConvertOpenAIResponsesRequestToCodex` 中先删除 `prompt_cache_options` /
`prompt_cache_retention`，再遍历删除内容块 `prompt_cache_breakpoint`。因此“7.2.140 会剥离”
是当前端点/版本的实证结论，但不能外推为所有 Proxy 或未知兼容端点的默认行为。

OpenAI 官方 Platform 文档同时明确规定：GPT-5.6 及后续模型的 `/v1/responses` 支持
`prompt_cache_options.mode = explicit` 和内容块级 `prompt_cache_breakpoint`。因此能力必须
由“物理端点 + Adapter revision + 物理模型”共同决定，不能只由 `gpt-5.6-sol` 模型名决定。

同日又对当前配置的 Cloudflare API 路线做了最小字段探针。物理模型使用该路线要求的
`openai/gpt-5.6-sol` 标识；baseline、仅顶层 options、仅内容块 breakpoint、两者同时存在
四种请求均返回 HTTP 200。随后用约 7.8K 输入词元做了受控长前缀验证：

| API 请求 | 输入词元 | 缓存写入词元 | 缓存读取词元 |
| --- | ---: | ---: | ---: |
| 显式模式首次写入 | 7,822 | 7,819 | 0 |
| 保持原前缀并追加新回合 | 7,833 | 0 | 7,819 |
| 修改稳定前缀第一个词 | 7,822 | 7,819 | 0 |
| 隐式模式首次写入 | 7,822 | 7,819 | 0 |
| 隐式模式保持前缀并追加 | 7,833 | 11 | 7,819 |

这组结果证明当前 API 路线真实支持 GPT-5.6 显式字段，也证明 append-only 前缀在显式和
隐式模式下都能复用。它不等于“单个 monolithic Message 的任意变化后缀也能复用”；后者
正是原实验观察到会失效的形态。因为用户明确要求停止额外 API 消耗，未继续跑完整任务集。

同日完成的真实 Morphz 单任务 transport-only 试验，把 canonical Context 的 Inbox 末端拆成
一个 User Message，并把变化尾部放入后续 Developer Message；模型可见字符拼接保持相同，
但请求角色结构发生变化。四次调用合计 94,934 个输入词元、23,552 个缓存词元，命中率仅
24.81%，与未分割基线没有改善，因此该试验已经回滚。

这个失败只排除了“跨 User/Developer Message 改写角色结构”的方案，不能排除同一 User
Message 内的 content-block transport。第 2 节的 96.6% 实验恰好属于后一种形态：Proxy
剥离显式字段后仍保留两个 `input_text` 块，稳定第一块被隐式复用。因此先实现了更窄的
同消息 content-block 策略：仍是一条 User Message、仍是同一 canonical 文本，只把 Planner
已选择的边界保留为多个 `input_text` 块；不发送显式缓存字段。

2026-08-29 的真实 `git-multibranch` 运行否定了把最小探针外推到多步 Agent 的做法。该策略
9 次请求合计 257,283 input / 70,656 cached，命中率 27.46%；排除前两个冷请求后为 33.29%。命中
请求的缓存量始终固定为 11,776 tokens，另有一次相同 Cohort 请求为零。相同 task ref、
`gpt-5.6-sol/max` 的官方 Codex 两次有效运行分别达到 354,048 / 384,354（92.12%）和
517,632 / 550,714（93.99%），reward 均为 1。因此差距不能用题目本身的低缓存上限解释。

后续同题实验进一步定位了 11,776 平台。v4 把 Planner 选中的段落映射为连续 same-role User
message items，但仍沿用了“最多四个显式断点”的移动窗口；8 次请求合计 217,711 input /
47,104 cached（21.64%），排除两个冷启动请求后为 27.21%，标准 verifier reward 为 1。v5
改为确定性 message-item 拓扑，旧段落边界不再重排；10 次请求合计 275,530 input / 94,208
cached（34.19%），排除两个冷启动请求后为 40.79%，reward 同样为 1。v5 消除了 v4 的间歇
归零，但后 8 次请求仍全部精确命中 11,776。

最初把 v5 解释成“Codex 不缓存完全不变的 same-role message 前缀”是不充分的。源码级 wire
审计发现，canonical Context 的真实形态是 `稳定头 + Inbox Observations + 关闭/状态尾项`。
message-item 模式下，第 N 轮结尾是 `... Observation N, 尾项`，第 N+1 轮则是
`... Observation N, Observation N+1, 尾项`；新观察插在旧尾项之前。旧观察 item 虽然逐字节
不变，但上一轮**最新** User item 是尾项，完整旧 item 序列并不是新序列的严格前缀。
因此 v5 证明的是 Morphz 没有制造出更深的合格断点，不是 OpenAI 拒绝复用一个已经证明
完全相同的合格断点。

这与当前 [OpenAI Prompt Caching 文档](https://developers.openai.com/api/docs/guides/prompt-caching)
一致：GPT-5.6 Platform 的隐式模式在最新合格 User 或 Tool Message 末尾放置断点；普通
`input_text` block 本身不是隐式断点，内容块内部只有显式 `prompt_cache_breakpoint` 才能选择
边界。ChatGPT Codex OAuth 是独立物理端点，其内部隐式布局不能只凭 Platform 文档假定，
但 Morphz 必须先证明自己的 outbound wire 前缀严格成立，才有资格把未命中归因给端点。

v6 把所有结构段保留为确定性 `input_text` blocks；已取回的前三次 usage 仍是
`0, 0, 11,776` cached。远端 SSH 身份失效前没有取回完整尾段和 verifier，故该运行只作为
早期反证，不宣称完整任务结论。

这也说明 85% 不能机械套用到短题整题累计：v4 的两个冷启动请求已经占 44,609 input，即使
其余 6 次调用全部缓存，按该次调用形态计算的累计上限也只有约 79.5%。同题比较必须同时报告
整题累计率、排除冷启动后的 hot-path 命中率、不可避免的新增长词元和 verifier。官方 Codex
之所以能在同题达到 92--94%，也与其 22/31 次调用摊薄冷启动有关；这不影响 11,776 固定平台
仍是 Morphz 实现缺陷的结论。

Provider 在最终 outbound Responses body 上记录两类
不含模型可见内容的事件：

- `provider.prompt_cache.wire_audit`：请求参数 SHA-256、每个 input item 的类型/字节数/SHA-256、
  与上一请求的最长公共 item 前缀、上一请求是否为严格前缀，以及当前请求能匹配的最长历史
  隐式断点；
- `provider.prompt_cache.wire_outcome`：用同一 request sequence/digest 关联 Provider 报告的
  input、cached、cache-write 和 uncached tokens。

这个协议已经把“我们的前缀没成立”和“Provider 没有复用已成立前缀”分成了可证伪的两个
分支，并直接定位出旧方案的问题：新的 Observation 插在 canonical tail 之前，旧请求不是
新请求的严格前缀。

### 2.3 Codex OAuth append-only transcript 的历史单题结果（未作为产品设计采用）

修复版在不改变 Structured Context 权威结构和模型可见文本的前提下，保存第一轮完整 Context
Message（包括不持久化到 Context 语义中的 hidden segmentation metadata），后续 activation
重放同一 seed，并在其后追加原生 reasoning、tool call 和 tool output。Context transaction、
Observation retire、模型、推理档位、phase、System 或工具合同变化时开启新 transport generation。

第一道 `git-multibranch` 使用 v7 修复版，7 次调用共 212,698 input / 124,928 cached，整题
加权命中率 58.74%，标准 verifier reward 为 1。前 3 次为冷调用；第 4--7 次的输入分别为
32,014 / 34,161 / 35,625 / 39,022，缓存分别为 26,112 / 31,232 / 33,280 / 34,304，单次
命中率为 81.57% / 91.43% / 93.42% / 87.91%，稳定热路径加权命中率为 88.72%。wire audit
证明第 3→4、4→5、5→6、6→7 次均是相同请求属性下的完整严格 item 前缀。

v7 同时暴露了一个 Morphz 问题：transport seed 在 Provider refinement 之前把 Context 扁平化，
导致第 2→3 次虽然 input items 相同，Cache Cohort 和请求属性却改变。v8 改为保存和重放完整
Context Message，消除了这次身份漂移。

第二道 `cancel-async-tasks` 使用 v8 修复版，10 次调用共 286,866 input / 190,976 cached，整题
加权命中率 66.57%，标准 verifier reward、integrity Gate 和 public run Gate 均为 1/通过。
第 2→3 次已经是同一 Cohort、相同请求属性、5/5 个 input items 严格前缀，但第 3 次仍报告
0 cached；第 3→4 次为 12/12 严格前缀后转为 24,064 / 26,423（91.07%）命中。第 4--10
次稳定热路径共 218,159 input / 190,976 cached，加权命中率 87.54%。这些调用的单次命中率为：

| 调用 | input tokens | cached tokens | 命中率 |
| ---: | ---: | ---: | ---: |
| 4 | 26,423 | 24,064 | 91.07% |
| 5 | 29,802 | 25,088 | 84.18% |
| 6 | 30,469 | 20,992 | 68.89% |
| 7 | 31,404 | 29,184 | 92.93% |
| 8 | 32,708 | 30,208 | 92.36% |
| 9 | 33,512 | 32,256 | 96.25% |
| 10 | 33,841 | 29,184 | 86.24% |

因此不能再声称“OpenAI 对完全不变的前缀也不缓存”：两道真实题都在严格前缀成立后形成了
深层命中。v8 的首次严格重复仍冷，以及后续服务端选择的缓存深度波动，是已经隔离出的端点
行为；当前证据不能进一步区分异步缓存建立、路由抖动或服务端淘汰策略，因而也不能把其中
任一解释写成确定事实。整题累计低于 85% 主要来自 phase/工具合同切换造成的两个必要冷启动，
以及一次端点未复用；它不等于稳定轨迹的缓存优化失效。

上述 v7/v8 证明了严格追加前缀可以命中缓存，但它把 seed 后的内容表达成原生
assistant/tool transcript，形成了第二套模型可见上下文结构。该实现不作为默认行为，也不作为
最终实验特性的语义设计；这里只保留它作为机制探索的历史证据。

### 2.4 最终实验设计：canonical Context + Structured ContextDelta blocks

最终实现由编译特性 `experimental-openai-chatgpt-structured-cache` 控制，默认构建不包含该能力。
即使编译进 Runtime，也不会根据 Adapter 名字或 URL 猜测端点身份；Dashboard 只在 Runtime
公布该实验能力时显示开关，并由用户对具体 Provider/物理模型显式选择
`experimental-structured-deltas`。这使 API Proxy、反向代理和自定义域名都能被准确配置。

物理请求始终只有一条 User Message：第一个 `input_text` block 是完整、闭合且可独立求值的
canonical Context；每个后续 block 都是一个版本化 `context-delta` S 表达式，包含来源 attempt、
assistant text、tool call 和使用 canonical Observation renderer 产生的完整 Observation。模型按
`base preceding-context` 和有序 delta 进行求值；实现不会用普通消息列表替换 Structured Context。

缓存 generation 的重建规则按来源精确区分：Context transaction、合同变化、attachment、非规范
投影，或 retire 命中 seed 中的 Observation 时重建完整 seed；retire 只命中 delta Observation 时
保留 seed，只重新投影 delta 区。这样 retire 不会变成不断累加 tombstone，也不会让已退休内容
反而永久增加上下文。

真实 `cancel-async-tasks` 单题使用 feature 构建
`5fa3d3d378d3-structured-delta-v1`，Terminal-Bench verifier、strict reward 和 integrity gate 均为
1/通过。稳定 generation 的第 3--7 次请求，wire audit 逐次证明旧 content blocks 是新请求的
严格前缀；Provider 报告 115,200 cached / 125,228 input，热路径加权命中率 91.99%。把两个必要
冷 generation 起点也计入，整题累计为 115,200 / 168,903，即 68.20%。因此 85% 应用于稳定
热路径，不应脱离题长和冷启动次数套在整题累计值上。

第二道 `git-multibranch` 使用同一二进制，Terminal-Bench verifier、strict reward 和 integrity
gate 同样为 1/通过。第 3--21 次稳定 generation 共 618,148 input / 547,840 cached，热路径
加权命中率 88.63%；整题含两个冷起点为 547,840 / 662,789，即 82.66%。这组热路径已经包含
一次物理请求摘要完全相同却由端点报告 0 cached 的异常；随后相同请求恢复 31,232 / 32,275
（96.77%）命中。去掉该异常不是正式统计口径，但它证明剩余波动不能归因于 Morphz 修改了
wire 前缀；即使保留这次服务端未复用，热路径仍超过 85%。

## 3. 设计原则

### 3.1 Context 语义与传输优化分离

Context 的权威表示仍然是一棵 canonical S 表达式。缓存断点属于发送请求时的传输元数据，
不得写入：

- Yao 源码；
- Context Event Store；
- Observation 或 Mind Frame；
- 模型可见的自然语言文本；
- Context Protocol 的语义定义。

删除全部缓存元数据后，各内容块按顺序拼接所得文本必须与当前 canonical Context Message
逐字节相同。这个等价性是实现的第一项硬性测试。

`experimental-openai-chatgpt-structured-cache` 是明确隔离的例外：它不声称与每轮重建的单棵
Context 文本逐字节相同，而是维持同一结构化求值语义——一个完整 Context seed 加一组同样
采用 S 表达式和 canonical Observation schema 的 ContextDelta。因为这是模型可见表示的实验性
变化，所以必须同时经过编译特性和 Provider/模型显式配置两道开关，绝不能成为默认退化路径。

### 3.2 不把某一家 Provider 的字段当作通用协议

`prompt_cache_breakpoint` 是 OpenAI Responses API 的请求字段，不是跨 Provider 标准。
Anthropic、DeepSeek、Qwen 和 Gemini 的缓存接口不同。Morphz 内部只表达“这里是一个
适合复用的稳定前缀边界”，具体字段由 Provider Adapter 映射。

### 3.3 缓存不能影响正确性

Provider 不支持缓存、缓存过期、缓存未命中或命中率为零时，模型看到的语义内容必须完全
相同。缓存只能影响成本和延迟，不能成为任务正确执行的前置条件。

### 3.4 按协议字段与模型能力分别处理

`prompt_cache_key` 是 OpenAI Responses 的通用请求字段，因此所有 Responses 路线都会发送
稳定的 Cache Cohort；GPT-5.5 等使用自动前缀缓存的模型也能利用该字段。内容块上的
`prompt_cache_breakpoint` 和 `prompt_cache_options` 则是 GPT-5.6 及后续模型新增的显式缓存
能力，只有物理端点和模型都满足这一能力边界时才发送。公开 Platform `/v1/responses` 与
ChatGPT Codex OAuth Responses 不能视为同一端点；当前 `openai-codex` Adapter 保持同一
canonical 文本和同一 User Message，仅保留 transient `input_text` 内容块边界，并禁用显式
字段以避免确定性的 HTTP 400。其他协议不会收到 OpenAI 字段。

## 4. 建议的内部结构

### 4.1 保留现有持久化 Message

当前 `llm::Message` 使用单个 `content: String`。不建议直接把它改成 Provider 内容块数组，
因为该类型同时承担对话、工具结果、Continuation 和测试夹具等职责。把 Provider 优化写入
这个通用类型，会让持久语义和传输格式互相污染。

实现已经在模型请求构造前增加临时、不可持久化的分段文本表示。它沿用 `Message` 的传输
通道，但使用 Runtime 私有的瞬时 envelope；该 envelope 只在请求准备阶段存在，不进入
Event Store、Yao、Observation 或 Mind Frame。核心类型为：

```rust
struct SegmentedModelText {
    parts: Vec<ModelTextPart>,
    prompt_cache_key: Option<String>,
}

struct ModelTextPart {
    text: String,
    cache_boundary_after: bool,
    cache_boundary_candidate_after: bool,
}
```

普通的不支持显式断点 Adapter 会先拼接全部 `text`，再按原有普通文本协议发送。Codex
Responses 默认也发送拼接后的规范文本。`implicit-content-boundaries` 和
`implicit-message-boundaries` 仍可被显式配置为诊断策略，但真实同题实验没有证明它们产生了
更深的合格断点，因此不能作为 `auto` 默认值。所有路径中模型看到的拼接字节均与改动前相同。

### 4.2 Renderer 同时给出完整文本和稳定分区

第一阶段在 `compose_context_sexpr()` 得到完整 AST 后，按顶层节点生成三个连续文本片段，
并把拼接结果同原 canonical 字符串逐字节核对。长期形态仍可以收敛成下面的显式结果类型：

```rust
struct RenderedContextEncoding {
    canonical_text: String,
    parts: Vec<RenderedContextPart>,
}

struct RenderedContextPart {
    region: ContextRegion,
    text: String,
    fingerprint: String,
}
```

`canonical_text` 用于日志、Context Inspect、调试和现有接口；`parts` 只用于模型请求封装。
无论采用当前实现还是长期类型，都必须满足：

```text
concat(parts.text) == canonical_text
```

分区必须由 canonical Renderer 直接产生，不能在最终字符串上用正则表达式寻找括号位置。

### 4.2.1 Renderer 到底如何标记边界

Renderer 不在 Context 文本中写入 `(breakpoint ...)`，也不在渲染结束后搜索字符串。它在
遍历已经解析好的 Context AST 时，把输出写入若干连续缓冲区，并在旁路元数据中记录
“这个缓冲区之后是一个候选稳定边界”。

当前 Renderer 已经在构造 AST 时明确知道 `protocol`、`evaluation-profile`、`inbox`、
`observation-state`、`mind`、`session-directory`、`kernel` 和动态尾部各是哪一个节点；
每条 Observation 也带有 Event Sequence。因此边界来自结构本身，不需要从文本反推。

可以把现有的：

```rust
SExpr::List(context).to_string()
```

改造成语义等价的分段 Writer：

```text
写入 "(context"
写入 " " + protocol
写入 " " + evaluation-profile
flush(candidate = StableProtocolEnd)

写入 " (inbox"
for observation in observations ordered by Event Sequence:
    写入 " " + canonical(observation)
    if 当前 Observation 结束了一个确定性 Inbox 块:
        flush(candidate = InboxChunkEnd(first_seq, last_seq, hash))
写入 ")"
flush(candidate = CurrentInboxEnd)

依次写入 observation-state / mind / session-directory / kernel / ...
写入 Context 的结束括号
flush(candidate = None)
```

假设 canonical Context 是：

```lisp
(context (protocol ...) (evaluation-profile none)
  (inbox (observation A) (observation B) (observation C))
  (mind ...) (evaluate ...))
```

内存中的结果可以是：

```text
part[0].text = "(context (protocol ...) (evaluation-profile none)"
part[0].candidate_boundary_after = StableProtocolEnd

part[1].text = " (inbox (observation A) (observation B)"
part[1].candidate_boundary_after = InboxChunkEnd(A..B)

part[2].text = " (observation C))"
part[2].candidate_boundary_after = CurrentInboxEnd

part[3].text = " (mind ...) (evaluate ...))"
part[3].candidate_boundary_after = None
```

其中 `part[0] + part[1] + part[2] + part[3]` 必须等于当前 Renderer 生成的完整字符串。
Content Block 在 `(observation B)` 和 `(observation C)` 之间断开并不改变文本，也不会改变
括号结构；这和网络分包不会改变文件内容是同一层面的事情。

这里还要区分三项职责：

1. **Context Renderer** 只标出所有候选结构边界；
2. **Cache Boundary Planner** 根据 Provider 上限、上一轮边界和本轮变化，从候选边界中选择
   最多四个实际断点；
3. **Provider Adapter** 把选中的断点编码成该 Provider 的 JSON 字段。

例如 OpenAI Adapter 最终把 `part[1]` 写成：

```json
{
  "type": "input_text",
  "text": " (inbox (observation A) (observation B)",
  "prompt_cache_breakpoint": { "mode": "explicit" }
}
```

`candidate_boundary_after` 和 `InboxChunkEnd` 都不会发给模型；模型只看到 `text`。

### 4.2.2 如何知道“上一轮 Inbox 末端”

每个候选 Inbox 前缀使用以下信息形成稳定身份：

```text
stable Provider Request Cohort
visible prefix byte length
canonical prefix SHA-256
```

这些信息保存在请求准备阶段的进程内元数据中，不进入 Context。下一轮新增 Observation
时，旧前缀的长度和内容哈希保持不变，Planner 就能选择旧 Inbox 末端作为读取断点，同时
选择新 Inbox 末端作为写入断点。如果旧 Observation 被 Retire、Restore 或重写，前缀哈希
发生变化，旧边界自然不再被选择。

Runtime 不判断某段文本在语义上“重要不重要”。它只依据 Context AST 的 Observation
边界、canonical 字节和前缀哈希进行确定性选择。

### 4.2.3 对当前代码的具体改动位置

第一版可以沿用当前 `compose_context_encoding()` 已经执行的 S 表达式解析，不需要重写
Context Store。具体数据流如下：

```text
context.rs
  继续生成 canonical Context S-expression
        ↓
orchestrator.rs / compose_context_encoding()
  解析为 SExpr，并挂载 evaluation-profile / runtime-directive / harness-binding
        ↓
segmented_context_writer()
  按 AST 节点输出 canonical_text + candidate parts
        ↓
cache_boundary_planner()
  按精确 Provider 能力选择实际断点
        ↓
PreparedModelInput
  形成临时 TextParts，不写入 Event Store
        ↓
provider.rs / build_openai_responses_request()
  TextParts -> input_text[] + prompt_cache_breakpoint
```

需要修改的代码边界是：

1. `compose_context_encoding()` 的底层先返回 AST，再由分段 Writer 生成请求片段；
2. 固定自然语言引导进入第一个文本片段，并与 Context parts 一起返回；
3. 新增 transient `SegmentedModelText`，不改变 Event Store 中的消息格式；
4. `build_openai_responses_request()` 遇到 `TextParts` 时输出 `input_text` 数组；
5. 普通 Adapter 和 Codex Responses 的默认路径都只拼接 `part.text`；仅显式诊断配置会
   保留 content blocks 或 same-role message items，且模型可见拼接结果仍与旧实现相同。

为了避免“完整文本”和“分块文本”出现两套序列化逻辑，`canonical_text` 本身也必须由
`segmented_context_writer()` 的所有输出缓冲区拼接得到，不能再单独调用另一份 Formatter。
测试再将拼接结果与现有 `SExpr::to_string()` 对照；迁移完成并证明等价后，前者成为唯一的
请求序列化路径。

### 4.3 Context 的当前内容块

当前生产 Renderer 先产生以下候选片段：

1. **固定协议块**：固定引导、`context` 根开头、`protocol` 和稳定的
   `evaluation-profile`，固定设置断点；
2. **Inbox 开头**：只包含 ` (inbox`；
3. **Observation 候选块**：每条 canonical Observation 单独成为传输候选片段；
4. **动态尾部块**：从 Inbox 的结束括号开始，包含 `observation-state`、`mind`、
   `session-directory`、`kernel`、`evaluation-environment`、`evaluate` 和 Context 根的
   结束括号。

Provider Planner 只选择最多四个实际断点，Adapter 再把未选中的相邻候选片段合并，因此
不会把数百条 Observation 原样膨胀成数百个 `input_text` 块。

这些块拼起来仍是一段合法且与当前完全相同的 S 表达式文本。Provider Content Block
边界可以出现在 S 表达式的两个字符之间，但不会向文本插入任何标记，因此不会破坏语法。

## 5. Inbox 的增量边界

当前实现以 Observation 末端作为候选边界，并为候选前缀计算增量 SHA-256 身份。每次请求
最多选择四个战略边界：

1. 固定协议块末端；
2. 与当前 Inbox 仍完全匹配的最长最近历史末端；
3. 如容量允许，再选择一个次近的匹配历史末端；
4. 本轮最新 Inbox 末端，用于下一轮。

这样，一条新 Observation 到达时，请求既可以命中上一轮的稳定 Inbox 前缀，又可以为包含
新 Observation 的前缀建立下一轮缓存。具体块大小不在本设计中凭经验固定，应通过 A/B
选择，并受 Provider 每次请求允许的最大断点数约束。

Retire、Restore 或修改较早的活跃历史会从首次变化处产生一次缓存重建。这是语义状态真实
变化的结果，不能也不应通过保留已经失效的文本来掩盖。

## 6. Cache Cohort 与 `prompt_cache_key`

`prompt_cache_key` 和缓存断点解决的是两个问题：

- **缓存断点**声明一条请求内部哪些前缀可以形成复用边界；
- **`prompt_cache_key`**为相似请求提供稳定的缓存分组提示，提高命中机会。

`prompt_cache_key` 不能替代内容块，也不能让已经变化的字节继续命中。

当前实现以稳定的 **Provider Request Cohort** 为缓存分组，而不是以 Context 或 Session
身份分组。键由以下信息形成：

```text
Physical Model
Effective Reasoning Effort
Ordered Tool Name / Description / JSON Schema
System and preceding Message bytes
Stable Context protocol / evaluation-profile prefix
```

因此相同请求合同下的不同 Context 可以共享公共前缀；模型、实际缓存 wire mode、推理档位、
工具顺序或 schema、System Prompt、Context Protocol 或 Evaluation Profile 任一变化都会进入
新 Cohort。Provider 账户和端点仍由独立的 `ProtocolClient` 实例自然隔离。

不能把 Turn ID、Activation ID、随机请求 ID 或当前时间放进 Cohort Key。任何会改变模型可见
固定前缀的配置都必须形成新的 Cohort。

`prompt_cache_key` 不是权限边界；Context 的访问控制仍由 Morphz 的 Principal、Session、
Context 投影和 Provider 账户隔离负责。

## 7. Provider 能力模型

当前实现把 Responses 通用字段与物理端点能力分开：`prompt_cache_key` 按协议发送，显式
断点同时受模型版本、Adapter 和 `ProviderModelConfig.prompt_cache_strategy` 控制。该字段
描述精确 Provider/model 组合，不复用模型路由的业务能力列表：

```toml
[providers.openai.models."gpt-5.6-sol"]
prompt_cache_strategy = "explicit-content-boundaries"

[providers.codex-proxy.models."gpt-5.6-sol"]
prompt_cache_strategy = "experimental-structured-deltas"
```

可选值为 `auto`、`disabled`、`implicit-prefix`、`implicit-content-boundaries`、
`implicit-message-boundaries`、`experimental-structured-deltas` 和
`explicit-content-boundaries`。`implicit-prefix` 发送单个规范文本字符串；
`implicit-content-boundaries` 在同一条 User Message 内保留多个 `input_text` 块，但不发送
任何显式缓存字段；`implicit-message-boundaries` 保留相同文本和 User 角色，将段落映射为
连续的 User message items。`openai-codex` 的 `auto`、`disabled` 和 `implicit-prefix` 当前均
发送单个规范文本；两种分块模式只用于显式诊断。确认性实验必须对精确端点、模型和 revision
冻结策略。`openai-codex` Adapter 即使配置为 explicit 也拒绝输出显式字段，因为该后端已直接
验证为 HTTP 400。其他协议不会收到 OpenAI Provider-specific 字段。

`experimental-structured-deltas` 只有在构建时启用
`--features experimental-openai-chatgpt-structured-cache` 才是合法配置；默认构建的保存接口和
Provider 初始化都会拒绝它，而不是静默退化。启用该编译特性后，Dashboard 会显示实验能力，
但仍由用户对每个 Provider/物理模型显式选择，因而不依赖 `openai-codex` Adapter 名字识别 Proxy。

建议的 Provider 映射如下：

| Provider / 协议 | 第一阶段行为 | 说明 |
| --- | --- | --- |
| OpenAI Platform / 已验证 API Responses | 所有模型发送 `prompt_cache_key`；GPT-5.6 及后续模型再发送内容块断点和 cache options | 官方契约明确支持；当前 Cloudflare API 路线已验证 7,819 cached / 7,833 input |
| ChatGPT Codex OAuth Responses | 默认发送 `prompt_cache_key` 和单个规范文本；不发送显式字段 | 需要高缓存时，可在实验构建中对该 Provider/模型显式选择 Structured ContextDelta |
| CLIProxyAPI 7.2.140 → Codex OAuth | 不按 Proxy 名字猜测；Dashboard 显式配置 | 该 revision 对显式字段的处理已有配对请求与源码证据；实验 delta 路径已由真实单题验证 |
| OpenAI Chat Compatible | 默认不启用；只有精确端点声明且探测通过后才映射 | 不能因“OpenAI compatible”就假定支持 Responses 字段 |
| Anthropic Messages | 把内部边界映射为内容块 `cache_control` | 字段、TTL 和计费方式与 OpenAI 不同 |
| DeepSeek / Qwen 自动缓存端点 | 不发送显式断点，继续保持稳定字节前缀 | DeepSeek 官方说明为自动前缀缓存；实际兼容端点仍以配置和 Usage 为准 |
| Gemini implicit caching | 不发送显式断点，保留稳定前缀并读取 Usage | 新模型支持隐式缓存，但不等于支持 OpenAI 字段 |
| Gemini explicit caching | 后续映射为独立 Cached Content 资源 | 涉及资源创建、TTL 和生命周期，不纳入第一阶段 |
| 未知 Responses Provider | `auto` 保留兼容行为；正式实验前必须探测并冻结 | 不从“它是 Proxy”推断支持或不支持 |

官方接口参考：

- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [CLIProxyAPI v7.2.140](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.140)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)

## 8. 不支持字段时的处理

以下降级策略尚未进入第一阶段代码，是正式扩展到更多端点前的后续要求：

### 8.1 生产模式

若一个已经声明支持显式缓存的端点明确返回“字段不支持”类 4xx：

1. 记录一次结构化 capability downgrade；
2. 仅移除缓存元数据，以完全相同的模型可见文本重试一次；
3. 在当前 Provider Instance、Physical Model 和 Adapter Revision 组合上停止继续发送该字段；
4. 不把普通 5xx、模型拒绝或内容错误误判为缓存能力问题。

这样可以保证服务可用，但会产生一次额外请求。正式上线前应通过预检避免频繁触发该路径。

### 8.2 Benchmark 与论文实验

确认性实验不允许运行中静默降级。实验开始前必须完成端点探测并冻结实际能力；如果运行中
发现配置不成立，该 Trial 应标记为环境或协议失败，不能把降级后的请求混入同一统计口径。

## 9. 测试方案

### 9.1 纯确定性测试

第一阶段已经覆盖：

1. 分块文本拼接后与当前 Context Message 逐字节相同；
2. Provider 缓存字段不会进入模型可见文本；
3. 同一 Context 状态重复渲染得到相同分块和顺序；
4. Measurement Request、正式 Request 和 Context Pressure 重建使用同一分块规则；
5. Attachment、Continuation、Tool Result 和其他 Provider 协议不泄露内部 envelope；
6. Provider Usage 分开保存缓存读取、缓存写入和普通未缓存输入，避免重复计费。

Inbox 增量边界、历史谱系匹配、四断点上限、早期历史变化后的重建，以及跨 Context Cohort
复用都已有确定性合同测试。新增的 wire-form 测试进一步证明：连续 same-role message-item
策略会把新 Observation 插入旧尾项之前，因此旧请求不是新请求的严格 item 前缀；普通
content-block 的变化仍发生在同一消息 item 内，也不会凭空产生隐式消息断点。最终出站 JSON
现已同时记录逐 item 和逐 content-block SHA-256、两层最长公共前缀及严格追加状态。这样可以
直接证明“整个 User item 已变化，但前 N 个 input_text blocks 仍是严格旧前缀”。Structured
ContextDelta 的确定性测试覆盖单 User 物理形状、连续 block 严格追加、做题循环、seed/delta
retire 分流、Context transaction rebase 和默认构建拒绝实验配置。

### 9.2 Adapter 合同测试

每种协议验证完整 JSON：

- OpenAI Responses：`input_text` 数组、断点、cache options 和 key 的准确位置；
- Anthropic：第一阶段拼接为原普通文本，不发送 OpenAI 字段；
- DeepSeek / Qwen / Gemini implicit：不出现未知字段；
- 未知兼容端点：退化为普通文本且内容完全相同；
- `openai-codex` Adapter 保留 `prompt_cache_key`、同消息 content blocks 和 canonical
  拼接文本，剥离显式 options/breakpoint；普通 Platform Responses Adapter 在 GPT-5.6+
  输出相同块边界和显式断点字段；
- `disabled` 和普通 implicit Provider 仍发送原单字符串。
- 实验构建中显式选择 `experimental-structured-deltas` 时，只发送一个 User item；block 0 是
  完整闭合 Context，后续 blocks 全是 Structured ContextDelta；默认构建明确拒绝该配置。

不支持字段的 4xx 受控降级尚未实现。

### 9.3 真实 Provider A/B

第一轮只验证 GPT-5.6 Sol 当前物理路线，固定模型、账户、System Prompt、工具 Schema 和
Context 数据，比较：

1. 当前单字符串请求；
2. 内容相同、仅增加分块和缓存边界的请求。

场景至少包括：

- 动态 Evaluate 尾部变化；
- 追加一个 Observation；
- Mind Frame revision；
- Session 切换但共享同一 Context；
- Harness binding 变化；
- Retire 后的缓存重建；
- 工具 Schema 变化并进入新 Cohort。

观测字段包括：

- Provider reported input tokens；
- cached input tokens；
- cache write tokens（Provider 提供时）；
- output tokens；
- 首字节与端到端延迟；
- 当前价格快照下的 API 成本；
- 任务结果是否一致；
- 请求的 Provider、物理模型、Adapter、协议和 Cache Cohort。

不能只用 Cache Hit Rate 判断效率。最终成本必须分别按各 Provider 的普通输入、缓存读取、
缓存写入和输出价格计算。

以 2026-08-28 的 OpenAI 官方价格为例，GPT-5.6 Sol 普通输入为每百万词元 4 美元，缓存
输入为 0.4 美元，而缓存写入按普通输入价格的 1.25 倍计费。因此显式模式不应把每个动态
尾部都写入缓存；只有后续请求预计会复用的边界才值得写入。正式报告必须保存价格快照，
不能把这一价格永久写成算法常数。

## 10. 实施阶段

### Phase 1：传输表示与等价性测试（已完成）

- 引入不可持久化的 `SegmentedModelText`；
- Renderer 返回 canonical text 与结构化 parts；
- 保证现有字符串请求仍是无缓存能力时的默认路径；
- 完成逐字节等价、Context Inspect 和所有 Provider 的结构回归。

### Phase 2：OpenAI Platform / API Responses 缓存字段（实现与最小 A/B 完成）

- 所有 Responses 模型使用 `prompt_cache_key` / Cohort；
- GPT-5.6 及后续物理模型在支持该字段的 Platform 端点启用显式内容块断点；
- ChatGPT Codex OAuth 端点禁用显式字段，避免确定性的 400；
- 此前经 CLIProxyAPI 得到的 96.6% 已更正为隐式缓存证据；
- 当前 Cloudflare API 路线已验证显式写入、7,819-token 复用和稳定前缀变化失效；
- 完整任务 Benchmark 因成本约束暂停，不把最小探针外推为总体成本结论。

### Phase 3：Inbox 增量边界与 Structured ContextDelta 实验（已完成真实单题验证）

- 每条 Observation 末端作为结构候选，不改变 canonical 文本；
- 规划器按完整前缀哈希保留最近可复用边界，并遵守四断点上限；
- 较早历史变化时自动停止选择失效边界并重建；
- 已完成 append、跨 Context Cohort、模型/推理/工具隔离和回退的合同测试；
- 改变 User/Developer 角色结构的 Codex transport-only 试验无改善并已回滚；
- 同一 User Message 内的 content-block transport 真实同题仅 27.46%，普通 block 并不等于
  GPT-5.6 的隐式 message breakpoint；
- 连续 same-role User message-item transport 的 v4/v5 同题分别为 21.64%/34.19%，且 wire
  结构证明新增 Observation 插在旧 canonical tail 之前，不是严格追加；
- v7/v8 的原生 assistant/tool transcript 方案证明严格追加机制有效，但因引入第二套模型可见
  结构而只保留为历史证据，不作为产品默认或最终实验设计；
- 最终实验路径保持一条 User Message，以完整闭合 Context 为 seed，并只追加版本化、完整
  Observation schema 的 Structured ContextDelta blocks；
- feature 默认不编译；编译后也必须由 Dashboard 对具体 Provider/模型显式启用，Proxy 不依赖
  Adapter 名称猜测；
- seed Observation retire / Context transaction 重建 seed；delta Observation retire 只重建 delta
  投影，不追加 tombstone；
- `cancel-async-tasks` reward、strict reward、integrity gate 均为 1/通过，稳定 generation 热路径
  为 115,200 cached / 125,228 input（91.99%）；
- `git-multibranch` 同样 reward、strict reward、integrity gate 均为 1/通过；稳定 generation
  即使计入一次相同请求的端点 0-cache 异常，仍为 547,840 / 618,148（88.63%）；
- 完整多模型配对仍属于后续论文实验，不再用付费全套 Benchmark 探索 GPT-5.6 的已收敛机制。

### Phase 4：其他 Provider

- Anthropic 显式内容块映射；
- DeepSeek、Qwen 和 Gemini implicit 的 Usage 归一化；
- Gemini Cached Content 作为独立设计评估，不和内容块断点混为一谈。

## 11. 上线门槛

第一阶段已经只对经过验证的 GPT-5.6 Responses 路线启用。扩展到其他模型或把它作为通用
Provider 能力前，仍须同时满足：

1. 语义文本逐字节等价；
2. 全部 Runtime 与 Provider Adapter 回归通过；
3. 不支持缓存的端点仍能正常工作；
4. GPT-5.6 Sol 的真实多轮 A/B 可重复观察到稳定缓存收益；
5. 正确率无下降；
6. 真实 API 成本低于或不高于当前请求布局；
7. Usage、Cohort、能力降级和首次分歧均可审计；
8. Benchmark 模式能够冻结能力，不发生静默降级。

## 12. 对现有论文数据的处理

ME-08 已报告的 Token 和缓存数据是当时完整系统与当时请求封装下的真实测量，应保留原始
产物，不能事后改写。但它只能描述该版本系统的工程表现，不能据此断言 Structured Context
天然具有较低缓存率或较高 API 成本。

在本设计实现并验证后，如需对外提出成本优势或成本相当的主张，应使用同环境的 Morphz 与
参考智能体重新进行配对测量。论文正文不需要记录此次排查过程；只需要报告最终采用的系统
配置、实验方法、测量结果和适用范围。

## 13. 已冻结的实现决策与待决项

已经冻结：

- 缓存边界只属于请求封装层的临时表示，不进入 Yao、Event Store 或模型可见文本；
- Cache Cohort 绑定稳定 Provider 请求合同，不绑定 Context 或 Session 身份；
- 每条 Observation 末端是候选边界，Adapter 只输出 Planner 选中的少量内容块；
- OpenAI 每轮选择固定协议、最长可复用历史 Inbox、可选的次近历史 Inbox 和当前 Inbox，
  总数不超过四个；
- 当前只对支持显式字段的 OpenAI Platform Responses GPT-5.6+ 能力边界启用显式断点；
- ChatGPT Codex OAuth 与 Platform API 是独立能力边界，不能只按模型名合并判断。
- Codex OAuth 默认继续使用原 canonical Structured Context，不启用 append-only 变体；
- ContextDelta 路径是默认关闭的实验编译特性：单条 User Message、完整闭合 Context seed、
  Structured ContextDelta blocks；它只能由 Dashboard 对具体 Provider/模型显式启用；
- 普通 work/soft-checkpoint 内 Provider 可见的 tools 集合、schema 和顺序必须稳定，动态权限由
  Runtime admission 拒绝；critical-maintenance、final-reply 等真实协议边界继续物理裁剪 tools；
- 实验路径不得退化成一半 Structured Context、一半普通 assistant/tool transcript，也不得用
  tombstone 代替真实 retire；seed 与 delta 的 retire 必须按 provenance 分别重建。

仍待决定：

- 生产端点明确拒绝缓存字段时，是否允许一次有记录的无缓存降级重试；
- 完整多模型配对中的真实成本下降和正确率门槛；
- Anthropic 显式 `cache_control` 路线和各兼容端点的重复方差；隐式长前缀首轮映射已覆盖
  GPT、Qwen、DeepSeek、K3、GLM、Gemini、Grok 与 Claude 九条当前 Proxy 路由。

## 14. 建议结论

当前建议分端点处理：所有路线先保持确定性的 tools 合同；支持 GPT-5.6 显式字段的
Platform/API 路线可使用内容块断点。对缺少可用显式边界且真实任务达不到成本目标的
ChatGPT/Codex 兼容路线，可在用户明确接受实验复杂度时，对具体 Provider/模型启用 canonical
Context + Structured ContextDelta blocks；默认仍不启用。

该实验不改变 Event Store、Yao、Mind Frame 或 canonical Context 的权威状态；它改变的是模型
可见求值表示，因此必须保持完整结构化协议、精确 retire/rebase 和可关闭性。真实单题已证明
稳定热路径超过 85%；短题整题累计仍必须单独报告冷启动占比，不能用一个绝对门槛掩盖题长、
generation 切换和端点偶发未复用。
