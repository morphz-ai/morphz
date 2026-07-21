# Morphz benchmark adapters

本目录保存 Morphz 对公开评测协议的适配层，以及与公开评分器共享的任务夹具。它与 `morphz-evals` 的职责不同：

- `morphz-evals` 记录 Runtime 内部的 Objective、Evaluation、Activation、模型请求、工具调用、重启恢复和交付因果；
- `benchmarks/` 让外部评测框架从产品结果、持久工作区和多轮交互角度评价 `Morphz + model` 组合。

任何报告都必须同时给出模型、Provider 协议、Morphz commit、运行配置和重复次数，不能把模型能力归因给 Runtime。

## 当前接入状态

| 基准 | 状态 | 已验证边界 |
| --- | --- | --- |
| Harbor / Terminal-Bench | 任务与 Morphz Agent adapter 已实现 | 官方 Task schema 可解析；Oracle 通过隐藏验证器；完整容器试跑需要 Docker 和 Linux Morphz 二进制 |
| π-Bench | Test Channel / Session / Principal / trace bridge 已实现 | 协议单测通过；生成轨迹可被官方 trace parser 读取；完整 PROC/COMP 需要接入 AppWorld MCP 工具后端 |

## 本地并发基准

ForgeDepot 的 Runtime 内部对照由 `morphz-evals` 执行：

```bash
cargo run -p morphz-evals --bin concurrent_objective_eval -- \
  run autonomous /path/to/profiles.toml /path/to/runs

cargo run -p morphz-evals --bin concurrent_objective_eval -- \
  run objective_guided /path/to/profiles.toml /path/to/runs
```

`autonomous` 只描述产品目标，让模型自行决定是否升级为 Objective；`objective_guided` 明确要求使用 First-Class Objective，但仍不指定数量、边界、依赖或文件分工。两组使用相同项目、隐藏验证器和 Runtime 预算，用来区分“模型是否自然采用机制”和“机制在被明确要求后是否有效”。

Qwen 三次阶段实跑的机器可读摘要见 [`results/forgedepot_qwen_20260720.json`](results/forgedepot_qwen_20260720.json)，分析见 [`../docs/morphz_concurrent_objective_coordination_benchmark_results_v1.md`](../docs/morphz_concurrent_objective_coordination_benchmark_results_v1.md)。结果把产品正确性、结构调度和在线消息交付分开评分。

## 公开基准目录

- [`harbor/`](harbor/)：Harbor custom agent 和 ForgeDepot challenge；
- [`pi_bench/`](pi_bench/)：π-Bench Test Channel bridge、配置示例和协议测试。

后续推荐顺序是先完成 Harbor 容器试跑，再接 AppWorld MCP 完成 π-Bench 单任务、单 persona episode，最后按官方三次重复协议运行全量评测。
