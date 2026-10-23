# SGLang 输入超限误分类及 typed-infer Context 回涨

## 证据等级与影响

已在真实 Kaggle 环境连续复现两次。不是 mock、不是输出截断，也不是模型
把关卡判错。它导致算法评测在 600 秒预算结束前中断，不能作为完整性能对照。

私有执行：[V7，361544395](https://www.kaggle.com/code/shafreecksea/morphz-arc-agi-3-executable-algorithms-20261023?scriptVersionId=361544395)。
机器为免费 RTX PRO 6000；同一个 Flash-Next W4A16 V1、256K 服务端窗口。

- Runtime：`f38245e906814b33fb4f92edd70534b3a233610f`。
- Linux 二进制 SHA-256：`5d3d69517febf0bf77d9ca92c1a72b7865d093b239739ba93e17695f44b6af70`。
- Harness / 算法 / runner：提交 `6fdaf2e2`，`arc-algorithms@0.3.2`。
- 每个有限 Program 为 4 次 infer；最多 16 个独立 Evaluation；同一 root Session、
  DB、workspace 和游戏计时，不重置 Program 的持久预算或整局动作数。
- 本轮语义节点是无工具、非 thinking、受约束 JSON 输出；provider adapter 仅
  投影当前请求已按 SHA-256 捕获的 PNG。该配置差异已明示，不是纯算法消融。

## 1. 已定位的错误分类缺口

实际返回：

```text
HTTP 400
The input (281581 tokens) is longer than the model's context length (262144 tokens).
The input (282554 tokens) is longer than the model's context length (262144 tokens).
```

Runtime 日志均记录为 `failure_kind="invalid_model_or_request"`，随后
`(infer ...) failed: child Evaluation failed`，进程退出码却为 0。
runner 已独立检测 Evaluation 失败并设置 `valid_run=false`。

源码核对：

- `morphz/src/llm.rs` 的 `ModelFailure::classify_message` 有
  `context_length_exceeded`、`maximum context length`、`context window`、
  `prompt is too long` 等模式，但缺少这条 SGLang 文案。
- `morphz/src/provider.rs` 的 HTTP 错误分类先使用上述语义分类；未识别时，
  HTTP 400 会落入 `InvalidModelOrRequest`。
- `morphz/src/orchestrator/orchestrator.rs` 已有独立的 `ContextLimit` 恢复分支；
  本轮日志中的错误类型没有进入它。

这是可定位的兼容性缺口。修复需加入真实 SGLang JSON/HTTP 400 回归，避免把
所有 HTTP 400 或所有包含 context 的业务错误一概归类为输入超限。

## 2. 已观测、尚未完成源码归因的 Context 膨胀/回涨

ft09 实际出站请求（按时间排序）：

| 请求 | 棋盘 `grid_hex_rows` 副本数 | user 文本字符数 | 实际 prompt tokens |
| --- | ---: | ---: | ---: |
| 1 | 4 | 100306 | 46030 |
| 4 | 10 | 185704 | 94503 |
| 8 | 18 | 308152 | 162763 |
| 11 | 24 | 400747 | 213841 |
| 12 | 2 | 199528 | 82807 |
| 13 | 28 | 463956 | 248578 |
| 14 | 2 | 223891 | 92854 |
| 15 | 32 | 522710 | 被服务端拒绝：281581 |

每条请求只投影 1 张原生 PNG；增长不是把旧 PNG 重复追加为 image blocks。
请求 12、14 中像素矩阵暂时缩减，之后又恢复大量历史副本。
父子 Evaluation 的投影/失效传播、估算与实际 tokenizer 的差异均应检查，
但**不能仅凭此表断言某一个源函数就是回涨根因**。

定位入口：`sexpr_eval.rs` 的 `InferBody` 捕获序列化、
`OrchestratorInference::infer_typed`、Context 编译/重建以及 ContextLimit 重试。
已核对这些文件相对 Runtime 构建提交与本次本地 HEAD 没有差异。

## 3. 建议的验证要求

1. 真实 SGLang 错误应为 `context_limit`，不是无效模型/配置。
2. 内部 infer 超限可使用既有恢复机制，不重放已经提交的游戏动作。
3. 缩减后发出的下一次请求不应无界恢复历史大矩阵；保留当前明确 captures、
   返回契约、授权边界和必要证据，不能靠删除最新棋盘或读取未授权文件过关。
4. 用同一模型、固定 256K 服务端窗口重跑完整 600 秒 / 200 动作的样本，
   对照实际 wire tokens、Context 回涨、持久 Plan 状态和引擎轨迹。
5. 本机 mock/错误分类测试只能证明局部修复；不能替代上述真实长链路验证。

## 4. 材料位置

- 汇总：`actor-integration-v032-results-2026-10-24.json`，含两次真实结果、
  每条请求增长统计、轨迹哈希、原始错误和同 Session 分段回执。
- 原始本地目录：
  `/tmp/morphz-arc-algorithms-v7-output-20261024/morphz-arc3-harness-20261023/arc-algorithms-v032-actor-integration/`。
- `provider-wire.jsonl` 已去除图像 base64，保留内容/图片哈希；没有本机 Kaggle Token。
- 原始 Notebook 和输出保持私有，未提交排行榜，也未公开模型或公司材料。
