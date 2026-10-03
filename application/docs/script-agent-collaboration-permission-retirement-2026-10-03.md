# 剧本 Agent 协作：退役模型许可开关（2026-10-03）

## 产品决定与数据边界

用户明确要求“不做限制，我们就是 Agent 协作，没有禁用 Agent 的理由”。
`modelProcessingAllowed` 不再决定 Agent 能否读取正文、准备创作、提交候选或提交审改意见。
资料来源及使用说明仍是真实描述记录；它们不是 Agent 工作开关，系统不代写版权或第三方权利声明。

保留现有 `ScriptBrief` 字段、默认值、SQL 列、元数据历史与 typed Client schema。
旧 `false` 与 `true` 均原值读取和保存，不翻转真实数据，不增加迁移或新权限表。
完整设置中的旧字段仍可往返；仅修改这个字段会记录元数据修订，但不改变创作身份、使固定请求过期或撤销候选。
真实创作要求、来源记录、指定审阅人等原有创作身份变化仍使旧请求过期；中途变化后再恢复也不复活旧请求。

## 生产改动

- `packages/core/src/script-studio.ts`：保留兼容字段，创作身份计算排除旧开关。
- `packages/script-studio/src/store.ts`：移除旧布尔许可条件，保留实际读取和提交前后授权检查；完整元数据比较仍能保存历史字段变化。
- `packages/application/src/platform-agent-tools.ts`：读取准备材料/固定正文不再先检查旧开关，仍通过真实领域入口检查当前权限。
- `packages/application/src/application-operations.ts`：操作描述明确普通 Agent 创作无需额外启用或模型许可确认。
- `apps/web/src/ScriptStudio.tsx`：移除许可 checkbox；设置提示中的“资料许可”改为“资料说明”，保留资料说明编辑和设置保存。
- `apps/web/src/ScriptStudioEditor.tsx`：移除旧许可提醒、准备表单的布尔拒绝及提交按钮禁用。
- `harnesses/script-studio.hns` 与应用 manifest：发布新 `1.4.4`；旧 `1.4.3` 精确归档，不覆盖不可变包。

没有改变真实 Actor / 发起 Human / 项目 ACL、原作确切版本访问、冻结材料范围、请求取消和当前输入状态、CAS 修订号、预算或幂等回执。
正式稿写入、候选采纳、指定 Human 审阅批准、锁稿与导出沿用原权限。
完整制作规范设置仍由 Human 修改；本次没有把所有设置、最终采纳或锁稿角色权限一并取消。
Agent 可正常创建空剧本与条目、生成候选和审改，不需要先修改完整规范。

## Harness 激活机制

Host 的内置应用 manifest 为新的剧本应用 Input 固定 `1.4.4`；每个已记录 Input 的执行包引用仍不可变。
普通聊天没有自动应用 pin，应通过当前操作目录描述及 Runtime 的 `harness_select` 选择已安装的精确版本，Runtime 不猜测 latest。
Session 不是 Harness 的固定 owner；既有 Objective / Evaluation 有自己的不可变绑定。
向旧执行发送补充不能换包，新普通输入可以在同一 Session 使用新版。

源码机制：

- `packages/application/src/application.ts`：`platformMessage` 从 Host manifest 解析应用及 Harness，先核验实际项目权限。
- `packages/application/src/session-io.ts`：`workInputRequest` 沿用 Input 的精确引用；补充继承原执行，不覆盖 Harness。
- `../morphz/src/harness_package.rs`：安装追加持久 catalog；同 ID/版本不同 artifact 拒绝替换，Objective / Evaluation binding 不可变。
- `../morphz/src/runtime.rs`：Runtime 启动时把持久 catalog 载入内存 registry。
- `packages/application/src/runtime.ts`：读取 `/api/session-io/capabilities`，发送前核验 exact Harness；缺少新版时保留输入而不改用旧版或普通聊天。

