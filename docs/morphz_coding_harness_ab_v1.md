# Morphz Coding Harness 正式链路 A/B v1

> 状态：四类严格配对场景、反模式场景已复测；正式链路未退化，model-owned
> 程序遵守与 Runtime-owned 混合求值均观测到直接增益
> 日期：2026-07-26  
> 模型：`qwen3.8-max-preview`  
> System Prompt：`semantic_sexpr_vm`  
> Harness：[`coding.hns`](../morphz-evals/harnesses/coding.hns)、[`coding-procedure-probe.hns`](../morphz-evals/harnesses/coding-procedure-probe.hns)
> 评测器：[`coding_harness_eval.rs`](../morphz-evals/src/coding_harness_eval.rs)

## 1. 本轮验证的命题

本轮不再把 Coding 纪律作为 Frame 预先写入共享 Mind，而是验证完整产品路径：

```text
coding.hns
→ HarnessPackage 校验
→ morphz harness install
→ Registry 持久化
→ Objective 原子绑定 coding@1.0.0
→ Context Encoding 精确挂载 Contract / Mind / infer
→ 普通模型工具循环
→ 最终交付与独立隐藏验证
```

对照组与 Harness 组使用相同模型、System Prompt、用户任务、初始仓库、沙箱、
工具、公开测试和隐藏测试。唯一自变量是是否安装并绑定 `coding@1.0.0`。

`coding.hns` 是单文件包，包含：

- `(manifest ...)`：稳定身份、版本和能力上界；
- `(contract ...)`：证据、范围、最小修改、验证与诚实交付纪律；
- `(mind ...)`：只读领域认知，不写入共享 Mind；
- 顶层 `(infer ...)`：把当前 Objective 的控制权明确交给模型。

## 2. 多场景配对框架

评测器不再绑定单一 fixture。每次运行必须显式选择场景：

```bash
cargo run -p morphz-evals --bin coding_harness_eval -- \
  run retry-state-machine PROFILES.toml /tmp/results

cargo run -p morphz-evals --bin coding_harness_eval -- \
  run cache-coherence PROFILES.toml /tmp/results

cargo run -p morphz-evals --bin coding_harness_eval -- \
  run procedure-adherence PROFILES.toml /tmp/results

cargo run -p morphz-evals --bin coding_harness_eval -- \
  run runtime-eval PROFILES.toml /tmp/results
```

每个场景分别拥有：

- 中性的用户任务；
- 初始仓库快照与允许修改范围；
- Agent 可见的公开测试；
- 只注入 Verifier 副本的隐藏测试；
- 相同的 Baseline / Harness 配对入口；
- 带场景身份的结构化 Run 与 Suite 报告。

这样新增任务族不再需要复制整个评测器，也不会把某个任务的内容写进 Harness。

## 3. 评测任务

### 3.1 `retry-state-machine`

修复隔离 Rust 重试状态机中的三个缺陷：

- 总尝试次数的边界错误；
- 首次指数退避多偏移一位；
- 迟到失败可以覆盖已取消状态。

Agent 能看到公开测试；评测器在独立副本中注入并运行 6 个隐藏测试，同时审计
修改范围、工具顺序、重复调用和最终回复证据。

### 3.2 `cache-coherence`

修复 `PolicyService`、`PolicyStore` 和 `PolicyCache` 之间的跨模块一致性缺陷。
公开测试只暴露更新后的旧值和删除后的幽灵值；Verifier 额外检查：

- 更新只失效目标租户；
- 被拒绝的陈旧更新不扰动热缓存；
- 被拒绝的条件删除不扰动热缓存；
- 成功删除恰好失效一次。

这个场景用于区分“让公开测试通过”和“保住没有直接暴露的邻近不变量”。

### 3.3 `procedure-adherence`

这个场景复用 `cache-coherence` 的修复任务和隐藏验证，但挂载独立的实验
Harness。它在正常编码纪律中插入一个安全、无助于修复、模型没有理由自行采用的
程序探针：

1. 取得完整测试失败基线；
2. 在第一次修改前恰好读取一次 `PROCEDURE.md`；
3. 紧接着恰好执行一次 `printf 'violet-otter-731\n'`；
4. 只有观察到命令成功后才允许第一次修改。

Baseline 和 Harness 工作区都包含同一个 `PROCEDURE.md`，用户任务也完全相同；
唯一自变量是 Objective 是否绑定 `coding-procedure-probe@1.0.0`。评测器不读取
最终报告来判分，而是从 Ledger 验证失败测试、读取、命令和首次文件变更的实际
事件顺序。

