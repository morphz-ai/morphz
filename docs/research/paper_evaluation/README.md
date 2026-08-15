# Morphz 论文实验中心

> 状态：规划阶段
>
> 建立日期：2026-08-11
> 适用论文：*Morphz: Nondeterministic Cognitive Symbol Evaluation over Structured Context*

> 术语基线：Morphz 的正式机器身份是 **S-Expression Cognitive Machine（S 表达式认知机）**；LLM 是非确定性语义处理器，Runtime 是确定性事务内核，Agent 是加载身份与能力后的机器实例。论文标题描述研究问题，不替代这一系统定义。

这里是 Morphz 论文实验的唯一进度入口。产品回归测试可以快速演进；用于论文主张的证据必须遵守冻结协议、完整留痕和结论边界。

## 文档入口

- [实验总计划 v1](./master_plan_v1.md)：研究问题、阶段、优先级、实验依赖和发表门槛；
- [实验总账](./experiment_registry.md)：每项实验的负责人、协议版本、状态、结果和下一步；
- [实验协议模板](./templates/protocol_template.md)：正式运行前冻结假设、变量、样本和评分方法；
- [单次运行记录模板](./templates/run_record_template.md)：记录每个批次的环境、模型、代码和原始产物；
- [结果报告模板](./templates/result_report_template.md)：汇总统计、失败分类和论文可支持结论。

## 两条评测轨道

### A. 产品与 Runtime 回归

目的：发现错误、验证实现、支持快速迭代。协议可以随实现演进，结果可以作为工程证据或可行性证据，但不能自动升级为论文的确认性证据。

现有入口包括 `morphz-evals`、`benchmarks/` 和 `docs/morphz_*_eval*.md`。

### B. 论文确认性实验

目的：回答预先声明的研究问题。每项实验必须满足：

1. 有唯一实验编号和冻结的协议版本；
2. 预先指定主要指标、对照组、排除规则和停止条件；
3. Pilot 与 confirmatory 批次隔离；
4. 模型、Provider、解码参数、Runtime commit、dirty 状态和预算完整记录；
5. 原始输入、响应、工具轨迹、状态快照、评分器输出和错误均落盘；
6. 失败样本不得删除，服务故障与模型失败按协议分别处理；
7. 协议或评分器发生实质变化时提升版本，旧结果不覆盖、不混算；
8. 只有 `confirmatory-complete` 或 `external-complete` 的结果才能支撑论文定量结论。

## 证据标签

| 标签 | 含义 | 可以支持的表述 |
| --- | --- | --- |
| `D` | 确定性实现/故障测试 | Runtime 实现满足某项可机械验证的性质 |
| `F` | 可行性探针或历史探索 | 机制曾在有限条件下工作 |
| `P` | Pilot | 任务、指标和样本量设计可行；不能作为最终显著性结论 |
| `C` | 冻结协议后的确认性实验 | 在声明范围内支持或反驳论文假设 |
| `X` | 公开 Benchmark | 提供外部有效性和与公开任务的可比性 |

## 状态机

`planned` → `protocol-draft` → `protocol-frozen` → `pilot-running` → `pilot-complete` → `confirmatory-running` → `confirmatory-complete` → `incorporated`

允许的旁路状态：

- `needs-redesign`：Pilot 暴露构造或评分问题；
- `blocked`：缺少外部环境、预算或实现能力；
- `retired`：研究问题被替代，但历史材料保留；
- `external-complete`：公开 Benchmark 完成且可复现。

## 运行与产物约定

建议 Run ID：

```text
ME-<编号>-<阶段>-<协议版本>-<arm>-<model>-<YYYYMMDD>-<序号>
```

例如：

```text
ME-01-pilot-p1-full-morphz-gemini-3-flash-20260815-001
```

每个 Run 至少产生：

```text
manifest.json          # 环境、版本、模型、预算、fixture 与随机化信息
episodes.jsonl         # 原始 episode 索引及状态
requests/              # 原始模型请求和响应
traces/                # 工具、Ledger、Context 和 Runtime 轨迹
scores.json            # 确定性评分器逐项输出
summary.json           # 本 Run 汇总
run_record.md          # 人类可读运行记录
checksums.sha256       # 关键产物校验值
```

原始 Run 目录只追加、不覆盖。Git 中保存协议、代码、总账、体积可控的机器可读摘要和结果报告；大体积原始轨迹保存到持久实验目录，其绝对或相对位置、校验值和备份状态登记在 Run 记录中。不能再把唯一原始证据只放在 `/private/tmp`。

## 结论纪律

- 首先报告主要指标，不用次要指标挽救主要假设失败；
- 同时报告成功、失败、无效运行和 Provider 故障数量；
- 不把模型能力排名归因于 Morphz Runtime；
- 不把 S-expression 的表面语法等同于论文全部创新；
- 不把 Token 更少等同于系统更好；核心指标是状态是否正确进入后续认知和行动；
- 不从一次最好轨迹概括普遍能力；
- 论文正文中的每个定量数字必须能反查到实验编号、协议版本、结果文件和 Runtime commit。
