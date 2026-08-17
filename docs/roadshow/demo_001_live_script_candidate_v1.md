# DEMO-001 五阶段演示与现场讲解脚本候选版 v1

> 状态：`superseded`
>
> 已由 [Morphz 五分钟路演脚本候选版 v2](morphz_roadshow_five_minute_script_candidate_v2.md) 取代。v1 仅保留为历史记录，不再作为现场脚本。
>
> 对应协议：[DEMO-001 路演对比协议候选版 v1](demo_001_protocol_candidate_v1.md)
>
> 目标时长：7 分钟；允许压缩到 5 分钟或扩展到 10 分钟

## 1. 核心叙事

开场不用「长记忆 Agent」定义 Morphz。统一使用：

> Morphz 是面向大语言模型的认知符号求值虚拟机。普通 Agent 在消息里寻找答案，Memory Agent 从摘要里恢复答案；Morphz 对可寻址、可修订的认知状态求值，并让结果经过 Runtime 验证后直接进入下一步行动。

Hero Demo 只回答一个问题：

> 当现实证据变更、两个 Session 并发工作、进程中途重启且晚到旧资料试图干扰判断时，Agent 最终会把哪个版本真正发布出去？

## 2. 演示前准备

现场准备三个兜底层级：

1. **Live**：从阶段 1 签名 checkpoint 开始，实时执行阶段 2–5；
2. **Video**：同一冻结版本、同一场景的完整成功录屏；
3. **Offline trace**：冻结 Run 的 Dashboard 导出、Event/Context 时间线、最终 score 和结果表。

浏览器预开页面：

- Session A 对话；
- Session B 对话；
- Cognition/Mind；
- Work/Thread 与 Recovery；
- 冻结三 Arm 结果表。

终端只预留两个已审计命令：启动/恢复 Demo 与触发受控重启。现场不输入临时 SQL、不浏览源码、不打开完整 Prompt。

## 3. 标准 7 分钟时间轴

### 00:00–00:40：问题与定位（静态）

讲解：

> 今天我不演示一个更会聊天的助手，而是演示一个状态会进入现实行动的 Agent。这个项目已经运行了很久：证据被多次修订，两个 Session 同时工作，中间还会重启。最后我们只看一件事——它实际提交了哪个生产配置。

屏幕：一张简单链路图。

```text
证据 → 认知求值 → 当前状态 → Runtime 验证 → 发布动作
```

### 00:40–01:25：冻结三 Arm 结果（静态冻结数据）

显示 Message Agent、Summary-Memory Agent、Morphz 的同模型、同工具、同预算结果表。

讲解顺序固定：

1. 最终行动正确率；
2. 陈旧状态误用；
3. 跨 Session 与污染；
4. 重启恢复；
5. Token、成本和时间。

必须说：

> 这是路演演示批次，不是论文确认性实验。现场只实时运行 Morphz，另外两组使用冻结结果，避免把网络和模型随机性伪装成科学结论。

如果结果尚未形成，不得展示空表或预测值；直接跳到场景。

### 01:25–01:55：阶段 1 checkpoint（离线签名状态）

打开 Mind/Context：

- v1：8080、`/v1/events`，已取代；
- v2：9090、`/v2/events`，当前；
- 安全约束：`NEVER-LOG-SECRETS`。

讲解：

> 为了把现场控制在七分钟，我们从同一协议已经完成的第一阶段继续。这里不是一段摘要，而是三个可引用的认知对象：当前状态、旧状态和它们的取代关系。

### 01:55–03:05：阶段 2 并发更新（Live；超时则切视频）

同时向两个 Session 提交：

- Session A：批准的 v3 热修复，9443、`/v3/events`；
- Session B：保留期 45 天、Asia/Shanghai，以及仅属于审计 Session 的 `127.0.0.1:7001`。

展示 Work/Thread 两条活动轨迹和分别回到 A/B 的回复。

讲解：

> 两个 Session 共享同一个 Agent 的认知，但不是共享一段混在一起的聊天记录。v3 和合规决定可以成为后续共享状态；审计 Session 的地址不能串进发布端口。

切换规则：提交后 35 秒仍没有两个终态，立即切换到同版本视频对应片段；不现场诊断 Provider。

### 03:05–03:40：阶段 3 跨 Session 接续（Live/Video）

Session A 提问当前完整配置，禁止重新读取证据。

屏幕应显示：

```text
v3 / 9443 / /v3/events / 45 / Asia/Shanghai / NEVER-LOG-SECRETS
```

且不含 `127.0.0.1:7001`。

讲解：

> Session A 没有拿到 Session B 的原始 transcript，但能使用已经提交的合规决定；私有审计字段没有污染发布状态。这是跨 Session 的认知接续，不是把所有聊天拼在一起。

### 03:40–04:20：阶段 4a 受控重启（Live；失败则离线 trace）

触发预置重启命令，展示 Recovery 指标或 Thread/Context 重新出现。

讲解：

> 模型进程、会话连接和 Agent 的持久认知不是同一件事。现在 Runtime 被重启，但已经提交的状态和未完成工作的因果身份仍然存在。

切换规则：20 秒内服务未恢复到健康状态，切换到离线重启前后 trace，不重复执行重启命令。

### 04:20–05:05：阶段 4b 晚到陈旧证据（Live/Video）

