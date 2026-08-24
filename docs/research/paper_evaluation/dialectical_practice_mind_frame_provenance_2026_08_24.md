# 《实践论》《矛盾论》Mind Frame 原文通读与概念来源

> 状态：`complete-original-reading / exploratory-frame-frozen`
>
> 日期：2026-08-24
>
> 用途：Terminal-Bench 四臂探索实验；不代表对哲学文本的完整学术阐释

## 1. 原文读取记录

本 Frame 不是根据模型既有知识生成。2026-08-24 已逐篇完整读取以下中文原文正文与注释：

- [《实践论：论认识和实践的关系——知和行的关系》](https://www.marxists.org/chinese/maozedong/marxist.org-chinese-mao-193707.htm)；
- [《矛盾论》](https://www.marxists.org/chinese/maozedong/marxist.org-chinese-mao-193708.htm)。

网页经 Jina Reader 转为 Markdown 后仅在 `/private/tmp` 临时保存并分段通读，不把大段
原文复制进仓库或每次模型请求。抓取快照的审计信息：

| 原文 | 行数 | UTF-8 bytes | 临时快照 SHA-256 |
| --- | ---: | ---: | --- |
| 《实践论》 | 93 | 34,827 | `8a421918c54263860f9c765b2c0d99cf42dd4c92358af83b887616eb3a7310c3` |
| 《矛盾论》 | 330 | 86,708 | `46b0641fbc815f3e5b96307fae5c779e418a3929f07135bf929fbd3f8bf7d129` |

哈希只证明本次读取快照的身份；源网页未来更新时可能变化。

## 2. 从全文提炼到认知机制

### 2.1 《实践论》

全文的可操作认识论结构不是一句“多做实践”，而是：

1. 认识从对具体环境和实际后果的接触开始；
2. 零散感性材料需要经过比较、整理和综合，形成对关系与规律的暂时理解；
3. 理解还要返回行动，由客观结果检验；
4. 结果与预期不一致时，失败不是简单噪声，而是修改认识的材料；
5. 环境、阶段和实践变化后，旧认识不能冻结，需要再次进入“实践—认识—再实践—再认识”；
6. 既反对脱离环境的教条，也反对停留在零碎经验而拒绝综合。

对应 Frame：`concrete experience → provisional understanding → practical outcome → revised understanding`。

### 2.2 《矛盾论》

全文的可操作分析结构不是把任何问题机械说成“有矛盾”，而是：

1. 事物要在内部关系以及同周围条件的联系中理解，而非孤立、静止地贴标签；
2. 共性存在于具体特殊性中，不同性质的问题不能套同一个公式；
3. 复杂过程同时存在多组相互作用的矛盾，其地位并不平均；
4. 当前主要矛盾以及矛盾的主要方面，会规定或影响其它关系；
5. 主要与次要、对立双方的位置，会随条件和发展阶段变化；
6. 对立面既排斥又相互依存，并可能在具备条件时转化；
7. 对抗只是矛盾的一种形式，不能把“冲突升级”当成普遍解法。

对应 Frame：`concrete situation → interacting tensions → current principal tension/aspect → conditions and stage → possible transformation`。

## 3. 最终 Mind Frame 的取舍

实现只保留认识论结构，不复制历史例证、政治任务、原文长句或固定行动步骤。这样做有三个
原因：

1. 实验要检验抽象哲学框架是否改变通用任务表现，不是测试模型复述文章；
2. 历史例证会显著增加 Token 并把注意力引向与 Terminal-Bench 无关的内容；
3. 《矛盾论》本身反对把一般公式机械套到具体问题，因此最终 Frame 必须保持条件性和
   可选择性。

最终包：
[`terminal-task-dialectical-practice.hns`](../../../morphz-evals/harnesses/terminal-task-dialectical-practice.hns)

- ID/version：`terminal-task-dialectical-practice@0.1.0`；
- source SHA-256：
  `b05d8883928a50be19bb2075761596e97bab19784258a293a30d5c8f0df4ec3a`；
- normalized artifact：
  `sha256:6ecfafdac4636b3de67022218eddd399812ae050f749c9f59193097f89440559`；
- 静态干预门禁：4 个作用域、1617 个自然语言字符、0 个强命令命中。

## 4. 实验解释边界

哲学臂相对 v0.5 的差异不仅是几个字段名称，还包含完整的关系性认识框架；因此若结果有
差异，只能归因于这个 Frame 的整体注入，不能声称某一条哲学命题单独有效。每题仅一次
也不能消除采样随机性。本轮结果只用于决定这一方向是否值得做更严格的多次验证。
