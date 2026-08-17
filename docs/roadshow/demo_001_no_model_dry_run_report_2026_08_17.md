# DEMO-001 无模型 Dry-run 与 Runner/Scorer 接口审计

> 历史状态：本报告记录第一工程 Gate；其中“adapter 尚未实现”的结论已由 [Adapter / Fake-client 工程 Gate 报告](demo_001_adapter_fake_client_gate_report_2026_08_17.md) 更新。
>
> 日期：2026-08-17（Asia/Shanghai）
>
> 对应协议：[DEMO-001 路演证据协议候选版 v2](demo_001_protocol_candidate_v2.md)
>
> Purpose：`roadshow_demo`
>
> 结论：无模型协议闭环通过；尚不具备进入每 Arm 1 次模型 smoke 的条件

## 1. 范围与边界

本轮只验证：

- fixture 解析、顺序与并发注入元数据；
- Principal / Session / Thread 路由身份；
- 三 Arm 的输入、维护、活动输入构造、恢复和 usage 接口合同；
- 隐藏最终行动评分与负例；
- manifest、Run ID、产物目录和 checksum；
- 错误分类、是否计入结果和 replacement Run 规则。

本轮没有：

- 调用任何 Provider 或模型；
- 生成任何可作为 Arm 效能结果的数据；
- 冻结模型、预算、采样参数或完整历史 fixture；
- 修改 Morphz Runtime 或论文 `ME-*` 协议。

Dry-run 的 `outputs/observed_run.json` 是确定性合成输出，只用于检验 scorer 接线。manifest 明确记录：

```text
runner_mode=no_model_dry_run
include_in_paper_statistics=false
model_and_budget.status=intentionally_unfrozen
metrics.status=not_applicable_no_model_dry_run
```

## 2. 新增接口资产

| 资产 | 作用 |
| --- | --- |
| `morphz-evals/tests/fixtures/roadshow_demo_001_v2/event_stream.json` | 10 事件的最小合同 fixture；含历史、并发更新、跨 Session 请求、Worker 替换、晚到旧证据和最终行动请求 |
| `morphz-evals/src/roadshow_demo_001.rs` | 三 Arm 合同、fixture validator、产物生成、隐藏 scorer、usage schema、错误分类、checksum 和 inspect |
| `morphz-evals/src/bin/roadshow_demo_001.rs` | `dry-run` 与 `inspect-run` CLI |

运行命令：

```bash
cargo run -q -p morphz-evals --bin roadshow_demo_001 -- dry-run <BASE_DIR>
cargo run -q -p morphz-evals --bin roadshow_demo_001 -- inspect-run <RUN_ROOT>
```

## 3. 接口清单与结果

| 接口 | 当前合同 | Dry-run 结果 | 模型 smoke 前状态 |
| --- | --- | --- | --- |
| Fixture identity | `purpose`、fixture ID/version、fixture hash | 通过 | 完整历史尚未冻结 |
| Event order | 严格递增 sequence、唯一 event ID、order hash | 通过 | 可复用 |
| Concurrent injection | 两个事件同 injection group/offset，不同 Principal/Session/Thread | 通过 | 真实 runner 需实现并发门 |
| Recovery order | terminated → attached → late conflict | 通过 | 各 Arm 需实现实际恢复动作 |
| Persistent Messages | durable append + frozen budgeted selector | 合同 trace 通过 | adapter 未实现 |
| Summary/JSON | durable messages + same-model maintenance + recent messages/memory | 合同 trace 通过 | adapter、schema、触发器、usage 未实现 |
| Morphz Context | observation + Context transaction + projection + reattach | 合同 trace 通过 | DEMO-001 Runtime 映射未实现 |
| Final action capture | tool name、调用 sequence、结构化七参数 | 通过 | 真实工具 trace adapter 未实现 |
| Hidden scorer | 恰好一次、在最终请求后、工具名正确、七参数完全相等 | 通过 | 可复用 |
| Stale detection | 结构化 action + adapter 归一化 current-state claims | 通过负例 | 文本归一化策略待冻结 |
| Cross Session | 完整当前状态结构化快照 | 通过合成合同 | 真实输出捕获待实现 |
| Principal attribution | 六个字段来源映射 | 通过合成合同 | 真实来源映射待实现 |
| Thread routing | release/compliance 各一个终态 | 通过合成合同 | 真实事件映射待实现 |
| Restart recovery | replacement attached、state restored、零重复动作 | 通过合成合同 | 真实恢复事件映射待实现 |
| Usage/cost inputs | 每次调用区分业务/维护，记录 input/output/active context/time | schema 通过；值标记 N/A | Provider usage adapter 未实现 |
| Error taxonomy | service/model/budget/system/harness/live presentation | 6 类合同通过 | 名称需写入 frozen-v2 |
| Artifact set | manifest/input/trace/output/score/errors/checksums | 三 Arm 全通过 | 可复用 |
| Re-score/integrity | 同一 scorer 重算 + SHA-256 | 通过；篡改负例被拒绝 | 可复用 |

