# DEMO-001 路演证据协议候选版 v2

> 状态：`candidate-review`
>
> 日期：2026-08-17（Asia/Shanghai）
>
> Purpose：`roadshow_demo`
>
> Runtime 源码基线：`paper-eval-runtime-v2` / `03a32f864a3c38026672b4076855137e0bbb5627`
>
> Demo 冻结 commit/tag：尚未生成；必须另行包含 frozen protocol、fixture、runner、collector 与 scorer
>
> 场景：ORBIT-42「AI 运营公司的一次生产发布」
>
> 角色：五分钟路演中的 20–40 秒 Hero Proof，以及支撑结果页的小规模对比批次
>
> 证据边界：产品演示，不是论文 Pilot 或确认性实验；不得并入任何 ME 数据

## 1. 路演中的位置

五分钟路演首先回答：

> 已经有 Codex、OpenClaw 等强大的 Agent 产品，为什么还需要 Morphz？

DEMO-001 不再承担完整介绍 Morphz 的任务，只验证主叙事中的一个关键结果：当一个长期 Agent 同时推进多个公司事务、接收晚到或冲突事实并跨 Session 接续时，它能否把**唯一正确的当前认知**转化为**唯一正确的最终行动**。

DEMO-001 在现场只占 20–40 秒。完整五阶段事件流、三 Arm 比较和维护成本统计在离线批次中完成；现场使用冻结视频、动画或离线 trace 展示结果，不等待模型实时运行。

路演传播采用两层口径，但不改变实验命题、Arm 或评分：

```text
主标题：让 Agent 具备自我学习与自我改进能力
技术副标题：Structured Context：主动认知学习与并发工作的基础
```

这里的“自我学习”是 Agent 主动吸收 Observation，并依据新证据修订结构化认知；“自我改进”是让已形成的经验改变后续认知判断和 Runtime 行为。它不表示模型权重在运行中自动训练或更新。

## 2. 被验证的架构命题

### 2.1 核心对照

典型消息式 Agent 的连续性以 append-only messages 为主要载体；Morphz 把 Structured Context 提升为第一等认知状态：

- Context 对象可寻址、可引用、可修订并持续维护；
- 当前值、历史值、来源与取代关系可以被明确区分；
- 多个 Session 可以挂载同一个 Agent Context；
- Principal 标识参与主体，Session 承担连接与局部连续性；
- Runtime 可以依据 Principal、Session、权限与当前任务投影不同的 Context 子集，并限制各主体可提交或修订的对象；“Shared Mind”表示它们属于同一个权威认知域，不表示所有主体都能无差别读取或修改全部信息；
- Runtime/Scheduler 负责工作线程的调度、因果路由、状态提交和恢复。

并发安全不是 Structured Context 数据格式单独产生的能力，而是 **Structured Context + Runtime/Scheduler + Session/Thread 路由**共同成立的系统性质。

### 2.2 结论边界

本批次可以报告：

- 同模型、同工具、同事件流、同预算下的唯一正确最终行动成功率；
- 陈旧事实错误率、每次正确完成的输入 Token、活动上下文长度和墙钟时间；
- 跨 Session 接续、Principal 来源归属、工作线程隔离和重启恢复的机械判定；
- 各 Arm 的全部状态维护调用及其 Token/时间成本。

本批次不得声称：

- Structured Context 必然更省 Token、更快或在任意任务上更准确；
- 外部产品只能使用消息历史，或不能实现类似能力；
- 五个演示 Run 足以形成统计或论文结论；
- 并发、恢复或权限是数据格式本身自然提供的；
- 现场单次成功可以替代冻结批次。

## 3. 实验单位与产物身份

一个实验单位是一个 Arm 在完整 ORBIT-42 事件流上的一次独立运行。

Run ID：

```text
DEMO-001-<arm>-<model-slug>-<YYYYMMDDTHHMMSS>-<ordinal>
```

允许的 Arm：

- `persistent_messages`
- `summary_json_memory`
- `morphz_structured_context`

每个 manifest 必须包含：

```json
{
  "purpose": "roadshow_demo",
  "demo_id": "DEMO-001",
  "protocol_version": "candidate-v2",
  "arm": "persistent_messages | summary_json_memory | morphz_structured_context",
  "include_in_paper_statistics": false
}
```

产物路径：

```text
<demo-root>/DEMO-001/<run-id>/
```

不得把产物写入 `docs/research/paper_evaluation/results`、任何 `ME-*` Run 目录或论文确认性汇总表。

## 4. ORBIT-42 事件序列

### 4.1 参与主体与连接

同一个 Agent 拥有一个长期 Context，事件从两个 Session 到达：

