# ME-06 Phase A 无模型 Gate 结果

> 日期：2026-08-26（Asia/Shanghai）  
> 协议：`me06-long-horizon-compaction-p1-candidate`  
> 证据等级：`D`（确定性无模型 Gate）  
> 真实模型调用：`0`

## 结论

ME-06 的两臂候选设计已具备可实现的确定性基础，但尚未获得真实模型运行许可。

- 正式比较仅包含 `controlled_compaction` 与 `full_morphz`；
- Codex 因同时改变系统提示、工具编排、会话实现和不透明 compaction，不进入 ME-06；完整
  Agent 产品对照继续归入 ME-07 公开 Benchmark；
- 三个 paired fixture 均包含 120 条事件和 12 个业务检查点，可见内容 hash 互不相同；
- 分层 scorer 的 5/5 正负例通过，证明“语义正确、格式不合规”仍可记为语义成功；
- `controlled_compaction` 的全局 revision CAS、冲突拒绝、重读后提交、重启恢复、跨
  Session 读取、Context 隔离和历史召回合同均通过；
- `full_morphz` 使用真实生产 `ContextEngine` 与 SQLite 完成测试：不同对象的并发更新可
  自动 rebase，同一对象的过期并发更新被拒绝，进程重新打开数据库后 Frame 可恢复，另一
  Session 可投影同一 Context，相邻 Context 未污染主 Context；
- 三个 fixture × 两个 arm 的 6/6 deterministic fake-provider 接线合同通过，从原始 JSONL
  轨迹重新收集并评分的结果与首次评分逐字节一致；
- planner 预计两臂单 fixture smoke 共 42 次物理模型调用，三 fixture 正常路径约 126 次，
  硬验收上限 216 次。精确 Token 预算仍需冻结最终系统提示、工具 envelope 和 tokenizer。

因此，Phase A 判定为 `passed`，但 `ready_for_real_model_smoke=false`。这不是实验结果，
不能写成 Morphz 优于 compaction 的论文证据。

Fake provider 的当前状态与最终行动由模型可见事件确定性推导，hidden answer 仅由 scorer
读取；全部 run 均明确标记 `include_in_paper_statistics=false`。它只证明 runner、collector
和 scorer 能闭环，不证明任何真实模型具备长期状态能力。

## 两臂的研究角色

| Arm | 角色 | 可支持的结论 |
| --- | --- | --- |
| `controlled_compaction` | 本项目实现、机制公开且可审计的强 compaction 基线 | 与 Morphz 的状态机制比较 |
| `full_morphz` | 真实 Structured Context、Frame、revision、事务和 SQLite | Morphz 的完整机制与架构能力 |

`controlled_compaction` 不是某个第三方产品。它保留不可变原始历史、模型生成的有界持久
summary、全局 revision CAS、跨 Session 读取、重启恢复和同预算 recall；但没有 Morphz 的
Frame、Relation、逐对象 revision 和 `context_tx`。

## Fixture 身份

| Fixture | Visible semantic SHA-256 | Hidden semantic SHA-256 |
| --- | --- | --- |
| `me06-p1-orbit-01` | `84b2376dbe808b9cfdd8e6b28b529db541e55b80442dc4e1f83474df006f6f25` | `46d467dcafdfb80c951dc3019633abc3dea04c8db3e7808a4486e0b60e4cb8cc` |
| `me06-p1-helios-02` | `ee6ee0cc1a8b504a042bf5d85c74b835ca76cb5b7777c5fc887b4484efe37294` | `aade86ad638e3e0514eee910ed46f56e6d80e792531608c05e4e13fedecff3c0` |
| `me06-p1-vector-03` | `a27fab9e272c0e2ad64d781a3bec57924d00fd18df6ba154243744880e58b4c9` | `9e4320ecb7f21115a18195708727f74c2578da0e68e80122e60833c848c7fcb5` |

这些 hash 对应生成器的规范化内存对象，不是 pretty-printed JSON 文件的逐字节 hash。真实
运行时，hidden fixture 必须置于全部 arm workspace 和模型可见工具根目录之外。

## Gate 结果

### Scorer

| Case | 预期 | 结果 |
| --- | --- | --- |
| 正确状态与行动 | 语义成功、格式成功 | 通过 |
| 仅字段形状错误 | 语义成功、格式失败 | 通过 |
| 使用陈旧状态 | 语义失败 | 通过 |
| 相邻 Context 污染 | 语义失败 | 通过 |
| 缺少状态与行动 | 语义失败 | 通过 |

### Controlled compaction

- revision：`0 -> 2`；
- 过期写入被拒绝；重新读取后，两个不同更新均被保留；
- 文件重载后状态一致；另一 Session 读取相同持久状态；
- foreign Context 使用独立状态文件，主状态未出现其私有值；
- 候选 recall 查询命中 7 条 approved 事件。

### Full Morphz

- Context version：`1 -> 4`；
- 不同 Frame 的并发更新自动 rebase 成功；
- 同一 Frame 的过期并发更新被真实 Runtime 拒绝；
- SQLite 重新打开后恢复 `release-state`、`policy-state` 和最新 revision；
- Session B 可读取同一 Context；foreign Context 不可见；
- 本轮主 Context 编码 SHA-256：
  `36336d48308ee05c5b3aa56194d4053d5277143ada15cb0236ea194c4509367b`。

### Fake-provider adapter contracts

- 6/6 接线 run 通过，每个 run 均包含 12 个 checkpoint output；
- `controlled_compaction` 每 fixture 注入 2 次候选维护周期；
- `full_morphz` 每 fixture 注入 6 次候选维护/事务周期；
- 6/6 原始 trace replay 后的 score 与首次 score 相同；
- 本 Gate 没有网络、Provider 或真实模型调用，不能进入论文统计。

## 进入真实 smoke 前仍需完成

1. 用户复核并冻结三份完整事件文本及 hidden answer；
2. 实现真实 `controlled_compaction` 模型 adapter；
3. 实现独立生产 Morphz 的 12-checkpoint 进程 adapter；
4. 冻结 tokenizer、系统提示和工具 envelope，计算完整请求 Token 预算；
5. 复核 fake-provider 合同与真实 adapter 的字段一致，避免实现真实 adapter 时改变 scorer。

上述项目完成、协议升为 frozen 且用户明确允许后，才运行两臂各一次真实 smoke。
