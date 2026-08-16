# Morphz 多 Objective 并发协调基准：阶段结果

> 日期：2026-07-20 至 2026-07-21
>
> 模型：Qwen `qwen3.8-max-preview`
>
> 协议：OpenAI Responses compatible
>
> 场景：ForgeDepot v1

> 后续状态（2026-07-22）：本文记录的 `context_tx` 已提交但最终回复未交付问题，已在后续 Runtime 中加入持久 Assistant decision 恢复逻辑和确定性回归测试；尚未按本文相同模型、HTTP 探针和故障窗口完成至少三次真实复跑，因此历史结果仍保留为失败，不追溯改分。

## 1. 结论先行

本轮已经证明 Morphz 的同 Session 多 Objective 主链路可以真实工作，而不只是产生多条看似并发的工具调用：

1. 明确要求使用 First-Class Objective 后，模型两次都自主拆出了 3 个兄弟 Objective；它们在 51 毫秒内全部开始求值，峰值并发为 3。
2. Runtime 在三个 Objective 仍活跃时被强制终止；lease 到期后三个 Objective 均恢复，最终全部 completed，没有重复交付或遗留 Activation。
3. 最新一轮的有效并行度为 2.69。隐藏验证 7/7 通过，生成项目自身 86 个测试全部通过。
4. 运行中状态询问能够独立得到基于 Event History 的准确回复，不会停止正在工作的 Objective。
5. 运行中追加的跨模块 yank 规则被写入受保护 Mind Frame，并最终同时体现在 resolver、install、registry、search 及测试中。

但本轮也发现两个不能被总分掩盖的问题：

- 三个 Objective 都尝试修改 `src/semver.rs`。文件 SHA 版本保护拒绝了其中一次陈旧写入，保证了物理正确性，但模型没有维持理想的文件所有权边界。
- 故障注入发生在跨模块规则完成 `context_tx` 之后、准备回复用户之前。语义维护与最终实现成功，但该 Dialogue Turn 在重启后没有恢复最终回复。因此最新一轮是“产品成功 + 结构调度成功 + 在线消息恢复失败”，不应笼统标成全部成功。

## 2. 三次实跑

三次运行使用相同模型、Provider、ForgeDepot 规格、隐藏验证器、Context 预算和物理工具。

- `autonomous`：只要求自行识别可并行工作，不提 Objective；
- `objective_guided-v1`：明确要求使用 First-Class Objective，但使用旧版 stdin 探针；
- `objective_guided-http`：使用正式 HTTP 消息入口注入在线探针，并在活跃期间重启 Runtime。

| 指标 | autonomous | objective_guided-v1 | objective_guided-http |
| --- | ---: | ---: | ---: |
| 产品隐藏验证 | 7/7 | 7/7 | 7/7 |
| 项目自身测试 | 通过 | 68 项通过 | 86 项通过 |
| Objective 数 / 完成数 | 0 / 0 | 3 / 3 | 3 / 3 |
| 峰值并发 Evaluation | 0 | 3 | 3 |
| Objective 启动扩散 | 不适用 | 44.6 ms | 50.7 ms |
| 有效并行度 | 0 | 1.53 | 2.69 |
| Runtime 重启恢复 | 未执行 | 成功 | 成功 |
| 在线探针应答 | 未执行 | 旧入口，无效 | 1 / 2 |
| Model Attempt | 25 | 55 | 81 |
| 物理工具调用 | 40 | 85 | 105 |
| Objective token 事件历史累计 | 不适用 | 4,292,028 | 5,132,165 |
| 失败工具结果 | 0 | 2 | 3 |
| Context 版本冲突 | 0 | 2，重试收敛 | 0 |
| 跨 Objective 文件重叠 | 不适用 | 旧轨迹无法归因 | `src/semver.rs`，3 个 Objective |
| 墙钟时间 | 926.10 s | 2712.06 s | 1529.77 s |
| 产品成功 | 是 | 是 | 是 |
| 结构调度成功 | 否 | 是 | 是 |
| 完整协调成功 | 否 | 是（无有效探针） | 否（缺 1 次回复） |

`effective_parallelism` 定义为所有 Evaluation 活跃时长之和除以墙钟时间。最新一轮为 `4113.27 / 1529.77 = 2.69`，说明三路工作大部分时间确实重叠，而不是只在创建瞬间并发。

原始、可机器读取的摘要保存在 [`benchmarks/results/forgedepot_qwen_20260720.json`](../benchmarks/results/forgedepot_qwen_20260720.json)。运行目录只保留在本地临时目录，报告不包含 Provider 凭证。

## 3. 自主采用机制的边界

自主组完成了完整产品，却创建了 0 个 Objective，并以一次没有最终回复的失败 Activation 收尾。这说明：

- 模型本身具备完成任务的能力；
- Runtime 的 Objective 机制可用；
- 但仅告诉模型“自行并行实施”，不足以让它稳定选择 First-Class Objective。

现阶段应把 Objective 作为明确可见、语义清楚的核心能力，并继续优化模型对其适用条件的认识；不能因为底层已经支持，就假设模型一定会自然采用。

## 4. 最新 HTTP 探针运行的轨迹