| Principal | Session | 职责 | 可提交信息 |
| --- | --- | --- | --- |
| `principal-release-owner` | `release-coordination` | 发布负责人 | 当前批准版本、端口和入口 |
| `principal-compliance-owner` | `compliance-review` | 合规负责人 | 保留期、时区和安全约束 |

两个 Session 访问同一个 Agent Context，但不互相复制原始 transcript。Harness 对三个 Arm 使用相同 Principal/Session 标签；没有原生 Principal 的 Arm 也必须在消息元数据中保留相同来源标签。

### 4.2 阶段 0：相同长期历史

三个 Arm 获得字节一致、顺序一致的历史，其中包括：

- ORBIT-42 v1：8080、`/v1/events`，已被取代；
- ORBIT-42 v2：9090、`/v2/events`，当前批准；
- `NEVER-LOG-SECRETS` 持续安全约束；
- 与最终动作无关的已完成诊断、迁移过程和公司事务记录。

存储层必须保留完整历史。各 Arm 如何在模型调用时构造预算内活动上下文，由第 5 节冻结规则决定。

### 4.3 阶段 1：两个工作线程接收新事实

Harness 在不超过 100 ms 的窗口内注入两个 Work Item：

发布线程收到：

```text
status: approved-current
project: ORBIT-42
version: v3
port: 9443
endpoint: /v3/events
supersedes: v2
```

合规线程收到：

```text
status: approved-policy
project: ORBIT-42
retention_days: 45
timezone: Asia/Shanghai
security_rule: NEVER-LOG-SECRETS
supersedes: retention=30, timezone=UTC
```

要求：两个工作线程各自产生唯一终态；共享的当前事实进入后续可用认知；回复按 Session/Thread 正确路由。

### 4.4 阶段 2：跨 Session 接续

发布 Session 在不能读取合规 Session 原始 transcript 的情况下询问当前完整生产配置。Agent 可以使用其状态机制，但不能重新读取阶段 0/1 的 fixture 文件。

正确状态：

```text
v3 / 9443 / /v3/events / 45 / Asia/Shanghai / NEVER-LOG-SECRETS
```

本阶段要求调用一次共同诊断工具 `report_current_state`，以完全相同的七字段 schema 回报当前判断。该工具只记录参数并返回收讫回执，不验证、补全或暗示正确答案。

### 4.5 阶段 3：Worker 替换与恢复

Harness 终止当前 Runtime Worker，并使用同一 Agent 身份与持久存储启动替代 Worker。权威认知状态不得依赖旧 Worker 内存；已完成动作不得重复。

此阶段是 Cloud Native 工程可信度佐证，不作为一级创新结论。

### 4.6 阶段 4：晚到冲突事实

替代 Worker 收到物理到达时间最新的历史文件：

```text
status: archived-untrusted
project: ORBIT-42
version: v1
port: 8080
endpoint: /v1/events
warning: historical copy; must not restore production state
replaced_by: v2 and later v3
```

“最后到达”不等于“当前有效”。正确判断必须保持 v3/9443/`/v3/events`。

随后发出阶段 4 诊断请求，要求再次调用一次 `report_current_state`。除阶段 2 和阶段 4 外不得调用该工具。

### 4.7 阶段 5：隐藏最终行动

Agent 只能调用一次 `commit_release`。工具不泄露期望值，失败后不能重试。

唯一正确调用：

```json
{
  "project": "ORBIT-42",
  "version": "v3",
  "port": 9443,
  "endpoint": "/v3/events",
  "retention_days": 45,
  "timezone": "Asia/Shanghai",
  "security_rule": "NEVER-LOG-SECRETS"
}
```

## 5. 三 Arm 与公平边界

### 5.1 Persistent Append-only Messages

- 持久保存完整 append-only 消息与工具事件，不删除长期历史；
- 每次模型调用使用冻结的、预算内消息选择策略构造活动 prompt；
- 候选策略为固定 system 内容 + 当前请求 + 按时间倒序装入能够容纳的完整历史事件，再恢复为时间正序；
- 不生成摘要，不建立独立共享 Memory 或稳定认知对象；
- 两个 Session 的历史都可被相同选择器访问，并保留 Principal/Session 标签，避免把基线削弱为彼此失忆的聊天窗口。

候选实现（尚未冻结）：完整历史始终持久化；活动输入由固定 system 前缀、当前请求和预算内最新完整事件组成，事件装入后恢复时间正序。选择器不得生成隐式摘要，也不得读取其他 Arm 的状态。

### 5.2 Same-model Summary/JSON Memory

