# ME-08 Morphz 全 89 题刷新运行（ad60e / 并发 8）

> 日期：2026-08-26（Asia/Shanghai）  
> 协议：`me08-terminal-bench-postfix-all89-morphz-v2`  
> 主口径：Terminal-Bench 2.1 官方 verifier `raw_reward`  
> 性质：Morphz 单臂工程刷新；不是新的同期双臂配对实验

## 结果

- Morphz：**73/89，82.02%**；Wilson 95% CI `[72.77%, 88.62%]`。
- 89 个唯一任务均产生官方 verifier 结果；本地完整性 Gate 通过，无缺失、额外或取消资格的 trial。
- 历史 Codex 单臂结果也是 **73/89，82.02%**。两者数值相同，但 Codex 没有在本轮重跑，因此只能作为非同期、不同 arm 并发设置的参考，不能称为新的严格配对结果。
- 原严格同期、同并发的 ME-08 配对实验仍是 Morphz 70/89、Codex 73/89；不得把两个实验的逐题结果拼接为一个新配对批次。

## 冻结配置

- Runtime commit：`ad60e300f115fe84e03a8cd3ab70940deb06ae68`
- Runtime binary SHA-256：`af41ba739096f1970a5439d97d21e7ea237937278a7b2c689d990990b00ab0a6`
- 运行基础设施 commit：`a226bfef1b555e2d83fa4b3ce6d90790bc522705`
- 模型：`gpt-5.6-sol`，reasoning effort `max`，fallback `false`
- 每题 1 次、零补跑；Morphz arm 内 `n_concurrent=8`，整机同时最多 8 个 trial
- 每道题使用独立任务容器、Context 和 SQLite；并发任务之间不共享 SQLite 数据库

## 资源观测

446 个资源样本显示：

- 16 个逻辑 CPU；1 分钟 load 均值 1.51、P95 5.52、最大 14.93；
- 61.52 GiB 内存；已用内存均值约 3.36 GiB、P95 约 5.18 GiB、最大约 8.79 GiB；
- 运行中 Docker 容器均值 6.59、最大 10。

该节点在并发 8 下仍有显著内存余量；本轮没有证据表明跨题资源竞争或共享 SQLite 是主要失败原因。

## 失败与超时诊断

官方 verifier 判定 16 题失败。其中 10 题正常结束但 reward 为 0；6 题以
`AgentTimeoutError` 结束。诊断分类只解释轨迹，不覆盖官方分数。

### 1. 永久安全拒绝被错误恢复：2 题

- `break-filter-js-from-html`：没有一次成功的模型 Evaluation；Provider 的
  `cyber_policy` 拒绝被 Runtime 归入可恢复的 `server_unavailable`，反复健康探测和重试直至
  1200 秒超时。
- `vulnerable-secret`：模型只完成一次 `list_files`，随后进入同类安全拒绝—恢复循环，900 秒
  超时。

这两题不是模型探索不收敛，而是错误分类和恢复策略缺陷。主分仍按冻结协议记 0；不得从主分
剔除。

### 2. 视觉 Observation／Context 维护重复循环：2 题

- `video-processing`：404 个轨迹 step、264 次图片读取、131 次 `context_tx`；
  `/app/contact.jpg` 和 `/app/jump_detail.jpg` 各被读取 132 次，仅执行 3 次普通命令，3600 秒内
  始终没有创建要求的脚本。Context Frame 保留了图片路径、hash 和“读取成功”，却没有沉淀可
  行动的视觉结论；相应 Observation 被退休后，下一轮只能重新读取同一图片。
- `extract-moves-from-video`：74 个 step、95 次图片读取、16 次 `context_tx`；多个 sample 图被
  重读约 15 次，直到末尾才启动全视频 OCR，1800 秒内未生成交付物。

这两题与“视觉语义没有在维护前可靠沉淀、重复读取仍被当成进展”的组合失效一致，需要通用
Runtime/Context 修复，不能写任务特例。

### 3. 真实探索未及时收口：2 题

- `raman-fitting`：没有 `context_tx`；连续尝试多个全局、侧带和鲁棒拟合方案，但在 900 秒内
  没有把已有候选收口为交付物。更接近模型过度优化／收口失败。
- `make-doom-for-mips`：仅 1 次 `context_tx`；持续进行 MIPS 工具链安装、编译、ABI 与未解析
  符号调查，已生成约 660 KiB 的组合目标文件，但 900 秒内未完成最终可运行产物。它包含实质
  新进展，更适合归类为任务复杂度与时限内未完成，而不是重复 Context 循环。

### 4. 官方通过但 Harbor 超时：`build-pov-ray`

该题最终 verifier reward 为 1，但 Agent 交付链路超时。只读诊断确认单个 Runtime 内部存在
终态提交—交付接力的取消竞态：Activation 自己提交终态后，旧 revocation watcher 取消仍在
执行的 post-commit handoff；取消又可能污染同一题的 SQLite 连接池事务。修复 commit
`ac3344ef557d749f0c2f1d1c3ab572586e852e91` 在本轮启动后才形成，因此本轮二进制不包含它。

这里的“竞态”发生在同一道题、同一个 Runtime 的 Activation、EventBus、Delivery Timer 与
SQLite 连接池之间，不是八道并发题共享数据库造成的跨题竞争。

## 解释边界

1. 本轮支持的直接事实是：Morphz 单臂在完整 89 题上取得 73/89，数值追平历史 Codex 单臂。
2. 本轮不是同期双臂对照，不能重新计算或复用旧配对实验的 McNemar `p` 值来证明两者等价。
3. 单次采样无法区分稳定能力和模型轨迹方差；定向 24 题中的恢复不能外推为全集必然恢复。
4. 运行仍暴露永久错误恢复、视觉 Context 维护循环和终态交付等 Runtime 问题，因此不是“最新
   修复均已包含”的干净生产基线。
5. 所有安全拒绝、timeout、Runtime 缺陷和普通任务失败均保留在官方 73/89 中；诊断结果不
   生成“剔除外因后的分数”。