## 4. 实际 Dry-run 结果

最终 Run：

```text
/private/tmp/morphz-roadshow-dry-run-report.Iqvfrb/DEMO-001/
```

Suite：

```text
DEMO-001-dry-run-20260817T093818.391Z-75522
```

结果：

- fixture validation：通过；
- 三个 Arm manifest/目录/trace/checksum/重评分：全部通过；
- scorer contract：6/6 通过；
- error taxonomy：6/6 通过；
- checksum 篡改负例：成功拒绝；
- `ready_for_model_smoke=false`。

Scorer 负例覆盖：

1. 正确且唯一的 `commit_release`：通过；
2. v1 陈旧行动：失败并标记 stale；
3. 重复 action：失败；
4. 缺少 action：失败；
5. 在最终请求前行动：失败；
6. 错误工具名：失败。

验证：

```text
cargo test -p morphz-evals --lib roadshow_demo_001
5 passed; 0 failed

cargo clippy -p morphz-evals --lib -- -D warnings
passed
```

## 5. 发现的问题

### P0：三个 Arm 还没有真实统一 adapter

- Persistent Messages 只有合同，没有模型调用、持久历史读取与活动窗口构造实现；
- Summary/JSON 没有维护 schema、触发器、同模型调用、解析失败策略和 usage 统计；
- Morphz 没有把 DEMO-001 事件显式映射到当前 Runtime 的 Observation、Context transaction、Principal/Session/Thread 和恢复 trace。

因此合成 dry-run 证明的是 runner/scorer 合同，不是端到端系统已经可跑。

### P0：完整长期历史 fixture 尚未形成

当前 fixture 只有 10 个语义事件，目的是验证合同。协议所需的长期历史、无关事务、迁移过程、稳定 event ID、最终字节顺序和 hash 尚未冻结。直接用当前最小 fixture 跑模型会产生明显地板/天花板风险，不能作为公平 smoke。

### P0：真实结果捕获规则未实现

隐藏 scorer 已要求 action 工具名、发生顺序和七参数，但真实 adapter 仍需从统一工具 trace 中生成 `ObservedAction`。跨 Session、Principal 来源、Thread 终态、恢复和陈旧文本也需要明确的原始证据到结构化 `ObservedRun` 映射，不能由人工填写。

### P1：状态文本的 stale 判定需要冻结

最终 action 可机械评分；阶段 4 回复中的“陈旧事实误用”仍需要决定：

- 只评分结构化 current-state 输出；或
- 对自由文本使用冻结 parser；或
- 要求三个 Arm 调用统一 `report_current_state` 工具。

推荐第三种，避免中文/英文措辞导致脆弱字符串判定，同时不向 `commit_release` 泄漏隐藏答案。

### P1：usage 与墙钟的统一采集点未接线

schema 已包含业务调用、状态维护调用、input/output Token、活动上下文和墙钟，但 Provider usage、Summary maintenance 和 Morphz Context maintenance 尚未汇入同一记录。没有这一层，不能诚实计算 `input_tokens_per_correct_completion`。

