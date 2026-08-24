# `raman-fitting` 三种 Agent 方式归因对照结果

> 状态：`completed / diagnostic case study`
>
> 日期：2026-08-24
>
> 协议：`raman-agent-attribution-v1`
>
> 结论边界：同一已观察题、每组一次；不得表述为总体胜率或公开 Benchmark 成绩

## 1. 结论

同一 `raman-fitting` 任务、同一 GPT-5.6 Sol/max、同一 CLIProxyAPI、同一
Terminal-Bench 2.1 容器和验证器下，三个 Agent 方式得到：

1. **原生 Morphz（无 Harness）通过，raw/strict reward 均为 1.0**；
2. **Morphz + `terminal-task@0.4.0` 为 0 分**，没有创建 `results.json`；
3. **官方 Codex CLI 0.149.1 为 0 分**，但正常创建并校验了 `results.json`，失败来自
   拟合参数而不是未收口或 Runtime 异常。

因此，本题不支持“GPT-5.6 Sol 本身无法完成”或“Morphz Agent 必然弱于 Codex”的判断。
最直接的工程结论是：**当前原生 Morphz 已具备完成本题的能力，v0.4 Harness 在本次轨迹
中没有帮助且呈现明显负作用；Codex 的交付效率更高，但其科学建模决策没有通过验证。**

由于三组都只有一次随机轨迹，不能把结果差异全部因果归于 Harness 或 Agent 实现；但它
足以阻止继续推广 v0.4，也证明后续优化应同时关注交付效率、科学判断和终态语义，而不是
只增加“及时收口”的命令。

## 2. 冻结条件

- 任务：`terminal-bench/raman-fitting`；每组一次、并发 1、Harbor retries 0；
- 模型：精确 `gpt-5.6-sol`；reasoning effort `max`；fallback false；
- Provider：同一云节点 CLIProxyAPI / OpenAI Responses 路由；
- 容器：Linux/AMD64；Harbor 0.21.0；Terminal-Bench 2.1 固定 registry digest；
- 权限：Morphz 为 `full_access`；Codex 为隔离容器内
  `--dangerously-bypass-approvals-and-sandbox`；
