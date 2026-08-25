# ME-01 结构化 Context 与结果直接回流 Pilot 协议 p1

> 状态：`pilot-complete`；p1.1 Stage A 已完成，确认性 p2 尚未冻结
>
> 日期：2026-08-25（Asia/Shanghai）
>
> 关联研究问题：RQ2
>
> 证据目标：`P`（Pilot）；通过 Gate 后另行冻结确认性协议 p2

> 运行结果：5 个任务族 × 3 arms = 15 个有效 episode 全部严格通过，形成明显天花板。
> p1.1 不再对同类简单任务扩样；结果只支持机制真实性和当前范围内未观察到退化。
> 长程 compaction 对照属于 ME-06，不加入本协议的无压力基础任务。

## 1. 假设与结论边界

### 主要假设

在模型、语义信息、来源与版本信息、最终行动合同和评分器相同的条件下，将早期认知
结果提交为具有稳定标识、来源、版本和关系的结构化对象，并允许后续求值直接消费该
对象，会提高跨轮、跨 Session 的状态驱动行动正确率，尤其是在存在修订、来源冲突和
干扰信息时。

这个假设可以被反驳：若 `full_morphz` 与只保留文本结果或消息历史的组没有稳定差异，
则论文不得声称直接回流提高了行动正确性，只能保留“该机制已经实现且可运行”的能力
主张。

### 次要假设

- H2：结构化但只读的 Context 相比按时间追加的完整消息，能够降低陈旧事实复用和来源
  混淆；
- H3：`full_morphz` 在进程重启或切换 Session 后，仍能从真实持久化 Context 恢复当前
  权威状态；
- H4：不同 Context 中的认知对象不会发生负迁移或串扰。

### 本实验不回答

- 不证明 S-Expression 一定优于 JSON、Markdown 或其他表面语法；该问题属于 ME-02；
- 不证明 Morphz 更省 Token、更快或在通用编码 Benchmark 上更强；Token、延迟只作诊断；
- 不测试 Program-valued `infer` 或未来的任意动态交替求值；
- 不以官方 Codex、Terminal-Bench 或公开排行榜成绩替代机制消融；
- Pilot 只校准任务、实现、难度和成本，不进入论文的最终显著性结论。

## 2. 实验单位与任务族

一个 episode 由同一 fixture 的三个阶段组成：

1. `establish`：输入早期事实、来源和对象标识，不要求最终行动；
2. `revise`：输入更新、冲突、干扰或反例；
3. `act`：在同一 Session 或另一个 Session 中要求唯一的结构化行动。

最终输出合同固定为严格 JSON：

```json
{
  "action": "<action-name>",
  "object_id": "<stable-object-id>",
  "value": "<selected-current-value>",
  "evidence_id": "<authoritative-evidence-id>"
}
```

每个可见 fixture 同时公开唯一的 `required_action` 字符串；隐藏评分文件不得要求模型猜测
未在输入中定义的动作名称。隐藏文件只保存预期对象、值、证据及用于判错的元数据。

主要 fixture 内容和 hidden expected answer 分文件保存。模型可见输入包含完成判断所需的
全部语义信息；hidden 文件只保存预期行动和评分元数据，不向模型投影。

任务族：

1. `delayed_reference`：早期对象经过若干干扰后用于最终行动；
2. `supersession_conflict`：新证据明确取代旧事实，最终不得复用陈旧值；
3. `source_authority`：较新的未批准材料与较早的权威材料冲突，不能把时间顺序当真值；
4. `cross_session_continuity`：Session A 形成状态，Session B 在同一 Context 中使用；
5. `context_isolation`：两个 Context 含相似对象，最终行动不得继承另一个 Context 的值。

每个可见事件在三组中都保留相同的 `event_id`、`source`、`session`、`version`、时间和
正文。`append_only` 也能看到这些字段，避免通过删除信息制造稻草人基线。三组之间只
改变状态表示和结果回流方式。

## 3. 三个核心 Arms

