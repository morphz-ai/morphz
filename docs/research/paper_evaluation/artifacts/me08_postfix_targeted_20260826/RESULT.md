# ME-08 Runtime 修复后 24 题定向诊断

> 协议：`me08-terminal-bench-postfix-targeted-v1`  
> Runtime：`ad60e300f115fe84e03a8cd3ab70940deb06ae68`  
> 模型：GPT-5.6 Sol / max  
> 日期：2026-08-26  
> 性质：定向修复诊断，不是完整 89 题成绩

## 结论

- 24 题官方 verifier 结果完整，15/24 通过；该比例不得作为 Terminal-Bench 全集分数。
- 原 19 道 Morphz 失败题中，10 道在新 Runtime 上恢复通过。
- 5 道原通过回归哨兵全部继续通过，未观察到哨兵回归。
- 该结果说明 Runtime 综合修复产生了实质变化，满足重新运行完整 89 题的预设触发条件。
- 不允许把这 24 题结果替换进旧 Runtime 的 70/89，从而拼接出“修订分数”。

## 恢复通过的 10 题

`configure-git-webserver`、`extract-elf`、`gcode-to-text`、`mteb-leaderboard`、
`raman-fitting`、`install-windows-3.11`、`overfull-hbox`、`protein-assembly`、
`prove-plus-comm`、`tune-mjcf`。

## 仍未通过的 9 题

`dna-insert`、`make-doom-for-mips`、`pytorch-model-recovery`、`train-fasttext`、
`vulnerable-secret`、`break-filter-js-from-html`、`extract-moves-from-video`、
`financial-document-processor`、`video-processing`。

其中 6 个 trial 以 `AgentTimeoutError` 结束。这里仅记录 Harbor 观测，不在定向报告中把超时
进一步归因于模型、Provider、任务环境或 Runtime；后续诊断分类不能覆盖官方 verifier 结果。

## 回归哨兵

`bn-fit-modify`、`build-pov-ray`、`cancel-async-tasks`、`qemu-alpine-ssh`、
`qemu-startup` 全部通过。

## 执行与资源

- 每题一次，重试 0，并发 1；墙钟约 5 小时 50 分钟。
- Provider 报告 input tokens 25,483,218，cache tokens 2,513,408，output tokens 548,630。
- 700 个 30 秒资源样本：16 CPU、总内存 61.52 GiB。
- 内存使用均值约 1.63 GiB、P95 约 2.13 GiB、峰值约 4.05 GiB。
- 1 分钟 load 均值 0.24、P95 约 0.99；同时运行容器峰值 1。

这些数据支持把后续完整 Morphz 89 题运行提高到并发 8。并发 8 的正式结果必须独立生成，
不得与本轮并发 1 的局部结果合并。

## 完整性说明

- `launcher_result.json` 标记 `complete_official_results=true`；
- `strict_result.json` 包含 24 条唯一任务记录，`audit_complete=true`；
- 本地完整性 Gate 通过；
- Harbor launcher 返回码为 3，同时产生了完整官方结果和 6 个 errored trial。返回码与错误数
  保留在原始文件中，不被改写为成功退出。
