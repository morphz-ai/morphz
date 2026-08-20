# Morphz 一致性测试套件 v1

> 状态：测试套件定义草案；独立公共 Runner 尚未抽取
>
> 标准维护者：新变元（Newvar）
>
> 日期：2026-08-21
>
> 规范文本：[English](../morphz_conformance_suite_v1.md)
>
> 翻译说明：本文件是英文规范的中文翻译；如含义冲突，以相同版本的英文文本为准。

## 1. 目的

一致性测试套件将结构化上下文规范转化为可以独立复现的行为。它有三个目标：

1. 防止 Morphz 官方实现偏离规范；
2. 允许独立实现证明自身具有兼容行为；
3. 让兼容性成为有证据支持的声明，而不是一种品牌宣传。

一致性测试衡量协议行为。它不认证建立在协议之上的 Agent 是否具有高质量、安全或智能表现。

## 2. 公开层与官方层

### 2.1 开放基础套件

规范性的基础套件必须开源，并且无需 Newvar 云端账户即可运行。它必须包含验证每项公开要求所需的夹具、预期状态转换、失败用例和报告 Schema。

任何隐藏测试都不得成为某项规范语义规则的唯一依据。

### 2.2 官方验证

新变元可以提供官方验证服务，其中包含额外的互操作、长期运行、对抗、资源压力和安全测试。为防止针对固定答案进行投机，这些测试可以保护精确夹具，但每项失败都必须映射到已经公开的规范要求。

通过开放套件后，可以作出类似“通过 Morphz SC-Core v1 自测”的事实性声明。使用官方兼容标识则必须遵守独立的商标政策，并取得签名的官方报告。

## 3. 被测目标接口

独立 Runner 应通过一个小型 Adapter 测试实现，而不是导入 Morphz 内部类型。Adapter 必须公开语义等价的操作，以便：

- 创建并重新打开 Context；
- 追加和读取 Event；
- 读取当前 Context revision 和 Projection；
- 提交 Context Transaction；
- 按 Profile 要求创建、挂载、退役和恢复 Session；
- 在文档规定的事务边界注入确定性故障；
- 重启实现；
- 执行并发操作；
- 导出规范的一致性报告。

项目可以为 Morphz Rust RuntimeStore、HTTP API 和未来 SDK 提供参考 Adapter。

## 4. 必测用例组

### C1：身份与生命周期

- Context、Agent、Session、Event 和 Frame 标识在读取及重启后保持稳定。
- Session 身份不会替代 Context 或 Agent 身份。
- 退役 Session 只改变其注意力状态，不删除历史。

### C2：Event 不可变性与顺序

- 已提交 Event 不能被原地修改；
- Event 在其声明的权威域内具有确定顺序；
- 更正通过追加新 Event 表达；
- 直接因果引用在重放后仍然存在。

### C3：Frame 操作

- create、derive、revise、retire、restore、protect、unprotect、place、relate 和 unrelate 产生规范要求的状态转换；
- revise 保留 Frame 身份并增加 revision；
- retired Frame 从活动 Projection 消失，但仍可恢复；
- protected Frame 如果没有完成必要状态转换并提供审计 reason，则不能退役；
- 已声明来源继续附着在推导出的认知上。

### C4：事务原子性

- 有效的多操作事务提交全部变更，并只产生一个连贯 revision；
- 语法、权限、引用或生命周期失败时，不得提交其中任何一项；
- 提交后 Event History 与所有受影响 Projection 保持一致；
- 重试具有幂等身份的事务不会产生重复效果。

### C5：冲突与 Rebase

- 对同一 Frame 的不兼容写入不能相互静默覆盖；
- 对独立 Frame 的写入可以保守冲突，也可以依据声明的 Profile 安全 rebase；
- 声明的来源失效时，事务被拒绝；
- 全局 rollback 和 checkpoint 操作使用足够强的 Context 级 fence。

### C6：现实与来源

- 源 Event 在存在之前或超出授权范围时不能被引用；
- preview 与完整源内容可以区分；
- 推导 Frame 保留声明的证据引用；
- Runtime 事实不能通过 Agent 拥有的事务重写。

### C7：注意力与召回

