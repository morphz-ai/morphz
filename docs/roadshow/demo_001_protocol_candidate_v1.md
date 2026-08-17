# DEMO-001 路演对比协议候选版 v1

> 状态：`superseded`
>
> 已由 [DEMO-001 路演证据协议候选版 v2](demo_001_protocol_candidate_v2.md) 取代。v1 仅保留为历史记录，不再用于 5 分钟路演或后续 Run。
>
> 冻结日期：2026-08-17（Asia/Shanghai）
>
> Purpose：`roadshow_demo`
>
> 场景：ORBIT-42「冲突证据下的生产发布决策」
>
> 证据边界：路演演示与产品探针；不属于论文预实验（Pilot）或确认性实验，不得并入论文统计

## 1. 演示命题与结论边界

DEMO-001 用一个可机械评分的生产发布场景展示以下产品命题：

> 当长期任务中的现实证据发生修订、跨 Session 更新、并发到达和进程重启时，Morphz 能够把带来源、版本和取代关系的认知状态继续用于最终行动，而不是仅从消息或摘要中重新猜测当前状态。

本演示重点呈现从认知求值到现实行动的闭环：

```text
Observation
  → 认知符号求值
  → 可寻址、可修订的 Context 对象
  → Binding / 当前状态
  → Runtime 验证
  → 最终行动
```

本演示可以报告：

- 在冻结 fixture、模型、工具和预算下，各 Arm 的演示批次结果；
- 最终行动、陈旧状态、跨 Session 接续、并发隔离和重启恢复的机械评分；
- Token、请求数、物理工具数、墙钟时间和估算成本。

本演示不得声称：

- 结果是论文确认性实验或具有统计普适性；
- Morphz 在任意模型、任意任务和任意长度下必然优于其他 Agent；
- 路演 Run 可以补入 ME-01、ME-04 或 ME-06；
- 单次现场成功可以替代冻结批次或论文实验。

## 2. 实验单位与 Run 身份

一个实验单位为：一个 Arm 在相同 ORBIT-42 五阶段事件流上的完整运行。

Run ID：

```text
DEMO-001-<arm>-<model-slug>-<YYYYMMDDTHHMMSS>-<ordinal>
```

允许的 Arm slug：

- `message_agent`
- `summary_memory`
- `morphz`

每个 manifest 必须显式包含：

```json
{
  "purpose": "roadshow_demo",
  "demo_id": "DEMO-001",
  "protocol_version": "candidate-v1",
  "arm": "message_agent | summary_memory | morphz",
  "include_in_paper_statistics": false
}
```

产物根目录不得放入 `docs/research/paper_evaluation/results` 或任何 ME Run 目录。候选约定为：

```text
<demo-root>/DEMO-001/<run-id>/
```

## 3. 共同世界状态

### 3.1 初始权威证据

所有 Arm 获得字节完全相同的业务证据：

`release-v1.txt`

```text
status: superseded
project: ORBIT-42
version: v1
port: 8080
endpoint: /v1/events
retention_days: 30
timezone: UTC
replaced_by: v2
```

`release-v2.txt`

```text
status: approved-current
project: ORBIT-42
version: v2
port: 9090
endpoint: /v2/events
retention_days: 30
timezone: UTC
supersedes: v1
```

`security-rule.txt`

```text
status: active-until-explicitly-revoked
project: ORBIT-42
rule: NEVER-LOG-SECRETS
```

### 3.2 历史负载

在阶段 1 前为三个 Arm 注入同一份、顺序相同的长期项目历史。历史由以下部分组成：

- 上述三份权威证据的到达事件；
- 24 条已完成、与最终发布无关的部署诊断记录；
- 8 条与 v1、v2 迁移过程有关、但不改变当前权威状态的过程记录；
- 每条记录都包含稳定 fixture event ID、时间、Session 和来源类型。

历史负载用于在 5–10 分钟演示中模拟长期运行，不得包含某个 Arm 专属的提示、答案或评分字段。具体文本和顺序在首次模型 Run 前生成 fixture hash 并冻结。

## 4. 五阶段事件序列

### 阶段 1：建立当前发布状态

Session A（`release-coordination`）收到：

> 审查现有发布证据，判断 ORBIT-42 当前可用版本、端口、事件入口和持续安全约束。旧版本可以保留为历史，但不得作为当前配置。

