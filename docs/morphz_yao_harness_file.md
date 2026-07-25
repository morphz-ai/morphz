# 爻 Harness 文件：三段结构与双入口

> 状态：设计已定，加载器未实现
> 前置：[表征分层与归属判据](morphz_yao_representation_layers.md)、[Agent-Owned Context](morphz_agent_owned_context_design.md)
> 首要目标：Runtime 加载 `.yao` 文件实现领域 harness（coding / writing / video editing）。模型自发调用 `eval` 工具是次要路径，不作为验收目标。

## 1. 文件结构

一个 `.yao` 文件最多三段，顺序固定，前两段可选：

```lisp
(tools read edit exec)                 ; ① 工具声明：引用并收窄
(mind                                  ; ② 领域知识：seed 进共享 Mind
  (frame
    (id coding/style-rules)
    (protected true)                   ;    protect 由作者显式声明，不默认
    (body ...)))
(seq ...)                              ; ③ 入口：根形式决定谁驱动
```

- **tools 是引用不是实现**。声明只能从已注册工具中选取并收窄闸门（声明 ⊆ 部署 `eval_callable_tools`）；新物理工具仍由 Rust 提供。将来 `define` 出的过程是 harness 唯一能"新增"的可调用能力。
- **mind 用 Mind 的原生 frame 形式**，不发明新形状。
- **入口是恰好一个表达式**。

## 2. 入口规则：根形式选择求值器

> **根是 `(infer (task ...) ...)` → 非确定性求值器（LLM）驱动；根是其他程序形式 → 确定性求值器（Runtime）驱动。**

不引入显式 `(eval ...)` 包装：根形式本身已说明归属，加壳与已被否决的 `(yao ...)` 同属冗余标注（见表征分层判据：语义进介质，元数据不进语法）。

两种入口的生产映射：

| 入口 | 谁驱动 | 生产实现 |
| --- | --- | --- |
| `(infer ...)` | LLM | **现有 attempt loop 就是顶层 infer 的生产实现**。加载 = seed mind + 收窄工具 + 把 task 作为 Objective 交给现有循环。几乎零新代码 |
| 程序形式 | Runtime | 已实现的 `validate`/`evaluate`，作为 Objective 的首个 Evaluation 执行；`infer` 节点处控制权交回模型 |

选择权属于 harness 作者：coding harness 可选确定性入口（管线固定、模型填 `infer` 槽位），writing harness 可选 infer 入口（模型主导、mind 携带 canon 规则）。这是设计文档"同一棵树上确定与不确定节点交替求值"在文件层的直接体现。

## 3. 同一个 infer，两个预算包络

算子是同一个，语义都是"交给非确定性求值器"；**位置决定预算包络**，必须写进算子描述，不让模型猜：

| 位置 | 包络 |
| --- | --- |
| 程序内部 | 有界证据槽：`MAX_INFER_ROUNDS` 轮内必须给出值；工具集 = 声明 ∩ 闸门；隐藏 `eval` 以保全语言 |
| 文件根 | 整个 Objective 的任务：完整 attempt loop、turn budget、恢复与审批机械 |

## 4. Harness 不取代默认 loop

`harness.rs` 既有契约（原文）：

> Domain semantics may narrow Runtime behavior and propose work, but cannot execute physical effects or replace Scheduler/permission authority.

预算、准入、审批、重启恢复全部留在 Objective/attempt 机械内。harness 改变的是**控制方向**，不是机械：

- 默认形态：模型驱动，runtime 响应工具调用；
- 确定性入口形态：runtime 驱动程序推进，模型在 `infer` 节点被调用。

两种形态都是"一个 turn 的结构"，loop 仍是 turn 之外的机械。coding 的"改→测→再改"外层循环由 Objective 的多次 Evaluation 承担，语言内不加 `loop` 算子（全语言性质不破）。

## 5. Mind 合并的三条纪律

由 Agent-Owned Context 的红线导出：

1. **走 seed 事务进 Ledger**（`TYPE_CONTEXT_SEED` / `seed_context_from_mind` 一族）。不直接改 Mind 状态；卸载 harness = `retire` 这批 frame，同一套机制。
2. **来源必标**：`sources: harness:<id>@<version>`。红线禁止无来源内容混入已知事实。
3. **frame ID 命名空间化**（如 `coding/review-checklist`）；同 ID 已存在则**拒绝而非覆盖**。

`protected` 由作者按 frame 显式声明，不默认——默认 protect 违背"Agent 管自己注意力"，且占用 Context 预算。

mind 段存在的理由：`infer` 把控制权交回模型时，模型看的是当前 Context——**harness 的领域知识通过这些 frame 在 infer 点生效**。tools 给能力，mind 给知识，入口给结构。

## 6. 加载流程（v1）

```
解析（parse_all，三段按序识别）
→ 校验 tools ⊆ 部署闸门，工具存在
→ 校验入口（确定性入口走 validate；infer 入口校验 (task ...) 存在）
→ seed mind（事务，来源标注，撞 ID 拒绝）
→ 创建 Objective：
    infer 入口  → task 进现有 loop，Evaluation 工具集收窄到声明
    程序入口    → 首个 Evaluation = evaluate(程序)
```

## 7. v1 边界与升级路径

- **重启即失败（fail-clean）**：求值器状态不持久化；Objective 机制负责重试整轮。长程序中断成本高时，升级路径是持久化求值器（绑定与位置随 Evaluation 落盘），接口不变。
- **`define` 过程库与 validator 挂接（`DomainHarness`）未在本文件格式内**，是 harness 的下一层；本格式为其预留位置（过程即未来第四段或独立文件）。
- **待核实**：infer 入口的按-Objective 工具收窄是否可复用既有机制（`ToolExecutionOptions.allowed_tool_names` / delegation 的收窄路径），做加载器时先查先例再动手。

## 8. 与既有机制的对齐清单

| 本设计的每一段 | 库内先例 |
| --- | --- |
| tools 声明与收窄 | 部署闸门 `eval_callable_tools` + 程序声明（已实现） |
| mind seed | `seed_context_from_mind`、`TYPE_CONTEXT_SEED`、Lifecycle v1 Mount/Seed/Projection |
| 入口→Objective | Objective supervisor、`objective/requested` 入口事件 |
| 确定性求值 | `sexpr_eval::{validate, evaluate}`（已实现，510 测试） |
| 顶层 infer | attempt loop 本身 |
| 不取代调度权 | `DomainHarness` trait 契约注释 |
