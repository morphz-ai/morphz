# 待答问题面板：实现与复核记录

日期：2026-10-25；按 10:47、10:57 的人类反馈更新。范围：Desktop 与 Dashboard
原活动卡上的回答入口及独立回复弹窗。这是现有 Operate 界面的局部扩展，方向见
[交互方向](2026-10-25-user-input-dialog-direction.md)，`seed: none`。

当前新审阅者对紧凑面板的原机实拍与 16 张最新挂载图给出 **ship-with-notes**：
所审证据中没有残余视觉阻断。先前被用户否决的 `ship` 结论全部作废，旧 14 图
批次不再支持当前结论。当前意见也不等于用户已经认可审美、全功能原机验收或
整体 Runtime 验收。实际端到端验证与本地提交仍为 **pending**，尚未发布。

## 实现边界与现有系统

最新绑定要求是：原活动卡只增加可见的“回答问题”按钮，绝不内嵌或缩进展示
问题。点击才打开已保存问题的弹窗；编号选项可选，始终允许自由文字；只有
明确发送才提交给原提问 Thread。关闭保留各自表单，不占用或修改主输入草稿。
旧记录缺少问题正文时如实说明，不从进度或相邻消息重建问题。

本次文档检查的视觉来源和消费组件如下，数值仅描述当前实现，不新增全局规范。

| 来源 | 当前组件的使用方式 |
| --- | --- |
| [现有 Desktop 设计入口](../../DESIGN.md)、[UI 规范](../16-ui-design-standard.md) | 沿用紧凑标题／动作行、密集详情文字、系统亮暗、四套强调色和原生模态分工；未宣称已经接入 shadcn/ui。 |
| [Desktop 主题](../../apps/web/src/styles.css)、[共享 UI](../../apps/web/src/ui.css)、[基础控件](../../apps/web/src/ui/controls/base.css) | 系统字体栈；问题、选项和文本框使用既有 14px／1.6 详情角色；标题使用 14px 共享角色；复用 4／8／12／16／24px 间距、7px 控件圆角、中性表面、`--accent-strong` 和现有主按钮／焦点配方。 |
| [Dashboard 主题](../../../dashboard/src/App.css) | 保留 cyan／iris／coral／mono 及亮暗模式；沿用中性表面、`--text`／`--muted`、`--accent-strong`／`--on-accent`、6／8／16px 圆角。问题面板标题 16px、问题 15px、选项／文本框 14px，普通辅助文字 12px；两端输入下的折叠来源行均为 11px。 |
| [Desktop 问题样式](../../apps/web/src/user-input-dialog.css)、[Dashboard 问题样式](../../../dashboard/src/components/user-input-dialog.css) | 当前宽度 512px；选项行 40px、编号 20px、输入最小 48px。问题紧随标题，来源披露在输入下方。Desktop 局部清除继承的 header／footer 留白，Dashboard 同步收紧本地留白；正文内部滚动，粗指针选项／回答入口保留 44px。没有新增全局色值或阴影系统。 |
| 两端 `UserInputDialog`、`LegacyUserInputDialog`、`UserInputDialogHost`、`UserInputPreview` | 使用真实保存的问题对象和请求身份；发送、忙碌、结果未确认、过期及权限丢失各有状态；旧记录明确标注缺失问题正文。 |
| Desktop `useModal`、Dashboard `useQuestionDialog` | 原生 `<dialog>` 模态，关闭后的入口焦点恢复及 Tab 范围；回复表单不通过主 composer 路由。 |
| Desktop `ExecutionSidebar`／`SubjectObjectives`／`SubjectObjectiveDialog`，Dashboard `App`／`ThreadCausalCard` | 原工作卡只显示回答动作，不展开问题或新增缩进问题块；`UserInputPreview` 保留实现名称，但当前只渲染入口按钮。原工作身份继续决定回复目的地。 |

`application/DESIGN.md` 原样保留；本轮没有替换它，也没有生成或改写设计侧车。
检查时未发现 PRODUCT.md、Dashboard DESIGN.md 或两端 `.impeccable/design.json`。
这些是本次扩展前已有的上下文／文档缺口；现有代码已经提供视觉系统，缺文件
不等于新品牌。本轮未启动品牌访谈、概念种子、格式迁移或顺带修复。

## 当前修正与复核

当前结论来自新审阅者对原机实拍及最新 16 图的独立复核交接；文档整理未另开
浏览器或新增复核轮次。人类反馈优先于此前审阅意见。

| 复核问题 | 已落实的修正与确认范围 |
| --- | --- |
| 10:47：原活动卡不能嵌入／缩进问题 | 原卡只保留可见“回答问题”按钮，点击才开弹窗；最新两端活动态截图与实际组件已核对。 |
| 10:57：再次否决 640px 弹窗比例 | 当前面板收至 512px，选项行／编号／输入分别为 40／20／48px，并清除继承的标题／底栏留白。短题断言宽度不超过 512px、高度不超过 360px；该高度只适用于短题，不是长批次的固定上限。 |
| 问题被任务来源压后，层级和比例不合适 | 具体问题紧随紧凑标题；任务来源移至输入下方，作为默认折叠的 11px 次级行，仍能查看完整来源。 |
| 未知投递与权限丢失时，恢复操作说明不充分 | 两端明确说明答案／原投递已保留，核对重试原请求；权限丢失保留草稿，并说明恢复访问后关闭重开核对。最终未知回执、权限状态截图与回归已覆盖。 |
| Dashboard 浅色启用控件的文字对比不足 | 浅色 Send 使用既有 `--accent-strong`，取消选择也使用强强调色；浏览器从 computed styles 测得四套浅色主题的启用 Send／取消选择均达到 4.5:1。修正在局部组件，不改全局品牌色。 |

