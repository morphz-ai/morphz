# ME-09：共享 Context、多 Session 与跨任务迁移协议 v1

状态：`frozen-candidate / awaiting-real-smoke`
协议标识：`ME-09-TB2.1-shared-context-8-session-v1`

## 1. 研究问题

在模型、推理强度、授权、任务、官方评分器和总并发数保持一致时，一个 Morphz Agent
能否让八个 Session 在同一权威结构化 Context 上并发工作，并通过 Context 中持久化的
认知帧在后续任务间复用经验？

ME-09 不重复构造“八个隔离 Context”的控制组。ME-08 已经给出了每题独立
Context/SQLite 的 Morphz 89 题结果，ME-09 只增加共享 Context 处理组，并按相同的 89 个
Terminal-Bench 2.1 官方 verifier 与 ME-08 做逐题配对。

## 2. 预注册主张边界

1. 若 ME-09 显著低于 ME-08，只能说明本协议下共享状态或并发带来负效应；需结合
   Context 冲突、错误类型和 Runtime 轨迹判断原因。
2. 若 ME-09 与 ME-08接近，支持“共享 Context + 多 Session 未观察到明显退化”；不能据此
   断言存在迁移学习，因为任务之间可能没有可复用信息。
3. 若 ME-09 高于 ME-08，结果与正迁移一致，但总体分数上涨本身不构成因果证明。只有出现
   跨 Session Frame 证据时，才把对应任务对报告为机制案例。
4. 无论方向如何，一次 89 题运行都是探索性配对证据，不宣称官方榜单成绩，也不把本地
   完整性扫描器替代 Terminal-Bench 官方 verifier。

## 3. 冻结条件

- 数据集：`terminal-bench/terminal-bench-2-1`；89 个任务；官方 registry ref：
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`；
- 模型：精确物理模型 `gpt-5.6-sol`，reasoning effort=`max`，无 fallback；
- Provider：同一 CLIProxyAPI 订阅线路；
- 权限：`full_access`；公开任务自身的 Docker、网络与 verifier 规则不变；
- Harness：`terminal-task@0.5.0`，source SHA-256 与 `toolchain.lock.json` 一致；
- 尝试：每题一次，零自动重试；
- 总并发：8；
- Runtime 二进制与 ME-08 完全相同：commit
  `4bbc3d63f4bda09947dc79dc5656edc71f8c02fa`，SHA-256
  `31f6cdd3de8ddf4a76e190eb4c0863ff9de7c9159c7acbf7ac2765b474ec0575`；启动器必须同时
  校验完整 commit 标识和二进制摘要，实验基础设施 commit 单独记录；
- 官方 `raw_reward` 是唯一主评分；Provider 安全拒绝、Agent timeout 与 Runtime 失败均按
  原始运行计为失败，不事后剔除；
- 运行期间不改 Runtime、Harness、提示词、任务顺序或评分逻辑。

## 4. 拓扑与任务顺序

- 一个中央 Morphz Runtime；
- 一个 Agent：`me09-agent`；
- 一个共享 Context：`me09-shared-context`；
- 八个稳定 Session：`me09-session-00..07`；
- 八个稳定 Execution Target：`me09-target-00..07`；
- 每个 Target 同一时刻只连接一个任务容器；
- 八条 lane 并发，每条 lane 串行执行 11 或 12 题；上一题完成官方评分、容器被 Harbor
  销毁后，才把该稳定 Target 交给下一题；
- 89 题按冻结的完整 Harbor lock 顺序 round-robin 分配。权威清单为
  `benchmarks/harbor/me09_task_manifest_v1.json`，重建顺序 SHA-256 为
  `7689aff6fc2cf2df1831848203d5db840738b7b236c67bebf832ff783426735d`。

中央 Runtime 持有模型凭据和 SQLite；任务容器不接收 Provider 凭据。每个容器仅运行
Morphz Edge Worker，通过一次性 pairing code 将工具执行绑定到本题 workspace。消息入口
显式携带 `target_id`，Runtime 在同一事务中将新 Dialogue Thread 冻结到该 Target，避免
八个容器串用工具。

## 5. 与 ME-08 的可比性

相同项：89 题、Sol/max、Provider 线路、full access、Harness、官方 verifier、一次尝试、
零重试、总并发 8、同一云节点。

唯一预期机制差异：

- ME-08：每题独立 Runtime、SQLite、Context 与 Session；
- ME-09：单 Agent、单共享 Context、八 Session 和八 Target，Session 内多题连续。

ME-09 不使用另行编译的 Runtime。ME-08 的冻结二进制已经包含真实多 Target 路由、按
root turn 等待持久回复以及 ME-08 审计确认的 Runtime 修复。ME-09 只增加外部实验编排和
逐 turn 轨迹导出；其基础设施 commit 与共享的 Runtime commit、二进制 SHA-256 分栏记录。

## 6. 评分与统计

主指标：

- ME-09 官方通过数 / 89；
- 与 ME-08 Morphz 隔离 Context 结果逐题配对的净差；
- discordant pairs：ME-09-only 与 ME-08-only；
- exact McNemar 检验与 paired bootstrap 95% CI。

诊断指标：

- Runtime/adapter/Provider/Agent timeout/正常方案错误分类；
- 每条 lane 的通过率、Context transaction 数、Frame 数、事务冲突与 Token；
- 宿主机资源曲线；
- 本地完整性扫描结果（只作辅助，不覆盖官方得分）。

## 7. 跨 Session 迁移证据等级

- **E0：仅共享**——两个 Session 挂载同一 Context；只证明拓扑成立。
- **E1：可见暴露**——Session A 提交的 Frame 在后续 Session B 的 Context 版本中仍处于
  活跃投影；证明信息可被 B 使用，不证明实际使用。
- **E2：显式复用**——Session B 的 `context_tx`、recall 或其他结构化事件通过稳定 Frame
  ID 引用了 Session A 创建或修订的 Frame；构成跨 Session 机制证据。
- **E3：结果相关案例**——E2 成立，且相同任务在 ME-09 通过、ME-08 失败；只能作为
  可解释案例，不凭单例宣称总体因果效应。

没有 E2/E3 时，即使总分提高，也只表述为“与迁移一致”，不得写成已证明迁移学习。

## 8. Gate 与停止规则

1. 无模型检查：manifest 89 题唯一、lane 为 12/11×7、Session/Target 唯一、按 root turn
   导出的 ATIF 不混入其他 Session/turn。
2. 真实 smoke：每条 lane 第一题，共 8 题；验证中央 Runtime、八 Session、八 Target、
   Edge pairing、官方 verifier、逐题 ATIF 与容器销毁后的 Target 交接。
3. Smoke 任一任务出现系统性串 Target、共享 DB 污染、凭据进入容器、官方 verifier 未运行
   或轨迹跨 turn 混合，则禁止正式 89 题。
4. Smoke 通过后重新使用全新数据库和 Context 启动正式批次；Smoke 数据不得拼入正式分数。
5. 正式运行期间不调参、不补跑；所有失败原样保留。只有基础设施启动前失败才允许在修复后
   建立新的、完整独立 Run。
