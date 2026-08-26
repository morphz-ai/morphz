# ME-07 STATE-Bench 强记忆系统对照协议 v1

> 状态：`protocol-frozen / no-model-adapter-gate-complete / locked-eval-access-gated`
>
> 协议 ID：`ME-07-STATE-Bench-strong-memory-v1`
>
> 冻结日期：2026-08-26

## 1. 研究问题

在推理模型、训练轨迹、held-out 任务、工具、检索上限和评分器相同的条件下，Morphz
Structured Context / Mind Frames 能否比另外两种强记忆方法更可靠地把历史任务经验转化为
后续企业工具行动？

本实验不再设置无记忆组。无记忆与有记忆的对照只能说明历史经验有用，不能区分 Morphz 与
普通记忆系统，因而不值得消耗一整个正式 arm。STATE-Bench 已公开的 no-memory 行只可作为
背景引用，不进入本项目的配对统计。

## 2. 三个正式 arms

| arm | 学习表示与更新 | held-out 检索 | 实现边界 |
| --- | --- | --- | --- |
| `morphz` | 生产 Morphz Context、带来源与关系的 Mind Frames、真实 Context transaction | 生产 Recall index 中的未退休 Frame | 冻结学习 SQLite；每个 task 使用只读源的独立克隆 |
| `amem` | A-MEM 风格动态 Note、元数据、连接与 memory evolution | 固定 embedding 检索，返回至多 3 条 Note | 使用 MemGym 中可序列化的 A-MEM-compatible 实现，并明确不冒充 agiresearch 原包 |
| `mem0` | Mem0 add-time 抽取、更新/冲突处理与持久化向量索引 | Mem0 OSS `search(top_k=3)` | 精确固定 Mem0 v2.0.19 与领域 namespace |

三组都读取完全相同的 300 条官方 train trajectories；每条轨迹经过同一个确定性 canonical
serializer，保留 user/assistant 文本、工具名、参数和工具结果。任何 held-out task 定义、环境
或答案均不得进入学习构建过程。

## 3. 冻结版本

- STATE-Bench：`5644b1838d96bc4483da29642d058ecaa6f80f7f`，v0.8.1，MIT；
- MemGym A-MEM-compatible implementation：
  `50b404e6ae4e1fcd453d3e07963eb3e6312cbded`，MIT；
- A-MEM 原始参考实现：`ceffb860f0712bbae97b184d440df62bc910ca8d`，v0.0.1，MIT；
- Mem0：tag `v2.0.19`，commit
  `dc82354e143c2581d505d581a00286d6ef8c3605`，Apache-2.0；
- `sentence-transformers/all-MiniLM-L6-v2`：revision
  `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`，384 dimensions。

机器可读真值见 [`../../../benchmarks/state_bench/protocol_lock.json`](../../../benchmarks/state_bench/protocol_lock.json)。

## 4. 共同 Agent 与检索合同

- 三组 reasoning Agent 均为 `gpt-5.6-sol`、reasoning `max`、CLIProxyAPI Responses、
  `fallback=false`；
- 三组使用同一个 custom `BaseAgent`，STATE-Bench 负责执行和记录正式 domain tools；
- 三组只更换 memory backend；系统提示、任务 transcript、领域工具和工具循环保持相同；
- 首次实质回答前调用只读 `retrieve_learnings(query, top_k=3)`；Runtime 无论模型请求多大
  `top_k` 都强制使用 3；
- 返回值统一为 `list[str]`，不向 Agent 暴露某组专有 API；
- 每个 task 构造全新 Agent 实例，不共享 task-local conversation 或 provider response state；
- memory ingestion、更新、embedding、索引、检索的模型调用、Token 与时间都属于被测方法成本，
  不得以“离线”为由隐藏。

## 5. 官方评测边界

STATE-Bench Agent Learning Track 的 user simulator、task-requirements judge 和 UX judge 必须
使用协议锁定的 Azure OpenAI GPT-5.4 evaluation client。不得以 CLIProxyAPI、Qwen、Gemini、
GPT-5.6 或其他方便线路替换。

正式规模：3 domains × 50 held-out tasks × 5 runs = 750 trials/arm，三组共 2,250 trials。
正式主指标为官方 pass@1；主要配对差为 Morphz−A-MEM 和 Morphz−Mem0。重复 run 按 task
聚类；区间与检验以 task 为重采样/置换单位，两个主要比较使用预声明 Holm 校正。

只有锁定 GPT-5.4 Azure client 通过精确绑定后才允许真实 smoke。此前的 adapter Gate 不得被
写成效果结果；也不得用可获得的替代 evaluator 生成“近似官方”分数。

## 6. Morphz 学习快照的只读性

Morphz 领域学习 Context 在 100 条训练轨迹处理完毕后执行 checkpoint、Recall index 审计和
Context audit，并冻结二进制、配置、SQLite 与内容哈希。正式 task 不直接打开源快照，而是：

1. 核对源快照、生产二进制和配置哈希；
2. 拒绝仍有 WAL/SHM 的未 checkpoint 快照；
3. 为当前 task 创建独立 SQLite 克隆；
4. 在克隆上执行 `context recall search`，只返回未退休 Frame；
5. 每次检索后重新核对源快照哈希。

因此 held-out task 可以使用生产 Recall 路径，但不能污染共享学习 Context。

## 7. 预注册 Gate 与停止规则

真实模型调用前必须全部通过：

1. upstream commit、数据数量、canonical digest 和许可证固定；
2. custom Agent/client 能被官方 extension loader 发现；
3. 三臂正式集合精确等于 Morphz/A-MEM/Mem0；
4. retrieval 工具往返、`top_k=3` 强制、只读快照和 test 泄漏负例通过；
5. 三种学习 artifact 的构建、冻结、重新加载和最小检索测试通过；
6. Agent route/physical model/max/no-fallback 精确绑定；
7. Azure GPT-5.4 simulator/judge 精确绑定；
8. 同一 held-out task 三臂各一次 smoke 完整评分。

任何 Gate 失败均保留原始产物，不得换模型、删题、静默重试或只挑成功 arm。正式运行中
Provider、模型、adapter 和评分失败均保留；官方 scorer 是主分数真值，事后诊断不能覆盖。

## 8. 当前状态

无模型 Gate 已通过：7 项单元测试和 7 项端到端 Gate 均成功，覆盖官方 commit、三个领域各
100 条训练轨迹、canonical digests、extension discovery、memory tool 往返、固定 top-k 和
无记忆 arm 排除。该阶段模型调用为 0。

尚未完成的实质门槛是：构建三个真实学习 artifact、取得锁定 Azure GPT-5.4 eval client、
完成三臂真实 smoke 和正式批次。因此目前只能声称协议与 adapter 合同闭环，不能报告 ME-07
效果结论。
