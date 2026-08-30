# Morphz 论文实验中心

> 状态：论文证据已闭合（ME-01～ME-08 已在各自证据边界内进入中英文稿；ME-07 三系统
> 正式批次与 Mind Frame 迁移审计已完成；ME-08 当前论文证据是两组各自完整 89 题的相同条件
> 配对，stable-schema Prefix Cache 89×2 A/B 发布 Gate 另已闭合并作为候选基线补充；ME-09 r6
> 无 Harness 共享 Context 补充实验已完整闭合，但不追改当前论文）
>
> 建立日期：2026-08-11
> 适用论文：*Morphz: Nondeterministic Cognitive Symbol Evaluation over Structured Context*

> 术语基线：Morphz 的正式机器身份是 **S-Expression Cognitive Machine（S 表达式认知机）**；LLM 是非确定性认知求值器，Runtime 是确定性事务内核，Agent 是加载身份与能力后的机器实例。论文标题描述研究问题，不替代这一系统定义。

这里是 Morphz 论文实验的唯一进度入口。产品回归测试可以快速演进；用于论文主张的证据必须遵守冻结协议、完整留痕和结论边界。

## 当前权威入口

- [论文证据与稿件收口报告](./paper_finalization_report_20260827.md)：当前稿件提交、ME-07/ME-08 权威数字、静态审计、ME-09 排除边界与仅剩发布元数据；
- [预印本发布审计 Gate](./preprint_release_audit_20260826.md)：最终 89 题、双语论文、作者元数据、敏感信息和限定主张的发布检查清单；
- [论文主张—证据矩阵](./paper_claim_evidence_matrix_20260826.md)：中英文稿数字与主张的唯一入口；
- [实验总账](./experiment_registry.md)：每项实验的状态、协议、结果和历史变更；
- [实验总计划 v1](./master_plan_v1.md)：研究问题、阶段、优先级、实验依赖和发表门槛；
- [Runtime 实验基线 v4](./runtime_baseline_v4.md)：ME-06 与 ME-08 使用的冻结 Runtime 源码基线；
- [ME-05 九模型跨模型结果](./artifacts/me05_nine_model_p1_20260826/RESULT.md)：144/144 完整，严格合同与事后语义诊断分开报告；
- [ME-06 长程 paired 结果](./artifacts/me06_long_horizon_p11_20260826/RESULT.md)：两臂 3/3 fixture、24/24 最终字段、3/3 行动；Morphz 额外提供跨 Session 状态、Context 事务、冲突重读、重启恢复、隔离与因果审计；
- [ME-07 当前 v2 协议](./me_07_state_bench_protocol_v2.md)：STATE-Bench Agent Learning 上公开 Agent 系统 Morphz、Letta 与 Mem0-backed reference agent 的端到端对照；使用更新版 GPT-5.6 Sol 评测器，不冒充官方历史榜分；
- [ME-07 三系统正式结果与 Mind Frame 迁移审计](./artifacts/me07_public_agent_systems_formal_one_run_20260827/README.md)：150 paired tasks/450 terminal trials；Morphz 81.33%、Letta 62.00%、Mem0 64.00%；150/150 Morphz trace Gate 通过；
- [ME-07 Letta 训练失败与恢复 Gate](./me_07_letta_training_failure_and_recovery_20260826.md)：保留原始活动 Context 膨胀失败，验证公开 `reset-messages`、原子 checkpoint 与恢复语义；正式 Letta 训练使用该已冻结路径；
- [ME-07 历史 v1 协议](./me_07_state_bench_protocol_v1.md)：A-MEM-compatible 旧方案已被 v2 取代，仅保留审计；
- [ME-07 无模型 Adapter Gate](./artifacts/me07_state_bench_adapter_gate_20260826/RESULT.md)：官方 300 条训练轨迹、版本锁、extension discovery、检索往返与固定 top-k 全部通过；模型调用为 0，不作为效果结果；
- [ME-07 历史 v1 学习产物 Gate](./artifacts/me07_state_bench_artifact_gate_20260826/RESULT.md)：Morphz、A-MEM、Mem0 的旧 Gate 仅证明 v1 路径，不能替代 Letta v2 Gate；
- [ME-07 历史 GPT-5.4 访问 Gate](./me_07_locked_evaluator_access_gate_20260826.md)：只记录 v1 阻塞；v2 已改用更新版评测协议，不再等待该旧评测器；
- [ME-07 Benchmark 重选决策](./me_07_benchmark_reselection_decision_20260826.md)：保留初次选择历史；当前 arm/evaluator 以 v2 协议为准；
- [ME-07 superseded LongMemEval 协议与取消边界](./me_07_longmemeval_v2_small_protocol_v1.md)：未经授权替代模型运行已中止，任何局部结果均不引用；
- [ME-08 当前 Runtime 完整 89 题结果](./artifacts/me08_current_runtime_d6e6d80_all89_20260828/RESULT.md)：Morphz 72/89（80.90%），Codex 74/89（83.15%），配对差 −2.25pp、95% CI [−10.11,+5.62]、双侧精确 `p=0.791`；Morphz 总逻辑词元少 31.5%、墙钟短 24.7%；本轮缓存与成本数据受已确认的显式缓存封装缺陷影响，仅保留作工程诊断，不进入论文结论；
- [ME-08 stable-schema Prefix Cache 同期 A/B](./artifacts/me08_prefix_cache_ab_89adf73_all89_20260830/RESULT.md)：Control 72/89、Treatment 71/89，配对 6:5、双侧精确 `p=1.0`；输入缓存命中率 29.88%→86.27%，未缓存输入减少 81.27%，178/178 隔离与完整性 Gate 全过。发布 Gate 通过，作为新候选基线交论文任务复核；墙钟未改善且 Treatment 有一例独有 AgentTimeout，本次不直接修改论文；
- [ME-08 Prefix Cache A/B verifier timeout 事后复评](./artifacts/me08_prefix_cache_ab_89adf73_verifier_recheck_20260830/RESULT.md)：原 task digest、原官方测试、零模型调用，按源 DB 与最终文件 SHA-256 恢复交付物后顺序复评；三个纯 verifier timeout 误伤恢复为 Control 74/89、Treatment 72/89，Treatment 的混合 Agent+Verifier timeout 最终文件也通过，最终状态诊断为 74/89 对 73/89。正式 72/89 对 71/89 保持冻结，不回写或拼接；
- [ME-08 当前 Runtime 单臂补充刷新](./artifacts/me08_current_runtime_2b01310_all89_20260828/RESULT.md)：无 Harness、隔离 Context、89/89 完整；69/89（77.53%）。Edge/background 与 keep-running 定向任务通过，但 7 个 Agent 超时中暴露 Harbor 外层超时后容器内 Runtime 继续进入 verifier 相位的独立缺陷；仅作工程补充，不替换论文 72/89 对 74/89 的冻结同期配对；
- [ME-09 r6 无 Harness 共享 Context 完整 89 题结果](./artifacts/me09_shared_context_full_r6_d6e6d80_max_sessions_50_20260828/RESULT.md)：与当前 ME-08 使用同一 Runtime，一个 Agent/共享 Context、八 Session/Target、并发 8、`max_sessions=50`；官方 70/89 对同 Runtime 隔离 Context 72/89，配对差异不显著；115 次 Context transaction、E3 为 0，总逻辑 Token 为 3.127×；9 个超时异常中 8 个计零。89/89 均无 Harness，仅作有效补充实验，不追改当前论文；
- [ME-09 r4 历史诊断结果](./artifacts/me09_shared_context_full_r4_working_set_one_20260828/RESULT.md)：历史得分 70/89，但 89/89 Evaluation 误绑定 `terminal-task@0.5.0`；与无 Harness 的 ME-08 不是单变量对照，不进入当前论文；
- [ME-09 历史探索性实验中止审计](./me_09_shared_context_interim_stop_audit_2026_08_27.md)：额度截止前 43 题旧前缀、跨 Session Frame 引用审计与停止判定；不与 r4 拼接；

