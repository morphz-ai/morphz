# Terminal-Bench 2.1 既有前 40 题四臂对照协议

> 协议：`terminal-bench-four-arm-prior-40-v1`
>
> 状态：`protocol-frozen / deterministic-gates-passed / awaiting-cloud-smoke`
>
> 日期：2026-08-24
>
> 性质：产品开发与 Harness 探索，不是未见题验证，不得冒充公开榜单成绩

## 1. 研究问题

在同一 GPT-5.6 Sol/max、Provider、Linux 容器、任务集和单次采样条件下：

1. 极简 v0.5 Harness 相对原生 Morphz 是帮助、无差异还是干扰？
2. 从《实践论》《矛盾论》原文形成的辩证实践 Mind Frame，相对极简 v0.5 是否改变完成率、
   行动路径和交付效率？
3. 原生 Morphz 与官方 Codex CLI 在同一模型上的差异有多大？

## 2. 四个 Arm

| Arm | Agent | Harness/Mind | 主要比较 |
| --- | --- | --- | --- |
| A | 原生 Morphz | 无 Harness；不安装、不绑定空包 | 产品默认基线 |
| B | Morphz | `terminal-task@0.5.0` | B−A：极简可选认知状态 |
| C | 官方 Codex CLI `0.149.1` | 官方原生 Agent；只追加共同完整性政策 | C−A：Agent 实现差异 |
| D | Morphz | `terminal-task-dialectical-practice@0.1.0` | D−B：哲学 Mind Frame 增量 |

四臂都使用同一反作弊、有限执行和任务环境政策。官方 Codex 的内部提示词和执行机制不作
修改；D 不混入 B，避免把哲学效果误记成 v0.5 效果。

## 3. 任务、尝试与并发

- 任务集：此前“前 20 题”与“第 21–40 题”两次开发批次的固定并集，共 40 个唯一任务；
- 清单：[`first_40_tasks_v1.json`](../../../benchmarks/harbor/first_40_tasks_v1.json)；
- 所有任务已被项目观察过，因此本轮不是 unseen evaluation；
- 每臂每题 1 次，`max_retries=0`，共 `40 × 4 = 160` 个正式 trial；
- 正式运行前，每臂使用 `caffe-cifar-10` 做 1 次不计分真实 smoke；
- 四臂同时启动，每臂 `n_concurrent=1`，全节点最多 4 个并行容器，低于此前已验证的 5 个；
- 各臂使用独立 Harbor job、容器、Morphz 数据库、Context、Session 和日志目录；
- 四臂使用同一冻结任务顺序启动，但任务耗时不同，不声称逐题墙钟完全同步。

## 4. 冻结环境

- 模型：精确 `gpt-5.6-sol`；reasoning effort `max`；fallback `false`；
- Provider：同一 CLIProxyAPI / OpenAI Responses 路由；
- 权限：Morphz `full_access`；Codex 使用隔离任务容器内官方 full-access 等价模式；
- Harbor `0.21.0`；Terminal-Bench `2.1` registry digest：
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`；
- Runtime：`paper-eval-runtime-v4@5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- 基础设施、Harness、任务清单和协议必须在运行前提交；每个 Run 记录准确 commit 与 hash。

## 5. 指标与统计

主要指标：40 题严格完整性审计后的 verifier 平均 reward。

同时报告：

- raw reward、严格通过题数与逐题四臂矩阵；
- 配对差值 B−A、D−B、C−A；
- discordant pair 数及双侧 exact McNemar/binomial 检验；
- Agent/Runtime/Harness/Provider 异常；
- input、cached input、估算 uncached input、output Token；
- Agent execution time、工具调用、是否创建要求的持久产物；
- 失败轨迹的机制分类，但不读取私有 verifier 内容反推答案。

每题仅一次意味着统计功效有限且包含采样方差。即使差异显著，本轮也只支持这 40 个已观察
任务上的开发判断；若要对外主张稳定提升，另行冻结未见任务和多次采样协议。

## 6. 外部失败与计分

- `cyber_policy` 等模型/Provider 永久拒绝视为该模型路线在任务上的实际失败，不剔除；
- 429、连接失败或 5xx 且未产生任何模型输出，标记外部基础设施无效，不在夜间自动重试；
- 同时报告保守 all-launched 分数（无效 trial 按 0）和四臂均有效的 paired-complete 分数；
- 不因某臂得分不理想而删除题目、补跑、换模型、改 Harness 或修改评分器。

## 7. Gate 与停止条件

正式 160 trial 只有在以下条件都满足后启动：

1. v0.5 与哲学臂均通过最小干预静态门禁；
2. Harness 解析、内容寻址、adapter、任务清单和四臂命令测试通过；
3. 云端精确模型、Runtime binary、watcher、Docker、Harbor 与权限预检通过；
4. 四个真实 smoke 均形成完整 job、轨迹和评分，并通过各自适用的严格完整性审计；Morphz
   三臂还须通过 Context、Session、数据库隔离及 Harness 绑定 Gate；smoke 得 0 分本身不阻塞，
   执行链或审计失败才阻塞；
5. tracked worktree 干净，运行 commit 已记录。

一旦完整批次启动，不自动修改配置或重试失败题。某个 Arm launcher 异常时不终止已经正常
运行的其它 Arm，但最终报告必须显著标记不完整对照，不能偷偷拼接历史结果。
