# DEMO-001 `protocol frozen-v2` 决策提案

> 状态：`user-decisions-complete / gpt-5.6-sol-readiness-confirmed`，即将生成 `frozen-v2`
>
> 日期：2026-08-17（Asia/Shanghai）
>
> Purpose：`roadshow_demo`
>
> Runtime 源码基线：`paper-eval-runtime-v2` / `03a32f864a3c38026672b4076855137e0bbb5627`
>
> Demo 冻结 commit/tag：待生成；不得将当前未提交的 runner/fixture 误记为 Runtime 基线内容
>
> 约束：截至本次更新未调用真实模型；仅在 frozen commit/tag 建立后进入每 Arm 1 次 normal smoke；不得并入 ME 数据

## 0.1 用户已冻结的 Provider 与预算口径（覆盖旧提案）

- 唯一路演主模型：`gpt-5.6-sol`；不得调用 Gemini，不得静默降级 Terra、GPT-5.5 或其他模型；
- Provider：当前 Morphz 已配置的 `codex-subscription` / OpenAI Responses 订阅路由；
- 当前 route 与 physical model 均为 `gpt-5.6-sol`，路由只有一个绑定候选、无 fallback；
- reasoning：请求 `max`。当前 Morphz 可表达的最高档为 `max`，Codex 请求适配器会原样保留该字段；首次 smoke 记录实际成功或拒绝，不把本地设置误写成 Provider 回显；
- 活动输入成本档：8,192 tokens；三 Arm 相同；
- 不设货币上限；`cost_attribution=subscription_not_monetarily_attributed`，不得写作 0 成本；
- Provider usage 能取得则原样保存，取不到的字段写 `unavailable`；仍以冻结 tokenizer 重算 `uncached_equivalent_input_tokens`；
- Codex 订阅适配器会移除服务端 `max_output_tokens`。因此 business=512、maintenance=1,024 是 Harness 的统一输出验收上限，`provider_accepted_parameters.max_output_tokens` 必须记为 `stripped_unavailable`，不得宣称由 Provider 强制执行；
- `42001..42005` 仅为 paired cell 标识；当前路由不发送 seed，`sampling_seed_applied=false`。

只读证据边界：精确物理模型来自 Morphz 的远端 Provider catalog 持久快照（`remote_provider`）及当前无 fallback 路由；账户处于 ready/authenticated。没有运行会发送 `MORPHZ_OK` 的 route health probe。宿主模型能力目录明确列出 `gpt-5.6-sol` 支持 `max`；首次真实 smoke 才是端到端 accepted Gate。

## 0. 建议结论

当前 43-event fixture 只能作为 `normal_load`。它对现代模型并不构成 Context 压力：其展开文件虽然有 25.8 KB，但模型实际需要看到的规范化事件仅约 3,856 `o200k_base` tokens。若三 Arm 在这一档都通过，这恰好证明基线没有被退化，却不能证明结构化状态在长程负载下产生区分力。

建议冻结前采用两级设计：

1. `normal_load`：43 events，全部历史完整进入活动输入，验证 Message 基线在事实全部可见时并不退化；
2. `context_pressure`：139 events，核心事实和最终答案不变，只增加真实可解释的公司运营历史；三个 Arm 共用 8,192-token 活动输入成本档。Message selector 形成稳定的完整事件后缀，早期长期约束在边界之外至少相隔 54 个完整事件，而不是“恰好差一条”。

8,192 是**已冻结的商业活动成本档**，不是目标模型物理 Context 上限。

## 1. Token 实测与边界

### 1.1 测量方法

- tokenizer：`tiktoken 0.12.0 / o200k_base`；
- 编码表 SHA-256：`446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`；
- 事件序列化：UTF-8 compact JSON、`ensure_ascii=false`、key 排序、一个完整 event 一个消息单元；
- 模型可见字段：`sequence/event_id/stage/kind/principal_id/session_id/thread_id/payload`；
- Harness 专用的 `injection_group/scheduled_offset_ms` 不进入模型事件正文；
- Provider 消息包装尚未冻结，因此每次调用先预留 256 tokens；阶段 4/5 再分别预留 1/2 轮既往诊断工具 transcript，每轮 256 tokens；
- 输出上限与输入分开，候选为 512 tokens/call。