允许读取初始三份证据。期望当前状态：

```text
version=v2
port=9090
endpoint=/v2/events
retention_days=30
timezone=UTC
security_rule=NEVER-LOG-SECRETS
```

阶段 1 的冻结批次完整执行；现场演示可以从阶段 1 完成后的签名 checkpoint 开始，但必须明确说明它是同一协议的预置长期状态。

### 阶段 2：并发更新与 Session 隔离

Harness 在同一 Agent 身份下并发提交两个 Work Item，提交时间差不超过 100 ms：

Session A 收到 `approved-hotfix-v3.txt`：

```text
status: approved-current
project: ORBIT-42
version: v3
port: 9443
endpoint: /v3/events
supersedes: v2
security: unchanged
```

并请求核验和更新当前发布判断。

Session B（`compliance-review`）收到：

```text
status: approved-policy
project: ORBIT-42
retention_days: 45
timezone: Asia/Shanghai
supersedes: retention=30, timezone=UTC
session_private_audit_sink: 127.0.0.1:7001
```

并请求维护新的合规决定。`session_private_audit_sink` 仅用于 Session B 的审计输出，不是发布端口，也不得出现在 Session A 的回复或最终发布动作中。

判定要求：

- 两个 Work Item 都产生唯一终态；
- 工具结果和回复投递到正确 Session；
- 共享决定 v3、45 天和 Asia/Shanghai 能进入 Agent 的后续可用状态；
- `session_private_audit_sink` 不污染 Session A 或最终行动。

### 阶段 3：跨 Session 接续

Session A 在看不到 Session B 原始对话 transcript 的条件下收到：

> 合规 Session 已完成。请仅根据当前可用的 Agent 状态，报告 ORBIT-42 的版本、端口、入口、保留期、时区和安全约束；本轮不得重新读取阶段 1/2 的证据文件。

正确结果：

```text
version=v3
port=9443
endpoint=/v3/events
retention_days=45
timezone=Asia/Shanghai
security_rule=NEVER-LOG-SECRETS
```

不得出现 `127.0.0.1:7001`。

### 阶段 4：重启恢复与晚到陈旧证据

Harness 在阶段 3 完成后关闭并重新启动 Agent Runtime，复用同一持久状态。恢复后向 Session A 注入物理到达时间最新的 `late-archived-v1.txt`：

```text
status: archived-untrusted
warning: historical copy; must not restore production state
project: ORBIT-42
version: v1
port: 8080
endpoint: /v1/events
replaced_by: v2 and later v3
```

Session A 收到：

> Runtime 刚刚重启，又收到一份物理时间更新的文件。判断它是否改变当前发布状态，并说明理由。本轮不得召回完整 Event History；只允许检查新到文件和恢复后的当前状态。

正确结果必须保持 v3/9443/`/v3/events`，并把新文件判为 `archived-untrusted`。将 v1/8080/`/v1/events` 恢复为当前值即为陈旧状态误用。

### 阶段 5：单次隐藏发布动作

Session A 收到：

> 如果当前证据足以支持发布，请提交 ORBIT-42 的当前生产配置；否则拒绝发布并说明缺失证据。不得为了回答本轮重新读取历史文件。

Agent 只能调用一次 `commit_release`；工具不会泄露期望参数，也不允许依据失败响应重试。

正确调用：

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

## 5. Arms 与公平边界

### 5.1 Message Agent

- 每个 Session 只有各自预算内的 append-only 消息窗口；
- 超出 Context 预算时按事件边界从最旧内容开始移除；
- 不生成摘要，不建立 Session 之间的共享记忆；
- 不具有稳定认知对象、版本、来源关系或直接结果回流。

### 5.2 Summary-Memory Agent

- 每个 Session 保留近期消息，并共享一份普通 Markdown Memory；
- 达到共同的维护触发点后，由同一物理模型根据当时可见内容更新 Memory；
- Memory 文本带 Session 标签，但没有稳定对象 ID、强制版本校验、来源引用或结构化取代关系；
- 摘要调用的输入、输出、延迟和成本全部计入该 Arm 总预算；
- 业务 Agent 可以读取摘要，但不得访问 Morphz Context/Frame/Relation。

### 5.3 Morphz

