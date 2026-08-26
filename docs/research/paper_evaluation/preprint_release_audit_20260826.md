# Morphz 预印本发布审计（2026-08-26）

> 用途：证明中英文论文从实验草稿进入可发布状态时，没有遗漏临时结果、越界主张、
> 取消实验或不可复现数字。本文档是发布 Gate，不新增实验结论。

## 1. 目标稿件

- 英文：`morphz_cognitive_symbol_evaluation_paper_draft_en_v1.md`
- 中文：`morphz_cognitive_symbol_evaluation_paper_draft_v1.md`
- 双语结果整合提交：`morphz-ai-biz@3158104`
- 数字与主张入口：`paper_claim_evidence_matrix_20260826.md`
- 实验状态入口：`experiment_registry.md`

## 2. 当前证据 Gate

| 项目 | 当前状态 | 发布要求 |
| --- | --- | --- |
| ME-01～ME-06 | 已完成并进入中英文稿 | 保持冻结数字、协议边界和限制条件 |
| ME-07 | STATE-Bench 三强记忆臂协议、adapter 与真实学习产物构建/重载 Gate 已完成；锁定评测访问未完成 | 不报告旧 LongMemEval 局部结果；没有官方效果结果前只写方法与预注册边界 |
| ME-08 前 40 题 | 已冻结，Morphz 30/40、official Codex 28/40 | 只作冻结子集历史，不作为最终主结果 |
| ME-08 后 49 题 | 已完成，Morphz 40/49、official Codex 45/49 | 与前 40 的身份和任务集合核验后合并 |
| ME-08 完整 89 题 | 已完成，Morphz 70/89、Codex 73/89；差 −3.37pp，`p=0.678` | 同环境 paired 主结果；每题每 arm 一次；不得声称采样方差、形式化非劣或普遍优越 |

## 3. 最终结果必须同步的位置

完整 89 题结果已生成；中英文稿必须同时更新：

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

## 4. ME-08 报告 Gate

主口径必须来自官方 verifier `raw_reward`，并至少报告：

- 两臂各自 `pass/89` 与准确率；
- Morphz-only、Codex-only、both-pass、both-fail；
- 配对差值及其区间；
- 双侧精确配对检验/McNemar 等价结果；
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
- 两稿不报告 ME-07 效果分数；旧 LongMemEval-V2 只作为取消历史。STATE-Bench 三个强记忆
  arms 的协议、adapter 与真实学习产物 Gate 可作为预注册/复现材料，但在锁定 evaluator 和
  正式运行完成前不得写入效果数字。

## 6. 尚需用户提供的发布元数据

当前两稿仍保留作者占位符。公开发布前必须由用户确认：

- 作者公开姓名及顺序；
- 公开 affiliation（如使用北京新变元科技有限公司）；
- 通讯邮箱；
- 是否加入 ORCID、项目主页、代码仓库或通讯作者标识。

不得从专利、公司登记、Git 提交或私人文件中擅自推断并填入公开作者元数据。

## 7. 最终发布检查

- [x] ME-08 49 题 launcher 与两臂 official results 完整；本地扫描误报不覆盖官方评分；
- [x] 合并 89 题时验证任务集合不重叠且并集恰为 89；
- [x] 官方得分、配对表、统计、资源和失败诊断可由冻结 artifact 重算；
- [x] 主张—证据矩阵、实验登记、中英文摘要/正文/结论数字一致；
- [x] 无临时状态、占位数字、失效链接、本机路径、密钥或 Provider 凭据；
- [ ] 作者元数据由用户确认；
- [x] `git diff --check`、引用集合、Markdown 结构和限定范围提交通过；
- [ ] 最终中英文稿由用户人工通读后再公开。