可复现输入：

- [候选 system、请求和工具 schema](../../morphz-evals/tests/fixtures/roadshow_demo_001_v2/prompt_bundle_candidate_v2.json)
- [无模型 Token/selector planner](../../morphz-evals/tools/roadshow_demo_001_protocol_planner.py)

若最终模型不使用 `o200k_base`，必须在冻结前用 Provider 官方 tokenizer 对相同序列化字节复测；`bytes/4` 只能作为缺少 tokenizer 时的显式粗估，不得标记为精确 Token。

### 1.2 当前 43-event 候选的真实量级

| 口径 | UTF-8 bytes | `o200k_base` tokens |
| --- | ---: | ---: |
| 当前 fake-client 展开的 pretty JSON 文件 | 25,838 | 6,463 |
| 同一完整 fixture compact JSON | 19,607 | 4,410 |
| 仅模型可见的 43 个规范化事件 | 17,419 | 3,856 |
| 候选 system prompt | — | 159 |
| 五个共同工具 schema | — | 422 |
| 三阶段当前请求 | — | 15 / 16 / 17 |

因此，把“25.8 KB”直接理解为活动 Token 压力是不成立的。

## 2. 两级负载与 Message selector 模拟

### 2.1 共同 selector

三个阶段均先扣除 system、工具 schema、当前请求、Provider wrapper 余量和既往报告 round 余量。Message Arm 再从当前请求之前的持久化历史末端向前扫描：

1. 只装入完整事件；
2. 第一条无法整体装入时停止，得到连续时间后缀；
3. 将已选事件恢复为正序；
4. 不生成摘要、不跳选关键词、不检索其他 Arm 状态；
5. 活动输入上限在任何模型结果出现前冻结。

### 2.2 `normal_load`

- 43 events；
- 32 条混合公司运营记录；
- fixture compact：19,759 bytes / 4,374 tokens；
- 候选 canonical SHA-256：`e0b5fe091d386da0db18444616dd14c099a4b67a2cf281ca66a68a90419223c0`。

| 请求 | 固定占用 | 历史事件占用 | 可见事件 | 省略 | 权威事件可见性 |
| --- | ---: | ---: | ---: | ---: | --- |
| Stage 2 | 852 | 3,397 | 37/37 | 0 | v1、v2、长期安全规则、v3、合规更新均可见 |
| Stage 4 | 1,109 | 3,708 | 41/41 | 0 | 上述全部 + 晚到 archived v1 可见 |
| Stage 5 | 1,366 | 3,779 | 42/42 | 0 | 所有先前权威事件可见 |

这一级的目的不是制造差距，而是验证：当历史完整可见时，Persistent Messages 具备完成任务的公平机会。

### 2.3 `context_pressure`

- 139 events；
- 128 条混合公司运营记录；
- fixture compact：65,649 bytes / 14,298 tokens；
- 候选 canonical SHA-256：`414308aad0758305fdfc2ebb8b913951994e4537324850aac1165a94b61f64f8`；
- 同一 8,192-token 活动输入成本档。

| 请求 | 固定占用 | 历史事件占用 | 可见事件 | 省略 | 第一条可见事件 |
| --- | ---: | ---: | ---: | ---: | --- |
| Stage 2 | 852 | 7,290 | 79/133 | 54 | `company-history-background-052` |
| Stage 4 | 1,109 | 7,048 | 77/137 | 60 | `company-history-background-058` |
| Stage 5 | 1,366 | 6,749 | 74/138 | 64 | `company-history-background-062` |

权威事件可见性：

