# ME-05 九模型跨模型普适性实验协议 p1

> 状态：`frozen`。无模型 Gate、九模型精确绑定 Gate、运行器测试、Cargo 测试、Clippy 和
> diff-check 已全部通过；真实运行必须来自包含本协议、配置、runner、collector 和 scorer
> 的干净冻结 commit。

## 1. 研究问题与边界

ME-05 回答：在不改变 Morphz 核心求值协议和评分标准的条件下，不同能力层级、不同厂商的
语言模型是否都能执行：

1. 以 S-expression 表示的结构化程序—数据统一求值；
2. 受结构化 Context 和类型契约约束的非确定性认知求值；
3. 与非确定性认知求值相配套的确定性唯一结果控制。

本实验验证机制的跨模型可执行性和边界，不比较模型的通用智力排名，不证明某个模型优于
另一个模型，也不把输出多样性等同于随机性。ME-05 不承担长程 Context、并发事务、恢复、
Token 效率或公开 Benchmark 的主张；这些分别由 ME-06、ME-04 和 ME-07 承担。

## 2. 固定模型矩阵

| 编号 | 逻辑/物理模型名 | 家族定位 | 精确协议 |
| --- | --- | --- | --- |
| M01 | `gpt-5.6-sol` | OpenAI 旗舰 | `openai-responses` |
| M02 | `claude-opus-5` | Anthropic 旗舰 | `anthropic-messages` |
| M03 | `grok-4.6` | xAI 旗舰 | `openai-responses` |
| M04 | `gemini-3.7-flash-high` | Google 较轻量能力层级 | `openai-responses` |
| M05 | `deepseek-v4-pro` | DeepSeek Pro | `openai-responses` |
| M06 | `bai-deepseek-v4-flash` | DeepSeek Flash | `openai-responses` |
| M07 | `k3-256k` | Kimi K3 | `openai-responses` |
| M08 | `glm-5.3` | GLM 旗舰 | `openai-responses` |
| M09 | `qwen3.8-max-preview` | Qwen Max Preview | `openai-responses` |

九个模型全部经同一个 `mini-m4.local` CLIProxyAPI 服务入口和 `custom` Provider 调用。
Morphz 对 Claude Opus 5 使用该入口提供的 `anthropic-messages` 兼容协议，其余八个使用
`openai-responses`；这属于同一代理入口内的精确协议绑定，不是直接订阅线路。每条 route
必须只有一个 candidate、`fallback=false`，并在每次运行前核对逻辑模型、物理模型、
Provider、endpoint 和协议；任何静默换模或绕过 CLIProxyAPI 都会使对应 cell 无效。

统一请求 `reasoning=max`。若上游不接受或降级参数，必须原样记录实际绑定和响应元数据，
不得把“请求了 max”写成“实际执行了 max”。

## 3. 冻结任务子集

### 3.1 ME-02：S-expression 程序求值

只使用 ME-02 已冻结 Canonical Program IR 的 S-expression arm，不在 ME-05 重新比较 JSON
和 Markdown：

- `nested_fallback`
- `alternating_branches`
- `shared_reference`
- `merge_after_observations`

评分沿用 ME-02 p1.1：隐藏输出、工具顺序、参数、绑定、分支、回退和最终回复必须全部满足
冻结的严格 scorer。每个模型每个任务运行一次，共 `4` 个 episode。

### 3.2 ME-03：非确定性认知求值

使用 ME-03 已冻结的三个任务族：

- `incident_response`
- `release_strategy`
- `research_strategy`

每个任务运行四个条件：非确定性 Base、非确定性 Context Intervention，以及同一对 Context
下的确定性唯一结果控制。历史内部 condition key `bounded_open_*` 为保持原始产物兼容而
保留，但论文和新协议统一称“非确定性认知求值”。评分沿用 ME-03 p1.1 的类型、候选、数量、
语义合同、Context 因果依据和非空解释规则。每个模型共 `12` 个 episode。

每个模型合计 `16` 个 episode；九个模型总计 `144` 个 episode，不做重复采样。本实验只做
普适性 Pilot，不用单次结果估计模型方差或宣称统计显著性。

## 4. 分阶段运行且不重复消耗

Stage A 同时是装置 smoke 和预注册正式矩阵的第一部分：

- ME-02：`nested_fallback` × S-expression；
- ME-03：`incident_response` × 四条件；
- 每个模型 `5` 个 episode，九模型共 `45` 个。

只有在九个模型的精确绑定、独立状态、报告完整性和 scorer 重放全部通过，且 Stage A 后
没有修改协议、fixture、runner、collector 或 scorer 时，Stage A 才计入最终数据并进入
Stage B。若发生任何上述修改，Stage A 整批标记 invalid，不得选择性保留成功 cell。

Stage B 完成其余 `11` 个 episode/模型；最终按 Stage A + Stage B 合并成冻结的 144-cell
矩阵。此设计避免把 smoke 和正式实验机械重复一遍，同时阻止看到结果后只选择性补跑。

## 5. 隔离、执行顺序与失败处理

- 每个 `model × stage × ME` 使用独立输出目录、独立 SQLite、独立 Context/Session 标识；
- 不读取产品 Context、历史 Session 或其他模型的数据库；
- 同一模型内部 ME-02 与 ME-03 顺序固定；模型启动顺序由冻结矩阵决定；
- 可并发不同模型，但默认并发不超过 `3`，避免共享代理入口限流污染结果；
- Provider 拒绝、超时、格式错误和任务错误全部保留为失败，不自动换模、不静默补跑；
- 只有明确的实验装置故障才能使 cell invalid，且必须在看到任务得分前依据原始证据判定；
- Kimi K3 当前约 100 元可用额度不设为人为截断阈值。逐请求保存 usage；若出现明显异常的
  请求膨胀、重复计费或线路错误，暂停后先审计，不为消耗额度而继续运行。

## 6. 产物与接受门槛

每个 cell 保存完整输入、原始输出、Responses continuation、工具轨迹、Provider usage、错误、
逻辑/物理模型绑定和严格评分。矩阵级产物至少包含：

- frozen protocol、模型配置和源码 commit；
- Stage A/Stage B launcher manifest；
- 每个子实验 `report.json` 和所有 episode JSON；
- 文件 SHA-256 清单；
- 每模型两类机制的通过数、失败类别和 usage 汇总；
- 不夸大的结论边界。

升级为 `frozen` 的 Gate：

1. ME-02、ME-03 无模型正负 scorer Gate 全部通过；
2. 九条 route 的零 completion 精确绑定 Gate 全部通过；
3. 筛选后的 episode 数、独立数据库路径和汇总器负例测试通过；
4. `cargo test`、Clippy `-D warnings` 和 `git diff --check` 通过；
5. 协议、runner、collector、scorer 均来自一个明确、干净的实验 commit。

## 7. 预注册解释

- 若大多数或全部模型通过：支持 Morphz 核心机制不依赖单一模型家族；
- 若轻量模型主要在复杂程序或严格类型上失败：记录能力门槛，不把它解释为机制无效；
- 若某家族出现系统性协议不兼容：报告适配边界，不能用其他模型替换后冒充原模型结果；
- ME-02/ME-03 全部简单 cell 通过仍可能存在天花板效应，只支持可行性和未观察到退化；
- 本 Pilot 不支持“所有模型都能同等可靠地运行 Morphz”或“Morphz 提升基础模型智力”。
