# Morphz 论文证据与稿件收口报告（2026-08-27）

## 1. 当前稿件

- 中文稿：`morphz-ai-biz/docs/research/morphz_cognitive_symbol_evaluation_paper_draft_v1.md`
- 英文稿：`morphz-ai-biz/docs/research/morphz_cognitive_symbol_evaluation_paper_draft_en_v1.md`
- 稿件仓库提交：`8cee436`（包含结果收口提交 `982e71d1b0333caf4db9ed0f2cd0a1a1ddf41dc5`）
- 英文预印本 PDF：`morphz-ai-biz/output/pdf/morphz_nondeterministic_cognitive_symbol_evaluation_preprint_en.pdf`

两稿的机制描述、ME-01～ME-08 数字、限定语、参考文献和附录证据入口已经同步。中文版与
English version 保持相同事实和主张强度，但允许采用各自的章节编排，不作为逐段翻译稿。

## 2. 当前权威外部结果

### ME-07：经验迁移

- Morphz：122/150（81.33%）
- Letta：93/150（62.00%）
- Mem0 支撑的参照系统：96/150（64.00%）
- Morphz−Letta：+19.33pp，95% CI `[+10.67,+28.00]`
- Morphz−Mem0：+17.33pp，95% CI `[+10.00,+24.67]`
- 两项 Holm 校正 `p=0.000060`
- 150/150 Morphz 轨迹通过 Mind Frame 迁移 Gate

### ME-08：完整智能体外部效度

当前主结果来自 Morphz 与官方 Codex 各自独立完成的完整 89 题同期运行，不使用 40+49
拼接：

- Morphz：72/89（80.90%）
- 官方 Codex：74/89（83.15%）
- 共同通过 65、共同失败 8、仅 Morphz 通过 7、仅 Codex 通过 9
- Morphz−Codex：−2.25pp
- 任务级自助法 95% CI `[-11.24,+6.74]`
- 双侧精确配对 `p=0.803619`

该单次配对没有解析出稳定系统差异，也不足以证明形式化等价或非劣。旧 40+49 合并结果、
历史 70/89 对 73/89 和 Morphz-only 刷新只保留为工程历史，不承担当前论文结论。

## 3. 复核结果

- ME-08 归档中 89 个任务的配对统计、失败保留、运行身份和 SHA-256 校验通过；
- 官方验证器原始奖励是唯一主分；附加本地扫描器不覆盖 Codex 74/89；
- 中英文稿均有 26 条参考文献，编号连续且全部被引用；
- 已按原始出版页面复核全部 26 条文献，并修正 PLSemanticsBench 所属论文标题、AIOS 与
  Voyager 的正式发表信息，以及 MemGPT 的作者列表；
- 两稿代码围栏均为 38 个，Markdown 结构闭合；
- 未发现旧 ME-08 主结果、`three-task gap`、`Ledger`、开放求值、本机路径或模型凭据残留；
- 英文 `two-task gap` 与 72/89 对 74/89 一致；中文结论中的指代残句已重写；
- ME-08 附录同时固定 Morphz 与官方 Codex 两个评测基础设施修订。
- 中英文稿公开作者名均已确认为 `Raymond Ren`；英文 PDF 共 27 页，逐页视觉复核无裁切、
  空白页或表格、代码块、附录与参考文献溢出。

## 4. 未进入当前论文的实验

ME-09 因订阅额度耗尽停止。额度截止前 43 题的共享 Context 有效前缀为 25/43，同题隔离
Context 为 33/43；唯一跨 Session 显式 Frame 引用没有形成正向迁移案例。该结果只作为
后续选择性共享设计证据，不进入当前论文。

## 5. 发布元数据

研究内容与实验结果已经达到当前有边界预印本候选稿状态。作者公开姓名已经确认为
`Raymond Ren`。当前稿不虚构或推断 affiliation、通讯邮箱、ORCID、项目主页、代码仓库与
通讯作者标识；这些项目可在作者决定公开时再补充，不阻塞当前预印本 PDF。

ME-07 的 30 条盲化人工评测器校准和 ME-08 重复采样属于后续增强，不阻塞当前有边界预印本。