| Arm | 状态机制 | 结果如何进入下一阶段 | 实现边界 |
| --- | --- | --- | --- |
| `append_only` | 完整、按时间排序的共享消息记录；不截断、不摘要 | 先前 assistant 输出作为普通消息继续追加 | 独立的最小消息 runner，直连同一 Provider；保留 Session 标签和全部证据字段 |
| `structured_no_direct_reentry` | 生产 Morphz 的真实结构化 Observation/Context；Context 对模型只读 | 先前输出仅作为 Event/Observation 文本重新解释，不允许提交 Frame/Relation | 使用生产 Morphz 二进制、真实 SQLite 和 ContextEngine；由 Runtime 级 capability policy 隐藏并拒绝 `context_tx`，不得仅用提示词要求模型不要调用 |
| `full_morphz` | 生产 Morphz 的真实结构化 Observation、Frame、Relation、版本与 Context 事务 | 结果通过真实 `context_tx` 提交为带来源的 Frame/Relation，后续阶段直接投影并消费 | 使用同一生产二进制路径、真实 SQLite、真实 `context_tx`、多 Session 挂载和进程重启恢复 |

### 3.1 主要比较

- `structured_no_direct_reentry` vs `full_morphz`：主要因果比较，估计“事务化结果直接
  回流”的贡献；
- `append_only` vs `full_morphz`：完整架构比较；
- `append_only` vs `structured_no_direct_reentry`：探索结构化输入本身的贡献。

`append_only` 必然使用不同的承载适配器，因此第三项和完整架构比较不能被描述成只改变
一个函数开关。论文必须披露这一点。最接近单变量消融的是两个生产 Morphz arm 之间的
比较。

### 3.2 生产实现真实性 Gate

`full_morphz` 的 episode 只有同时满足以下条件才可标记为实现有效：

- 启动冻结 commit 构建的生产 Morphz 二进制，而不是 fake client；
- 每个 episode 使用独立可写数据库和新的 Context identity；
- Event History 中存在由模型调用产生的 `context_tx` 尝试和成功提交；
- `chat/context_tx_committed`、Frame 版本、来源引用和阶段因果链可从 SQLite 重建；
- 跨 Session fixture 的两个 Session 实际挂载同一 Context；
- 重启 fixture 在同一数据库上停止并重新启动 Runtime，不能把状态复制进新 prompt；
- 最终行动所用对象确实存在于 act 阶段的 Context 投影。

任何仅把 `context_transaction_committed=true` 写进 fixture JSON、本地内存对象或模拟 trace
的实现均不满足本 Gate，不能作为 Morphz 实验结果。

`structured_no_direct_reentry` 同样必须使用生产 ContextEngine 和 SQLite，但其
`context_tx` 工具定义必须不可见，Runtime 也必须拒绝伪造调用；Event History 中成功
Context 提交必须为 0。该能力差异由运行时配置和产物审计证明，而不是由模型自述证明。

## 4. 控制变量与提示纪律

固定：

- 主模型：精确物理模型 `gpt-5.6-sol`；reasoning effort=`max`；fallback=`false`；
- Provider：CLIProxyAPI 兼容 OpenAI Responses route；运行前校验物理模型；
- 权限：隔离节点 `full-access`；fixture 不依赖网络或人工审批；
- 每个 fixture 的语义事实、对象 ID、版本、来源、阶段顺序和最终合同；
- 最终输出预算、每阶段最大物理模型请求数、总 wall-clock 限制和评分器；
- 每个 arm/run 的独立数据库、Context、Session 集合、workspace 和 artifact root；
- 不挂载产品 Context、历史 Session 或个人开发状态。

共同任务指令只描述目标、证据语义和输出合同，不解释某个 arm 的内部实现，也不命令
模型必须反复读、必须收口或必须采用特定思维步骤。每个系统只可说明它真实拥有的状态
能力。不得使用针对某一道题的 Harness 或在运行中修改 prompt。

Pilot 不制造 Context 长度压力。`append_only` 在同一 episode 中保留完整历史，防止把
窗口截断误当作结构化状态的效果。容量和 Token 经济性另立实验。

## 5. 指标

### 主要指标

