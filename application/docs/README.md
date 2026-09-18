# Morphz 应用产品设计文档

日期：2026-09-06  
状态：设计草案，不代表已发布功能或稳定协议

Morphz 应用面向人与 AI 的共同工作：Agent 自主规划和协调事务，人和 Agent 都可以承担工作。Web 与 Desktop 使用同一应用业务层；Mobile 和浏览器扩展仍是后续目标，不代表当前已提供这些客户端。

当前应用源码已位于 Morphz 主仓库的 `application/`，包名为 `morphz-application`。
MorphzWork 仅保留为旧仓库、兼容路径与历史文档中的称呼。实际实现以
[实施记录](./13-implementation-status.md)、[共享应用层](./24-shared-application-host.md)
和[仓库整合记录](./25-repository-integration.md)为准；下列早期草案不代表现状或发布承诺。

产品需求从真实使用中的摩擦出发。Morphz 的认知、事务和调度能力用于支撑体验，不作为预先限定产品范围的功能清单。

## 文档范围

这些文档介绍 Morphz 应用的产品目标、交互场景和应用架构，供使用者与贡献者评审。应用提供用户界面与业务规则，Morphz Runtime 提供认知、调度与执行底座；两者在同一仓库中保持独立模块，通过明确的 API／SDK 对接。

## 阅读顺序

1. [产品定位与原则](./01-product-direction.md)：产品目标、参与者和中心／Edge 关系。
2. [需求与交互场景](./02-experience-scenarios.md)：从推广协作等真实需求展开的体验设想。
3. [事务对象与生命周期草案](./03-work-item-lifecycle.md)：通用 Inbox、责任分派、模型选择、交接和交付。
4. [开放设计问题](./04-open-design-questions.md)：需要进一步明确的契约与验证方法。
5. [应用架构与分发](./05-application-architecture-and-distribution.md)：组件职责、Web App 获取方式与兼容性要求。
6. [Principal 与团队协作](./06-principals-and-team-collaboration.md)：团队成员如何以独立身份与同一个 Agent 对话、接收任务和交付结果。
7. [技术选型](./07-technology-selection.md)：桌面采用 Electron 的决策、内置浏览器与扩展边界、其他端的选型状态及首轮验证要求。
8. [第一条完整工作流程与工作空间](./08-first-workflow-and-workspace.md)：Inbox、工作、对话与浏览器如何接续，人工调整、交付与失败处理的验收要求。
9. [Runtime 接入评估](./09-runtime-integration-assessment.md)：基于固定源码版本区分已有能力与接入缺口，列出身份、工作事项、模型策略、同步和浏览器的待补契约。
10. [对象模型与工程基础](./10-object-model-and-foundation.md)：以 Actant、InputBox、Artifacts 与 Views 为核心的产品结构，以及第一阶段正式工程的实现边界。此前草案中的交互组织与它不一致时，以此文档为准。
11. [桌面界面](./11-desktop-interface.md)：窗口、侧栏、工作台、项目、主题与输入框的当前界面约定。
12. [桌面能力实施路线](./12-desktop-capability-roadmap.md)：本轮桌面优先、本地中心验证的范围，四个能力里程碑与验收边界。与早期多端排期有差异时，以本文件的本轮范围为准。
13. [桌面能力实施记录](./13-implementation-status.md)：各里程碑实际已实现和已验证的内容，以及尚未完成的部分。
14. [本机中心与身份接入](./14-local-center-and-identity.md)：单用户／团队模拟中心、私有配置与配套 Runtime 的开发接入方式。
15. [认知应用与工作空间](./15-cognitive-application-host.md)：应用宿主、独立 UI、工作台保存为项目、空间级 Session、Harness 路由和权限协议。工作台与 Session 的现行约定以本文件为准。
16. [Morphz UI 设计规范与优化方案](./16-ui-design-standard.md)：以 Apple HIG 和 W3C 可访问性规则为依据，定义工作导向的导航、输入与交流联动、页面取舍、搜索与弹窗及视觉基线。公共 UI 首轮已落地，具体完成项和后续目标分别记录，不将目标规范等同于全部已实现。

## 文档约定

- **产品原则**：用于指导设计与评审的目标和边界，不等同于功能已经实现。
- **已确定的设计决策**：当前采纳的方向，不表示相关功能已经实现或通过验证。
- **设计提案**：交互、对象或工程契约的候选方案，可以根据验证结果修订。
- **待验证**：需要原型、实际使用或技术核对才能下结论。
- “支持”“可以”等产品描述表示拟设计的体验，不宣称当前 Morphz Runtime 已完整实现。
- 文档中的“事务／工作事项”指用户层面的工作对象；底层 `context_tx` 等另称“上下文事务”，二者不可混用。

## 参与设计评审

反馈可以引用具体章节，说明使用场景、当前方案的不足、替代方案及验证方式。本文档集不提供安装承诺；设计中的命令、接口和状态机应在实现与验证后另行形成使用文档。