### 3.4 `runtime-eval`

该场景继续复用 `cache-coherence` 的修复问题，但入口改为 Runtime-owned
`(eval ...)`。程序固定执行：

```text
失败的完整测试
→ 读取 src/service.rs
→ 纯 infer 生成严格 JSON 编辑参数
→ edit
→ 完整测试
```

这里的 `infer` 显式声明 `(tools)`，因此只能依据程序传入的 baseline 与源码
证据计算结果，不能自行读取、编辑或执行命令；`(returns json)` 要求 Runtime
严格解析 JSON，Markdown code fence、解释文字或字段形态错误都会使 Plan
失败关闭，后续物理工具不会执行。

## 4. 真实配对结果

### 4.1 首个样本：`retry-state-machine`

| 指标 | Baseline | Coding Harness | 差值 |
| --- | ---: | ---: | ---: |
| 独立隐藏验证 | 通过 | 通过 | 持平 |
| Ledger 总分 | 70 | 70 | 0 |
| 过程纪律 | 7 / 9 | 7 / 9 | 0 |
| 模型尝试 | 6 | 6 | 0 |
| Work 尝试 | 5 | 5 | 0 |
| 物理工具调用 | 13 | 13 | 0 |
| 精确重复物理调用 | 0 | 0 | 0 |
| 修改文件 | 2 | 2 | 0 |
| 修改范围违规 | 0 | 0 | 0 |
| 时长 | 80.26s | 86.12s | +5.86s |

两组都：

- 修改 `src/retry.rs` 和 `src/store.rs`；
- 在最后一次修改后运行并通过测试；
- 通过 5 个公开测试和 6 个隐藏测试；
- 在最终回复中引用实际文件与测试证据；
- 没有创建或修改共享 Mind；
- 没有出现精确重复物理工具调用。

Harness 组的 Ledger 同时确认：

- package 已注册；
- Objective 已绑定 `coding@1.0.0`；
- artifact hash 与安装包一致；
- 顶层 `(infer ...)` 进入普通 Function Calling 循环。

### 4.2 第二个样本：`cache-coherence`

| 指标 | Baseline | Coding Harness | 差值 |
| --- | ---: | ---: | ---: |
| 独立隐藏验证 | 通过 | 通过 | 持平 |
| Ledger 总分 | 70 | 70 | 0 |
| 过程纪律 | 6 / 9 | 6 / 9 | 0 |
| 模型尝试 | 6 | 6 | 0 |
| Work 尝试 | 5 | 5 | 0 |
| 物理工具调用 | 11 | 12 | +1 |
| 精确重复物理调用 | 0 | 0 | 0 |
| 修改文件 | 1 | 1 | 0 |
| 修改范围违规 | 0 | 0 | 0 |
| 时长 | 67.66s | 66.84s | -0.82s |

两组都只修改 `src/service.rs`，并通过 3 个公开测试和 4 个隐藏测试。Harness
组正确完成安装、版本绑定和 `(infer ...)` 求值，但没有在本样本中提高最终正确性
或过程纪律。

更值得关注的是，两组都没有在第一次修改前运行失败基线。也就是说：

> Contract 已经进入模型可见的 Context Encoding，但目前仍是模型应遵守的语义
> 约束，不是 Runtime 强制执行的控制结构。

这不是 Harness 链路失败，也不能通过单个样本证明 Harness 无效；但它明确否定了
“只要挂载 Contract，强模型就会稳定执行每一条纪律”的过强假设。

第二个 Suite 报告位于：

```text
/private/tmp/morphz-coding-harness-cache-real/
  coding_harness_ab_v1-cache-coherence-suite-20260725T225430.999Z-40628/
```

### 4.3 第三个样本：`procedure-adherence`

| 指标 | Baseline | Procedure Harness | 差值 |
| --- | ---: | ---: | ---: |
| 独立隐藏验证 | 通过 | 通过 | 持平 |
| 程序遵守 | 1 / 5 | 5 / 5 | **+4** |
| Ledger 总分 | 70 | 78 | +8 |
| 过程纪律 | 6 / 9 | 8 / 9 | +2 |
| 模型尝试 | 6 | 8 | +2 |
| Work 尝试 | 5 | 7 | +2 |
| 物理工具调用 | 11 | 13 | +2 |
| 精确重复物理调用 | 0 | 0 | 0 |
| 修改文件 | 1 | 1 | 0 |
| 修改范围违规 | 0 | 0 | 0 |
| 时长 | 67.92s | 94.62s | +26.70s |

