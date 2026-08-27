# ME-06 真实 smoke 运行器事故记录（2026-08-26）

以下事件均发生在有效 paired cell 产生前，永久保留但不进入效果分数。

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

## Incident 3：把固定生产 scaffold 误算为共同任务状态预算

- Suite：`ME-06-real-p1-20260825T204712.830Z-34693`；
- 现象：controlled-compaction 的首个 fixture 已产生 12 checkpoint 结果；生产 Morphz 在 S1
  只有约 2.0k tokens 可变任务证据时，Runtime 已估算完整请求约 19.2k tokens，并因 runner
  将 soft/hard 直接设为 10k/12k 而立即进入 critical maintenance；
- 后果：Morphz 反复提交事务以退休刚产生的 assistant-call Observation，但因当前 root request
  受因果保护且固定 Runtime/工具 scaffold 本身约 17.2k，任何语义维护都不可能把完整请求降到
  12k。该状态不是预注册的长程压力，也不能与 direct baseline 的 10k 任务证据 Gate比较；
- 判定时点：生产臂尚未产生 S1 checkpoint 或可计分结果；看到的是预算装置不可能成立，不是
  某一 arm 的语义成绩。runner 被人工中止，子进程已确认退出，原始目录未覆盖；
- 分类：harness budget-semantics/fairness failure；首个 baseline 单臂结果不构成 paired cell，
  不进入 Pilot；
- p1.1 修复：取消人为 10k/12k 小窗口和 scaffold offset。生产 Morphz 恢复
  196,608/262,144 soft/hard 与 3,000 maintenance reserve；受控基线改为在冻结的 S6 业务
  生命周期边界执行一次 compaction。完整实际请求和 Provider usage 仍全部记录；fixture、模型、
  输出合同、评分、900 秒单请求 Gate、batch concurrency 1 及 S8/S9 预注册并发均不改变；
- p1.1 使用新的 protocol ID、代码身份和全新运行目录，p1 的任何单臂结果不得拼入。

保留产物哈希：

- `controlled_compaction/score.json`：`2ad9811a096a5a3f5f0c3cccbea4f3bf722be8f9a49931ff8ba803d41aca3d7d`；
- `controlled_compaction/arm_report.json`：`a6d4aba9b131d37c15ebe5033ba4262becc5899d6c04e9d9ebd60d8d81f79f06`；
- `full_morphz/agent.stdout.log`：`79eef773716de94f9f4a3f759e0814e259bf1a6f9657a5f8f1db55b009bc377b`；
- `visible_fixtures.json`：`419535bb442fc43d2f87440115135ad0c77c2cf748c1555f32a1bf834f6b4ed5`；
- production Morphz binary：`8cdd58018c93d10fcb41573c0195e0b2d0e24e2b927e6c3ba3f56750e1a071c0`；
- runner binary：`b23ca82c0d75a25a69d4b6f7fafbd6b83ea7466483e936b7727dbccbd01b7239`。

下一次真实 smoke 必须使用新的代码身份和全新目录；不得覆盖上述三个 suite。
