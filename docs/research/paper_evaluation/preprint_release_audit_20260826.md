# Morphz 预印本发布审计（更新于 2026-08-27）

> 用途：证明中英文论文从实验草稿进入可发布状态时，没有遗漏临时结果、越界主张、
> 取消实验或不可复现数字。本文档是发布 Gate，不新增实验结论。

## 1. 目标稿件

- 英文：`morphz_cognitive_symbol_evaluation_paper_draft_en_v1.md`
- 中文：`morphz_cognitive_symbol_evaluation_paper_draft_v1.md`
- 双语稿件仓库提交：`bd8724d`（结果收口基线 `982e71d`，并包含此前 `59c78a0`、`8dfb214`）；ME-07 正式结果、Mind Frame 迁移证据、ME-08 当前完整 89 题同期配对和完整参考文献复核均已进入候选稿
- 数字与主张入口：`paper_claim_evidence_matrix_20260826.md`
- 实验状态入口：`experiment_registry.md`
- 收口报告：`paper_finalization_report_20260827.md`

## 2. 当前证据 Gate

| 项目 | 当前状态 | 发布要求 |
| --- | --- | --- |
| ME-01～ME-06 | 已完成并进入中英文稿 | 保持冻结数字、协议边界和限制条件 |
| ME-07 | 单次正式批次 150 paired cells/450 terminal trials 已闭合：Morphz 122/150、Letta 93/150、Mem0 96/150；Mind Frame 迁移 Gate 150/150 | 报告更新评测器下的本地系统级结果及其统计边界；不得冒充官方榜分，不得把全部分差单独归因于 Mind Frame；盲化人工校准只作可选增强 |
| ME-08 当前完整 89 题同期配对 | 两个独立完整批次已闭合：Morphz 72/89、official Codex 74/89；差 −2.25pp，95% CI [−11.24,+6.74]，`p=0.803619` | 只使用官方 verifier 原始奖励作为主分；明确每题一次不能估计同题采样方差；不得宣称形式化等价、非劣或优越 |
| ME-08 历史运行 | 旧 40+49 合并结果、70/89 对 73/89 以及 Morphz-only 刷新均完整留档 | 只作工程历史；不得回流为当前论文主结果或与当前运行拼接 |
| ME-09 | 额度截止前 43 题有效前缀和跨 Session Frame 审计已保存，实验停止 | 探索性结果不进入当前论文 |

## 3. 最终结果必须同步的位置

ME-07 与 ME-08 当前完整 89 题同期配对均已闭合。中英文稿必须同步更新：

1. 稿件状态与进度行；
2. 摘要中的 ME-07、Terminal-Bench 数字和边界结论；
3. Evaluation/研究问题与共同控制；
4. ME-07 与 ME-08 结果小节；
5. 外部效度、统计效力、成本和系统成熟度限制；
6. 结论；
7. 附录 Claim–Evidence Matrix；
8. 复现入口与最终 artifact 路径；
9. `experiment_registry.md` 和主张—证据矩阵。

最终稿全文不得残留：`running`、`in progress`、`interim`、`partial`、`运行中`、
`正在整合最终实验结果`、`完整结果另行闭合`、`剩余 49 题`，不得把 40+49 历史拼接结果、
非同期单臂刷新或 ME-09 有效前缀写成当前论文结论。

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

ME-08 主口径必须来自官方 verifier `raw_reward`。当前主结果必须来自 2026-08-27 的两个
独立完整 89 题同期运行：Morphz Runtime `4bbc3d63...` 与官方 Codex CLI `0.149.1`，两组均
并发 8、每题一次、零重试。旧 40+49 合并和 Morphz-only 刷新只能保留在历史审计中。

每份 ME-08 报告至少包括：

