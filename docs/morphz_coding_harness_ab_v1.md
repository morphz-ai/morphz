# Morphz Coding Harness 正式链路 A/B v1

> 状态：首个严格配对样本；证明正式链路可用且未退化，尚未证明能力增益  
> 日期：2026-07-26  
> 模型：`qwen3.8-max-preview`  
> System Prompt：`semantic_sexpr_vm`  
> Harness：[`coding.hns`](../morphz-evals/harnesses/coding.hns)  
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
4. 正式 Harness 路径没有破坏正确性、范围纪律、工具效率或最终交付；
5. Runtime-owned `eval` 与 model-owned `infer` 的工具边界已经分开。
6. 同一配对框架已能承载不同仓库、提示词、隐藏不变量和修改范围。

不能确认：

1. Coding Harness 提高了当前强模型的编码能力；
2. 5.86 秒差异来自 Harness，而不是模型和本机运行方差；
3. Harness 能提高较弱模型、复杂任务或长程任务的成功率；
4. Runtime-owned Plan、重启恢复、审批、Edge Target 和 Context pressure 已在
   本评测中通过。
5. Contract 中的每一项过程纪律都会被当前模型稳定执行。

因此最准确的结论是：

> Coding Harness 的正式产品链路已经跑通，并在首个严格配对中未退化；本次
> 平局是架构可行性证据，不是能力提升证据。

## 7. 下一阶段

下一轮应使用同一评测器：

1. 至少运行 5 个 seed；
2. 在已有跨模块状态错误之外，增加模糊范围和缺少公开测试的任务；
3. 加入一个较弱模型，观察 Harness 是否补足基础纪律；
4. 增加非 Coding 负向任务，验证不会错误激活；
5. 增加 Runtime-owned `(eval ...)` Harness，覆盖 Plan suspend/resume；
6. 做 Provider 失败、进程重启、审批和 Edge Target 故障注入。

在进入更大样本前，还应明确区分两类 Contract：

- **advisory contract**：由模型理解并自行遵守，适合开放式判断；
- **enforced contract**：可降低成 Typed Plan IR 或由 Runtime 验证的规则，适合
  范围、阶段门和交付证据等必须保证的约束。

只有候选在多个任务族或较弱模型上稳定提高隐藏正确性或减少遗漏，且成本可接受，
才能把“Coding Harness 提高能力”提升为正式结论。