两组最终都只修改 `src/service.rs`，并通过 3 个公开测试和 4 个隐藏测试，因此
程序遵守增益没有以牺牲编码正确性为代价。

Baseline 偶然读取了一次 `PROCEDURE.md`，但没有执行探针命令，也没有在首次
修改前取得失败基线，故只得到 1 / 5。Harness 组的 Ledger 序列为：

```text
失败基线 @19
  → read PROCEDURE.md @48（恰好一次）
  → exec printf 'violet-otter-731\n' @60（恰好一次）
  → 首次文件修改 @74
```

这组结果直接支持：当前强模型能够把 `.hns` 中结构化 Contract 解释为实际执行
顺序，并遵守一个它原本不会完整执行的反常过程。代价也清晰可见：多 2 次模型
求值、2 次物理工具调用和约 27 秒。

该结论只覆盖 **model-owned 顶层 `(infer ...)` 的程序遵守能力**。它没有验证
Runtime 按节点确定性执行 Contract，也不能由单个样本外推为稳定遵守率。

在当前实现重跑的第二个同模型样本中，结果再次成立：Baseline 为 0 / 5，Harness
为 5 / 5；两组仍通过全部公开与隐藏测试，Harness 严格满足
`失败基线 → PROCEDURE.md → 探针 → 首次修改`。这次 Harness 比 Baseline 快
3.77 秒，但多 9 个评测层物理工具调用并出现 1 次精确重复，因此这里只把复测用于
确认“结构可以驱动反常顺序”，不把单次效率波动解释为性能增益。

复测报告位于：

```text
/private/tmp/morphz-coding-harness-procedure-current/
  coding_harness_ab_v1-procedure-adherence-suite-20260726T012617.866Z-67594/
```

第三个 Suite 报告位于：

```text
/private/tmp/morphz-coding-harness-procedure-real-network/
  coding_harness_ab_v1-procedure-adherence-suite-20260725T233041.459Z-45494/
```

### 4.4 第四个样本：`runtime-eval`

| 指标 | Baseline | Runtime Eval Harness | 差值 |
| --- | ---: | ---: | ---: |
| 独立隐藏验证 | 通过 | 通过 | 持平 |
| Ledger 总分 | 65 | 75 | **+10** |
| 过程纪律 | 5 / 9 | 7 / 9 | **+2** |
| 模型尝试 | 5 | 3 | -2 |
| Work 尝试 | 5 | 2 | -3 |
| 评测层物理工具调用 | 12 | 2 | **-10** |
| 精确重复物理调用 | 0 | 0 | 0 |
| 修改文件 | 1 | 1 | 0 |
| 修改范围违规 | 0 | 0 | 0 |
| 时长 | 66.90s | 151.78s | +84.88s |

两组都只修改 `src/service.rs`，并通过 3 个公开测试和 4 个隐藏测试。
Runtime Eval 组的 Ledger 进一步确认：

- `PlanExecution` 按 `exec → read → infer → edit → exec` 顺序推进；
- 内部 infer 产生一个 `plan/infer_result`，没有自行调用物理工具；
- edit 只在严格 JSON 成功解码后创建；
- 最终验证完成后 Objective 进入 `completed`，即使模型没有额外 Delivery，CLI
  也能根据持久终态自动退出；
- 没有重复执行已完成的 effect。

这个样本说明 Runtime-owned eval 不只是让模型“理解流程”，而是把流程变成可恢复
的物理控制结构。它显著减少了模型自主探索和工具调用，但当前单样本时长更高，
主要成本来自独立 child infer、持久调度交接与两次完整编译测试；不能据此宣称吞吐
也得到提升。

第四个 Suite 报告位于：

```text
/private/tmp/morphz-coding-runtime-eval-paired-fixed-2/
  coding_harness_ab_v1-runtime-eval-suite-20260726T012116.145Z-66781/
```

为避免只靠人工读取 Ledger 判断控制流，随后用新版报告器单独复跑 Harness 臂。
这次得到如下机器证据：

```text
Plan 状态                 succeeded
物理 effect 顺序          exec → read → edit → exec
infer request / result    1 / 1
infer 内部工具调用         0
infer 工具契约             显式纯推断
infer 结果契约             strict JSON
strict_control_flow       true
```

报告位于：

```text
/private/tmp/morphz-coding-runtime-eval-evidence/
  coding-v3-20260726T014750.067Z-70932/coding_harness_run.json
```

