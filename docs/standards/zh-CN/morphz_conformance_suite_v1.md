# Morphz 一致性测试套件 v1

> 状态：测试套件定义草案；独立公开运行器尚未抽取
>
> 标准维护者：新变元（Newvar）
>
> 规范文本语言：英文
>
> 日期：2026-08-21
>
> 规范文本：[English](../morphz_conformance_suite_v1.md)
>
> 翻译说明：本文件是英文规范的中文翻译；如含义冲突，以相同版本的英文文本为准。

## 1. 目的

一致性测试套件把结构化上下文规范转化为可由独立实现复现的行为。它有三个目标：

1. 防止 Morphz Runtime 偏离规范；
2. 让独立实现可以证明兼容行为；
3. 让兼容性成为有证据支持的声明，而不是品牌断言。

一致性验证衡量协议行为，不认证 Agent 或 Runtime 的质量、安全性、整体安全或智能水平。

## 2. 规范用语

本文中以全大写形式出现的 **MUST**、**MUST NOT**、**REQUIRED**、**SHALL**、**SHALL
NOT**、**SHOULD**、**SHOULD NOT**、**RECOMMENDED**、**NOT RECOMMENDED**、**MAY** 和
**OPTIONAL**，应按照 BCP 14、[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) 与
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html) 解释，且仅在它们以全大写形式
出现时具有该含义。

## 3. 公开层与官方层

### 3.1 开放基础套件

规范基础套件必须开源，并且无需新变元云账号即可运行。它必须包含验证每项公开要求
所需的夹具、预期状态转换、失败用例和报告 Schema。

任何隐藏测试都不能成为某项规范语义规则的唯一来源。

### 3.2 官方验证

新变元可以提供官方验证服务，其中包含额外的互操作、长时间运行、对抗性、资源压力
和安全测试。这些测试可以保护具体夹具以防针对性取巧，但每项失败都必须映射到已发布
的规范要求。

通过开放套件后，可以作出“通过 Morphz SC-Core v1 自测”等事实声明。使用官方兼容性
标识则需要遵守独立商标政策，并取得签名的官方报告。

## 4. 目标接口

独立运行器应该通过小型 Adapter 测试实现，而不是导入 Morphz Runtime 内部结构。
Adapter 必须公开等价操作，以便：

- 创建并重新打开 Context；
- 追加和读取 Event；
- 读取当前 Context revision 与 Projection；
- 提交 Context Transaction；
- 根据 Profile 创建、挂载、退役和恢复 Session；
- 在有文档说明的事务边界注入确定性故障；
- 重启实现；
- 执行并发操作；
- 导出一致性报告。

项目可以为 Morphz RuntimeStore、HTTP API 和未来 SDK 提供参考 Adapter。

## 5. 测试组

### C1：身份与生命周期

- Context、Agent、Principal、Session、Event 和 Frame 标识在适用的读取与重启后保持稳定；
- Principal、Session、Context 与 Agent 身份不得彼此替代；
- 退役 Session 只改变 Attention 状态，不删除其历史。

### C2：Event 不可变性与顺序

- 已提交 Event 不能原地修改；
- Event 在其声明的权威域内具有确定顺序；
- 更正通过追加新 Event 表达；
- 当所声明 Profile 包含重放时，直接因果引用在重放后保持不变。

### C3：Frame 操作

- create、derive、revise、retire、restore、protect、unprotect、place、relate 和 unrelate
  产生规范规定的状态转换；
- revise 保留 Frame 身份并增加 revision；
- 已退役 Frame 从活动 Projection 中消失，但仍可恢复；
- 受保护 Frame 在缺少所需转换与审计理由时不能被退役；
- 声明的来源继续附着在派生认知上。

### C4：事务原子性

- 合法的多操作事务提交全部变更并产生一个一致 revision；
- 语法、权限、引用或生命周期错误不会提交其中任何变更；
- Event History 与所有受影响 Projection 在提交后一致。

### C5：冲突与 Rebase

- **C5.1：** 对同一 Frame revision 的不兼容写入不能静默覆盖彼此；
- **C5.2：** 使用相同稳定 Frame 标识创建不同内容必须被拒绝；
- **C5.3：** 声明的来源失效时必须拒绝事务；
- **C5.4：** 不同 Frame 的独立写入必须保守地发生冲突，或在不损坏任何一项变更的
  前提下安全 rebase；
- **C5.5（保留）：** 在 Profile 定义 checkpoint 与 rollback 的可移植语义之前，不启用
  相关 fence 一致性用例。

### C6：现实边界与来源

- Runtime 事实与 Agent 编写的结论保持可观察地区分；
- 来源 Event 在存在并获得授权与 Causal Scope 允许之前不能被引用；
- preview 与完整来源内容保持可区分；
- 派生 Frame 保存声明的证据引用；
- Runtime 事实不能通过 Agent 所有的事务被改写；
- 不能仅依据新旧、频率、使用量或最新版本状态，将 Observation 标记为具有语义权威。

### C7：Attention 与召回

- Projection 排除、退役与删除保持可观察地区分；
- recall 通过稳定引用找到正确原始来源；
- 资源压力不会静默编写或改写语义 Frame 内容。

### C8：Session 与因果路由

- 不同的授权 Session 可以共享已提交 Mind，但不会共享无关局部证据；
- 迟到结果返回创建它的已声明 Causal Scope 或 Evaluation；
- 显式跨 Session 交付保留来源和目标；
- 并发工作不会扩大 Evaluation 可以使用的证据或权限。

