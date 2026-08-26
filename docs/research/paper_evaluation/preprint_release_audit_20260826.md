# Morphz 预印本发布审计（2026-08-26）

> 用途：证明中英文论文从实验草稿进入可发布状态时，没有遗漏临时结果、越界主张、
> 取消实验或不可复现数字。本文档是发布 Gate，不新增实验结论。

## 1. 目标稿件

- 英文：`morphz_cognitive_symbol_evaluation_paper_draft_en_v1.md`
- 中文：`morphz_cognitive_symbol_evaluation_paper_draft_v1.md`
- 双语结果当前基线：`morphz-ai-biz@209066e`；最终结果尚未形成定稿提交
- 数字与主张入口：`paper_claim_evidence_matrix_20260826.md`
- 实验状态入口：`experiment_registry.md`

## 2. 当前证据 Gate

| 项目 | 当前状态 | 发布要求 |
| --- | --- | --- |
| ME-01～ME-06 | 已完成并进入中英文稿 | 保持冻结数字、协议边界和限制条件 |
| ME-07 | v2 Morphz/Letta/Mem0 adapter、持久化重载、精确模型绑定与三臂 scored smoke Gate 已通过；九份正式训练快照正在云端闭合，正式批次尚未启动 | 不报告旧 LongMemEval 或 A-MEM v1 局部结果；正式统计及人工校准闭合前只写方法、Gate 与预注册边界 |
| ME-08 前 40 题 | 已冻结，Morphz 30/40、official Codex 28/40 | 只作冻结子集历史，不作为最终主结果 |
| ME-08 后 49 题 | 已完成，Morphz 40/49、official Codex 45/49 | 与前 40 的身份和任务集合核验后合并 |
| ME-08 历史完整 89 题 | 已完成，Morphz 70/89、Codex 73/89；差 −3.37pp，`p=0.678` | 保留为原始 Runtime、并发 1 的同环境 paired 历史结果；不得与后修复运行拼接 |
| ME-08 新 Runtime 完整 89 题 | Morphz-only、并发 8、每题一次的独立刷新正在运行；Codex 不重跑 | 必须按官方 verifier `raw_reward` 闭合全部 89 题并通过唯一性、身份、哈希及失败保留 Gate；历史 Codex 只能作为非同期参考 |

## 3. 最终结果必须同步的位置

历史完整 89 题结果已生成，新 Runtime 的 Morphz-only 完整刷新尚未闭合；中英文稿必须在新结果通过 Gate 后同时更新：

1. 稿件状态与进度行；
2. 摘要中的 Terminal-Bench 数字和边界结论；
3. Evaluation/研究问题与共同控制；
4. ME-08 结果小节；
5. 外部效度、统计效力、成本和系统成熟度限制；
6. 结论；
7. 附录 Claim–Evidence Matrix；
8. 复现入口与最终 artifact 路径；
9. `experiment_registry.md` 和主张—证据矩阵。

最终稿全文不得残留：`running`、`in progress`、`interim`、`partial`、`运行中`、
`正在整合最终实验结果`、`完整结果另行闭合`、`剩余 49 题`，或把 30/40 与 28/40
写成完整结论的句子。前 40 题可以作为审计历史保留，但必须明确为冻结子集。

## 4. Runtime release-r3 与 ME-08 报告 Gate

ME-07 正式评测必须使用同时包含请求—回复 durable fence 与终态交付修复的 Runtime：

- adapter 基线：`2e502056f52fc355e29f01df69d3b434607c257e`；
- 通用终态交付与 SQLite 取消安全修复：`ac3344ef557d749f0c2f1d1c3ab572586e852e91`；
- 组合正式基线：`2249878536ce5f7a8d7449add2f5c8743395b69b`；
- Linux 二进制 SHA-256：`7b0c63cd685f4b4420f362bea1f986fa4546ad27482802aec5af3c9cbdbb356e`；
- 无模型 Gate 必须证明 durable `chat/reply`、非空 `delivered_at`、进程退出后新的
  `BEGIN IMMEDIATE` 写事务可成功，并且 `model_calls=0`。

已经启动的训练快照仍保留原生产二进制身份，不得为了统一哈希而重跑或拼接。修复只用于正式
评测请求—回复交付边界；训练快照的生产身份必须在 manifest 中单独记录。

ME-08 主口径必须来自官方 verifier `raw_reward`。本轮新 Runtime 刷新仅运行 Morphz，不能
伪装成与历史 Codex 的同期 paired 重跑。报告必须把新 Morphz 分数、历史 paired 结果及二者的
并发差异分开。

每份 ME-08 报告至少包括：

- 对应运行的 `pass/89` 与准确率；
- 只有历史同期 paired 运行可报告 Morphz-only、Codex-only、both-pass、both-fail、配对差值及检验；
- Provider refusal、timeout、Runtime、adapter/harness 和普通任务失败的独立诊断；
- Token、执行时长和主机资源采样；
- 精确模型、reasoning effort、Runtime/Codex/runner/dataset 身份及零重试约束。

诊断分类不能删除任务、修改官方 reward 或生成“剔除外因后的主分数”。本地完整性扫描器
只能作为附加审计，不能凌驾官方 verifier。

## 5. 已完成的静态审计

- 中英文稿均定义并使用参考文献 `[1]`～`[23]`，无缺号引用；
- 未发现 `/Users`、`/private` 或 `file://` 本机路径泄漏；
- 论文主术语统一为“非确定性认知求值 / nondeterministic cognitive evaluation”；
- “开放求值 / open evaluation”只用于说明为何不采用该宽泛术语；
- 两稿均明确 S-Expression 是当前表示选择，不是贡献本身；
- 两稿均明确 Program-valued `infer` 是未来工作；
- 两稿不报告 ME-07 效果分数；旧 LongMemEval-V2 与 A-MEM v1 只作为取消/取代历史。
  STATE-Bench v2 的 Morphz/Letta/Mem0 协议可作为预注册材料，但 Letta Gate、更新评测器
  验证和正式运行完成前不得写入效果数字。

## 6. 尚需用户提供的发布元数据

当前两稿仍保留作者占位符。公开发布前必须由用户确认：

- 作者公开姓名及顺序；
- 公开 affiliation（如使用北京新变元科技有限公司）；
- 通讯邮箱；
- 是否加入 ORCID、项目主页、代码仓库或通讯作者标识。

不得从专利、公司登记、Git 提交或私人文件中擅自推断并填入公开作者元数据。

## 7. 最终发布检查

- [x] 历史 ME-08 49 题 launcher 与两臂 official results 完整；本地扫描误报不覆盖官方评分；
- [x] 历史合并 89 题时验证任务集合不重叠且并集恰为 89；
- [ ] 新 Runtime Morphz-only 89 题运行闭合并通过 official reward、任务唯一性、身份与哈希 Gate；
- [ ] ME-07 九份快照、三臂正式批次、统计与盲评材料闭合；
- [ ] 新结果进入主张—证据矩阵、实验登记及中英文摘要/正文/结论，且数字一致；
- [ ] 最终全文无临时状态、占位数字、失效链接、本机路径、密钥或 Provider 凭据；
- [ ] 作者元数据由用户确认；
- [x] `git diff --check`、引用集合、Markdown 结构和限定范围提交通过；
- [ ] 最终中英文稿由用户人工通读后再公开。