| 权威事件 | Stage 2 | Stage 4 | Stage 5 |
| --- | --- | --- | --- |
| v1 superseded | 不可见 | 不可见 | 不可见 |
| v2 approved-current | 不可见 | 不可见 | 不可见 |
| `NEVER-LOG-SECRETS` 长期约束 | 不可见 | 不可见 | 不可见 |
| v3 approved-current | 可见 | 可见 | 可见 |
| retention/timezone 合规更新 | 可见 | 可见 | 可见 |
| 晚到 archived v1 | 尚未发生 | 可见 | 可见 |

这不是通过“把答案放到第 8,193 token”制造失败：长期安全规则距 selector 边界至少有 54 个完整事件的稳定余量；当前版本、保留期、时区和晚到冲突仍处在最新后缀中。Pressure 测的是长期未撤销约束能否在大量其他公司事务之后继续影响行动。

## 3. 推荐冻结的 fixture 文本与生成规则

### 3.1 两级共同核心

建议保持以下固定顺序和原文语义：

1. v1：`superseded`，8080，`/v1/events`；
2. v2：`approved-current`，9090，`/v2/events`；
3. 安全规则：`active-until-explicitly-revoked / NEVER-LOG-SECRETS`；
4. 固定数量的已完成公司运营记录，全部声明不改变 ORBIT-42 生产状态；
5. Stage 1 release：v3、9443、`/v3/events`、supersedes v2；
6. Stage 1 compliance：retention=45、timezone=`Asia/Shanghai`、supersedes 旧值；
7. Stage 2 请求；
8. Worker terminated / replacement attached；
9. 晚到 `archived-untrusted` v1；
10. Stage 4 请求；
11. Stage 5 唯一 `commit_release` 请求。

关键修正：**Stage 1 compliance 不再重复 `security_rule`**。这是对真实长程工作的模拟：一条保留期/时区变更没有理由重述所有仍有效的安全约束。隐藏正确答案仍包含 `NEVER-LOG-SECRETS`；Normal 能从完整历史取得它，Pressure 则要求状态机制持续保留它。

### 3.2 背景历史

Normal 固定 32 条，Pressure 固定 128 条，依次轮转以下八种文本，不随机生成：

```text
Closed customer-support review {index:03}; no ORBIT-42 production-state change.
Reconciled vendor invoice {index:03}; no ORBIT-42 production-state change.
Completed onboarding checklist {index:03}; no ORBIT-42 production-state change.
Archived marketing draft {index:03}; no ORBIT-42 production-state change.
Reviewed domain renewal {index:03}; no ORBIT-42 production-state change.
Completed deployment diagnostic {index:03}; no ORBIT-42 production-state change.
Recorded roadmap discussion {index:03}; no ORBIT-42 production-state change.
Closed analytics investigation {index:03}; no ORBIT-42 production-state change.
```

精确字段、序列化和候选生成逻辑已落在 no-model planner。进入 frozen 时由 Rust fixture builder 生成两份落盘 JSON，再记录 byte hash；本提案不直接生成 frozen fixture。

## 4. 三 Arm 推荐冻结值

### 4.1 Persistent Messages

- 完整 append-only 历史永久保存；
- 业务调用按第 2.1 节固定 selector；
- 不使用摘要、RAG、关键词跳选或跨 Arm 状态；
- 存储完整不等于每次把整个历史送进活动 prompt；活动成本档是被测系统共同的服务约束。

### 4.2 Summary/JSON Memory

最终 schema 建议：

```json
{
  "schema_version": "demo-001-summary-v1",
  "current_facts": {
    "project": "string|null",
    "version": "string|null",
    "port": "integer|null",
    "endpoint": "string|null",
    "retention_days": "integer|null",
    "timezone": "string|null",
    "security_rule": "string|null"
  },
  "field_sources": {
    "<field>": {
      "event_id": "string",
      "principal_id": "string",
      "observed_sequence": "integer"
    }
  },
  "open_items": ["string"],
  "source_notes": ["string"],
  "last_maintained_event_sequence": "integer"
}
```

