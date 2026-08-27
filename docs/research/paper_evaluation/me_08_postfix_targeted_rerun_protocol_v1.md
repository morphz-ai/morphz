# ME-08：Runtime 修复后定向复测协议 v1

> 协议：`me08-terminal-bench-postfix-targeted-v1`  
> 状态：协议与二进制哈希已冻结，待执行  
> 性质：修复后定向诊断，不是一次新的 Terminal-Bench 2.1 完整 89 题成绩

## 1. 目的

ME-08 原始一次性同环境对照在 Runtime `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`
上得到 Morphz 70/89、Codex 73/89。开发审计随后确认了 Harbor 工作区发现和命令输出排空的
通用 Runtime 缺陷，并新增了 Objective 通用收敛契约。本协议检验这些修复在原失败题上的实际
影响，同时以少量原通过题监测明显回归。

## 2. 冻结变量

- 数据集：Terminal-Bench 2.1 的原 89 题集合；
- 模型：`gpt-5.6-sol`，`reasoning_effort=max`；
- Provider、网络、容器和官方 verifier：沿用原 ME-08 云端环境；
- 权限：`full_access`；
- Morphz Harness：关闭，使用 native Morphz；
- 每题一次，Morphz 单臂并发 1，Harbor 重试 0；
- 主分数：官方 verifier 的 `raw_reward`；本地完整性扫描只作独立诊断，不覆盖官方分数。

## 3. 变化变量

- Runtime 从 `5e4b0ff` 更新至 `ad60e300f115fe84e03a8cd3ab70940deb06ae68`；
- Linux x86-64 Runtime 二进制 SHA-256：
  `af41ba739096f1970a5439d97d21e7ea237937278a7b2c689d990990b00ab0a6`；
- 新基线同时包含 Harbor 工作区发现、命令输出排空修复和 Objective 通用收敛契约。因此结果只能
  解释为“最新 Runtime 综合修复后的变化”，不能把全部变化单独归因于某一个补丁。

## 4. 阶段

1. **Smoke：** 复测 `prove-plus-comm` 与 `install-windows-3.11`，两题分别对应已确认并修复的
   工作区发现与输出排空缺陷。
2. **Targeted：** Smoke 产物完整后，复测原 19 道 Morphz 失败题；另加入 5 道原通过题作为
   回归哨兵。
3. **决策：** 只有在定向复测显示修复产生实质变化，或回归哨兵出现失败时，才讨论是否值得以
   最新 Runtime 重新运行完整 89 题。

## 5. 结果边界

- 原 70/89 永久保留为可审计的旧 Runtime 一次性基线；
- 不把修复后错题结果替换进旧结果并拼成“修订后的 89 题分数”；
- 定向复测只报告恢复题数、仍失败题、回归哨兵以及逐题官方 `raw_reward`；
- Provider 安全策略拒绝继续计为失败，不从分母中剔除；
- 若要形成新的完整 89 题主结果，必须在同一最新 Runtime 上重新运行全部 89 题。