- 使用 Agent-owned Structured Context、稳定对象、来源、版本和关系；
- 模型可以提出 Context transaction，Runtime 负责验证与提交；
- 多 Session 挂载同一 Agent Context，但保留 Session/Thread 因果路由；
- Context maintenance 的模型调用、Token、事务和延迟全部计入总预算。

### 5.4 共同控制变量

三个 Arm 必须保持一致：

- 精确物理模型、Provider/API、推理参数和输出上限；
- 五阶段业务文本、fixture 字节、event ID 和注入顺序；
- 业务工具名称、schema、结果和错误行为；
- Session A/B 的消息时序与阶段 2 并发门；
- 总模型 Token 预算、最大模型 Attempt、最大物理工具调用和墙钟上限；
- `commit_release` 隐藏评分器；
- 排除、失败和补跑规则。

状态管理机制是唯一有意改变的系统变量。`context_tx` 或 Summary maintenance 属于相应 Arm 的状态机制，不计作物理业务工具，但其模型 Attempt、Token、延迟和成本必须计入。

### 5.5 候选预算

以下为候选值，在第一次模型 Run 前必须整体冻结；不得看到结果后按 Arm 调整：

| 预算项 | 三 Arm 共同候选值 |
| --- | ---: |
| 单次物理 Context 上限 | 32,000 tokens |
| 全 Run 累计输入+输出 | 96,000 tokens |
| 最大模型 Attempt | 16 |
| 最大物理业务工具调用 | 12 |
| `commit_release` 调用 | 最多 1 次 |
| 全 Run 墙钟 | 300 秒 |
| 阶段 2 并发槽位 | 2 |

如果预演证明预算存在明显天花板、地板或无法在现场时限内完成，只能在任何比较 Run 之前形成新协议版本统一调整。

## 6. 共同业务工具

三个 Arm 暴露完全相同的业务工具：

| Tool | 作用 | 关键约束 |
| --- | --- | --- |
| `read_evidence` | 按 path 读取当前 fixture 文件 | 只返回请求文件，不提供隐藏答案 |
| `check_release_config` | 检查版本、端口、入口格式与组合 | 不判断证据权威性 |
| `check_security_policy` | 检查安全规则格式与是否缺失 | 不选择当前版本 |
| `commit_release` | 单次提交最终生产配置 | 隐藏期望值；失败不泄漏差异；不可重试 |

Harness 的消息注入、Runtime 重启和结果抓取不是 Agent 工具，不向任何 Arm 暴露额外信息。

## 7. 评分器

### 7.1 主要指标：最终行动正确率

`final_action_pass = 1` 当且仅当：

- 恰好调用一次 `commit_release`；
- 七个参数与阶段 5 的隐藏正确调用逐项相等；
- 调用发生在阶段 5 用户请求之后；
- 此前不存在另一项发布副作用。

其他情况均为 0。最终回复正确但未正确调用工具，仍记为失败。

### 7.2 陈旧状态误用

`stale_state_reused = 1`，若阶段 4 或 5 的当前状态、行动参数或 Session A 最终交付把以下任一内容当作当前配置：

- `version=v1` 或 `version=v2`；
- `port=8080` 或 `port=9090`；
- `endpoint=/v1/events` 或 `endpoint=/v2/events`；
- `retention_days=30`；
- `timezone=UTC`。

仅作为已取代历史明确提及不算误用。

### 7.3 跨 Session 接续

`cross_session_continuity_pass = 1`，当且仅当阶段 3 在禁止读取历史文件的情况下，同时正确报告 v3、9443、`/v3/events`、45、Asia/Shanghai 和 `NEVER-LOG-SECRETS`。

### 7.4 并发隔离与污染

`concurrent_isolation_pass = 1`，当且仅当：

- 阶段 2 两个 Work Item 都有且仅有一个终态；
- 回复投递到对应 Session；
- Session A 的阶段 2/3 回复与阶段 5 行动均不包含 `127.0.0.1:7001`；
- Session B 的私有 audit sink 没有被解释为发布端口或生产入口。

### 7.5 重启恢复

`restart_recovery_pass = 1`，当且仅当：

- 重启后的 Runtime 使用同一 Run/Agent 持久状态继续；
- 阶段 4 无需重新读取阶段 1/2 证据即可保持阶段 3 当前状态；
- 不重复阶段 2 已完成的外部动作或用户交付；
- 阶段 5 最终行动仍可完成。

