# ARC 算法 Harness 实测与接入问题

证据范围：私有 Kaggle Notebook V5、同一 Flash-Next V1、同一 Morphz Runtime
`f38245e906814b33fb4f92edd70534b3a233610f`。六次公开游戏尝试已完成；不是
排行榜提交。数值和后审结论分别保存在 `algorithm-results-2026-10-24.json`。

## 1. 观测已进入请求，但原生图像没有进入候选推理

v0.3.0 的固定 Harness 先调用 `read` 读取 `frame.png`，再通过 lexical captures
向 `infer` 传递 `picture`。实际出站请求只有附件元数据，没有原生 image block。
完整十六进制像素矩阵仍然在请求内，不能描述为“模型没有看到任何棋盘数据”。

本机真实 Runtime 加 mock provider 可重现这一投影行为；V5 的三次候选尝试
均为零条 image-bearing 请求，对照组各有三条。它是当前 Harness 集成路径的
限制，不足以直接断言整个 Runtime 的图片读取功能失效。

v0.3.1 使用实验专用 provider adapter，只投影已经在当前请求中以 SHA-256
明确捕获的当前 PNG，并记录实际出站适配回执。未修复或宣称修复 Runtime
全局附件语义。测试验证未捕获文件不能被替换进请求。

## 2. 输出截断后的空 final 回复造成恢复空转

ft09 候选第一次长度截断后曾成功续写一次合法 request，执行一个动作；第二轮
发生长度截断，之后反复收到只有空白 final content 的 HTTP 200/stop 回复，
直到 600 秒预算耗尽。离线统计为 28 条已完成的 empty-stop 回复。

日志可见：`model response contains neither non-empty content nor tool calls`。
这不是数学求解器搜索失败；该次尝试从未进入 GF(2) 或 A*。

需要区别两层：provider 确实没有返回有效 final；Runtime 没有及时终止或有效
恢复重复空回复。不能把私有 reasoning 字段当成 final 内容直接执行。

v0.3.1 的实验性缓解措施是把窄语义节点配置为非 thinking、受约束 JSON 输出，
并在重复空回复达到三次时判定接入失败。它改变了推理策略，不是同策略算法
消融对照，也不是 Runtime 全局续写修复。

## 3. ls20 对照组提前结束是 provider 拒绝，不是正常完成

实际在 378.296 秒、16 个动作后终止。最后请求收到：

`HTTP 400: Assistant tool call function.arguments must be valid JSON.`

当时进程返回 0，旧 runner 的 `valid_run=true`、`runtime_returned` 没有捕获
这个终止条件。原始回执不覆盖，后审单独标为无效完整预算对照。

部分 tool-call arguments 的截断/历史组装可能相关，但仅凭本轮证据不能认定
某一具体源码行为就是唯一根因。新 runner 会独立检查终止 provider 错误，
不能继续用进程码代替任务状态。

## 4. 方法选择与假设仍然是瓶颈

- ls20 候选在没有 ACTION6 的情况下提出 toggle；模块拒绝，未提交该动作。
- vc33 候选提出的二元切换假设不满足“双击恢复”；模块给出实际反例并停止。
- 这些拒绝证明前置假设校验在工作，不证明已经建立正确游戏模型。

v0.3.1 根据真实 available_actions 隐藏不适用方法，向语义节点传递前次请求、
真实动作参数、像素差分和反例；新增主动运动辨识后再 A* 的有限算法入口。
仍不把像素目标、模型内可达路径或算法返回成功当成官方关卡成功。

## 5. 评测边界

V5 对照组曾在 full-access shell 中执行 `cd /root` 或 workspace 以外的
`find` 路径查找。人工审查尚未建立读取游戏源码的证据，但这不是封闭防作弊
沙箱，不能据此宣称严格隔离的性能对照。候选的固定计算节点只使用其 workspace
可见轨迹和受限本地动作接口；控制端未读取环境实现来设计已知关卡解法。

私有运行、GPU 就绪、HTTP 200、Harness 绑定、算法入口执行、真正搜索、
过关、完整 WIN、正式排行榜评分是不同证据层级，报告必须分别列出。

## 6. V6 实测暴露固定 Program 推理预算

v0.3.1 实际发出的 16 条请求均带捕获绑定的原生图像，HTTP 200、有效 JSON、
stop 正常结束；但两个游戏均在第 9 个 infer 前终止：
`program exceeds the infer limit of 8`。源码 `morphz/src/sexpr_eval.rs` 中
`MAX_PROGRAM_INFERS=8` 是固定的单个 Program 额度，不是配置项。

ft09 为 5 动作 / 79.136 秒，ls20 为 48 动作 / 82.164 秒，均为 0 关、0 次
数学搜索。原始 `valid_run=true` 再次不等于有效完整评测；后审明确标为无效。
新 runner 也会把 Runtime Evaluation 失败本身纳入 invalid_reasons。

v0.3.2 不修改 Runtime 二进制或上述额度。每个有限 Program 改为 4 次推理，
评测驱动最多发起 16 个独立 Evaluation，保持同一 root Session、DB、workspace
和同一局引擎。Program 的持久预算不被重置；整局仍受 600 秒 / 200 动作限制。
每段请求单独存档，create-mode 写入不会覆盖历史；错误停止而非伪装为正常接续。

同时加入 model-free 连通区域追踪节点，避免相同颜色的玩家、目标、UI 被整个
合并。它按真实图像位移和后续预测检验建立模型，再对可见同色区域做有界 A*
探索。候选目标仍然只是假设；追踪合并、运动矛盾和引擎边界均会停止旧计划。