`strict_hidden_action_success`：最终回复能被严格 JSON parser 接受，且 `action`、
`object_id`、`value`、`evidence_id` 四字段与 hidden expected answer 完全一致。

这是二元、确定性指标，不使用 LLM judge。多余字段、缺字段、非法 JSON、多个候选行动、
陈旧值或错误来源均计失败。

### 次要指标

- `current_value_success`：`value` 是否为当前权威值；
- `stale_value_reused`：是否选择被明确取代的值；
- `authority_success`：是否引用正确权威来源；
- `cross_session_success`：跨 Session 行动是否正确；
- `context_isolation_success`：是否没有引用另一个 Context 的对象或值；
- `mechanism_adopted`：full arm 是否产生合规的真实 Context 提交；
- `restart_recovery_success`：重启后是否无需复制旧文本即可恢复；
- 输入、输出、cached Token、物理模型调用数、wall-clock 和成本。

### 诊断指标

- Context version、Frame revision、source refs、Session mount 和阶段因果链；
- 模型空响应、非法 JSON、工具参数错误、Context 事务拒绝、版本冲突；
- Provider、Runtime、runner、scorer 故障分层；
- act 阶段实际投影的 Context hash 和消息历史 hash。

Token 指标同时保存 Provider 原始 usage 和按冻结 tokenizer 对完整实际请求重算的
uncached-equivalent 值；缓存折扣不得被用来宣称架构更省 Token。

## 6. Pilot 样本、顺序与停止规则

为控制成本，Pilot 分两级：

### Stage A：最小配对 Pilot

- 每任务族 1 个 fixture；5 个 paired cells；
- 3 arms × 5 fixtures = 15 episodes；
- 每个 episode 只运行一次，不把重复采样当作统计估计；
- 三组按预生成的交错队列运行，不能先跑完一组再跑下一组；
- 在真实批次前，每 arm 只用 1 个 fixture 做 smoke；smoke 与 Pilot 数据隔离。

### Stage B：难度扩展

仅当 Stage A 的 runner、评分器和任务难度通过 Gate 时，再增加每族第 2 个独立 fixture，
新增 15 episodes。若出现全组 100% 的天花板、全组接近 0 的地板、信息不等价或实现
Gate 失败，应先修改协议并更换 Run ID，不得用原数据拼接。

Pilot 不直接采用“每 arm × 每任务族 20 个 episode”的原规划。确认性样本量必须根据
Stage A/B 的配对差异、失败类型、调用成本和置信区间宽度重新确定；若差异不足以稳定
估计，优先增加不同 fixture，而不是对相同题机械重复五遍。

### 停止条件

- 任一 Morphz arm 未使用生产 Runtime/真实数据库：立即停止；
- arm 间可见语义信息不一致：立即停止；
- hidden expected answer 泄漏进 prompt、Context 或文件工具可读范围：立即停止；
- scorer 无法从原始产物确定性重放：立即停止；
- 第一组真实 smoke 发现模型/Provider binding 不是精确 Sol/max/no-fallback：立即停止；
- Provider 额度耗尽或明确服务故障：停止队列，保留失败 receipt，不切换模型。

## 7. 排除、失败与补跑规则

| 情况 | 分类 | 计入任务结果 | 是否允许 replacement |
| --- | --- | --- | --- |
| Provider 明确 5xx、连接失败或订阅端在请求前拒绝 | service failure | 否 | 按相同 paired cell、相同配置在队尾补 1 次，并保留原失败 |
| Provider safety/cyber policy 拒绝 | provider policy outcome | 是，计失败 | 否；本 fixture 不应涉及敏感操作 |
| 模型空响应、非法 JSON、错误值或错误来源 | model outcome | 是 | 否 |
| Context 事务非法、版本冲突后未恢复、达到调用预算 | model/runtime outcome | 是 | 否 |
| Runner 崩溃、数据库未隔离、模型绑定审计缺失 | harness failure | 否 | 修复并提升协议/runner 版本后整组重跑 |
| Scorer bug | scorer failure | 暂不计 | 修复后对原始不可变产物重评分；若原始信息不足则整组重跑 |

不得因“模型本来会做”“换个说法可能成功”或某组成绩难看而删除 trial。

