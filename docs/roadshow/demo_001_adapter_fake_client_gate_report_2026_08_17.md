# DEMO-001 Adapter / Fake-client 工程 Gate 报告

> 日期：2026-08-17（Asia/Shanghai）
>
> 对应协议：[DEMO-001 路演证据协议候选版 v2](demo_001_protocol_candidate_v2.md)
>
> Runner mode：`deterministic_fake_client`
>
> 结论：达到 `protocol frozen-v2` 人工决策 Gate；禁止进入真实模型 smoke

## 1. 本轮完成内容

### 统一 adapter 与 trace collector

三个 Arm 已实现相同 runner 生命周期：

```text
fixture event
  → arm adapter ingest / state maintenance
  → unified runtime trace
  → read-only trace collector
  → ObservedRun
  → hidden scorer
```

`ObservedRun` 不再由 adapter 内存直接构造。collector 只读取落盘的 `runtime_trace.jsonl`，重建：

- 最终 `commit_release` 工具名、调用顺序和七参数；
- 阶段 2/4 的 `report_current_state`；
- Principal 字段来源；
- release/compliance Thread 终态；
- Worker 替换与恢复；
- business/state-maintenance/final-action 调用用量；
- Run 墙钟时间。

### 三个 Arm

| Arm | Fake-client 合同实现 |
| --- | --- |
| Persistent Messages | durable append-only event history；候选 selector 构造活动输入；请求阶段从所选消息推导当前状态 |
| Summary/JSON Memory | durable messages；同一 fake client 维护统一 JSON；按触发器更新；一次计费修复；失败不覆盖上一份有效 Memory |
| Morphz Structured Context | evidence → Observation；认知维护 → Context transaction trace；Principal/Session/Thread 投影；替代 Worker 重新挂载持久状态 |

### `report_current_state`

三个 Arm 使用完全相同七字段 schema：

```text
project / version / port / endpoint /
retention_days / timezone / security_rule
```

工具只记录参数并返回 `recorded=true`：

- 不返回正确答案；
- 不校验或补全字段；
- 只允许阶段 2 和阶段 4；
- 调用计入工具次数与时间；
- 不替代唯一 `commit_release` 主指标。

非允许阶段调用的合同测试会直接拒绝。

## 2. 完整历史 fixture 候选

候选 fixture 共 43 个事件：

- 3 条初始权威历史：v1、v2、安全约束；
- 24 条已完成且不改变当前状态的诊断记录；
- 8 条 v1→v2 迁移过程记录；
- 2 条阶段 1 并发更新；
- 1 条阶段 2 跨 Session 请求；
- 2 条 Worker 替换事件；
- 1 条晚到 archived v1；
- 1 条阶段 4 结构化诊断请求；
- 1 条最终行动请求。

候选来源：

- `morphz-evals/tests/fixtures/roadshow_demo_001_v2/event_stream.json`：核心事件模板；
- `morphz-evals/tests/fixtures/roadshow_demo_001_v2/adapter_candidate_design.json`：历史生成、三 Arm 策略和工具合同；
- fake-client suite 的 `expanded_fixture_candidate.json`：完整展开稿。

当前版本明确为 `candidate-v2-full-history-generated`，尚未冻结文字、顺序与 hash。

## 3. 三个状态策略候选

### Persistent Messages selector

```text
完整事件永久持久化
+ 固定 system 前缀
+ 当前请求
+ 活动输入上限内的最新完整事件
→ 恢复为时间正序后交给模型
```

不生成隐式摘要，不访问其他 Arm 的状态。当前 fake-client contract 使用无限事件数，真实活动输入上限仍待人工冻结。

### Summary JSON

候选字段：

```text
schema_version
current_facts
field_sources
open_items
source_notes
last_maintained_event_sequence
```

候选触发器：每累计 8 条新 evidence，以及协议诊断/最终行动前维护。

失败策略：

1. 非法 JSON 不覆盖上一份有效 Memory；
2. 使用同一模型进行一次计费修复；
3. 修复仍失败则终止，归类为 `model_outcome`；
4. 不静默沿用无法确认是否过期的结果继续最终行动。

Fake client 已覆盖“首次失败后修复成功”和“连续两次失败后终止”两条路径。

### Morphz mapping