维护 prompt 建议冻结为：

```text
Update the JSON memory using only the prior valid memory and the new complete events.
Return JSON matching the schema and no prose. Preserve a current fact until explicit
evidence supersedes or revokes it. Physical arrival order alone does not establish
authority. Superseded and archived-untrusted records are historical. Preserve event_id,
principal_id and observed_sequence for each accepted field. Do not invent missing facts.
```

- 触发器：每累计 4,096 个新规范化 evidence tokens，或在 Stage 2/4 诊断前仍有未维护 evidence 时；Stage 5 前若没有新 evidence，不重复维护；
- 最大序列化 Memory：2,048 tokens；
- 非法 JSON 不覆盖旧版本；同一模型允许一次计费修复；再次失败记 `model_outcome` 并终止；
- 维护只读取上一份有效 Memory + 尚未维护的完整事件，不反复免费读取全历史。

### 4.3 Morphz Structured Context

- 每个 evidence 先确定性落为 Observation，携带 event/source、Principal、Session、Thread；Observation 入库不是模型调用；
- 稳定对象建议：`release:orbit42/current`、`policy:orbit42/retention`、`policy:orbit42/timezone`、`rule:orbit42/no-secret-logging`；
- 每个字段保留 value、source event、source Principal、validity 和 supersedes/revokes 关系；
- 模型认知维护使用与 Summary 相同的 4,096 新 evidence-token Gate 和同一 2,048-token 活动状态上限；所有维护调用计费计时；
- 模型提出 transaction，Runtime 做 schema、权限、引用和版本检查后原子提交；验证失败允许一次计费修复，再失败记 `model_outcome`；
- 业务请求只投影该 Principal/Session/任务获准读取的对象，并限制可提交对象；Shared Mind 不等于无差别共享；
- Stage 1 两个 Work Item 在同一 100 ms 注入窗内进入两个 Thread，二者必须各有一个终态，最终 projection 同时包含已提交结果；
- Stage 3 替换 Worker 只能用 Agent identity + durable store + Context 重新挂载，不能依赖旧进程内存，不能重复已完成外部动作。

## 5. 调用量、Token 与成本

### 5.1 批次规模

固定 `3 Arms × n=5 × 2 levels = 30 runs`。每 Run 有三次业务模型调用：Stage 2、Stage 4、Stage 5。

在 4,096-token 维护 Gate 下，候选调用量为：

| Arm | Normal 每 Run | Pressure 每 Run | 10 Runs 合计 |
| --- | ---: | ---: | ---: |
| Persistent Messages | 3 business | 3 business | 30 calls |
| Summary/JSON | 3 business + 2 maintenance | 3 business + 4 maintenance | 60 calls |
| Morphz Context | 3 business + 2 maintenance | 3 business + 4 maintenance | 60 calls |
| **总计** | — | — | **150 calls** |

正常路径另有：

- `report_current_state`：2/Run，共 60 次；
- `commit_release`：最多 1/Run，共最多 30 次；
- `report_current_state` 必须恰好出现在 Stage 2/4，并计入业务工具和时间；
- `read_evidence` 只用于 Harness ingestion，不在决策阶段暴露；
- 两个 validator 各最多 1 次/Run；业务工具总上限建议 5 次/Run。

若每次维护都触发一次允许的修复，Summary 和 Morphz 各自最多增加 30 次模型调用；这是预算上界，不是正常调用量。

### 5.2 Token 规划值

Message Arm 的 selector 可精确规划：

| Level | 三次输入/Run | 5 Runs 输入 |
| --- | ---: | ---: |
| Normal | 4,249 + 4,817 + 5,145 = 14,211 | 71,055 |
| Pressure | 8,142 + 8,157 + 8,115 = 24,414 | 122,070 |
| **合计** | — | **193,125** |

这是候选内容 Token + 预留量；真实运行必须记录 Provider 返回的实际 input/cached/output/reasoning usage，并用实际 transcript 取代预留。

