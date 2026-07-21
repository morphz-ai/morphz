# Morphz 多 Objective 并发协调基准 v1

> 状态：评测器、公开基准适配和三次 Qwen 实跑已完成；完整 Harbor 与 π-Bench 官方分数受本机外部执行环境限制
>
> 目标：验证同一个 Agent 在同一个 Session 中自主建立多个兄弟 Objective 后，能否在共享 Context/Mind、共享 Workspace 和 Runtime 因果状态下并发完成一个复杂工程项目，并量化相互感知带来的协调收益与代价。

## 1. 评测对象

本基准不把“同时发出了多个模型请求”视为成功。它评价的是完整闭环：

1. Agent 是否识别出真正可以并行的工作；
2. 是否为长期模块建立多个 First-Class Objective，而不是用若干互不相关的物理工具调用伪装并发；
3. 兄弟 Objective 是否通过共享 Mind、Objective 状态、`concurrent-activations` 和 Workspace 事实感知彼此；
4. 是否能遵守依赖顺序、避免重复实现和覆盖彼此修改；
5. 是否能在需求变更、局部失败和 Runtime 重启后继续收敛；
6. 最终是否形成一个由隐藏测试验证的完整产品。

模型决定任务如何拆分以及何时并行。Runtime 只提供 Objective、Activation、并发准入、Context transaction 和持久恢复机制，不替模型编写业务计划。

## 2. 项目夹具：ForgeDepot

ForgeDepot 是一个完全离线、可程序化验收的本地软件包注册表。目标实现使用 Rust workspace，最终提供一个 `forgedepot` 二进制。

项目包含以下天然可并行、但在接口上相互依赖的能力：

- 包清单、领域模型和稳定错误协议；
- SemVer 依赖解析与确定性 lockfile；
- 内容寻址 Blob 存储和完整性校验；
- 事务性元数据、幂等发布和并发写入；
- HTTP Registry API；
- `publish / resolve / install / search / yank / serve` CLI；
- 取消、失败恢复和结构化审计日志；
- 单元、集成和端到端测试。

这不是八个孤立小题。领域类型、存储事务、解析语义、CLI 和 HTTP 必须共享同一套稳定契约；盲目并发会造成重复类型、互相覆盖和集成失败。

## 3. Agent 可见任务与实验组

Agent 只会收到自然产品要求和 Workspace 中的公开 `PROJECT_SPEC.md`：

- 自主分析模块边界；
- 对可独立推进的长期工作主动并发；
- 避免多个执行线无协调地修改同一公共契约；
- 在公共接口稳定后完成集成；
- 运行自己能够看到的测试并交付结果。

提示不会指定 Objective 数量、Frame schema、文件分工，也不会提醒“不要幻觉”或透露隐藏测试。

为了把“模型是否自然采用机制”和“机制本身是否有效”分开，固定两个实验组：

- `autonomous`：只要求自行识别可并行部分，不提 Objective；未使用多 Objective 是有效观测，不等同于项目实现失败；
- `objective_guided`：明确要求使用 Runtime 的 First-Class Objective，但不指定数量、边界、依赖或文件归属。若这一组仍不创建 Objective，说明仅有机制可见性和自然语言要求还不足以完成调度路由。

两组共享项目规格、模型、Provider、Context 预算、物理工具、隐藏验证器和 Runtime commit。

## 4. Runtime 配置

首轮使用 Qwen，Context 预算保持代码 Agent 的正常规模：

```toml
[orchestrator]
model_provider_max_in_flight = 8
context_soft_token_limit = 196608
context_hard_token_limit = 262144
context_maintenance_reserve_tokens = 32768

[orchestrator.activation_admission]
max_in_flight = 16
```

Workspace、SQLite、Artifact、Morphz Home 和日志均使用独立运行目录。Agent 不能读取隐藏验证器，也不能修改 Morphz 源码。

## 5. 阶段与扰动

### 5.1 初始并发构建

向一个 Session 提交完整项目目标。允许当前 Evaluation 创建多个兄弟 Objective；Runtime 应让它们拥有独立 Activation 并并发进入模型。

### 5.2 运行中状态询问

模块执行期间，向同一个 Session 询问整体进度。该 Dialogue Turn 应从 Runtime 权威状态和已提交事实回答，不应接管兄弟 Objective，也不应重复它们的工具调用。

### 5.3 跨模块规则变更

在已有模块并行推进后追加一条自然需求：被 yank 的版本不能参与新的解析，但已有 lockfile 仍可安装。它同时影响解析、存储、CLI、HTTP 和测试，用于观察共享认知能否让多个 Objective 对新规则形成一致理解。

### 5.4 失败与恢复

保留一次真实测试失败，不向 Agent 提供答案。运行中重启 Morphz，验证 Objective、Evaluation lease、Thread mailbox、Mind 和 Workspace 能否恢复且不重复执行已完成工作。

### 5.5 集成与交付

所有模块终结后运行隐藏验证器。最终报告必须区分：已完成、失败、未验证和阻塞项；不能把兄弟 Objective 的启动或局部通过当成产品完成。

## 6. 机械评分

### 6.1 Outcome

- Rust workspace 可构建；
- 公开测试与隐藏测试结果；
- CLI 端到端发布、解析、安装和 yank 语义；
- 内容哈希损坏能被拒绝；
- 并发重复发布保持幂等；
- 重启后元数据和 lockfile 行为一致；
- HTTP 健康检查和基本资源接口可用。