这次控制流严格通过，但独立隐藏验证只有 2 / 4 通过：模型选择在 upsert 后把新值
直接写入缓存、delete 后清空整个缓存，满足了公开测试，却违反了“成功写入只使目标
tenant 失效一次”的隐藏不变量。该反例说明 Runtime `eval` 能保证步骤、权限、数据
交接和恢复语义，不能替代模型对领域问题的正确推理。这里保留失败样本，不通过重复
抽样把它改写成成功结论。

## 5. 本轮发现并修复的 Runtime 边界错误

第一次真实 Harness 运行在工具调用前被拒绝：

```text
工具 'write' 不能在 eval 程序中调用；
此处只接受 list_files、read、search
```

根因是 Runtime 对所有 Harness 入口都错误使用了 Runtime-owned `eval` 的只读
工具白名单。显式双求值语义要求：

- 顶层 `(eval ...)`：由 Runtime 降低为 Typed Plan IR，只能使用
  `eval_callable_tools`；
- 顶层 `(infer ...)`：由模型拥有控制权，`requires` 应是普通 Function
  Calling 工具面的子集。

修复后，`infer` 可以声明 `write/edit/exec/context_tx` 等普通工具，但声明只会
收窄能力；实际调用仍受当前 phase、Objective、权限、沙箱、租约和 Runtime
工具列表控制。`infer` 也不能递归取得 `eval` 或 `no_reply`。

## 6. 可以确认与不能确认的结论

可以确认：

1. 单文件 `.hns` 可以通过真实 CLI 安装、查询和精确版本绑定；
2. Manifest、Contract、Mind 和显式 `infer` 能被同一 Objective 正确挂载；
3. 模型能按该结构完成真实多文件编码任务；
4. 两个自然编码样本中的正式 advisory Harness 没有破坏正确性、范围纪律、工具
   效率或最终交付；
5. Runtime-owned `eval` 与 model-owned `infer` 的工具边界已经分开。
6. 同一配对框架已能承载不同仓库、提示词、隐藏不变量和修改范围。
7. 在保持最终正确性的前提下，实验 Harness 把反常程序探针的实际遵守得分从
   1 / 5 提高到 5 / 5。
8. Runtime-owned `eval` 已在真实模型场景中强制完成确定性步骤、纯 infer、严格
   JSON 数据交接和物理工具恢复链路；该保证与模型生成的补丁是否正确相互独立。

不能确认：

1. Coding Harness 提高了当前强模型的编码正确性；
2. 5.86 秒差异来自 Harness，而不是模型和本机运行方差；
3. Harness 能提高较弱模型、复杂任务或长程任务的成功率；
4. 审批、Edge Target 和 Context pressure 的正确性；
5. Contract 中的每一项过程纪律都会被当前模型跨任务、跨 seed 稳定执行。
6. Runtime-owned `eval` 能提高单次编码任务的语义正确率；新增失败样本反而证明
   目前只能确认控制流增益，不能确认领域推理增益。

Runtime-owned Plan 的重启边界由确定性测试覆盖，而不是这次真实模型样本：非法
JSON child result 在 Coordinator 重建后仍使 Plan 失败关闭，且不会创建后续物理
Execution Job。真实进程中途崩溃的故障注入仍应作为后续耐久性压测。

因此最准确的结论是：

> Coding Harness 的正式产品链路已经跑通，在两个自然编码任务中未退化，在
> 反常步骤实验中表现出直接、可审计的模型程序遵守增益，并在混合求值实验中证明
> Runtime 能强制执行确定性流程、显著减少模型自主工具操作；同一控制流既出现过
> 隐藏验证全通过，也出现过模型补丁语义失败，因此编码正确性增益与跨样本稳定性
> 仍未得到证明。

## 7. 下一阶段

下一轮应使用同一评测器：

1. 至少运行 5 个 seed；
2. 在已有跨模块状态错误之外，增加模糊范围和缺少公开测试的任务；
3. 加入一个较弱模型，观察 Harness 是否补足基础纪律；
4. 增加非 Coding 负向任务，验证不会错误激活；
5. 做真实进程强杀后的 Plan suspend/resume 故障注入；
6. 做审批、Edge Target 和 Context pressure 故障注入。

在进入更大样本前，还应明确区分两类 Contract：

- **advisory contract**：由模型理解并自行遵守，适合开放式判断；
- **enforced contract**：可降低成 Typed Plan IR 或由 Runtime 验证的规则，适合
  范围、阶段门和交付证据等必须保证的约束。

只有候选在多个任务族或较弱模型上稳定提高隐藏正确性或减少遗漏，且成本可接受，
才能把“Coding Harness 提高能力”提升为正式结论。