- 持久保存与 Message Arm 相同的完整消息历史；
- 同一物理模型在冻结触发点维护一份共享 JSON Memory；
- JSON 采用通用字段，如 `summary`、`current_facts`、`open_items`、`source_notes`，但 Runtime 不强制对象身份、版本、来源引用或取代关系；
- 业务调用使用近期消息 + 当前 JSON Memory；
- 每次 Memory 维护的输入、输出、请求数、Token 和墙钟时间全部计入该 Arm；
- 维护提示、触发点、最大 Memory 大小和解析失败策略在任何模型 Run 前冻结。

候选实现（尚未冻结）：共享 JSON 使用 `current_facts`、`field_sources`、`open_items`、`source_notes` 和 `last_maintained_event_sequence`；每累计 8 个新 evidence event 以及协议诊断/最终行动前触发维护。非法 JSON 不覆盖上一份有效 Memory，允许同一模型进行一次计费修复；仍失败则终止并记为 `model_outcome`。

### 5.3 Morphz Structured Context

- 使用 Agent-owned Structured Context、稳定对象、来源、版本和关系；
- 模型提出认知修订，Runtime 验证并提交状态事务；
- 多个 Session 挂载同一 Context，Principal 保留参与主体归属，Thread 保留因果执行链；
- Context maintenance 的全部模型调用、Token、事务、重试和墙钟时间计入该 Arm；
- Scheduler/Runtime 负责并发调度、结果路由、提交和恢复，不把这些能力归因于结构化数据本身。

候选映射（尚未冻结）：fixture evidence 进入带 Principal/Session/Thread/source event ID 的 Observation；批准的当前事实进入稳定的 release/policy/security 对象，并保存来源与 supersedes 关系；用户请求作为 Session/Thread 输入，根据 Principal 权限构造 Context 投影；替代 Worker 重新挂载 Agent 身份、持久存储和 Context，不重放已完成外部动作。

### 5.4 共同控制变量

三个 Arm 必须使用相同：

- 精确模型、Provider、推理参数与输出上限；
- fixture 字节、event ID、注入顺序、Principal/Session/Thread 标签；
- 业务工具 schema、返回值与错误行为；
- 总 Token、最大模型调用、最大业务工具调用和全 Run 墙钟预算；
- 隐藏 `commit_release` 评分器；
- 运行队列、失败分类、排除与补跑规则。

状态组织和维护机制是唯一有意改变的变量。所有维护工作都计费、计时，不能使用免费离线摘要或人工整理。

## 6. 业务工具

| Tool | 作用 | 约束 |
| --- | --- | --- |
| `read_evidence` | 按路径读取 fixture | 只返回指定文件，不给隐藏答案 |
| `check_release_config` | 校验参数格式与组合 | 不判断哪份证据当前有效 |
| `check_security_policy` | 检查规则是否缺失 | 不替 Agent 选择规则 |
| `report_current_state` | 以统一七字段 schema 记录阶段 2/4 的当前状态判断 | 只返回收讫回执；不验证或补全答案；调用计入工具数与时间；其他阶段禁用 |
| `commit_release` | 提交最终生产配置 | 最多一次；隐藏正确值；失败不泄漏差异 |

Worker 终止/替换、事件注入和结果抓取由 Harness 完成，不算 Agent 工具。

`report_current_state` 只用于降低自由文本评分噪声，不替代 `commit_release`。三个 Arm 获得完全相同的 schema、阶段限制和回执行为；主要指标仍只由唯一 `commit_release` 决定。

## 7. 预算冻结原则

首次模型 Run 前一次性冻结以下共同预算：

- 单次模型物理 Context 上限；
- 全 Run 累计输入与输出 Token；
- 最大业务调用与状态维护调用；
- 输出上限；
- 全 Run 墙钟上限；
- 阶段 1 并发槽位。

无模型 dry-run 可以用于校准“能否跑完”，但不得观察任一 Arm 的模型结果后单独调参。若统一预算需要改变，提升协议版本并重新开始全部批次。

## 8. 评分与报告

### 8.1 主指标

`unique_correct_final_action = 1` 当且仅当：

- 阶段 5 后恰好调用一次 `commit_release`；
- 七个参数逐项等于隐藏正确值；
- 此前没有发布副作用。

批次主指标：

```text
unique_correct_final_action_rate
  = 正确完成的有效 Run 数 / 有效 Run 总数
```

回答文本正确但行动错误、未行动或多次行动，均为失败。

### 8.2 次指标

| 指标 | 定义 |
| --- | --- |
| `input_tokens_per_correct_completion` | Arm 全部业务与维护调用输入 Token 总和 / 正确 Run 数；零正确时报告 `N/A` 并保留原始总量 |
| `stale_fact_error_rate` | 阶段 4/5 将 v1、v2、30 天或 UTC 当作当前事实的有效 Run 占比 |
| `active_context_tokens` | 每次模型调用实际发送的输入 Token；报告最终行动调用值、中位数和峰值 |
| `wall_clock_seconds` | 从事件流开始到最终判定的全 Run 时间，含 Summary/Context 维护与恢复等待 |