主 Token 效率必须同时报告两个不互相替代的口径：

1. `provider_reported_total_input_tokens`：Provider usage 原样返回的总输入 Token，并保留所有 cached/cache-write/cache-read 子字段；
2. `uncached_equivalent_input_tokens`：对每次完整实际请求使用冻结 tokenizer 重新计数，假设所有前缀都未命中缓存；cached prefix 仍按 1:1 输入 Token 计入，不应用价格折扣。

实际 `billed_cost`、cache write/read Token 和折扣后成本单列为商业指标，不得用缓存折扣后的账单 Token 或价格替代架构 Token 效率。这样即使 Provider 对重复 benchmark 前缀启用显式或隐式缓存，运行顺序也不会把某个 Arm 看起来“天然更省 Token”。若 Provider 的 total-input 定义包含或排除 cached tokens 不明确，必须保存原始 usage JSON，并以本地 `uncached_equivalent_input_tokens` 作为跨 Arm 可比口径。

Summary/Morphz 在模型运行前只能给上界：

- 每次 maintenance 输入上界：4,096 pending evidence + 2,048 prior state + 512 maintenance prompt/schema = 6,656；
- 每次 business 输入规划上界：2,900；
- 每个状态 Arm：Normal 不超过约 22,012 input tokens/Run，Pressure 不超过约 35,324 input tokens/Run；
- 五次每级后每个状态 Arm不超过约 286,680 input tokens；
- 三 Arm 正常路径合计输入规划上界约 766,485 tokens；
- 输出硬上限：business 512/call、maintenance 1,024/call；正常路径全部 150 calls 的输出上限约 107,520 tokens。

上界高于实际并不意味着 Structured Context 更贵；它只说明在真实 usage 出现前不能预设“更省 Token”。路演报告使用实际的“每次正确完成输入 Token”，失败 Run 单列，不用删掉失败来美化均值。

成本公式：

```text
Cost = T_uncached_in / 1e6 × P_uncached_in
     + T_cached_in   / 1e6 × P_cached_in
     + T_output      / 1e6 × P_output
     + T_reasoning   / 1e6 × P_reasoning        # Provider 若单列
     + N_tool × P_tool                           # 工具若单独收费
```

价格表、币种、区域和生效时间必须随 manifest 快照；没有价格快照时只报告 Token/调用数，不自行换算金额。

## 6. Queue、usage、并发/恢复与产物

### 6.1 交错队列

- 五个 paired cell 标识：`42001..42005`；同一 level/cell 的三个 Arm 使用同一模型参数；
- 只有 Provider 明确接受并执行 seed 参数时，才能把该值同时记为 `sampling_seed`；若 Provider 不支持 seed，它只用于配对 cell 和队列身份，必须记录 `sampling_seed_applied=false`，不得声称采样已固定；
- manifest 保存请求参数、Provider 实际接受/回显的参数以及被忽略或拒绝的参数；
- 两级均按预先生成的 counterbalanced 队列交错，不能先跑完一个 Arm 再看结果调另一个；
- 推荐顺序文件包含 30 个不可变 cell：`level/seed/arm/queue_index`；
- `service_failure` 保留失败 attempt，使用相同 cell 追加到队尾，最多补 2 次；
- `model_outcome`、超预算、无 commit 或错误 commit 都是结果，不补跑；
- 不允许根据任一 Arm 结果修改另一个 Arm 的 fixture、selector、prompt 或预算。

### 6.2 Manifest/usage 字段

除 candidate-v2 已有字段外，建议冻结：

