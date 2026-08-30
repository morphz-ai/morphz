# ME-08 Codex 完整 89 题超时复核

> 日期：2026-08-30  
> 对象：论文 ME-08 使用的 Codex CLI `0.149.1` 完整 89 题运行  
> 原始运行：`me08-new-account-codex-r2-20260827`  
> 方法：只读检查冻结 trial、官方 verifier 结果与测试日志；不调用模型、不补写产物、不重跑任务

## 结论

Codex 运行共有三个 `AgentTimeoutError`。三题在 Agent 超时后都正常进入官方 verifier，
没有 `VerifierTimeoutError`，因此不存在需要用事后 verifier 补齐的缺失分数：

| 任务 | 官方奖励 | verifier 结果 | 判定 |
| --- | ---: | --- | --- |
| `make-doom-for-mips` | 0 | 2/3 通过；缺少规定的初始化输出 | 保持失败 |
| `password-recovery` | 0 | 0/2 通过；要求的结果文件不存在 | 保持失败 |
| `query-optimize` | 1 | 6/6 通过 | 已由官方评分恢复为成功 |

这说明 Harbor 的实际评分语义不是“出现 Agent 超时便自动计零”，而是超时后仍以官方 verifier
检查任务环境。Codex 的一项超时任务已经因此得到 1 分；另外两项的 verifier 给出了明确的功能性
失败，不是 verifier 自身超时或缺失结果。Codex 的官方总分保持 `74/89`。

本复核与 Morphz Prefix Cache A/B 的事后检查采用同一原则：已有官方 verifier 结果时保留其
判定；只有 verifier 本身超时或没有结果时，才对冻结的原始最终状态进行零模型复评。当前 Codex
完整批次不存在后一种情况。

## 原始证据摘要

原始批次总结果 SHA-256：

- `codex/result.json`：`07803114ca128e846d9e84369e6c98fd201a84f7599d188edfbbbe2fe31fe274`
- `codex/strict_result.json`：`fda28c4f188f7786f53f7c5909be3056c8d8a140c8394f0e9dcfe6d545fe24ed`

三个超时 trial 的 `result.json` SHA-256：

- `make-doom-for-mips__X8MAfaD`：`b71437ba8d8d06d49c97192c7eb8e0c5909923d7e1d81a2ba072c8e6edf0fac8`
- `password-recovery__hMgv9MB`：`96bb0f4a238ab96350653fe8ad72bdef99093f79ff3d42ceb1d7f0a84feab0aa`
- `query-optimize__PyHqhe4`：`f8bc9ebd36779575eb6336f31370d368e6047d8f9b2e17407c04f91a8ff6421a`

对应 verifier `ctrf.json` SHA-256：

- `make-doom-for-mips__X8MAfaD`：`173a79a325bda1a390f3abdedd8487a228c912e9cbcc31a75e006db1c727067d`
- `password-recovery__hMgv9MB`：`add99e44859b4efc1607d3a3dd27478aabcac34a6b1f1429a48caa66c7fcc5b3`
- `query-optimize__PyHqhe4`：`f17ca9cd234d966bcce6a7b7cef8c7260b8d43c305d7becb8d40eac78f5895f5`

原始云端目录：

`/opt/morphz-benchmark/repeat-runs/me08-new-account-codex-r2-20260827/jobs/official-codex/2026-08-27__00-32-08`