只更新 Web/Desktop 包不会给独立 Runtime 自动安装 Harness。
正常部署应在原 profile、原配置及原库上安装新的包，并在在途工作安全边界正常重启/重连原 Runtime 和新版 Host。
`/api/session-io/capabilities` 必须实际包含 `morphz.script-studio@1.4.4` 才能声称新版已加载。
就绪恢复不会自行重放已失败的 Input，用户正常“重试发送”仍沿用同一输入身份。
不得为升级重写历史 Input、Objective、Evaluation、Session 或覆盖原 `1.4.3`。
旧 Contract 可能继续说需要许可；这是旧执行提示，不是新版 Store 的硬拒绝条件。

## 已完成的离线验证

`npx tsx --test --test-concurrency=4 tests/script-*.test.ts tests/harness-readiness.test.ts`：
160 项，131 通过、0 失败、29 PostgreSQL 条件测试跳过（未配置 PG 环境）。
测试使用隔离真实 Host / typed Agent / SQLite 域，不调用真实模型。

新增或更新的正例覆盖：

- 新建原创默认旧字段 `false`、空权利说明，可正常准备、读固定材料、提交候选，正式稿不被采纳。
- 已建原创 `false` 可工作；旧字段 `false → true → false` 保存和冷恢复，不使固定请求或候选失效。
- 三目标准备、读取、提交、结果恢复、同命令幂等及零问题审改报告。
- 新 Input 绑定 `1.4.4`；历史请求含 `1.4.3` 仍保持 exact ref，冷恢复不改绑、不重放。
- Runtime 仅加载 `1.4.3` 时，新 `1.4.4` 请求不发送，加载新版后仅显式重试原输入。

保留并通过的负例包括：跨项目/身份注入、成员撤权、原作迁出、读取和提交期间撤权、非首目标来源撤权、取消/排队/终态、迟到写入、固定范围旁路、版本冲突、实际风格变化、非 Human 采纳锁稿、失去回执后的 unknown 与严格幂等。
旧布尔拒绝断言改为“旧 false 正常工作”；实际创作身份失效负例改用真实风格变更，没有删除权限负例来混绿。

`morphz harness check harnesses/script-studio.hns --format=json` 离线检查通过：
`valid=true`，版本 `1.4.4`，artifact hash
`sha256:cabe46f636e6fdb99d2a0e6f7a9acc0354c4ab13554ecec3f14bfa4aed824e6b`。
`tool_contracts_verified=false`：动态 Host tool 参数与实际权限仍由运行时核验，不把静态检查当真实模型验证。
旧 `1.4.3` 文件 SHA-256：`b2539bab37bf101894bfba3542d4ebe75d82b58e6a5266d553ff158e43cdb9ff`。

## 浏览器验收与剩余边界

`tests/e2e/script-platform-settings.spec.ts` 在最终统一构建 `app-BEP3OG9n.js` / `app-Cmgh1pv6.css` 后，以缓存 Chromium 和独立随机真实 Host 验收通过 1/1、0 跳过（用例 5.840 秒，总计 7.751 秒）：资料说明保存/恢复、界面无模型禁用开关、旧 false 生成入口与实际准备到输入框可用、固定引用及全程零模型 Input，保留正文 v2/v3/v4 保存/历史恢复、人工审阅/批准/锁稿/解锁、意见解决和 Word 下载。
Runtime dispatch 停止，不使用 65421、原 App、真实业务数据或模型服务。
报告：`/tmp/morphz-script-agent-permission.LRVvfm/report.json`；同目录 results 留有资料说明和准备请求截图。
首次两次测试失败发生在清理准备引用：缺少展开原“输入关联”菜单和重新打开自动收起输入框的步骤；补齐现有用户操作和既有 `openInput` helper 后通过，没有改动相关生产交互。
允许的删 gate 后 if / button 排版已局部整理，scoped Prettier 与 diffcheck 均通过，未改其他视觉样式。
此前截图检查发现旧设置提示残留“资料许可”；经确认仅改为“资料说明”，浏览器测试新增新提示/无旧词断言。最终构建上的上述 1/1 已包含这两项断言；复查同目录新截图，设置提示与资料说明表单均为更新后的文案，准备请求按钮可用且没有模型许可开关。
本记录不声称真实原 App 已部署新版 Harness、原对话提示已消失、真实模型创作已成功或 PostgreSQL 已验证。
