# ME-07 STATE-Bench 三强记忆学习产物 Gate

> 日期：2026-08-26
> 状态：`artifact-build-and-reload-gate-complete / official-evaluation-not-run`
> 性质：运行资格与持久化真实性验证，不是效果实验

## 结论

Morphz、A-MEM-compatible 与 Mem0 OSS 均已使用同一条 STATE-Bench 官方成功训练轨迹，
通过各自真实学习路径形成持久化产物；产物关闭后能够由新进程或新实例重载，并返回非空的
`top_k=3` 检索结果。三组学习请求均核验为 `gpt-5.6-sol`、reasoning `max`。

这证明正式三臂实现不再是 fixture、JSON 占位或只读 adapter。它不回答哪一种记忆方法效果
更好，也不提供 ME-07 分数。

## 共同输入

- Domain：`travel`；
- 官方训练轨迹：`1-cancel_economy_domestic`；
- Canonical SHA-256：
  `4d79d0ff440afbfa8d4b71d6ef15c4d24b4907efb332bcc30ea06f4b21eb3b86`；
- Held-out task、答案与 judge 信息均未进入构建过程；
- 正式实验不设置无记忆 arm。

## 真实学习与重载结果

| Arm | 原生学习路径 | 模型调用 | 构建墙钟 | 冻结产物 | 重载检索 |
| --- | --- | ---: | ---: | --- | ---: |
| Morphz | 生产 `context_tx`、Context checkpoint、Recall rebuild/audit | 2 | 128.401 s | SQLite + 二进制/快照哈希 | 2 个活跃 Frame |
| A-MEM | MemGym A-MEM-compatible metadata generation | 1 | 8.335 s | `amem_state.json` | 1 个 Note |
| Mem0 | Mem0 OSS procedural-memory extraction | 1 | 107.238 s | Qdrant + history DB | 1 条 memory |

Morphz 额外核验：1 次 Context transaction 提交、3 个 Recall Frame 文档、Context audit
重放/投影一致、冻结 SQLite 无 WAL/SHM；新进程使用源快照的独立克隆检索。Morphz 两次模型
调用分别完成认知事务和事务后的最终确认，共报告 50,584 tokens。该单轨迹成本只用于
构建预算估计，不能外推为三种方法的正式效率结论。

A-MEM 与 Mem0 还通过了 100 条合成记忆的无模型持久化 Gate：关闭存储、重新实例化后均能
返回 3 条结果。该 Gate 只检查序列化、namespace 与检索合同，不计作模型实验。

## 发现并修复的问题

1. Mem0 procedural memory 写入 `agent_id` scope；旧 adapter 错用 `user_id` 检索，会静默返回
   空结果。现已改为 `filters={"agent_id": ...}`，并由单元测试锁定。
2. Python SDK 对 `mini-m4.local` 选择公网 IPv6 地址时返回 502，而 curl/Morphz 走本地链路。
   第一轮失败完整保留于 `ipv6_route_failure_preserved.json`；固定到同一服务的内网 IPv4 后，
   两个真实 Gate 成功。没有把 A-MEM 吞掉异常后的原文回退当成真实学习成功。
3. 读取 WAL-mode 冻结 SQLite 可能产生新的 WAL/SHM；审计连接已改为 immutable read-only URI，
   保证核验本身不修改冻结源。

## 尚未完成的正式 ME-07

正式效果实验仍需：每个 arm、每个 domain 处理完整 100 条官方训练轨迹；冻结 9 份领域学习
产物；通过锁定的 Azure GPT-5.4 user simulator/judges；再运行
`3 arms × 3 domains × 50 tasks × 5 runs = 2,250 trials`。在这些条件完成前，论文不得报告
ME-07 效果数字，也不得把本 Gate 表述为 Morphz 优于 A-MEM 或 Mem0。