- evidence → 带 Principal/Session/Thread/source event ID 的 Observation；
- approved-current/policy/security → 稳定的 release/policy/security 对象；
- 更新保留来源和 supersedes 语义；
- user request → Session/Thread input；
- Runtime 按 Principal 权限构造 Context projection；
- Worker replacement → 重新挂载 Agent identity、durable store 和 Context；
- 已完成外部动作不得重放。

该映射目前是 eval adapter 候选，不等于已经冻结生产 Runtime 内部 schema。

## 4. Fake-client 合同测试结果

最终 Suite：

```text
/private/tmp/morphz-roadshow-adapter-gate.TZ0Blc/DEMO-001/
_fake_client_runs/DEMO-001-fake-client-20260817T095008.798Z-82935
```

| Arm | Fixture events | `report_current_state` | `commit_release` | trace→ObservedRun | Hidden score |
| --- | ---: | ---: | ---: | --- | --- |
| Persistent Messages | 43 | 2 | 1 | 通过 | 通过 |
| Summary/JSON | 43 | 2 | 1 | 通过 | 通过 |
| Morphz Structured Context | 43 | 2 | 1 | 通过 | 通过 |

所有结果均标记：

```text
measurement_mode=deterministic_fake_client
metrics.status=deterministic_fake_not_reportable
include_in_paper_statistics=false
```

Fake token/时间只用于验证 usage 管道字段，不得进入路演对比表或论文。

测试：

```text
cargo test -p morphz-evals --lib roadshow_demo_001
11 passed; 0 failed

cargo clippy -p morphz-evals --lib -- -D warnings
passed

git diff --check
passed
```

覆盖内容：

- 三 Arm 完整 round-trip；
- 43 事件 fixture 形状；
- Message selector 保持完整事件与时间正序；
- Summary 一次修复成功；
- Summary 两次非法后终止；
- `report_current_state` 阶段限制；
- 隐藏 scorer 正负例；
- artifact checksum 与篡改检测；
- 错误分类。

## 5. 路演文案同步

文案已采用两层口径：

```text
主标题：让 Agent 具备自我学习与自我改进能力
技术副标题：Structured Context：主动认知学习与并发工作的基础
```

固定解释：

- 自我学习：主动吸收 Observation，并根据新证据修订结构化认知；
- 自我改进：让既有经验改变后续认知判断和 Runtime 行为；
- 不宣称模型权重在运行中自动训练或更新。

该调整只改变传播层表达，不改变 ORBIT-42 事件、三 Arm、工具公平性或评分主指标。

## 6. 仍待人工冻结项

以下事项不得由 fake-client 结果自动决定：

1. 43 条 fixture 的最终文字、event ID、顺序和 hash；
2. Persistent Messages 的精确活动输入上限、system/current-request 固定占用和 selector 参数；
3. Summary JSON 的最终提示词、schema 细节、最大长度、触发边界与终止错误文案；
4. Morphz 稳定对象 schema、Context transaction 表达、来源/supersedes 关系和 Principal 投影；
5. 三 Arm 共用的精确模型、Provider、sampling 与总预算；
6. 阶段 1 并发门的实现和 100 ms 测量口径；
7. 三 Arm 等价的 Worker replacement 语义；
8. `report_current_state` 是否计入业务工具总上限中的具体数量；
9. usage/cached token/价格快照口径；
10. 交错运行顺序、seed、service-failure replacement 队列；
11. Demo commit/tag、dirty diff hash、artifact root 与备份位置。

## 7. Gate 判定

### Protocol `frozen-v2` 决策 Gate

**达到。**

理由：

- 三 Arm 已按统一生命周期执行；
- 完整候选 fixture 能逐事件注入；
- `report_current_state` 公平且不泄漏答案；
- 原始 trace 可以由独立 collector 重建 `ObservedRun`；
- 隐藏 scorer、用量接口、恢复、来源、Thread 和失败路径均有测试；
- 未根据某个 Arm 的结果调整其他 Arm。

这意味着可以由统筹/人工审查并冻结第 6 节决策，不表示它们已经自动冻结。

### 真实模型 smoke

**仍然禁止。**

只有人工完成协议冻结、记录模型/Provider/预算并生成 frozen fixture/hash 后，才能由统筹单独授权每 Arm 1 次 smoke。本轮未调用任何真实模型。

## 8. 已知非本轨问题

`postgres_multi_process_probe` 使用旧 `claim_message(bool)` 接口导致全包测试编译阻塞。按统筹要求只记录，不在本轨道修复；目标 lib 测试和 DEMO-001 专用 CLI 均通过。