- 对应运行的 `pass/89` 与准确率；
- 只有当前两个独立完整 89 题同期运行可承担正文的 Morphz-only、Codex-only、both-pass、both-fail、配对差值及检验；
- Provider refusal、timeout、Runtime、adapter/harness 和普通任务失败的独立诊断；
- Token、执行时长和主机资源采样；
- 精确模型、reasoning effort、Runtime/Codex/runner/dataset 身份及零重试约束。

诊断分类不能删除任务、修改官方 reward 或生成“剔除外因后的主分数”。本地完整性扫描器
只能作为附加审计，不能凌驾官方 verifier。

## 5. 已完成的静态审计

- 中英文稿均定义并使用参考文献 `[1]`～`[26]`，无缺号引用；
- 全部 26 条参考文献已经按原始论文页、会议页或项目发布页复核；PLSemanticsBench 所属论文
  标题、AIOS 与 Voyager 的正式发表信息以及 MemGPT 作者列表已经修正；
- 未发现 `/Users`、`/private` 或 `file://` 本机路径泄漏；
- 论文主术语统一为“非确定性认知求值 / nondeterministic cognitive evaluation”；
- “开放求值 / open evaluation”只用于说明为何不采用该宽泛术语；
- 两稿均明确 S-Expression 是当前表示选择，不是贡献本身；
- 两稿均明确 Program-valued `infer` 是未来工作；
- 两稿均只报告完整 STATE-Bench v2 单次正式批次，不报告旧 LongMemEval-V2、A-MEM v1 或
  中止批次的局部效果；ME-07 分数、CI、`p` 值、失败数和 Mind Frame trace 数字来自同一组
  已闭合 Artifact。系统级优势与机制参与证据分层陈述，不越界为单机制纯因果效果。
- 两稿的 ME-08 均只使用 2026-08-27 两个独立完整 89 题同期运行：Morphz 72/89、官方
  Codex 74/89；不存在 `three-task gap`、70/89、73/89 或 40+49 当前主结果残留；
- 中英文内容集合与事实口径一致，但章节顺序按各自读者的叙事习惯保留差异。因此对外称为
  “中文版”和“English version”，不称为逐段“中英文对照版”；
- 英文术语采用语义化大小写：`Structured Context`、`Mind Frame` 等正式构件名使用大写；
  `agent`、`runtime`、`session`、`observation` 在泛指概念时使用小写，在指 Morphz 正式构件时
  才使用大写。不得用无语义的全局替换追求表面计数一致。

## 6. 尚需用户提供的发布元数据

当前两稿尚未写入公开作者元数据。公开发布前必须由用户确认：

- 作者公开姓名及顺序；
- 公开 affiliation（如使用北京新变元科技有限公司）；
- 通讯邮箱；
- 是否加入 ORCID、项目主页、代码仓库或通讯作者标识。

不得从专利、公司登记、Git 提交或私人文件中擅自推断并填入公开作者元数据。

## 7. 最终发布检查

- [x] 当前 ME-08 两个独立完整 89 题运行均通过 official reward、任务唯一性、身份与哈希 Gate；
- [x] 当前 ME-08 配对统计仅使用上述两个同期完整批次；本地扫描器不覆盖官方评分；
- [x] 历史 40+49、70/89 对 73/89 与单臂刷新保留审计但不进入当前主结论；
- [x] ME-07 九份快照、450-trial 三臂正式批次、统计和只读 Mind Frame trace 审计闭合；
- [ ] 可选增强：ME-07 预留 30 条盲化人工评测器校准；不阻塞当前有边界预印本；
- [x] 新结果进入主张—证据矩阵、实验登记及中英文摘要/正文/结论；
- [x] 双语数字与限定语最终机器审计一致；
- [x] 最终全文无临时状态、占位数字、失效链接、本机路径、密钥或 Provider 凭据；
- [ ] 作者元数据由用户确认；
- [x] `git diff --check`、引用集合、Markdown 结构和限定范围提交通过；
- [ ] 最终中英文稿由用户人工通读后再公开。
