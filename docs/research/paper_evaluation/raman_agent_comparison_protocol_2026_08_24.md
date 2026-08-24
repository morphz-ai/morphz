# Raman-fitting Agent 归因对照协议

状态：frozen before model execution  
日期：2026-08-24  
协议：`raman-agent-attribution-v1`

## 目的

本实验不估计 Terminal-Bench 总体成绩，只回答一个归因问题：在相同题目、模型、Provider、权限和执行环境下，`raman-fitting` 的未完成主要来自 GPT-5.6 Sol 本身，还是来自 Agent/Runtime 的工作与收敛策略。

## 三个实验臂

1. Morphz 原生：不安装、不绑定任何 Harness；
2. Morphz + `terminal-task@0.4.0`：复用已完成的单次结果，不重复消耗模型额度；
3. OpenAI Codex CLI `0.149.1`：使用 Harbor 0.21.0 内置的官方 Codex 适配器，仅附加与 Morphz 相同的 Benchmark 完整性策略。

三个实验臂均使用 Terminal-Bench 2.1 的同一 `raman-fitting` 任务、GPT-5.6 Sol、`reasoning_effort=max`、同一 CLIProxyAPI 路由、Linux/amd64 Docker 任务容器、full access、一次尝试、并发度 1、Harbor 原始任务期限和同一验证器。禁止读取私有测试、验证器文件、参考答案、奖励文件或在线任务解答。

## 判读

- Codex 成功而两个 Morphz 组失败：优先归因于 Morphz Agent/Runtime 的工作和终态策略；
- Codex 与 Morphz 原生成功、v0.4 失败：v0.4 Harness 存在负作用；
- 三组均失败且失败轨迹近似：模型/题目难度是更强解释；
- 三组路径不同但均失败：逐项比较工具选择、有效产物形成时间、重复诊断、终态提交与 Runtime 异常。

该实验只有一题、每臂一次，结果是诊断性案例研究，不得表述为模型或 Agent 总体胜率。

## 收敛机制设计约束

后续 Harness 不以“到时间立即提交”或固定工具次数作为主要机制。优先向模型提供通用决策方法：持续维护交付物、验收证据、未解决不确定性、当前最佳有效检查点，以及下一步行动能否显著改变验收结果。Runtime 只负责明确区分进度消息与终态交付、持久化工作状态和执行 I/O 契约，不替模型作任务特定的收敛决定。
