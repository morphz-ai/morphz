# ME-05 九模型跨模型普适性 Pilot 结果

> 日期：2026-08-26
>
> 冻结实验 commit：`38d9d845ef1d389bcf5d1f9f6b14b07b703ab590`
>
> 所含 Runtime 主线基线：`9981b9877bcb84e5e76c94eda00af87bb6f95563`
>
> 总 cell：`144/144`，无补跑
>
> 装置完整性：`passed`

## 结论

ME-05 支持 Morphz 的两类核心求值机制能够跨九个模型家族工作，但“语义求值正确”和
“严格服从输出/执行合同”必须分开报告：

- 冻结主评分为 `98/144`（68.1%）；它把 Provider 拒绝、程序执行轨迹偏离、输出 schema
  和语义错误统一严格计为失败；
- ME-02 S-expression 程序求值严格 `26/36`（72.2%），最终交付值 `32/36`（88.9%）；
  四个未交付均为 Claude Provider safety refusal。排除这四个仍保留为正式失败的 Provider
  拒绝后，其他模型最终值为 `32/32`，严格执行轨迹为 `26/32`；
- ME-03 非确定性认知求值严格合同为 `72/108`（66.7%）；预注册评分不变。作为明确标注的
  事后诊断，忽略 `basis` 数组/字符串、额外字段等 schema 形状，只把 `selected` 重新放回
  原始可见合同校验，语义选择为 `104/108`（96.3%）；
- ME-03 剩余四个均是空响应/Provider 级失败。所有实际返回且能够解析出选择的 104 个
  episode，语义选择 `104/104`，没有观察到“成功返回但选择违反 Context 合同”的案例。

因此，本 Pilot 对“结构化程序与 Context 约束的非确定性认知求值不依赖某一个模型家族”
提供了正向证据。它同时暴露出：严格类型合同和精确程序轨迹不能默认由所有 LLM 稳定遵守，
这恰好说明确定性 Runtime 的校验、lowering 和失败处理仍是架构必要组成，而不是可省略包装。

## 分模型结果

| 模型 | ME-02 严格程序 | ME-02 最终值 | ME-03 严格合同 | ME-03 语义选择（事后诊断） | 总严格分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | 4/4 | 4/4 | 8/12 | 12/12 | 12/16 |
| Claude Opus 5 | 0/4 | 0/4 | 10/12 | 12/12 | 10/16 |
| Grok 4.6 | 4/4 | 4/4 | 6/12 | 12/12 | 10/16 |
| Gemini 3.7 Flash High | 4/4 | 4/4 | 12/12 | 12/12 | 16/16 |
| DeepSeek V4 Pro | 3/4 | 4/4 | 5/12 | 9/12 | 8/16 |
| DeepSeek V4 Flash | 2/4 | 4/4 | 6/12 | 11/12 | 8/16 |
| Kimi K3-256K | 3/4 | 4/4 | 9/12 | 12/12 | 12/16 |
| GLM-5.3 | 3/4 | 4/4 | 4/12 | 12/12 | 7/16 |
| Qwen 3.8 Max Preview | 3/4 | 4/4 | 12/12 | 12/12 | 15/16 |

Gemini Flash 的 16/16 说明它与本组短合同任务适配良好，不代表其综合智能高于旗舰模型。
ME-05 不是模型排行榜，也没有重复采样来估计模型方差。

## 失败审计

### ME-02

- Claude Opus 5 的四个程序任务全部在同一个 CLIProxyAPI endpoint 上由
  `anthropic-messages` Provider 明确 safety refusal；没有工具调用或最终值。该结果保留为
  正式失败，但不能解释为 Claude 不具备 S-expression 理解能力；
- 其余六个严格失败全部给出了正确最终值，但没有严格执行冻结程序：五个集中在
  `alternating_branches`，一个 DeepSeek Flash `nested_fallback` 多调用了无关工具；