### P1：代码身份字段尚未采集

dry-run manifest 保留了 Runtime/runner commit、dirty diff hash 和环境字段，但本轮按要求未冻结，状态为 `capture_required_before_smoke`。模型 smoke 前必须自动采集，不能手填。

### P2：全包测试存在一处无关编译阻塞

`cargo test -p morphz-evals roadshow_demo_001` 会编译所有 eval bin，并在既有 `postgres_multi_process_probe.rs` 失败：当前 `claim_message` 需要 `MessageDispatchMode`，该 bin 仍传入 `bool`。本轮没有修改这条其他轨道代码；目标模块使用 `--lib` 测试和专用 bin 均通过。该问题不阻塞 DEMO-001 专用 CLI，但会阻塞全包绿色验证。

## 6. 需要冻结的决策项

以下只列出，不在本轮擅自决定：

1. 完整长期历史的记录数量、文本、event ID、顺序和 fixture hash；
2. 三 Arm 共用的精确模型、Provider、sampling、输出上限和上下文/累计/调用/墙钟预算；
3. Persistent Messages 的活动窗口选择器，包括 system/current request 的固定占用和事件装载顺序；
4. Summary JSON schema、最大大小、维护提示、触发点、解析失败和恢复策略；
5. Morphz 对 fixture event → Observation/Context transaction 的映射，以及投影权限；
6. 阶段 1 的真实并发门、100 ms 约束如何测量；
7. 三 Arm 的 Worker 替换语义，确保测试的是相同持久性要求而非不同故障；
8. `report_current_state` 结构化诊断工具是否加入共同工具集；
9. 原始事件到 Principal attribution、Thread terminal、restart recovery 的 scorer adapter；
10. usage/cost 的 Provider 原始字段、cached token 口径、维护调用标记和价格快照；
11. 交错 Run 队列、seed、服务故障 replacement 队列和最大补跑次数；
12. Demo commit/tag、dirty diff 审计、artifact root 和备份位置。

## 7. 建议的 protocol `frozen-v2` 变更清单

冻结前建议把以下内容写回协议；它们是本次 dry-run 暴露的接口精化，不改变研究命题：

1. 明确 Run 产物目录与 Suite 元数据目录：Run 位于 `<demo-root>/DEMO-001/<run-id>/`，dry-run/suite 汇总位于 `_dry_runs/` 或 `_suites/`；
2. manifest 增加 `runner_mode`、fixture/order hash、code identity、环境、arm interface、error taxonomy 和 artifact index；
3. 明确 no-model 产物必须标记 `metrics.status=not_applicable_no_model_dry_run`，不得作为 Arm 结果；
4. 最终行动评分增加工具名和事件顺序：只能在最终请求后调用一次 `commit_release`；
5. 失败分类固定为 service/model/budget/system/harness/live-presentation 六类，并明确 replacement Run 而不是在原 Run 内重试；
6. 每个模型调用增加 `call_kind=business|state_maintenance|final_action`，所有维护调用进入 Token/时间；
7. 固定 `ObservedRun` 的跨 Session、Principal、Thread、恢复和 current-state 结构化证据接口；
8. 明确 contract-minimal fixture 只用于 dry-run，不能进入 smoke 或批次；
9. 若采用 `report_current_state`，把它加入三个 Arm 相同工具集，并声明它只结构化回报、不给正确答案。

## 8. Smoke Readiness 判定

当前判定：**不具备进入每 Arm 1 次模型 smoke 的条件。**

允许开始下一步工程工作，但不是模型调用。最短 Gate：

1. 实现三个 Arm 的统一 runner adapter；
2. 实现真实 trace → `ObservedRun` 的只读采集；
3. 冻结完整 fixture 与三个状态策略；
4. 冻结共同模型和预算；
5. 再跑一次使用真实 adapter、确定性假 client 的无模型 contract test；
6. 三 Arm 均通过后，才进入每 Arm 1 次真实模型 smoke。

这个 Gate 可以防止先运行 Morphz，再根据结果临时设计两个基线或调整预算。
