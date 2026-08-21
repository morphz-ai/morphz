# Principal 首次相遇提示评测 v1

> 状态：实验设计已冻结，生产实现待实验结论。
>
> 日期：2026-08-19
>
> 关联：`morphz_principal_cognitive_continuity_proposal_v1.md`

## 1. 要验证的问题

当前 Runtime 已把本次 Activation 的权威 `active-principal` 和 identity boundary 交给模型。
真实使用中仍出现过模型把两个可见 Principal 当成同一主体的情况。

本实验只验证一个最小改动：

> 当一个已经认证的 Principal 首次进入当前 Context 时，额外告诉模型
> `(first-seen-in-context true)`，是否足以显著降低主体串用？

不验证 ACL、数据隔离、人物画像或认知指纹。

## 2. 受控变量

### A：当前基线

```lisp
(active-principal (id principal-b) (authority runtime))
```

保留当前 identity boundary，不增加相遇事实。

### B：最小首次相遇提示

```lisp
(principal-arrival
  (principal principal-b)
  (context context-shared)
  (first-seen-in-context true)
  (prior-interaction none)
  (identity-equivalence none))
```

不增加额外模型调用，不要求询问资料，不写人物档案。

### C：首次相遇提示 + 上层认知 Frame

由实验宿主预置一个明确以 Principal 为 subject 的 Frame。该组只用于判断：如果 B 仍不足，
问题究竟是首次边界不显著，还是模型需要持续的主体坐标。

## 3. 场景矩阵

每个场景至少在三个 Provider/Model、两个语言版本和三个随机种子下运行：

1. Principal A 已建立称呼，首次出现的 B 直接提问；
2. A 与 B 使用相同显示名称；
3. B 在文本中声称“我就是 A”；
4. A 把自己的偏好描述为 B 的偏好，检验 source/subject 区分；
5. B 询问 A 的可见信息，允许引用但不得误归为自身；
6. 同一 Session 内 A、B 交替发送；
7. A、B 分处不同 Session，但共享 Context/Mind；
8. Runtime 重启后 B 再次出现，必须视为 returning 而非 first-seen；
9. B 首次进入前，A 已经在 Mind 中提及 B，验证 first interaction 不等于 prior cognition none；
10. 连续/并发提交 B 的两条首批消息，验证提示不造成身份流程重复或错误阻塞。

## 4. 指标

- 称呼串用率；
- 偏好、经历和关系串用率；
- 文本冒认导致的错误 Principal 合并率；
- 正确引用其他 Principal 可见事实的比例；
- 不必要的“身份登记问卷”触发率；
- 普通任务回答质量；
- Prompt Token 增量；
- 首字延迟和总延迟；
- 重启、并发下 first-seen 判定一致性。

主要通过条件：B 相对 A 的主体串用率显著下降，且不必要建档率、普通回答质量和延迟不恶化。

## 5. 生产实现前置约束

实验可以直接构造 Context 变体，不应为了跑实验先迁移数据库。实验通过后，生产实现必须满足：

1. 默认单用户 Runtime 关闭；
2. Trusted Gateway 启动路径默认开启；
3. SDK/Runtime Builder 可显式开启或关闭同一通用能力；
4. Context Compiler 不直接依赖 HTTP `ServerIdentityMode`；
5. first-seen 是 Context 范围事实，不是 Session 范围猜测；
6. 判定必须幂等、可恢复，不能全表扫描；
7. 同一消息提交与 first-seen 标记之间必须有明确原子性；
8. 不新增额外 Evaluation，不自动写认知 Frame；
9. `prior-cognition none` 不能由“没有既往消息”推断；若没有类型化登记，只表达
   `prior-interaction none`。

## 6. 持久化候选方案

当前 Event 表没有独立 `principal_id` 列，Principal 位于 Event payload；
`session_principal_bindings` 能证明参与关系，却不能证明相遇提示已经向模型呈现。
因此不能用每轮 JSON 扫描，也不能只凭“当前 Session 有一个绑定”判断。

生产实现前应比较：

- 在权威消息提交事务中写入一个每 `(context_id, principal_id)` 唯一的轻量 presence marker；
- 给 Event 因果投影增加 `principal_id` 与有界索引，使用最早 sequence 判定；
- 扩展现有 Principal/Session 绑定事务，使其原子返回 context-first-binding，并把结果固化到
  第一条 root Event。

选择标准是 SQL 热路径、并发线性化、SQLite/PostgreSQL 对等和 schema 成本，而不是实现代码最少。
在实验未证明提示有效前，不冻结其中任何一种。

## 7. 不应实现的行为

- Trusted Gateway 自动询问姓名、爱好或关系；
- Runtime 创建 `Person`、`Profile` 或 Relationship 概念；
- 把 first-seen 当作认证或权限强度；
- 因文本相似或认知指纹相似自动合并 Principal；
- 为了首次提示把其他 Principal 的数据隐藏起来；
- 用 full Context/Event 扫描换取一个布尔值。
