# ME-06 真实 smoke 运行器事故记录（2026-08-26）

以下事件均发生在确认性结果产生前，永久保留但不进入效果分数。

## Incident 1：Provider control SQLite 父目录缺失

- Suite：`ME-06-real-p1-20260825T181301.995Z-20100`；
- 现象：精确模型 client 初始化前 `SQLite code 14: unable to open database file`；
- 模型调用：0；
- 分类：harness setup failure；
- 修复：预先创建 `provider-control/`；commit `e909baa`；
- 协议、fixture、模型、并发和评分均未改变。

## Incident 2：不一致的单次调用 timeout 与缺少逐调用落盘

- Suite：`ME-06-real-p1-20260825T191540.943Z-23528`；
- 现象：controlled-compaction 的 S1–S3 已返回，S4 在 600 秒被 runner 终止；
- 问题一：生产 stage Gate 已为 900 秒、单 fixture Gate 为 60 分钟，但 direct baseline
  误用了未写入冻结表的 600 秒局部常量，两臂 wall-clock 约束不一致；
- 问题二：成功调用仅计划在 cell 结束后批量落盘，导致 S1–S3 的完整 model usage/stream
  artifact 未保存，无法区分“无任何 stream 的 service stall”和“已有 stream 的 model timeout”；
- 分类：harness observability/fairness failure，不把未知失败归给模型或状态机制；
- 修复：统一单请求 Gate 为 900 秒；每个成功调用立即落盘；失败立即保存 stream、usage、
  input hash、Token 测量、wall-clock 和可判定的失败分类；
- 原始 suite 不删除、不补写模型产物。

保留产物哈希：

- `model_binding.json`：`ca29edc892cad79c9d76747389493f24467b28bcded6944bceb0984edf8774f3`；
- `raw_events.jsonl`：`38de1fe4859d365bc4524408fbaf183abeb45f711d2eedd095dd1e11de7b0a2a`；
- `active_messages.json`：`68b1779e31d96a6a7ed1887dc0c962ac29c46ce2dd297dcf5046766c959f8488`。

下一次真实 smoke 必须使用新的代码身份和全新目录；不得覆盖上述两个 suite。
