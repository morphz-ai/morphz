# ME-07 STATE-Bench 三强记忆臂无模型 Adapter Gate

> 日期：2026-08-26
>
> 协议：`ME-07-STATE-Bench-strong-memory-v1`
>
> STATE-Bench：`5644b1838d96bc4483da29642d058ecaa6f80f7f`
>
> 模型调用：0

## 结果

无模型 Gate 全部通过：

- 机器可读协议锁校验通过，正式 arms 精确为 `morphz`、`amem`、`mem0`；
- `no_memory` 与 `messages_only` 明确禁止进入正式实验；
- STATE-Bench 当前 checkout 与冻结 commit 一致；
- 三个领域的官方训练轨迹均为 100 条，总计 300 条；
- 300 条轨迹经共同 canonical serializer 后形成稳定领域 digest；
- 官方 root extension loader 正确发现 custom `BaseAgent` 与 custom `BaseLLMClient`；
- fake client 下 `retrieve_learnings` 完成正式 harness 往返；
- 模型即便请求 `top_k=999`，Runtime 仍强制实际后端调用为 `top_k=3`。

另外，7 项针对协议、Morphz Recall 过滤、Responses transcript 转换和 Agent top-k 的单元测试
全部通过；Ruff 静态检查通过。

## 数据身份

| domain | train trajectories | canonical SHA-256 |
| --- | ---: | --- |
| travel | 100 | `ae6f1539c779252f61c29753adffc66c86d650c35fa5e0452d4b7e32bfe1623d` |
| customer_support | 100 | `2431c31ba3fe85ce99f419d982556535af8c88a53788dcb215dfe004d7f096bc` |
| shopping_assistant | 100 | `ff8d97a9ca7517b84f4c377d242b9676f715c28084a846da5621a6a1d2651869` |

协议锁 SHA-256：
`3c3338cdea622961d1e4c008fdbe71750547e8b5d651563c0d3cdd35aab66b9a`。

Overlay tree SHA-256：
`724f598d24695effb4813328ffb1bf17f52a5c5ecc2230e49f1fe821d9149224`。

## 结论边界

本 Gate 证明实验协议、输入身份和三臂 adapter 合同已经闭合，不证明任何一种记忆方法效果更
好。正式结果仍受两个 Gate 约束：

1. Morphz、A-MEM、Mem0 的真实学习 artifact 尚未构建和冻结；
2. 官方锁定 Azure GPT-5.4 simulator/judge 尚未绑定，因而禁止真实正式运行。

论文当前只能把 ME-07 写成预注册的外部实验，不能填入 pass@1、差值或显著性数字。

## 证据

- 机器结果：[`no_model_gate.json`](./no_model_gate.json)
- 冻结协议：[`../../me_07_state_bench_protocol_v1.md`](../../me_07_state_bench_protocol_v1.md)
- Adapter 与 Gate：[`../../../../../benchmarks/state_bench/README.md`](../../../../../benchmarks/state_bench/README.md)