注入最新到达、但明确标记 `archived-untrusted` 的 v1 文件；询问它是否改变当前状态。

期望：仍为 v3/9443/`/v3/events`。

讲解：

> 「最后到达」不等于「最权威」。Morphz 保留的是证据状态和取代关系，而不是简单按消息时间选择最后一句话。

### 05:05–05:50：阶段 5 隐藏发布动作（Live；最重要）

发送最终发布请求。显示 `commit_release` 的单次调用和机械判定结果。

正确结果：

```text
PASS · ORBIT-42 · v3 · 9443 · /v3/events
45 days · Asia/Shanghai · NEVER-LOG-SECRETS
```

讲解：

> 评分器没有判断它说得像不像，而是检查它实际提交的七个生产参数。回答正确但行动错误，仍然是失败。认知结果在这里真正重新进入了计算和现实动作。

如果 Live 行动失败，保持现场诚实：显示失败结果，随后切换冻结成功 trace；不得临时重跑直到成功。

### 05:50–07:00：机制收口与商业意义（静态/离线 trace）

打开一条精简因果 trace：

```text
approved-v3 Observation
  → release-state revision
  → supersedes v2
  → cross-session policy revision
  → restart recovery
  → stale v1 rejected
  → commit_release(v3, 9443, /v3/events)
```

收口话术：

> Morphz 管理的不是更多聊天记录，而是持续计算中的认知状态：什么是当前事实、它从哪里来、取代了什么，以及它能否安全地进入下一步行动。Token、时间和成本决定它能否成为商业产品；最终行动正确率决定它是否值得被信任。

## 4. 五分钟压缩版

- 00:00–00:35：定位；
- 00:35–01:05：冻结结果表；
- 01:05–01:35：阶段 1 checkpoint；
- 01:35–02:35：阶段 2/3 使用视频加 Live 最终状态；
- 02:35–03:10：Live 重启；
- 03:10–03:45：晚到旧证据；
- 03:45–04:25：隐藏发布动作；
- 04:25–05:00：因果 trace 与收口。

五分钟版不现场等待阶段 2 的两个模型响应，直接播放冻结视频并在阶段 3 切回 Live。

## 5. 十分钟扩展版

在标准版基础上最多增加：

- 45 秒解释三个 Arm 的状态差别；
- 45 秒展开一条 Frame revision/source/supersedes；
- 45 秒展示 Session A/B 的因果 Thread；
- 45 秒解释成本表和云服务意义。

不得增加源码浏览、完整 Prompt、多语言/文言 Context 或新的现场任务。

## 6. 演示员操作脚本

| 顺序 | 操作 | 成功信号 | 失败动作 |
| --- | --- | --- | --- |
| 1 | 打开冻结结果表 | 三 Arm、版本和 Run 数齐全 | 跳过，不口述预测数字 |
| 2 | 打开阶段 1 checkpoint | v1/v2/security 三对象可见 | 切 checkpoint 截图 |
| 3 | 同时提交 Session A/B 阶段 2 | 两条 Work Item，回复各自归位 | 35 秒切视频 |
| 4 | Session A 执行阶段 3 | 六项当前值正确，无 audit sink | 显示冻结 trace |
| 5 | 执行一次受控重启 | 20 秒内恢复健康与 Context | 切重启前后离线 trace |
| 6 | 注入 archived v1 | 当前值仍为 v3 | 显示冻结对应片段 |
| 7 | 提交最终发布请求 | `commit_release PASS` | 保留失败并切冻结成功 trace |
| 8 | 打开精简因果链 | 能从证据追到行动 | 使用预导出静态图 |

## 7. 现场纪律

- 不因一次 Live 失败即时重跑；
- 不把冻结失败轨迹隐藏或替换；
- 不在现场调整模型、Prompt、预算或 fixture；
- 不把 Dashboard 的内部诊断字段逐项讲成产品概念；
- 不展示 Provider Key、完整 Prompt、数据库 schema 或未决定公开的实现；
- 不把路演结果称为论文实验；
- 不加入多语言或文言 Context 内容。

## 8. 录像与离线 trace 要求

正式录像必须：

- 使用最终冻结 Demo commit、模型配置和 fixture；
- 从阶段 1 checkpoint 校验开始录到阶段 5 score；
- 同时记录屏幕和原始 Run ID；
- 不剪掉等待以伪装速度，可以倍速但必须标注；
- 片尾显示 commit、协议版本、模型、Run ID 和 `purpose=roadshow_demo`。

离线包至少包含：

- 每阶段输入和回复；
- 精简工具/Thread/Event trace；
- 阶段 1、3、重启后和阶段 5 的 Context 快照；
- `commit_release` 请求与 PASS/FAIL；
- 单 Run score 与三 Arm 冻结汇总；
- Token、成本、耗时和 checksum。

## 9. 讲解禁区与允许范围

允许讲：认知对象、来源、版本、取代、跨 Session、因果隔离、恢复、验证后行动。

不主动讲：调度表结构、lease/fencing 实现、Edge 路由、身份锚定算法、完整 System Prompt 和未申请后续技术细节。

## 10. 版本记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| candidate-v1 | 2026-08-17 | candidate-frozen | 首次冻结候选五阶段脚本、时间轴与现场切换规则 |
