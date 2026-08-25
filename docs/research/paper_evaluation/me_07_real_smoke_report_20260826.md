# ME-07 LongMemEval-V2 Small 真实 smoke（2026-08-26）

## 状态

四个冻结 cell 均完整通过，允许进入 451 题全量 paired 运行。每个 cell 内部并发保持 1。

## 环境

- Reader requested/physical：`qwen3.8-max-preview` / `qwen3.8-max`；
- Judge requested/physical：`qwen3.8-max-preview` / `qwen3.8-max`；
- Provider：CLIProxyAPI，Chat Completions；
- 官方 token processor：`Qwen/Qwen3.5-9B`；
- 官方 Python：3.11；macOS 依赖为 Torch 2.6.0、Torchvision 0.21.0；
- 每个 domain 使用固定的官方首题和其 100-trajectory Small haystack。

## 结果（仅 smoke，不做效果推断）

| Domain | no_retrieval | Morphz projection | Morphz memory context |
| --- | ---: | ---: | ---: |
| web `00aa905a` | 0/1 | 1/1 | 16,595 tokens / 20 Frames |
| enterprise `01307e07` | 0/1 | 0/1 | 14,904 tokens / 20 Frames |

Morphz/web 给出正确 `False`；no-retrieval 两题均按要求回答 `UNKNOWN`。Morphz/enterprise 给出
具体但错误的答案，证明 scorer 不是只要检索到非空 Context 就给分。四个 cell 均无 truncation、
无模型空响应、无 scorer 或 adapter 异常。

逐题产物 SHA-256：

- Morphz/enterprise：`cdbeb0f4e9ab08475bcc6189d2799121a4751e869676d8414bbe95eff58ef6ea`；
- Morphz/web：`7782c985c0b493727b2660d6b0283a942758c7fc4294b49ae404998e0517bcfd`；
- no-retrieval/enterprise：`dda16c41a03cb1112c7dea4da74b15362872f919d836265dbdb72f3f835d6e44`；
- no-retrieval/web：`19234835a87c022703ce45ae383a6a368a058bf68d7769a1edb8e5250445ab1b`。

## 保留的环境事故

第一次 smoke 目录永久保留：no-retrieval/web 已成功；Morphz/web 在任何 reader 调用前因官方
`AutoProcessor` 缺少平台专用 Torch/Torchvision 而停止。安装官方版本的 macOS wheel 后使用
全新目录重跑全部四 cell，没有复用或覆盖第一次输出。该事件分类为 dependency Gate failure，
不计入效果分数。