## 8. 配置与预算

| 字段 | Candidate 值 |
| --- | --- |
| requested / physical model | `gpt-5.6-sol` / 运行前实测 |
| reasoning effort | `max` |
| Provider/API | CLIProxyAPI / OpenAI Responses compatible |
| fallback | `false` |
| sampling seed | 仅在 Provider 确认接受并执行时记录；否则 `sampling_seed_applied=false` |
| 输出上限 | 每次物理请求 4,096 tokens（冻结前以 smoke 校准） |
| 活动 Context 上限 | 128 Ki tokens 级，Pilot 不施加长度压力 |
| 每阶段物理请求上限 | 4；超过计 outcome，不自动追加 |
| 单 episode wall-clock | 20 分钟；仅防失控，不作为模型思考指导 |
| 并发 | smoke=1；Pilot candidate=3，必须保证 Provider 与数据库隔离 |

## 9. 产物与复现

每个 suite 必须保存：

- `suite_manifest.json`：协议、代码、模型、Provider、节点与队列身份；
- `fixture_manifest.json` 与独立的 hidden expected 文件 hash；
- 每 episode 的可见输入、原始请求/响应、usage、错误 receipt；
- Morphz arm 的 SQLite 数据库副本或可验证导出、Event History、Context snapshots、
  Frame/Relation/version/source refs 和 Session mount；
- append-only arm 的逐条 message transcript 与 hash；
- `observed_episode.json`、`score.json`、`checksums.sha256`；
- `summary.json`、配对明细和错误分类；
- 从不可变原始产物重新评分的命令与一致性证明；
- 运行前后 Git status、Runtime commit、runner/scorer commit 和 dirty diff hash。

原始产物只追加，不覆盖失败 trial。仓库只提交脱敏后的 manifest、结果表、评分输出、
checksums 和代表性 trace；含凭据或超大原始数据保留在独立 artifact root，并记录备份位置。

## 10. 无模型与真实模型 Gate

真实模型 smoke 前必须全部完成：

- [x] 三个 arm 的 adapter 都能生成同一 fixture 的可见输入审计；
- [x] `full_morphz` fake-provider contract test 通过真实 Context commit 与下游投影链；
- [x] `structured_no_direct_reentry` 在 Runtime 层隐藏并拒绝 `context_tx`，成功提交为 0；
- [x] `append_only` 完整保留消息、事件字段和 Session 标签；
- [x] hidden answer 不位于模型或文件工具可访问目录；
- [x] 正例、陈旧值、错误来源、串 Context、非法 JSON 均由 scorer 正确区分；
- [x] 三组各自数据库、Context、workspace 和 artifact 互不复用；
- [x] 从原始产物重评分得到逐字节一致的 score；
- [x] 确认实际 Runtime commit，且工作区状态已记录；
- [x] 精确模型、reasoning、fallback 与权限预检通过。

Pilot 后审查：

- [x] 已检查天花板/地板：15/15 全部通过，存在明确天花板；
- [x] 主要指标无需主观 judge；
- [x] 两个 Morphz arms 除 capability policy 外使用同一生产路径；
- [x] full arm 的成功行动存在可追溯的直接回流因果链；
- [x] 失败分类可复核，跨 Session 首次接线假阳性已保留并永久排除；
- [ ] 不直接冻结同类确认性扩样；先修订论文主张，再决定 p2 是否仍有必要。

## 11. 协议版本记录

| 版本 | 日期 | 修改 | 是否使旧结果失效 |
| --- | --- | --- | --- |
| p1 candidate | 2026-08-25 | 初始三 arm、五任务族、两级低成本 Pilot 与真实性 Gate | — |
| p1.1 candidate | 2026-08-25 | 将精确动作词表移入可见 fixture，修复隐藏字符串评分缺陷 | 是；p1 真实 smoke 不可计分 |
| p1.1 runner fix | 2026-08-25 | 按 fixture 路由真实 Session/Context，并要求挂载集合完整匹配 | 仅使错误硬编码的跨 Session 首次运行无效；其他既有 cell 不受影响 |