```text
purpose=roadshow_demo
demo_id=DEMO-001
protocol_version=frozen-v2
include_in_paper_statistics=false
load_level=normal_load|context_pressure
replicate_index=1..5
pair_cell_id=42001..42005
requested_sampling_seed / sampling_seed_applied
provider_requested_parameters / provider_accepted_parameters
queue_index / attempt_index / replacement_of
model / provider / endpoint_region / sampling / reasoning
tokenizer_name / tokenizer_version / tokenizer_table_sha256
active_input_cap / output_cap / maintenance_trigger_tokens
fixture_sha256 / event_order_sha256 / selector_sha256
system_prompt_sha256 / tool_schema_sha256 / maintenance_prompt_sha256
provider_reported_total_input_tokens / provider_usage_raw
uncached_equivalent_input_tokens
uncached_input_tokens / cached_read_tokens / cached_write_tokens
output_tokens / reasoning_tokens / billed_cost
business_calls / maintenance_calls / repair_calls / report_calls / commit_calls
wall_clock_ms / provider_request_ids / pricing_snapshot_sha256
dirty_diff_sha256 / code_commit / demo_tag
```

### 6.3 产物与 tag

```text
<demo-root>/DEMO-001/frozen-v2/
  protocol/
  fixtures/normal_load.json
  fixtures/context_pressure.json
  queue.json
  runs/<run-id>/
  aggregate/
```

建议 tag：`demo-001-frozen-v2-<YYYYMMDD>`；Run ID 加入 `normal` 或 `pressure`。冻结目录不得位于任何 `ME-*` 结果目录。

Tag 必须指向一个明确 commit，该 commit 同时包含 frozen 协议、两级 fixture、runner、collector 和 scorer。不得直接在当前混有论文、Runtime 或其他开发任务修改的 dirty worktree 上打 tag。冻结时二选一：

1. 对 DEMO-001 所需文件做 selective commit，确认 commit 能从干净 checkout 独立复现；
2. 从明确干净基线建立独立冻结分支，再提交 DEMO-001 文件。

Tag 前后都记录 `git status --porcelain`、基线 commit、冻结 commit、所选文件清单，以及未进入冻结 commit 的残余 dirty diff hash。残余 dirty worktree 可以存在，但不得被错误地表示为 tag 所指向的实验代码。

## 7. 决策拆分

### 7.1 统筹已原则接受的技术项

1. 接受两级设计，不再把当前 43-event fixture 当作 Pressure；
2. 接受 Stage 1 合规更新不重复长期安全规则；
3. 接受 32/128 条固定运营历史和八模板轮转文本；
4. 接受规范化事件字段、compact serializer 和连续后缀 selector；
5. 接受 Summary schema/prompt、4,096-token 维护 Gate、2,048-token 状态上限和一次修复；
6. 接受 Morphz Observation/Context transaction/Principal projection 映射及同 Gate 计费；
7. 接受 100 ms 并发窗、Worker replacement 判定和不重放约束；
8. 接受 `report_current_state` 恰好 2 次、`commit_release` 最多 1 次及共同工具上限；
9. 接受 paired cells、交错队列、失败分类、artifact 路径和 tag/manifest 字段；seed 只在 Provider 确实执行时具有采样语义；
10. 上述技术项已于 2026-08-17 原则接受；第 7.2 节用户决策现已完成，已授权生成两份 frozen fixture/hash 与 `protocol frozen-v2`。

### 7.2 用户决策（已完成）

1. 精确模型 `gpt-5.6-sol`，当前 `codex-subscription` 路由；
2. reasoning 请求 `max`，Provider 不支持的 sampling 参数不发送；
3. 8,192 为商业活动输入成本档；
4. 不设货币上限，订阅额度不做货币归因；
5. 先建立 frozen commit/tag，再只运行 Normal 每 Arm 1 次 smoke；不直接运行完整 30 Runs。

## 8. Gate 判定

技术项和用户决策均已完成。下一 Gate 顺序固定为：

1. 生成 frozen 文件、hash 和 route-readiness receipt；
2. 完成 real-smoke runner 合同测试；
3. 对 DEMO-001 资产做 selective clean commit 并建立 tag；
4. 仅运行 Normal 每 Arm 1 次真实 smoke；
5. 返回 Gate，不能直接进入完整 30 Runs。

截至本次文档更新，仍未调用真实模型，fake-client 数据仍不可用于效能宣称。