当前 `ship-with-notes` 仅说明所审原机短题画面与挂载状态没有残余视觉阻断；
其他真实状态和用户审美认可仍有证据缺口。这不是全产品审计，不能用审阅意见
或自动断言替代用户反馈和真实投递验收。

## 原机与挂载证据

当前 Desktop 的短题弹窗原机实拍保留在私有本地路径
`/tmp/morphz-user-input-acceptance.lpiXdF/desktop-compact-question-open.jpg`，未加入
仓库。原机实拍编码为 JPEG（2760×1840）。主流程只验证了
短题打开／关闭，以及此前同一请求草稿保留；没有发送答案，关闭后请求仍待答。
这不能推断其他异常状态或 Dashboard 已完成原机验收。

最终挂载图片位于 [user-input-final](../../.impeccable/review/user-input-final/)。16 个
文件均为有效 PNG，与私有 `compact-panel-fixtures` 输出逐字节一致。两端挂载
当前实际组件及 CSS，数据和 API 为显式 `TEST` 合成夹具；这是开发证据，不是
实际 Runtime 处理结果。旧图由主流程保留在私有 rejected 证据目录，不再用作
当前视觉结论。

| 状态 | Desktop | Dashboard | 图片尺寸 |
| --- | --- | --- | --- |
| 原活动卡，仅回答入口 | [截图](../../.impeccable/review/user-input-final/desktop-pending-activity.png) | [截图](../../.impeccable/review/user-input-final/dashboard-pending-activity.png) | 1280×900 |
| 选项与自由文字，浅色 | [截图](../../.impeccable/review/user-input-final/desktop-choices-light.png) | [截图](../../.impeccable/review/user-input-final/dashboard-choices-light.png) | 1280×900 |
| 选项与自由文字，深色 | [截图](../../.impeccable/review/user-input-final/desktop-choices-dark.png) | [截图](../../.impeccable/review/user-input-final/dashboard-choices-dark.png) | 1280×900 |
| 窄窗，深色 | [截图](../../.impeccable/review/user-input-final/desktop-choices-narrow-dark.png) | [截图](../../.impeccable/review/user-input-final/dashboard-choices-narrow-dark.png) | 390×844 |
| 多问题，紧凑窗口 | [截图](../../.impeccable/review/user-input-final/desktop-batch-compact.png) | [截图](../../.impeccable/review/user-input-final/dashboard-batch-compact.png) | 640×450 |
| 投递结果未确认 | [截图](../../.impeccable/review/user-input-final/desktop-unknown-receipt.png) | [截图](../../.impeccable/review/user-input-final/dashboard-unknown-receipt.png) | 1280×900 |
| 旧记录缺少问题正文 | [截图](../../.impeccable/review/user-input-final/desktop-legacy-question.png) | [截图](../../.impeccable/review/user-input-final/dashboard-legacy-question.png) | 1280×900 |
| 权限撤销 | [截图](../../.impeccable/review/user-input-final/desktop-permission-revoked.png) | [截图](../../.impeccable/review/user-input-final/dashboard-permission-revoked.png) | 1280×900 |

本次产品实现没有随附栅格素材；上述 PNG 是合成测试截图，原机实拍单独私有
保留，没有把用户当前工作画面当作公开夹具。

## 开发验证与剩余验收

主流程交接报告：[挂载浏览器回归](../../tests/user-input-dialog-mounted.test.ts)
最新结果为 **1/1 pass、0 skip**，覆盖两端实际组件的独立草稿、关闭重开、不隐式发送、精确且
不可变的重试／仅一次接受、旧请求路由、过期问题、403、主输入不变、Escape
焦点归还和九次 Tab 焦点循环。新增紧凑比例断言为短题宽度不超过 512px、高度
不超过 360px、问题在来源之前，以及指针选项行约 40px。截图轮次另覆盖四套
Dashboard 浅色主题的启用控件对比度。本文核对了断言、组件和文件来源，未重复
运行测试；这些通过项不表示实际 Runtime 已接受回复。

仍须在用户指定的当前 App、原配置和实际部署 Runtime 中验收真实提交及回执、
并发请求、主输入不变和可恢复异常；Dashboard 及上述非短题状态目前仍只有
挂载证据。200% 缩放和实体输入设备结果须另记，不能从 390px／640px 夹具
推断完成。整体 Runtime 实测、本地提交与用户审美认可仍待完成，尚未发布。
HTTP 成功、测试通过或模型复核意见均不独立证明实际业务已经恢复。

本轮文档不把预先存在的文档缺口、Dashboard 其他区域的旧样式或未经本批检查
的全局规则写成新系统规范；没有实施全局 token 改写或漂移修复。