模型先建立架构和计划 Frame，然后自主创建：

1. Utility：SHA-256、SemVer、TOML、JSON；
2. Core：Registry、Resolver、Install；
3. Interface：Search、HTTP Server、CLI、README 与集成。

三路第一轮 Evaluation 在约 51 毫秒内启动。运行中发送状态询问，模型准确列出 3 个 active Objective、各自范围和执行状态，并明确区分：

- 已经存在的脚手架与 Mind 契约；
- 尚未在 Event History 中出现的文件、构建和测试证据。

这条回答没有接管或停止兄弟 Objective，证明 Dialogue Turn 与 Objective Evaluation 可以在同一 Session 中并行。

随后发送跨模块 yank 规则。模型没有直接操作各 Objective，而是创建并保护 `yank-semantics` Frame，明确写出：

- 新的 resolve 必须过滤 yanked 版本；
- 旧 lockfile 仍可安装被 yank 的版本；
- yank 只改元数据，不删除 blob；
- search 仍显示 yanked 包；
- 四类必要回归测试。

最终 86 项测试包含这些语义，隐藏功能契约也通过。因此共享认知的传播是有效的。

## 5. 重启恢复与遗漏回复

故障注入在三个 Objective 和跨模块 Dialogue Turn 都活跃时发生。Objective 恢复路径表现正确：

- 首轮 Evaluation 在 lease 到期时被 fencing；
- 新 Evaluation 接管三个 Objective；
- 已提交的 Workspace 和 Mind 状态继续可见；
- 三个 Objective 最终全部完成。

但跨模块 Dialogue Turn 的轨迹是：

```text
user message
  -> context_tx 成功，Mind revision 1 -> 2
  -> tool-output continuation 开始 streaming
  -> Runtime 被终止
  -> Activation 后来被标记 completed
  -> 没有 chat/reply
```

这不是模型没有理解规则，也不是 `context_tx` 失败，而是**普通 Dialogue Turn 的进程重启恢复仍不完整**。评测器现在把每个有效 HTTP Probe 都要求至少出现一个同 `root_turn_id` 的 `chat/reply`；因此本轮：

- `structural_coordination_success = true`；
- `probe_reply_success = false`；
- `coordination_success = false`。

后续 Runtime 修复应让“已完成工具结果、尚未最终回复”的 Dialogue Turn 在重启后重新排队，或明确产生可审计的终止结果，不能只把 Activation 投影改成 completed。

## 6. 文件竞争与协调质量

最新评测器按 Objective 因果链追踪 `write/edit`。可归因的 10 次文件写入中，`src/semver.rs` 被三个 Objective 各修改一次。

其中 Core Objective 基于旧 SHA 提交 edit 时被拒绝：Runtime 返回当前 SHA，要求重新读取。这说明现有防线有效：

- 不会静默覆盖新版本；
- 冲突对模型可见；
- Objective 能继续读取、验证并收敛。

但这仍是效率损耗。下一步应优先让模型利用共享 Frame 和可见的兄弟进度形成文件所有权纪律，而不是在 Runtime 中加入 ForgeDepot 特化规则。

第一轮引导运行还留下过错误的 `forgedepot-blob-contract` Frame：最终代码通过读取真实 writer 修正，Frame 却没有 revise。这进一步说明报告必须区分：

1. `project_success`：最终产品是否正确；
2. `structural_coordination_success`：Objective/Evaluation/Activation 是否正确调度与恢复；
3. `probe_reply_success`：并发对话是否完整交付；
4. 语义协调：共享 Frame、最新事实与 Workspace 是否一致。

## 7. 公开基准接入状态

### Harbor / Terminal-Bench

ForgeDepot 已提供 Harbor Task schema、Morphz custom agent、容器环境、Oracle solution 和隐藏 verifier：

- 官方 Task schema 可解析；
- Oracle 通过全部 7 项隐藏检查；
- Morphz adapter 保留 Runtime 数据库和日志，并等待权威 Objective/Activation 终态；
- 当前机器没有可用 Docker daemon，因此完整 Harbor 容器 trial 尚未运行，不能声称已有官方可比成绩。

### π-Bench

第一层 bridge 已实现：

- persona 映射为稳定 Principal 和该 persona 专属共享 Context/Mind；
- task 映射为 Session；
- 同 persona 跨 task 共享认知，不同 persona 隔离；
- 不可变 Event History 被转换为官方 trace parser 可读取的 `turn_*.json`。

bridge 单元测试和官方 trace parser 兼容性已验证。完整 PROC/COMP 仍依赖 AppWorld MCP 后端，尚未获得官方分数。

## 8. 当前判断与下一步

这轮结果足以支持“方向正确、进入优化阶段”，但还不足以支持稳定性或行业领先的统计结论。下一步优先级是：

1. 修复进程重启时未完成 Dialogue Turn 的恢复与交付；
2. 为共享 Frame 与 Workspace 的语义一致性建立通用评测指标；
3. 同一模型重复至少 3 次，报告成功率与方差；
4. 在 Docker/Linux 环境完成 Harbor trial；
5. 接入 AppWorld MCP 后运行 π-Bench single task、single persona episode 和官方多次协议。
