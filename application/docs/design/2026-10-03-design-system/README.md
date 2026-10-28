# 前端工程提案与历史探索材料

日期：2026-10-03。状态：视觉规范已撤回；工程提案仍待评审、尚未落地。不是新的生产界面，不代表原 App 验收通过。

- [已撤回的视觉探索稿](../../design-system-exploration-withdrawn-2026-10-03.md)：只供历史追溯，其中数值及 MUST 等文字不产生规范效力，不作为后续 UI 实现依据。
- [前端整体架构](../../41-frontend-architecture.md)：已有基础、职责层、状态所有权、查询与事件、展示投影、CSS 所有权及渐进迁移。
- [职责图](./frontend-architecture.html)：只列主要调用依赖，不是完整数据流或业务执行时序；只读展示投影不直接依赖查询模块。
- [图的浏览器检查记录](./frontend-architecture.visual-check.json)及[明暗截图](./frontend-architecture.visual-check.html)。

## 交付记录

```text
diagram_type: architecture
output: /Users/shafreeck/Codes/Morphz/application/docs/design/2026-10-03-design-system/frontend-architecture.html
specification_sha256: 03b36c1b117d9badd6406dff9b266e7fe318e79a1c8d9d9059337db869ea0eca
specification_bytes: 3365
artifact_sha256: 958ed0e7001b61abda0f184f2a325e4e3c2b9aeb89879a9f9b192e815344b421
artifact_bytes: 709344
validation: passed (9/9; showcase; 0 errors; 0 warnings)
browser_evidence: passed
visual_review: passed
correction_rounds: 1
```

自动检查在确切交付 HTML 上完成 1440×900、1600×1000、1920×1080、2048×1320 的浅色首屏容纳测量，以及 1440×900、2048×1320 的明暗截图。人工式图像复核查看最终 1440×900 浅色与 2048×1320 深色截图：主图、连线、标签、图例和结论卡没有可见遮挡或截断；大尺寸没有明显的空白底带。此次图像复核不包含交互功能、导出行为或产品审美的用户认可。

唯一图像修订轮修正了误导的“后端”图例及纯投影到查询模块的依赖，随后重新验证、交付和截图。自动记录始终保留 `visualReview: pending`，没有把自动检查改写成人工审查结果。

当时两份提案通过格式及本地链接检查，只读审查指出的状态与范围边界得到修订；这些历史证据只覆盖文档一致性与架构图，不是前端重构、Runtime 能力或产品审美验证。视觉规范现已撤回，不能因这些检查重新获得规范地位。

## 与当前 App 故障的区别

本提案没有修改生产 UI、重启 Runtime 或清除数据。原 App 空白问题随后另行修复并恢复，准确验证与未定位边界见[实施记录](../../13-implementation-status.md)；不能将该修复算作前端整体架构已落地。