### 6.2 Concurrency

- 创建的 Objective 数量；
- Objective Evaluation 的开始/结束区间；
- 峰值并发 Evaluation 和峰值 Provider 请求；
- `sum(active_duration) / wall_clock_duration` 有效并行度；
- 首个兄弟 Objective 到最后一个兄弟 Objective 的启动扩散时间；
- 队列等待、Provider 等待和 Context transaction 等待。

### 6.3 Coordination

- 兄弟 Objective 是否引用已提交的公共接口或共享 Mind 事实；
- 同一文件的重叠写入和覆盖次数；
- 重复定义、重复工具调用和重复实现；
- 跨模块规则变更后的契约一致率；
- 依赖未满足时是否提前宣称完成；
- Context version 冲突、重试和最终收敛；
- 是否错误接管其他 Objective 的动作。
- 每个通过正式入口提交的在线 Probe 是否产生同 `root_turn_id` 的最终回复；
- 进程重启是否能恢复“工具结果已提交、最终回复尚未交付”的 Dialogue Turn；

### 6.4 Recovery 与 Cost

- Runtime 重启后 Objective 恢复；
- 重复 Activation / 重复交付；
- 模型请求、Prompt/Completion Token、工具调用和 Context transaction；
- 墙钟时间、CPU、峰值内存和 SQLite 增长。

所有率类指标同时报告分子和分母。单次运行只能作为工程诊断；稳定结论至少需要多个同模型重复样本或配对对照。

## 7. 因果报告

评测输出不能只有一个总分。报告需重建：

```text
Objective
  -> Objective Evaluation
  -> Thread Activation
  -> Model Attempt
  -> Tool Call / Action Group
  -> File or Database Effect
  -> Context Transaction
  -> Dependency Release
  -> Delivery
```

这样可以区分“模型碰巧写对了代码”“Runtime 真正产生了并发”和“并发执行线确实协调完成”三件不同的事。

## 8. 对照与外部基准

v1 先建立单 Session 多 Objective 的真实轨迹。后续使用相同项目增加：

1. 单 Objective 串行基线；
2. 同 Context、多 Session 并发；
3. 独立 Context、只共享 Workspace 的隔离对照。

ForgeDepot 同时封装为 Harbor/Terminal-Bench Challenge 兼容任务。公开基准接入顺序为：

1. Terminal-Bench 2：终端长程执行和程序验证；
2. π-Bench：持久 Workspace、跨 Session 依赖和主动性；
3. ProjDevBench：完整项目构建；
4. τ-Bench：多轮用户、政策与工具交互；
5. SWE-bench / SWE-Lancer：行业可比的代码修复和经济任务锚点。

公开报告必须把成绩标记为 `Morphz + model` 组合，不把模型能力误报为 Runtime 能力。相同模型对照应固定工具、预算、重复次数和评分器，并公开失败轨迹。

## 9. 已实现入口

Runtime 因果评测器位于 `morphz-evals::concurrent_objective_eval`，每次运行创建相互隔离的 Workspace、SQLite、Artifact、Morphz Home、日志、Manifest 和隐藏验证器，并输出 `run_report.json`。报告把产品结果和调度结果拆成两个结论：

- `project_success`：隐藏验证器是否全部通过；
- `structural_coordination_success`：是否至少创建两个 Objective、出现真实重叠求值、全部终结且没有失败/取消或遗留 Activation；
- `probe_reply_success`：每个拥有权威消息 Event ID 的在线 Probe 是否都收到因果匹配的最终回复；
- `coordination_success`：结构调度与在线消息交付是否同时成功；
- `success`：`project_success` 与 `coordination_success` 同时成立。

运行命令：

```bash
cargo run -p morphz-evals --bin concurrent_objective_eval -- \
  run autonomous PROFILES.toml RUNS_DIR

cargo run -p morphz-evals --bin concurrent_objective_eval -- \
  run objective_guided PROFILES.toml RUNS_DIR

cargo run -p morphz-evals --bin concurrent_objective_eval -- \
  inspect RUN_ROOT
```

当模型未创建 Objective 时，评测器会等待当前 Dialogue/Execution Thread 完成并出现最终回复，而不是错误地等待不存在的 Objective 六小时。任务、状态询问和跨模块规则都通过同一 Morphz HTTP/SDK 消息入口注入；不能使用只会在前台回合结束后消费的交互式 stdin 模拟并发消息。隐藏验证器独立检查离线构建、功能闭环、并发幂等发布、冲突拒绝、损坏检测和 HTTP 契约。

公开适配位于 `benchmarks/`：Harbor 任务沿用同一产品契约和隐藏评分思想；π-Bench bridge 将 persona 映射为 Principal 与该 persona 专属的共享 Context/Mind、task 映射为 Session，并生成官方评分器可读取的 `turn_*.json`。同 persona 跨 task 共享认知，不同 persona 相互隔离。

实跑结果与局限见 [`morphz_concurrent_objective_coordination_benchmark_results_v1.md`](morphz_concurrent_objective_coordination_benchmark_results_v1.md)。共享 Mind 与最终 Workspace 是否语义一致仍需场景级隐藏检查，不能由结构调度分数替代。