### C9：持久化、重试与恢复

- 已提交事务在重启后仍然存在；
- 提交前故障完整保留旧状态；
- 提交后故障能够重建已提交状态；
- Projection 重建结果等于权威当前状态；
- 对具有稳定请求或事务身份的 Transaction 重试不会产生重复效果；
- 中断的 lease 或工作所有权遵守所选 distributed Profile。

### C10：版本与扩展协商

- 版本报告准确标识规范、套件、实现和 Profile；
- 未知可选扩展按照协商规则处理；
- 不支持的必需扩展显式失败。

### C11：规范表示（保留）

当规范第 10 节仍是保留项时，不启用规范字节夹具。Draft 一致性不得要求逐字节序列化
完全相同。只有对应的带版本规范定义和夹具集同时发布后，C11 才会启用。

### C12：安全边界

- 未授权的 Context、Session、来源、召回和跨 Session 访问显式失败；
- 伪造或猜测的稳定引用不能绕过授权；
- 在要求幂等性的 Profile 中，使用稳定请求身份的重放不能复制已提交效果；
- 资源耗尽不会静默改写语义状态；
- 报告和诊断信息不会暴露测试配置中的凭据或秘密。

## 6. Profile 矩阵

| 测试组 | SC-Core | SC-Durable | SC-Concurrent | SC-Distributed |
| --- | :---: | :---: | :---: | :---: |
| C1 身份与生命周期 | required | required | required | required |
| C2 Event 不可变性 | required | required | required | required |
| C3 Frame 操作 | required | required | required | required |
| C4 事务原子性 | required | required | required | required |
| C5.1-C5.4 冲突与 Rebase | required | required | required | required |
| C5.5 Checkpoint/Rollback fencing | reserved | reserved | reserved | reserved |
| C6 现实边界与来源 | required | required | required | required |
| C7 Attention 与召回 | required | required | required | required |
| C8 Session 与因果路由 | optional | optional | required | required |
| C9 持久化、重试与恢复 | optional | required | required | required |
| C10 版本与扩展 | required | required | required | required |
| C11 规范表示 | reserved | reserved | reserved | reserved |
| C12 安全边界 | required | required | required | required |
| 多进程 lease/fencing 用例 | optional | optional | optional | required |

“required”表示该组所有活动用例都必须通过；“optional”表示该组不影响所选 Profile 声明，
但报告中的结果必须真实；“reserved”表示后续规范和套件版本启用该组之前，任何一致性
声明都不能依赖它。

## 7. 报告格式

每次运行必须产生机器可读报告，至少包含：

```json
{
  "specification": "morphz-structured-context/1.0.0-draft",
  "suite": "morphz-conformance/1.0.0-draft",
  "profile": "SC-Core",
  "implementation": {
    "name": "example-runtime",
    "version": "0.1.0",
    "revision": "source-revision-or-build-id"
  },
  "environment": {
    "adapter": "adapter-name-and-version",
    "storage": "implementation-defined"
  },
  "started_at": "RFC3339 timestamp",
  "results": [],
  "summary": {
    "passed": 0,
    "failed": 0,
    "skipped": 0
  }
}
```

跳过 required 测试意味着所选 Profile 不完整。报告还应该包含人类可读摘要和足以复现
失败的确定性证据，同时不得暴露秘密。

## 8. 兼容性声明

允许的声明必须同时标识规范、套件和 Profile 三个版本。只写“兼容 Morphz”不是充分的
技术声明。

发生以下情况时，实现失去官方声明资格：

- 已发布产物与被测试产物不同；
- required 测试被跳过或禁用；
- 签名报告依据未来认证政策已经过期；
- 重大安全或语义缺陷使结果失效。

兼容性标识和 Morphz 名称与源代码及规范文本许可证分别管理。现行
[知识产权状态说明](IPR_STATUS.md)和项目商标政策不授予一般标识或认证权。

## 9. 当前实现映射

Morphz Runtime 已经包含重要的内部前身：

- `morphz/tests/runtime_store_conformance.rs` 验证 SQLite/PostgreSQL RuntimeStore 行为；
- Scheduler Kernel 测试覆盖权威转换和后端等价性；
- attempt-loop 测试覆盖 Context Transaction 失败、去重和 continuation；
- long-run 与 context-pressure evaluation 在真实模型轨迹上观察 Context 行为。

这些测试是证据和抽取来源，但尚未构成独立公开套件。在声明符合 SC-Core v1 前，
新变元必须：

1. 将每项规范要求映射到稳定测试标识；
2. 在可观察行为足够时，移除对 Morphz Runtime 私有类型的依赖；
3. 发布至少一种外部 Adapter 边界；
4. 针对已发布 Morphz Runtime 产物产生干净的签名报告；
5. 随发布制品提供现行授权包，并记录所选规范成熟度要求的标准必要专利与兼容性标识决策。

## 10. 套件演进与勘误

改变预期规范行为需要已接受的 Standards Track MEP 和对应规范变更。为现有行为增加
覆盖可以通过普通 Pull Request 完成，前提是新测试不会改变先前一致实现的结果，而只是
揭示其真实规范违反。

每项一致性测试必须链接到它所验证的准确规范要求。疑似错误遵循
[MEP-0001](../../meps/MEP-0001-specification-governance.md) 的公开勘误与解释流程。