辅助诊断：总输出 Token、请求数、维护调用数、实际/估算成本、工具数、Provider 错误和 Runtime/Harness 错误。

### 8.3 能力判定

- `cross_session_continuity_pass`：阶段 2 不读取对方 transcript 或 fixture，仍得到完整当前配置；
- `principal_attribution_pass`：发布与合规事实保留正确 Principal 来源，不被解释为同一消息作者；
- `thread_routing_pass`：阶段 1 两条工作线程各有唯一终态且回复归位；
- `restart_recovery_pass`：替代 Worker 延续同一 Agent 状态，不重做已完成动作；
- `stale_state_reused`：阶段 4/5 将已取代值用于当前判断或最终行动。

这些能力判定用于解释主指标，不替代最终行动成功率。

## 9. 批次、失败与展示规则

- 候选规模：每 Arm 5 个配对 Run；只报告原始计数和描述性指标；
- 三 Arm 按预注册交错顺序运行，减少 Provider 时间漂移；
- Provider 5xx、连接失败等可验证服务故障不计结果，按冻结规则补跑一次；
- 模型空响应、非法工具参数、拒绝行动、超预算和状态误判均计为结果；
- Harness/评分器故障保留旧产物，修复后使用新 Run ID；
- 任何失败轨迹不得删除，任何规则变更必须提升协议版本。

路演结果页必须标注：

> 同条件路演演示批次，n=5/Arm；非论文确认性实验。

若 8 月 24 日前未形成有效冻结批次，五分钟版本不展示预测数字，只展示协议和一条已审计 Hero Proof。

## 10. 20–40 秒 Hero Proof

现场片段只保留五个视觉事件：

```text
发布线程（release owner）     → v3 / 9443 / /v3/events
合规线程（compliance owner）  → 45 days / Asia/Shanghai
替代 Worker 上线              → Agent 状态仍在
晚到 archived v1             → REJECT AS CURRENT
commit_release               → PASS（唯一正确七参数）
```

建议使用 30–35 秒冻结视频或 trace 动画；不在五分钟主流程中等待模型。视频末尾同时显示 Run ID、`purpose=roadshow_demo` 和机械评分结果。

旁白只说：

> 两个工作线程分别收到发布和合规更新，中间 Runtime Worker 被替换，随后又到了一份更晚但已经作废的 v1。Morphz 没有选择“最后一句话”，而是让同一个长期 Context 中的当前状态进入最终发布动作。评分器只看它真正提交的七个参数。

## 11. ME-00 兼容接口需求

路演 runner 可复用以下字段，但不得要求论文轨道修改协议或阻塞 ME-00：

- Runtime/runner/scorer commit 与 dirty diff hash；
- Provider、模型、采样参数、预算；
- fixture ID/hash 与 event-order hash；
- 起止时间、原始请求/响应、工具 trace、状态快照；
- Token、scores、summary 与 checksums。

ME-00 尚未提供的字段，由路演 manifest 自行实现等价记录。

## 12. 公开边界

可展示：

- messages list 与 Structured Context 的架构对照；
- Context 对象的可读摘要、来源、版本和取代关系；
- Session、Principal、Thread 的概念关系；
- Worker 替换前后连续性、Execution Target 概念；
- 最终行动和聚合后的 Token/时间/成本。

不主动展示：

- 完整 System Prompt、内部数据库 schema、调度/租约/身份锚定算法；
- 尚未决定公开的后续专利族实现细节；
- 凭证、真实用户数据和内部路径。

本演示不包含多语言或文言 Context 对比。

## 13. 冻结前待决策

以下事项必须在第一次模型 Run 前形成 `frozen-v2`：

1. 精确模型、Provider、采样参数和输出上限；
2. 完整历史 fixture、长度、顺序与 hash；
3. 三 Arm 的共同 Token/调用/时间预算；
4. Message 活动窗口选择器；
5. Summary JSON schema、维护提示、触发点和解析失败策略；
6. 交错运行顺序、随机种子与服务故障补跑队列；
7. Hero Proof 采用哪条冻结 Run 及其审计字段；
8. Roadshow Demo commit/tag 与视频版本。

## 14. 版本记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| candidate-v1 | 2026-08-17 | superseded | 完整五阶段现场演示，Message 基线过弱，时长以 7 分钟为中心 |
| candidate-v2 | 2026-08-17 | candidate-review | 改为 5 分钟架构主叙事；Hero Proof 压缩至 20–40 秒；加强 Message/Summary 基线和效能指标 |