- Runtime：两组 Morphz 均为
  `paper-eval-runtime-v4@5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- 原生 Morphz 明确使用 `harness_mode=none`，既不安装也不绑定空 Harness；
- Codex 使用 OpenAI 官方 CLI `0.149.1` 和 Harbor 内置 Codex adapter，外层只追加与
  Morphz 相同的 Benchmark 完整性策略；
- 三组均未读取私有测试、验证器目录、隐藏参考数据或在线任务答案；Integrity finding
  均为 0。

## 3. 量化结果

| 指标 | Morphz + v0.4 | 原生 Morphz | Codex CLI 0.149.1 |
| --- | ---: | ---: | ---: |
| raw / strict reward | 0 / 0 | **1 / 1** | 0 / 0 |
| Agent exception | 无 | 无 | 无 |
| Agent execution | 891.43 s | 739.89 s | **409.14 s** |
| 模型求值 / turn | 24 | 18 | 1 个 Codex turn |
| ATIF steps | 24 | 19 | 24 |
| 工具调用 | 22 | 26 | 18 |
| input tokens | 1,004,381 | 753,063 | **434,366** |
| cached input tokens | 33,280 | 53,760 | **360,448** |
| 估算 uncached input | 971,101 | 699,303 | **73,918** |
| output tokens | 32,894 | 27,396 | **14,333** |
| `results.json` | 未创建 | 已创建并通过 | 已创建但数值未通过 |

Codex 的 ATIF 把整次 `codex exec` 记录为一个 turn，内部仍有 18 次 `exec` 工具调用；
不能把“1 个 turn”理解成只做了一步。Token 来自同一 Provider 的运行记录，可以作本次
案例的描述性比较，但不应外推为不同 Agent 的稳定成本比。Codex 的高缓存命中尤其值得
后续单独分析：Morphz 每轮结构化投影和 Prompt 前缀变化可能降低了 Provider prefix cache
复用率。

## 4. 三条执行路径

### 4.1 Morphz + v0.4：未识别坐标换算，口头承诺后实际退出

v0.4 轨迹一直主要在原始横轴区间上寻找和拟合峰。到第 22 次工具调用时仍未形成
`Raman shift = 1e7 / raw_x` 的换算，也没有保存最小可用 `results.json`。最后一个实际
工具动作是安装 `matplotlib`；随后模型只回复：

> I’m generating a visual diagnostic of the peak regions to resolve the remaining baseline/peak separation before writing the final JSON.

这句话没有伴随后续画图工具调用。Runtime 将这个无工具调用的模型响应判为 terminal
delivery，持久化 `runtime/thread_result` 和 `chat/reply` 后退出。数据库中 24 个
Activation 全部为 `completed`，没有仍在运行或排队的求值线程，服务器也没有残留任务
进程。因此它不是“后台还在生成”，而是自然语言语义声称会继续、执行协议却已经结束。

### 4.2 原生 Morphz：较晚识别换算，但系统比较窗口后选择正确参数

原生 Morphz 前期也在探索原始横轴，但在第 19 个工具调用附近明确采用
`shift = 1e7 / raw_x`。随后它用相同四参数洛伦兹模型比较多个 G/2D 窗口，而不是只取
局部 RMSE 最低的最窄窗口。最终写入：

| 峰 | x0 | gamma | amplitude | offset |
| --- | ---: | ---: | ---: | ---: |
| G | 1580.329049 | 8.477974 | 8307.3847 | 5755.1258 |
| 2D | 2670.094791 | 17.870999 | 12384.6801 | 1127.8251 |

它在第 18 次模型求值后主动返回完成答复，Harbor 验证通过。轨迹没有 Runtime、Provider、
权限或后台任务异常。

### 4.3 Codex：更早完成坐标换算和文件交付，但选择了偏窄窗口

Codex 在第 9 个 `exec` 左右识别 `shift = 1e7 / raw_x`，随后使用 SciPy 比较常数、线性、
二次背景以及 Lorentzian/Gaussian/Voigt 峰型。它正常创建并用 `python -m json.tool`
校验文件，最终还重算确认写入参数与代码拟合一致；因此 0 分不是格式、路径或收口问题。

其最终参数为：

| 峰 | x0 | gamma | amplitude | offset |
| --- | ---: | ---: | ---: | ---: |
| G | 1580.3381 | 8.443722 | 8298.8277 | 5769.8884 |
| 2D | 2670.1287 | 18.455859 | 12530.798 | 920.49776 |

关键差异出现在 2D 窗口：Codex 最终固定 `2600–2800`，该窄窗口的局部 RMSE 较低，但
峰外基线样本不足，得到更低 offset 和更大 gamma；通过的 Morphz 轨迹则比较了
`2450–2900`、`2500–2900`、`2550–2850`、`2550–2800` 等窗口并选择了更能代表峰外
基线的参数。由于不读取隐藏容差或参考答案，本报告只陈述公开轨迹与最终 reward，不从
验证器反推私有评分规则。

## 5. 对 Agent 设计的实际帮助

### 5.1 不继续加强命令式 v0.4

v0.4 同时包含通用方法词汇和“立即返回”“只有……才允许继续”等命令式语句。本次它比
原生 Morphz 多消耗约 25.1 万 input Token，仍未形成交付物。下一版不能靠更强的
“请及时收口”命令解决，更不能加入 Raman、固定工具次数或固定时间阈值等题目特例。

### 5.2 给方法论，而不是替模型下任务特定命令

通用 Harness/Agent 方法应让模型持续外化以下状态：

1. **交付物状态**：要求的持久效果是否已经存在，当前最佳有效 checkpoint 在哪里；
2. **假设账本**：数据坐标变换、模型族、拟合窗口和背景模型各自的证据与反证；
3. **验收证据**：格式、路径、可执行检查和任务领域检查分别是否完成；
4. **下一步价值**：下一动作能否实质改变验收结论，而不只是产生更多诊断；
5. **终态决定**：依据上述状态由模型决定继续、降级提交还是完成，不由某条题目特定
   命令替它决定。

对本题而言，“先写一个粗糙 JSON”也不是万能答案：错误参数的早写文件仍会像 Codex
一样得 0。正确的方法是尽早建立可修订的交付 checkpoint，同时保留足够的模型验证。

### 5.3 Runtime 只负责通用协议语义

Runtime 可以、也应该区分 progress delivery 与 terminal delivery，并验证显式产物引用
是否存在；但不应替模型规定“第几轮必须完成”、指定拟合窗口或依据自然语言关键词强制
结束。v0.4 的最后一句应当被识别为 progress 或不完整 terminal，而不是自动变成成功
终态；这属于通用 I/O 契约，不是题目过拟合。

### 5.4 Morphz 的下一处效率优化

原生 Morphz 在质量上赢得本题，但 Codex 的执行时间、output Token 和 uncached input
明显更低。下一步应先审查：

- 为什么结构化 Context 投影导致稳定 Prompt 前缀缓存命中较低；
- 是否能减少对同一大文件的分段读取和重复全量历史投影；
- 如何让数据变换、模型选择、窗口敏感性和交付状态成为可寻址认知对象，避免每轮重新
  从文本恢复；
- 如何在不牺牲最终科学判断的前提下，更早形成可验证 artifact checkpoint。

## 6. 停止条件与下一步

本次三组对照已经回答原问题，今天不再调用模型：

- `terminal-task@0.4.0` 继续保持关闭，不改名重跑；
- 原生 Morphz 结果保留为产品诊断证据，不与 89×5 正式成绩拼接；
- 暂不写命令更强的 v0.5；先把上述方法论与 terminal/progress 协议做成设计提案和
  确定性测试；
- 若以后验证新设计，应选择多道未见任务或跨任务失败集合，预先冻结主要指标，避免围绕
  `raman-fitting` 继续拟合 Prompt。

## 7. 证据

协议：[`raman_agent_comparison_protocol_2026_08_24.md`](./raman_agent_comparison_protocol_2026_08_24.md)

归档：[`artifacts/terminal_task_raman_agent_comparison`](./artifacts/terminal_task_raman_agent_comparison)

历史 v0.4 归档：
[`artifacts/terminal_task_harness_v0_4_raman_regression`](./artifacts/terminal_task_harness_v0_4_raman_regression)

关键 SHA-256：

- 原生 Morphz `strict_result.json`：
  `9183eab9f36f03bdbf8415be9abb39472a62d0a2b817a718d99091c1b5e4d2d8`；
- 原生 Morphz ATIF：
  `543e0a7c7f0c49505134c16b6ce4f1c9e4247cb81dfff02d08d586d7857a3f8e`；
- Codex `strict_result.json`：
  `6a26d2c8bad13c10ed2c82901e9c902286a78c936a77a36e8375880ad147615f`；
- Codex ATIF：
  `b7b438d06d4dec8024043383d5b2c7d1f9a02c6bb7925a9aa4e80c3fd5c2e852`；
- Codex 原生 JSONL：
  `a72df2f6609b245f2bb54575713e54fc9ebe916dab4169708df4c2a03d9db724`。

归档只包含公开 job/trial 结果、ATIF、运行配置和 Agent 自有日志；没有复制 verifier 私有
测试、输出、参考答案或隐藏容差。
