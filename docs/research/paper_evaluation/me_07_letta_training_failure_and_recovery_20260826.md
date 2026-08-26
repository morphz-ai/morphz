# ME-07 Letta 正式训练失败与恢复审计

> 日期：2026-08-26
>
> 协议：`ME-07-STATE-Bench-public-agent-systems-v2`
>
> 本文件记录装置修复，不构成效果结果。

## 首次正式训练失败

Letta travel 训练第一次尝试按固定顺序成功确认 34 条 canonical episode。其活动消息窗口同时
保留了每条完整轨迹；服务日志在第 35 条开始前后记录的 Context token estimate 已达到
`226,673`。第 35 条继续推理时，CLIProxyAPI 后方 Provider 返回 HTTP 400
`invalid_prompt`，说明 prompt 被 policy 过滤器拒绝。脚本没有重试、没有换模型，也没有跳过
该 episode。

失败时 Agent 已对第 35 条执行过一次 `memory_replace`，但尚未返回
`TRAINING_EPISODE_INGESTED`，因此该状态属于部分写入，不能作为正式冻结快照。完整失败 Agent
文件保留在本机实验目录，SHA-256 为
`c35aba3fe4396b5d5458107e6f08dc64698ed61fa0c303eef21afed3d4205ffc`；仓库只保存非敏感、
小体积的失败收据，不把 2 MB Agent 文件纳入 Git。

## 根因与修复边界

失败与 embedding 无关，也不是某条任务被人为判错。根因是离线训练把 100 条原始 episode
当作一个持续膨胀的短期对话；这既不是 Letta 长期记忆必须保留的状态，也会让后续 Provider
请求包含越来越大的历史文本。

修复使用 Letta 0.16.8 的公开 `reset-messages` API：每条 episode 必须先由 Agent 使用原生
memory tool 完成学习并精确确认；随后只清除 in-context messages，并让 Letta 用最新 memory
blocks 重建 system context。原始消息仍保留在 Letta 数据库审计记录中，但不再进入下一条
episode 的活动模型输入。此处理不向 Letta 人工写入答案，也不修改其 memory 内容。

训练脚本同时新增单文件原子 checkpoint，包含 Agent `.af` 与输入前缀、usage、episode 哈希；
恢复只允许从该 checkpoint 的下一个固定 episode 开始。两条真实 episode 的 Gate 证明：

- 每条均调用原生 memory tool 并返回精确确认；
- reset 后活动 `message_ids` 均只剩一个 system message；
- 第二条由退出后的 checkpoint import 恢复执行，而非从头重放；
- 模型仍精确绑定 `gpt-5.6-sol` / `max` / `fallback=false`；
- embedding 仍为本机 `nomic-embed-text:latest`，768 维。

修复代码 commit：`c6d80048d99b2a38c49944398be2a49adc08283b`。首次失败不进入正式训练快照；正式
Letta 三域训练必须从全新 Agent 和全新目录开始。