- Projection 排除、retirement 和 deletion 在可观察语义上相互不同；
- recall 将稳定引用解析到正确原始来源；
- 资源压力不会静默编写或改写语义 Frame 内容。

### C8：Session 与因果路由

- 不同的授权 Session 可以共享已提交 Mind，但不能共享无关局部证据；
- 迟到结果返回创建它的因果 Thread 或 Activation；
- 显式跨 Session 交付保留来源和目标；
- 并发工作不能为同一 Activation 身份提交多个终态结果。

### C9：持久化与恢复

- 已提交事务在重启后继续存在；
- 提交前故障完整保留旧状态；
- 提交后故障能够重建已提交状态；
- Projection 重建结果等于权威当前状态；
- 被中断的 Lease 或工作所有权遵守所选分布式 Profile。

### C10：规范表示与版本

- 规范夹具逐字节产生相同序列化结果；
- 未知可选扩展按照协商规则处理；
- 不支持的强制扩展显式失败；
- 版本报告准确标识规范、测试套件、实现与 Profile。

## 5. Profile 矩阵

| 测试组 | SC-Core | SC-Durable | SC-Concurrent | SC-Distributed |
| --- | :---: | :---: | :---: | :---: |
| C1 身份与生命周期 | 必测 | 必测 | 必测 | 必测 |
| C2 Event 不可变性 | 必测 | 必测 | 必测 | 必测 |
| C3 Frame 操作 | 必测 | 必测 | 必测 | 必测 |
| C4 事务原子性 | 必测 | 必测 | 必测 | 必测 |
| C5 冲突与 Rebase | 基础 | 基础 | 必测 | 必测 |
| C6 现实与来源 | 必测 | 必测 | 必测 | 必测 |
| C7 注意力与召回 | 必测 | 必测 | 必测 | 必测 |
| C8 Session 与因果路由 | 可选 | 可选 | 必测 | 必测 |
| C9 持久化与恢复 | 可选 | 必测 | 必测 | 必测 |
| C10 表示／版本 | 必测 | 必测 | 必测 | 必测 |
| 多进程 Lease／Fencing 用例 | 可选 | 可选 | 可选 | 必测 |

“基础”表示必须拒绝过期且不兼容的写入；不强制要求安全自动 rebase。

## 6. 报告格式

每次运行必须生成机器可读报告，至少包含：

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

跳过任一必测用例，意味着所选 Profile 没有完成。报告还应该包含人类可读摘要，以及不暴露 Secret 的、足以确定性复现失败的证据。

## 7. 兼容性声明

允许的声明必须同时标识三个版本：规范版本、测试套件版本和 Profile。“Morphz compatible”如果没有版本信息，不构成充分的技术声明。

发生以下情况时，实现失去官方兼容性声明：

- 发布产物与被测产物不同；
- 必测用例被跳过或禁用；
- 签名报告依据未来认证政策已经过期；
- 重大安全或语义缺陷使结果失效。

兼容标识和 Morphz 名称独立于开源代码许可证进行治理。

## 8. 当前实现映射

Morphz 已经包含重要的内部前身：

- `morphz/tests/runtime_store_conformance.rs` 验证 SQLite/PostgreSQL RuntimeStore 行为；
- Scheduler Kernel 测试覆盖权威状态转换和后端一致性；
- attempt-loop 测试覆盖 Context Transaction 失败、去重和 continuation；
- long-run 与 context-pressure Eval 观察真实模型轨迹中的 Context 行为。

这些测试是证据和抽取来源，但尚不是独立公共套件。在声明 SC-Core v1 一致性之前，新变元必须：

1. 将每项规范要求映射到稳定测试标识；
2. 在可观察行为足以验证时，移除对 Morphz 私有类型的依赖；
3. 发布至少一个外部 Adapter 边界；
4. 针对已发布 Morphz 产物生成一份干净的签名报告；
5. 发布兼容性政策和商标政策。

## 9. 测试套件演进

修改规范性预期行为需要一份已接受 MEP 和对应规范变更。如果新增测试只是补充既有行为覆盖，并且不会让一个原本符合规范的实现无故变为不兼容，则可以通过普通 Pull Request 完成。

每项一致性测试必须链接到它所验证的精确规范要求。