### 7.6 诊断与商业指标

- 总输入、输出、cached input 和总 Token；
- 实际或按冻结价格快照估算的成本；
- 模型 Attempt、物理工具调用、状态维护调用；
- 各阶段与全 Run 墙钟时间；
- Context 峰值、摘要长度或活动 Frame 数；
- Provider、模型、Runtime、Harness 和评分器错误分类。

路演主表按以下顺序展示：最终行动 → 陈旧误用 → 跨 Session → 隔离 → 重启 → Token/成本/时间。

## 8. 失败、排除和补跑

| 情况 | 分类 | 计入 Arm 结果 | 补跑 |
| --- | --- | --- | --- |
| Provider 可验证的 5xx、连接失败或服务端超时 | service failure | 否，单独报告 | 按同一预注册队列补跑一次 |
| 模型空响应、非法工具参数、拒绝行动 | model outcome | 是 | 否 |
| 达到 Token、Attempt、工具或墙钟预算 | outcome | 是 | 否 |
| Runtime 语义错误或恢复失败 | system outcome | 是 | 否 |
| Runner/评分器无法读取产物 | harness failure | 否 | 修复后新 Run，保留旧产物 |
| 现场网络失败 | live presentation failure | 不改冻结批次 | 切换视频或离线 trace |

任何失败轨迹不得删除。只允许对原始产物使用冻结评分器重新评分；评分规则实质变化必须提升协议版本。

## 9. 批次与展示规则

- 正式路演表格候选为每 Arm 5 个配对 Run；
- 三 Arm 按预生成交错顺序运行，避免 Provider 时间漂移；
- fixture、模型、预算、Runner 和评分器冻结后才允许启动批次；
- 批次结果只称为「同条件路演演示批次」，不计算或呈现论文显著性；
- 现场只实时运行 Morphz；Message 与 Summary-Memory 只展示冻结结果和必要的失败 trace；
- 现场 Run 不替换冻结批次中的任何 Run。

## 10. ME-00 接口复用需求（非阻塞）

DEMO-001 希望复用但不要求论文轨道立即实现以下字段：

- Runtime commit、dirty flag、dirty diff hash；
- Runner/scorer commit；
- Provider、模型精确标识、采样参数；
- Context/输出/累计 Token 与 Attempt 预算；
- fixture ID/hash、event order hash；
- Run 起止时间、OS/架构和关键锁文件 hash；
- 原始请求/响应、工具 trace、状态快照、scores、summary 和 checksums。

如果 ME-00 接口尚不可用，路演 runner 在自己的 manifest 中实现等价字段；不得因此阻塞 ME-00，也不得修改论文模板或总账。

## 11. 公开边界

路演只展示：

- 输入证据、Context 对象的可读摘要、版本/来源/取代关系；
- Session/Thread 因果隔离的可视轨迹；
- Runtime 重启前后状态连续性；
- 最终行动和机械评分；
- 聚合后的成本与时延。

不主动展示：

- 完整 System Prompt、内部调度数据库 schema 或安全实现细节；
- 尚未决定公开的 Edge、身份锚定和后续专利族实现；
- Provider 凭证、真实用户数据或内部路径。

本场景不包含多语言、文言 Context 或相关比较。

## 12. 尚未冻结的运行决策

以下项目必须在第一次模型 Run 前形成 `frozen-v1`，目前不得根据结果选择：

1. 精确模型、Provider、temperature/top_p/seed 与输出上限；
2. 候选预算是否直接采用第 5.5 节数值；
3. 40 条长期历史记录的最终文本、顺序和 fixture hash；
4. Summary-Memory 的维护触发点和固定提示模板；
5. 三 Arm 的交错执行顺序；
6. 现场使用当前开发 commit 还是另行冻结 `roadshow-demo-v1`；
7. 现场 checkpoint 的制作方式与签名校验字段。

这些决策只能在无模型 dry-run、接口验证和时间预算校准后一次性冻结。任何涉及事件语义、Arm 定义、评分规则或答案信息的变化都必须提升协议版本。

## 13. 版本记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| candidate-v1 | 2026-08-17 | candidate-frozen | 首次冻结候选：五阶段事件、三 Arm、公平边界、评分和现场用途 |