- 这说明模型可能把结构化程序理解成“要达到的任务”，而不是逐节点解释执行。论文应把
  非确定性求值器和确定性解释/校验边界写清楚，不能用最终答案掩盖执行轨迹偏离。

### ME-03

- 32 个严格失败的选择在事后语义重评分中全部正确，失败原因仅为 `basis` 字符串代替数组、
  返回额外字段等 schema 差异；
- DeepSeek V4 Pro 有 3 个、DeepSeek V4 Flash 有 1 个空响应/Provider 失败；这些 episode
  不能获得语义分；
- 事后语义分不替换冻结严格分，也不用于选择性补跑。它用于回答用户此前提出的合理问题：
  “候选项本身选对，仅 basis 数组/字符串不同，是否应与语义错误区别”。

## 模型绑定与隔离

- 九个模型全部通过 `custom/custom-default` 和 `http://mini-m4.local:8317/v1` CLIProxyAPI；
- 每条 route 单 candidate、`fallback=false`，逻辑模型与物理模型同名；
- Claude 精确 wire protocol 为 `anthropic-messages`，其余八个为 `openai-responses`；Claude
  没有使用直接订阅线路；
- 每个 `model × stage × ME` 使用独立目录与 `provider-control.db`；36/36 子报告、36/36
  数据库路径和 144/144 episode 数通过 launcher 完整性 Gate；
- Stage A 45 个 cell 在 runner 未修改且完整性通过后直接计入结果；Stage B 99 个 cell；
  无模型补跑、无参数调整、无失败重试。

## Usage

Provider 原始 usage 汇总报告 `393,686` input、`52,964` output、`46,996` reasoning、
`446,863` total tokens。不同上游对 cached/uncached/total 的定义并不完全一致，尤其 Claude
协议字段不能与其他 Provider 直接相加作费用或效率排名，因此这些值只作审计，不作跨模型
效率结论。

Kimi K3 本次报告 `35,038` input、`6,096` output、`4,930` reasoning、`41,134` total
tokens；没有出现异常请求膨胀或重复运行。实验无法从 Provider usage 反推出账户实时人民币
余额，但该用量没有显示需要因 100 元余额预先缩减矩阵。

## 证据与复现

- 冻结协议：[`../../me_05_nine_model_generality_protocol_p1.md`](../../me_05_nine_model_generality_protocol_p1.md)
- Gate：[`../../me_05_no_model_and_binding_gate_2026_08_25.md`](../../me_05_no_model_and_binding_gate_2026_08_25.md)
- 聚合主结果：[`raw/me05_summary.json`](./raw/me05_summary.json)
- 严格与语义诊断：[`raw/me05_analysis.json`](./raw/me05_analysis.json)
- 事后诊断复现器：[`analyze_me05_results.py`](../../../../../morphz-evals/tools/analyze_me05_results.py)
- Stage launcher、各模型 report、prompt bundle 和 episode 原始 JSON：[`raw/`](./raw/)
- 222 个归档文件校验：[`CHECKSUMS.sha256`](./CHECKSUMS.sha256)

归档排除了 36 个可再生的 SQLite 文件和重复打印完整 report 的 launcher stdout，将体积从
约 151 MiB 降至约 11 MiB；评分、请求、响应、usage、错误、binding 和工具轨迹均保留在
JSON 中。脱敏扫描未发现 Bearer、`sk-*` 或 API key 值，manifest 只保留凭据环境变量名。

## 论文可用主张

可以写：

> Across nine model families, all 104 parseable nondeterministic-evaluation responses selected a
> value satisfying the visible Context contract. Exact schema compliance and exact program-trace
> compliance varied substantially across providers, motivating deterministic validation and
> execution boundaries around the model-owned evaluator.

不能写：

- 九个模型同等可靠；
- Gemini Flash 综合能力最强；
- Morphz 提升了底层模型智力；
- 68.1% 是公开 Benchmark 分数；
- Provider 拒绝等同于模型不能理解该机制；
- 本 Pilot 已证明长程 Context、并发事务或 Token 效率优势。