## 基线、历史与工程审计入口

- [Runtime 实验基线 v2](./runtime_baseline_v2.md)：历史的 2026-08-17 Runtime 基线；
- [Runtime 实验基线 v1](./runtime_baseline_v1.md)：历史基线及 author/committer 重写后的 SHA 映射；
- [ME-08 历史前 40 + 后 49 合并结果](./artifacts/me08_terminal_bench_all_89_20260826/RESULT.md)：Morphz 70/89、Codex 73/89；仅作历史审计，不是当前论文主结果；
- [ME-08 历史 `ad60e` Morphz-only 刷新](./artifacts/me08_postfix_all89_ad60e_concurrency8_20260826/RESULT.md)：73/89；非同期单臂工程测量；
- [ME-08 历史 `4bbc3d63` Morphz-only 刷新](./artifacts/me08_terminal_bench_postfix_all89_20260827/RESULT.md)：72/89；随后已有完整同期 Codex 运行，故不再单独承担当前主结论；
- [Terminal-Bench 2.1 执行就绪记录](./terminal_bench_2_1_execution_readiness_2026_08_20.md)：Harbor、数据集、Linux/AMD64 产物、ATIF、模型路由和隔离门禁；
- [Terminal-Bench 2.1 正式批次 v1 结果与审计](./terminal_bench_2_1_formal_v1_result_2026_08_21.md)：89 题 × 5 次正式运行、严格 reward-hacking 审计、Token、时延、异常与优化建议；
- [Terminal-Bench 2.1 误启动 89×5 批次停止记录](./terminal_bench_2_1_aborted_89x5_run_2026_08_24.md)：记录违反“先 89×1 诊断”顺序的误启动、立即停止、产物封存和后续禁止拼接规则；
- [Terminal-Bench 2.1 前 20 题单次诊断](./terminal_bench_2_1_diagnostic_20x1_result_2026_08_24.md)：固定顺序前 20 题 × 1 次、成本、失败归因、审计更正与定向修复计划；
- [Terminal-Bench 2.1 Harness v0.3 未见 20 题验证协议](./terminal_bench_2_1_harness_v0_3_unseen_20_protocol_2026_08_24.md)：固定 registry 顺序第 21–40 题、20×1、并发 5、零重试与独立结果边界；
- [Terminal-Bench 2.1 Harness v0.3 未见 20 题结果](./terminal_bench_2_1_harness_v0_3_unseen_20_result_2026_08_24.md)：20/20 完成、11/20 严格通过、Token、超时与 Provider/Runtime/模型分层归因；
- [Terminal-Bench 2.1 Harness v0.4 单题回归协议](./terminal_bench_2_1_harness_trial_protocol_v0_4.md)：用 `raman-fitting` 定向验证最佳有效产物与 proof-to-final 收口协议，不计入未见题成绩；
- [Terminal-Bench 2.1 Harness v0.4 单题回归结果](./terminal_bench_2_1_harness_v0_4_raman_result_2026_08_24.md)：0 分、无任务产物、24 步和 100.4 万输入 Token；证明纯文本收口建议不足，v0.4 已关闭；
- [`raman-fitting` 三种 Agent 方式归因对照](./raman_agent_comparison_result_2026_08_24.md)：同一题、模型和环境下，原生 Morphz 1 分、v0.4 Harness 0 分、官方 Codex 0 分；区分未交付、正确交付和错误拟合，并给出通用方法论与终态协议方向；
- [Terminal Harness 最小干预设计与 v0.5](./terminal_harness_minimal_intervention_design_2026_08_24.md)：逐项拆解 v0.4、冻结可选认知状态边界和静态干预门禁；
- [《实践论》《矛盾论》Mind Frame 原文通读与来源](./dialectical_practice_mind_frame_provenance_2026_08_24.md)：记录两篇完整原文读取、快照哈希、概念综合和最终哲学 Frame 的取舍；
- [Terminal-Bench 2.1 既有前 40 题四臂对照协议](./terminal_bench_2_1_four_arm_prior_40_protocol_2026_08_24.md)：原生 Morphz、极简 v0.5、官方 Codex、辩证实践 Mind Frame 四臂各 40×1 的冻结比较边界；
- [Terminal-Bench 2.1 前 40 题停止决策](./terminal_bench_2_1_prior_40_stop_decision_2026_08_25.md)：冻结 Morphz 75% vs Codex 官方 70% 的同环境主口径，记录不补剩余 49 题、不再运行 89×5、资源监控与后续恢复条件；
- [ME-01 结构化 Context 与结果直接回流 Pilot 协议 p1](./me_01_structured_context_reentry_pilot_protocol_p1.md)：三核心 arm、五任务族、低成本两级 Pilot、生产 Runtime 真实性与重评分 Gate；
- [ME-01 fixture 与评分器无模型 Gate](./me_01_no_model_fixture_scorer_gate_2026_08_25.md)：15/15 正例、5/5 负例、生产只读 Context capability；尚未允许真实模型 smoke；
- [ME-01 p1.1 三组真实模型 Smoke](./artifacts/me01_real_smoke_p11_20260825/RESULT.md)：三组 3/3 严格通过；完整 Morphz 实际完成两次 Context 事务、Frame 回流、进程重启和正确行动；该简单任务只支持机制真实性与非退化结论；
- [ME-04 Runtime 权威边界与故障注入 p1](./artifacts/me04_runtime_authority_gate_p1_20260825/RESULT.md)：八类确定性 Cell 全部通过；完整 `MorphzRuntime` 的恶意 Observation 正负控制证明文本不能扩大 Runtime 工具边界；各测试证据绑定实际执行的固定二进制 SHA-256；
- [ME-02 等信息递归表示对照 p1.1](./me_02_equal_information_representation_protocol_p1.md)：由同一 Canonical Program IR 生成 S-expression、JSON AST 和 Markdown 三组；只改变表面表示，不再混入 Kernel 解释强度和任务措辞差异；
- [ME-02 p1.1 No-model Gate 与绑定预检](./me_02_no_model_gate_2026_08_25.md)：6×3 表示 digest、原生 Boolean、隐藏答案泄漏和 scorer 正负例全部通过；零 completion 确认物理模型为 `gpt-5.6-sol`、reasoning `max`、单候选无 fallback；
- [ME-02 p1 首次真实 Pilot 无效记录](./me_02_p1_invalid_pilot_2026_08_25.md)：记录布尔值被建模成字符串和缺失 Responses continuation 的装置错误；18 个 episode 全部保留但不得进入论文结果；
- [ME-02 p1.1 真实 Pilot 结果](./artifacts/me02_real_pilot_p11_20260825/RESULT.md)：6×3 共 18/18 严格通过；支持 S-expression 统一程序/数据表示的可行性和当前条件下不退化，不支持相对 JSON/Markdown 的优越性；
- [ME-03 非确定性认知求值与 Context 干预协议 p1](./me_03_bounded_open_context_intervention_protocol_p1.md)：用多值合同、Context 干预和唯一确定性算子对照区分“受约束非唯一求值”与任意文本或强制随机性；
- [ME-03 p1.1 No-model Gate 与绑定预检](./me_03_no_model_gate_2026_08_25.md)：合法集合多值性、干预集合不相交、闭合唯一值及 scorer 正负例全部通过；零 completion 精确绑定 `gpt-5.6-sol`/max/no-fallback；
- [ME-03 p1.1 真实 Pilot 结果](./artifacts/me03_real_pilot_p1_20260825/RESULT.md)：非确定性求值合同 12/12、Context shift 6/6、确定性对照严格 11/12；唯一失败为语义选择正确但 JSON 字段类型错误，按冻结 scorer 保留失败；
- [ME-01 p1.1 Supersession Conflict](./artifacts/me01_supersession_conflict_p11_20260825/RESULT.md)：三组均正确选择两级 supersession 后的 `/hooks/v3`；累计两个真实 cell、6/6 有效 episode 严格通过，仍只作可行性与非退化证据；
- [ME-01 p1.1 Source Authority](./artifacts/me01_source_authority_p11_20260825/RESULT.md)：三组均正确保留权威来源的 `R-45`，拒绝更新但未批准的 `R-07/R-90`；累计三个真实 cell、9/9 有效 episode 严格通过；
- [ME-01 p1.1 Cross-Session Continuity](./artifacts/me01_cross_session_continuity_p11_20260825/RESULT.md)：有效重跑中，Session A/B 真实挂载同一 Context，三组均正确；首次硬编码 Session A 的运行永久标记无效；
- [ME-01 p1.1 Context Isolation](./artifacts/me01_context_isolation_p11_20260825/RESULT.md)：两个真实 Context 保持隔离，三组均选择 primary 的 `blue-archive`；五任务族累计 15/15 严格通过，p1.1 因天花板关闭同类扩样；
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
3. 预实验（Pilot）与确认性实验（confirmatory）批次隔离；
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
| `P` | 预实验（Pilot） | 小规模试跑，用于校准任务、指标、成本和样本量；不能作为最终显著性结论 |
| `C` | 冻结协议后的确认性实验 | 在声明范围内支持或反驳论文假设 |
| `X` | 公开 Benchmark | 提供外部有效性和与公开任务的可比性 |

## 状态机

`planned` → `protocol-draft` → `protocol-frozen` → `pilot-running` → `pilot-complete` → `confirmatory-running` → `confirmatory-complete` → `incorporated`

允许的旁路状态：

- `needs-redesign`：预实验暴露构造或评分问题；
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
traces/                # 工具、Event History、Context 和 Runtime 轨迹
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
