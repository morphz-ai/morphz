# ME-07 LongMemEval-V2 Small adapter Gate（2026-08-26）

## 结论

`morphz_structured_projection` 已通过官方接口、合成数据和官方真实数据的无模型 Gate，可以进入
固定 reader/judge 的真实 smoke。该 Gate 不产生论文效果分数。

## 固定上游与数据

- 官方代码：`xiaowu0162/LongMemEval-V2@2cc8c540bdb87fe6761629b585e727e1c4704520`；
- 官方数据：`xiaowu0162/longmemeval-v2@f152293e235517d504809563c833d7190b8c713b`；
- Small：451 题、1870 条 trajectory、每题 100 条 trajectory；
- `questions.jsonl`：`0a3ae5ebea938c24d7800e1e0b0828e08ae1646f939a53853b2b8cdc08e292b7`；
- `trajectories.jsonl`：`363cec9a8e87aa8d9101ce4e600aadbf7031d674056ebe4f969e8424abc5f3c6`；
- `haystacks/lme_v2_small.json`：`9b5301defb23a088a5f06e45ff8d5f35e569d78305a66d492046a9fff9b46593`；
- 仅省略不会被本 adapter/reader 使用的 trajectory screenshot 归档；29 张 question screenshot 已下载。

## 真实数据结构修正

候选 adapter 最初错误假定 state 使用通用 `text` 字段。官方数据实际使用 `thought`、
`accessibility_tree`、`action`、`url`，并在 trajectory 层提供 `goal`、`outcome`、
`environment`。在调用模型前已经修正，因此不存在使用空证据得出的伪结果。

最终 Gate 版本：

- 将官方真实字段映射为稳定 Frame；
- 使用 content-addressed SQLite/FTS 保存 Frame 与 `next-state` relation；
- 每题由官方随机 `query_invocation_id` 形成独立逻辑 Context，只挂载该题官方 haystack；
- query 只接收问题正文和可选图片，不接收 gold、题型、答案或 scorer 元数据；
- 以冻结的 FTS/BM25 规则返回最多 20 个 source-linked Frame；
- 不调用隐藏的检索/回答模型。

## Gate 结果

- Python 3.11 官方隔离环境建立成功；
- 3 项 adapter 单元测试通过；
- 官方数据 checksum 与 `validate_data.py --tier small --no-check-screenshots` 通过；
- 官方 web 首题：100 trajectories，1737 Frames，1637 relations，投影 20 Frames；
- 官方 enterprise 首题：100 trajectories，3358 Frames，3258 relations，投影 20 Frames；
- 两题均返回 20 个稳定 source refs；共享 SQLite/FTS Gate 索引约 188 MiB；
- substitute reader 多模态预检通过：请求 `qwen3.8-max-preview`，物理模型
  `qwen3.8-max`，能够读取 question image；
- substitute judge 二元输出预检通过：同一 requested/physical model，`medium` reasoning；
- `gpt-5.6-sol` Chat Completions 预检连续出现代理上游 TLS handshake 500，因官方 judge 固定
  使用 Chat Completions，未修改官方 scorer，亦未将该失败计为实验结果。

## 边界

该 adapter 验证公开记忆任务上的结构化表示与投影，不冒充生产 Morphz Runtime。生产二进制、
Context transaction、跨 Session、并发冲突与恢复由 ME-06 验证；完整 Agent 能力由 ME-08 验证。
