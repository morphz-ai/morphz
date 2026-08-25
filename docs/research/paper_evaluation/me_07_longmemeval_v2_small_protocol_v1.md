# ME-07：LongMemEval-V2 Small 外部记忆验证协议 v1

> 状态：`frozen / adapter-gate`
>
> 日期：2026-08-26（Asia/Shanghai）
>
> 官方代码：`xiaowu0162/LongMemEval-V2@2cc8c540bdb87fe6761629b585e727e1c4704520`
>
> 官方数据：`xiaowu0162/longmemeval-v2@f152293e235517d504809563c833d7190b8c713b`

## 1. 权威 benchmark 与范围

ME-07 固定使用 LongMemEval-V2 **Small 的完整 451 题**，同时覆盖 web、enterprise、五类
长期记忆能力和 abstention 题。Small 与 Medium 使用同一题集，区别是每题 haystack 深度；本轮
不运行 Medium，也不存在官方 Large tier。

Small 原始轨迹文本约 1.2 GB；完整轨迹截图归档约 5.9 GB。Morphz adapter 返回文字证据，
因此只下载官方 questions、Small haystack、trajectories 和问题本身引用的截图，不下载不会被
adapter 或 reader 使用的轨迹截图归档。数据 checksum 和缺失文件检查必须保存。

## 2. 两个 paired arms

1. `no_retrieval`：官方空记忆 backend；
2. `morphz_structured_projection`：按照官方真实字段（`goal`、`outcome`、`thought`、
   `accessibility_tree` 等）将每个 trajectory/state 映射为稳定可寻址 Frame，保存
   trajectory/state source ref 和 `next-state` relation；共享的 content-addressed SQLite/FTS
   Frame 存储避免跨题重复复制原始轨迹，每题则使用只包含官方 haystack 的独立逻辑 Context；
   query 只收到官方允许的问题正文和可选图片，以冻结的 FTS/BM25 投影规则返回最多 20 个
   source-linked Frames。

两组使用完全相同的 reader、judge、问题顺序、并发 1、memory-context ceiling 和 scorer。
ME-07 不再引入第三方完整 Agent 产品，也不调用第二个模型替 adapter 做隐藏检索。

## 3. 机制与主张边界

- 本实验验证结构化 Frame/Relation/Source 表示能够接入公开记忆 benchmark，并测量其对固定
  reader 的外部任务效果；
- adapter 使用 SQLite 保存 Frame、relation 与逐题隔离的逻辑 Context，但不把它冒充生产 Runtime；
- 生产 ContextEngine、`context_tx`、跨 Session、并发和恢复由 ME-06 真实二进制实验验证；
- Terminal-Bench 完整 Agent 产品比较归入 ME-08；
- 不把本实验解释为“S-expression 优于 JSON”，也不把 retrieval 分数等同于全部认知能力。

## 4. Reader/Judge 与榜单边界

官方榜单固定 reader 为 `Qwen/Qwen3.5-9B`，judge 为 `gpt-5.2`（medium）。本机现有
CLIProxyAPI 目录在冻结时不提供这两个精确模型。因此分两级保存：

1. 若能部署精确 reader/judge，则生成可提交的官方兼容结果；
2. 若只能使用冻结替代模型，则仍完成 451 题 paired 因果对照，但标题和论文必须写成
   “LongMemEval-V2 Small task-suite experiment”；不得与官方榜单绝对分数横向比较，也不得提交
   leaderboard。替代 reader/judge 的精确物理模型、协议和 route 必须写入 manifest。

原始 reader 回答、usage、memory projection、judge 输出和官方 scorer 结果全部保留，使未来
获得精确 reader/judge 后可以只重放必要阶段，不重新生成或篡改 memory evidence。

p1 substitute 已在真实调用前冻结：reader 与 judge 均请求
`qwen3.8-max-preview`，CLIProxyAPI 返回的物理模型均为 `qwen3.8-max`；reader 使用官方候选的
`temperature=0.6`、`top_p=0.95`、`top_k=20`，judge 使用 `medium` reasoning 参数。多模态
question image 与 judge 二元输出预检均通过。`gpt-5.6-sol` 的 Chat Completions 线路在预检中
连续返回上游 TLS handshake 500，因此未进入实验；不修改官方 scorer 去迁就 Responses API。

## 5. 运行与统计

- 全 451 题，每个 arm 一次，不重复五遍；
- arm 内并发 1，不在中途改变；
- 按官方 full-set accuracy、non-abstention、abstention 和五能力分类报告；
- paired 差异同时给出 McNemar 精确检验、bootstrap 95% CI 和逐题胜负表；
- query latency、reader Token、memory-context Token 和 Context Frame 数量单列；
- 模型、adapter、service、harness、data 和 scorer 失败分开分类，所有失败保留原始产物；
- 先做每个 domain 各 1 题无模型/真实 reader smoke；通过后仍使用同一冻结协议完成全量。
