# Morphz 论文实验总账

> 最后更新：2026-08-26
> 维护规则：任何状态、协议或结果变化都更新本表；不得删除已执行实验的历史记录。

## Runtime 基线

论文、路演和公开 Benchmark 的新实验当前默认 Runtime 源码基线为 [`paper-eval-runtime-v4`](./runtime_baseline_v4.md)，对应完整 commit `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`。历史 v3 继续对应 [`f875b93869282a14b738edec2f3a4069fd003600`](./runtime_baseline_v3.md)，历史 v2 对应 [`03a32f864a3c38026672b4076855137e0bbb5627`](./runtime_baseline_v2.md)，历史 v1 对应 [`cbfc540cedcdba8fba2dcbfbe6f37f1cc37d6df5`](./runtime_baseline_v1.md)。每个 Run 必须记录实际 Runtime 与实验包 commit；后续修复不得静默改写既有基线或追改历史结果。

## 新实验统一运行约束

- 主模型：`gpt-5.6-sol`；reasoning effort：`max`；
- Provider transport：CLIProxyAPI 兼容的 OpenAI Responses 路由；精确物理模型必须
  校验为 `gpt-5.6-sol`，且 `fallback=false`；
- 授权模式：隔离实验节点使用 `full-access`，episode 中不得混入人工审批等待；
- 隔离：专用 Morphz 节点、专用数据库、专用 Context；不同 arm/run 使用独立可写
  状态，不读取共享 Context、产品数据库或历史 Session；
- `full-access` 不改变公开 Benchmark 自身的 sandbox、网络、数据和工具规则。

## 总览

| ID | 实验 | RQ | 优先级 | 当前证据 | 状态 | 当前协议 | 下一门槛 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ME-00 | 实验基础设施与校准 | 全部 | P0 | 已供 ME-01 真实 Pilot 使用 | `protocol-draft` | — | manifest 自动记录 Runtime/runner commit、dirty diff hash 与持久备份身份 |
| ME-01 | 核心机制拆解对比（结构化 Context 与结果回流消融） | RQ2 | P0 | `D` + Stage A `P`（15/15） | `pilot-complete` | [`p1.1 candidate`](./me_01_structured_context_reentry_pilot_protocol_p1.md) | 记录天花板并关闭同类扩样；修订主张后决定是否需要 p2 |
| ME-02 | 表示形式拆解对比（等信息表示形式消融） | RQ1 | P0 | `F + P`（p1.1 18/18；三组各 6/6） | `pilot-complete` | [`p1.1 frozen`](./me_02_equal_information_representation_protocol_p1.md) | 不重复容易样本；冻结更长组合压力任务后再决定确认性样本量 |
| ME-03 | 非确定性认知求值特征 | RQ3 | P0 | `D + P`（开放 12/12；Context shift 6/6；闭合严格 11/12） | `pilot-complete` | [`p1.1 frozen`](./me_03_bounded_open_context_intervention_protocol_p1.md) | 进入 ME-05 跨模型核心子集；重叠合法集合软干预列为可选 p2 |
| ME-04 | Runtime 权威边界与故障注入 | RQ4 | P0 | `D`（8/8 cells） | `deterministic-gate-complete` | [`p1 frozen`](./me_04_runtime_authority_fault_injection_protocol_p1.md) | 进入 ME-02；未来 Runtime 基线变化按回归策略重跑 |
| ME-05 | 九模型跨模型普适性 | RQ5 | P1 | 144/144 完整；严格 98/144；ME-03 语义诊断 104/108 | `pilot-complete` | [`p1 result`](./artifacts/me05_nine_model_p1_20260826/RESULT.md) | 结果写入论文；不重复简单样本，进入 ME-06 长程实验 |
| ME-06 | 长期、多 Session、迁移与恢复 | RQ6 | P1 | `F` | `planned` | 历史协议多版 | 固定事件流、基线和隐藏行动评分 |
| ME-07 | 公开 Benchmark 外部验证（A: Terminal-Bench；B: Mem2ActBench） | 外部效度 | P1 | Terminal-Bench 前 40 题四臂 `P` | `pilot-complete` | [`ME-07A 结果`](./artifacts/terminal_bench_four_arm_prior_40_20260825/RESULT.md) | 保留 40 题为系统能力 Pilot；ME-07B 完成许可/环境/适配范围审计 |
| ME-08 | 第二公开 Benchmark | RQ5/RQ6 | P2 | 无 | `planned` | — | ME-07 后选择 |

## 依赖

```text
ME-00 ─┬─> ME-01 ─> ME-05 ─┬─> ME-06
       ├─> ME-02 ───────────┤
       ├─> ME-03 ───────────┤
       ├─> ME-04 ───────────┘
       └─> ME-07 ─> ME-08
```

ME-05 使用 ME-01/02/03 中冻结的核心子集，不重新设计任务；ME-06 只有在核心状态机制及评分器稳定后才扩成长运行。

## 已有材料映射

| 既有材料 | 对应实验 | 证据标签 | 处理方式 |
| --- | --- | --- | --- |
| `morphz_semantic_sexpr_vm_ablation_*` | ME-02 | F | 保留历史结果；正式实验等信息、多模型、更多配对样本重跑 |
| `morphz_bind_if_operator_eval_v1.md` | ME-01/ME-02 | F | 作为 Observation 进入绑定/分支的微基准 |
| `morphz_context_pressure_eval.md` | ME-05/ME-06 | F | 作为容量与跨模型可行性，不当作核心对照 |
| `morphz_context_long_run_eval.md` | ME-06 | F | 提炼任务与失败模式，冻结新协议后重跑 |
| `morphz_concurrent_objective_coordination_*` | ME-04/ME-06 | F | 并发、恢复案例和后续故障 fixture 来源 |
| `morphz_reality_contract_v1_validation.md` | ME-01/ME-04 | F/D | 提炼来源、时序和权威冲突评分项 |
| Rust/CLI/集成测试 | ME-04 | D | 建立“主张—测试—commit”覆盖矩阵 |
| Harbor、Terminal-Bench、π-Bench adapter | ME-07A / 通用能力 | F/P | Terminal-Bench 前 40 题四臂结果登记为外部系统能力 Pilot；不替代机制消融或 Mem2ActBench |

## 状态更新记录

### 2026-08-26

- ME-05 p1 九模型矩阵完成：来自冻结 commit `38d9d84` 的 Stage A 45 cells 与 Stage B
  99 cells 共 144/144 完整，无补跑。冻结严格评分 98/144；ME-02 严格程序轨迹 26/36、
  最终值 32/36，四个未交付均为 Claude Provider safety refusal；ME-03 严格合同 72/108。
  明确标注为事后诊断的语义选择重评分为 104/108，四个未通过均为空响应/Provider 失败；
  所有 104 个可解析选择都满足原始可见 Context 合同。该结果支持跨模型机制可执行性，同时
  显示严格 schema 和程序轨迹仍需要确定性 Runtime 校验。结果与 222 个校验后的原始 JSON
  见 [`artifacts/me05_nine_model_p1_20260826/RESULT.md`](./artifacts/me05_nine_model_p1_20260826/RESULT.md)；

### 2026-08-25

- 建立 ME-05 p1 candidate：固定九个模型全部经 `mini-m4.local` CLIProxyAPI、单候选、
  `fallback=false` 和 `reasoning=max`；使用 ME-02 的四个 S-expression 程序求值任务与
  ME-03 的三个非确定性认知求值任务族，不重新发明题目。Stage A 的每模型 5 个 smoke
  cell 只有在协议和运行器不变且完整性 Gate 全过时才计入最终 144-cell 矩阵，避免重复
  消耗。每个 `model × stage × ME` 使用独立 SQLite/Context；Kimi K3 逐请求记录 usage，
  不设置人为 100 元截断线，只在异常消耗或线路故障时暂停审计。协议见
  [`me_05_nine_model_generality_protocol_p1.md`](./me_05_nine_model_generality_protocol_p1.md)；
- ME-05 p1 Gate 关闭：ME-02/ME-03 的全部确定性正负 scorer Gate 通过；九条 route 的逻辑
  模型、物理模型、custom Provider、CLIProxyAPI endpoint、精确协议、max 请求和零 completion
  均核对通过。Claude 经同一 CLIProxyAPI 绑定为 `anthropic-messages`，其余八个为
  `openai-responses`，没有直接订阅线路。矩阵 runner 的 144-cell 数量、协议替换、错误数量、
  独立数据库和目录复用负例 6/6 通过；完整 `morphz-evals` 93 个库测试和 3 个 Harness 测试
  通过，Clippy `-D warnings` 与 diff-check 通过。审计见
  [`me_05_no_model_and_binding_gate_2026_08_25.md`](./me_05_no_model_and_binding_gate_2026_08_25.md)；
- ME-03 p1.1 真实 Pilot 完成：非确定性条件 12/12 严格满足类型、候选、数量、Context 依据和
  语义约束；六个 Base/Intervention 配对 6/6 发生符合预注册合法集合的变化。确定性控制严格
  11/12；唯一失败选择了正确 `canary`，但把数组 `basis` 输出成字符串，按冻结 scorer
  保留失败且不补跑。相同 task/Context 的两次重复选择一致，未观察到重复间多样性；该结果
  支持“契约允许多值、Context 约束选择”，不支持随机性或高熵输出主张。报告见
  [`artifacts/me03_real_pilot_p1_20260825/RESULT.md`](./artifacts/me03_real_pilot_p1_20260825/RESULT.md)；
- Terminal-Bench 前 40 题四臂结果正式登记为 ME-07A 外部系统能力 Pilot，而不是 ME-05。
  官方 scorer 下原生 Morphz 30/40、同模型 Codex 28/40；每题单次，任务虽已被用户和实验
  统筹观察，但各 trial 的 Agent 使用独立空 Context、没有题目记忆。该结果仍不能当作公开
  榜单或显著优越性结论。ME-05 继续只承担核心机制跨模型验证；ME-07B 保留
  Mem2ActBench 作为与跨 Session 记忆更贴近的外部验证；
- ME-03 p1.1 协议冻结：三个任务的 Base/Intervention 非确定性合法集合分别为 6/5、3/3、
  4/5，所有干预前后集合不相交；每个任务的确定性分数最大值唯一。scorer 对全部合法集合
  正例以及任意文本、未知候选、错误数量、错误 Context 依据和错误确定性值负例均正确判定。
  首次候选 Gate 后、真实模型调用前发现任务数量措辞与确定性单选冲突，且非确定性 Prompt 暴露
  无关 `closed_score`；p1.1 修正后二次 Gate 全部通过。零 completion 精确绑定为
  `gpt-5.6-sol`/max/单候选/no-fallback。报告见
  [`me_03_no_model_gate_2026_08_25.md`](./me_03_no_model_gate_2026_08_25.md)；
- ME-02 p1.1 真实 Pilot 完成：同一 Canonical Program IR 生成的 S-expression AST、
  JSON AST 和 Markdown Program 在六个任务上均为 6/6 严格通过，共 18/18；96 次模型
  请求、78 次工具调用无 Provider 错误，15 个发生工具调用的 episode 均正确回放
  Responses continuation。结果支持 S-expression 作为统一程序/数据表示的可行性和当前
  条件下未观察到退化，不支持其优于另两种表示。三组全通过构成天花板效应，不再机械重复
  容易样本；如需确认性结果，应先冻结更长组合求值、嵌套作用域、共享引用和干扰压力任务。
  p1 因布尔字符串类型错误和缺失 continuation 永久无效并独立保留；p1.1 从冻结 commit
  `f42f906` 全量重跑。报告见
  [`artifacts/me02_real_pilot_p11_20260825/RESULT.md`](./artifacts/me02_real_pilot_p11_20260825/RESULT.md)；
- ME-04 p1 确定性 Gate 完成：八类 Runtime 权威边界与故障注入全部通过；完整 lib
  989/989、6 个精确 `attempt_loop` 跨组件测试 6/6、Runtime Store conformance 5/5，
  模型调用为 0。新增恶意 Observation 正负控制：fake Provider 按恶意文本返回未开放
  的生产 `write` 调用时，完整 `MorphzRuntime` 没有创建目标文件并留下
  `executed=false` 的拒绝 receipt；同一生产工具在授权控制组正确创建文件。该结果只
  支持“文本不能扩大确定性权限边界”，不宣称识别所有 Prompt Injection。每项结果绑定
  实际执行的固定测试二进制 SHA-256；主工作区后续源码变化不会改变既有二进制结果，
  因此本轮标记为 `deterministic-gate-complete`，未来 Runtime 版本只需按回归策略运行。
  协议见
  [`me_04_runtime_authority_fault_injection_protocol_p1.md`](./me_04_runtime_authority_fault_injection_protocol_p1.md)，
  结果见
  [`artifacts/me04_runtime_authority_gate_p1_20260825/RESULT.md`](./artifacts/me04_runtime_authority_gate_p1_20260825/RESULT.md)；
- ME-01 p1.1 Stage A Pilot 完成：五个预注册任务族 × 三个 arm 共 15 个有效 episode
  全部严格通过。`cross_session_continuity` 的有效重跑证明 Session A 与 Session B 真实挂载
  同一个 Context，完整 Morphz 在 A 中形成并修订的 Frame 出现在 B 的行动投影；首次运行
  因 runner 把全部阶段硬编码到 Session A 而永久标记无效。`context_isolation` 证明两个
  Session 分别挂载两个不同 Context，三个 arm 均选择 primary 的 `blue-archive`，未复用
  foreign 的 `red-vault`；完整 Morphz 在两个 Context 分别提交 tenant-scoped Frame。
  runner/scorer 修复提交为 `0e4e643`，新增完整 Session/Context 集合校验，11 项目标测试、
  Clippy 和无模型独立进程 Gate 全部通过。报告见
  [`artifacts/me01_cross_session_continuity_p11_20260825/RESULT.md`](./artifacts/me01_cross_session_continuity_p11_20260825/RESULT.md)
  与
  [`artifacts/me01_context_isolation_p11_20260825/RESULT.md`](./artifacts/me01_context_isolation_p11_20260825/RESULT.md)；
- p1.1 的 15/15 结果构成明确天花板效应。它支持生产机制真实成立、无 Context 压力时未观察
  到最终行动退化，以及跨 Session/Context 隔离能力；不支持优越性、统计非劣效或 Token
  效率结论。停止对同类简单 fixture 机械扩样；现代 Agent compaction 的强基线只放入
  ME-06 长程实验，不加入 ME-01 基础能力 Pilot；
- ME-00 已实际支撑精确模型绑定、独立 SQLite/Context、原始轨迹、确定性评分、校验和与
  Git 归档，因此由 `planned` 更新为 `protocol-draft`。尚未关闭的实质缺口是 manifest 未
  自动记录 Runtime/runner commit、dirty diff hash 和持久备份身份；当前 `morphz --version`
  仍报告 `git unknown`，本轮以二进制 SHA-256 与人工报告补足，不虚假标记为完成；
- ME-01 p1.1 第三个真实 cell `source_authority` 完成：三组均严格保留正式权威来源的
  `R-45 / ev-sa-001`，拒绝较新的未批准草案 `R-07` 和传闻 `R-90`；两个 Morphz arms
  的进程重启成立。完整 Morphz 的 2 次事务和 revision 2 权威政策 Frame 只作为机制轨迹，
  前两组该能力为“不适用”。任务可见输入明确给出了来源权威边界，因此结果支持等语义路径
  的有效性与非退化，不支持优越性。当前三个真实 cell 共 9/9 有效 episode 严格通过，
  天花板效应进一步明确；报告见
  [`artifacts/me01_source_authority_p11_20260825/RESULT.md`](./artifacts/me01_source_authority_p11_20260825/RESULT.md)；
- ME-01 p1.1 第二个真实 cell `supersession_conflict` 完成：三组均严格选择最终权威值
  `/hooks/v3` 和 `ev-sc-003`，没有复用已被取代的 `/hooks/v1` 或 `/hooks/v2`；两个
  Morphz arms 的进程重启成立。完整 Morphz 的 2 次事务和 4 个行动前 Frame 只作为真实
  机制轨迹，不是三组得分，前两组该能力记为“不适用”。本 cell 出现 4 次 Provider HTTP
  500 后由同一 episode 的 Runtime 恢复；另有一次模型响应前的沙箱 DNS 无效启动，完整
  保留且不计分。目前两个真实 cell 共 6/6 有效 episode 严格通过，但存在天花板效应，
  仍不支持优越性结论。报告见
  [`artifacts/me01_supersession_conflict_p11_20260825/RESULT.md`](./artifacts/me01_supersession_conflict_p11_20260825/RESULT.md)；
- ME-01 p1.1 三组真实模型 Smoke 完成：在不制造 Context 压力的
  `delayed_reference` 任务上，`append_only`、`structured_no_direct_reentry` 和
  `full_morphz` 均严格通过并返回完全相同的正确行动。完整 Morphz 使用正式二进制、独立
  SQLite/Context、`gpt-5.6-sol`/max/no-fallback/full-access，实际产生 2 次
  `context_tx` 提交、2 个行动前 Frame，并在进程重启后正确引用回流结果；前两组没有可用的
  `context_tx` 能力，因此该项为“不适用”，原始遥测零计数不是比较得分。该结果支持真实
  接线与简单任务非退化，不支持优越性、Token 效率或容量主张；
  完整 Morphz 的 5 次调用对另两组 3 次调用仅作诊断记录。报告与机器可读证据见
  [`artifacts/me01_real_smoke_p11_20260825/RESULT.md`](./artifacts/me01_real_smoke_p11_20260825/RESULT.md)；
- ME-01 首次 p1 真实运行发现评分器构造缺陷：可见输入没有定义精确动作词，而隐藏 scorer
  要求 `apply_deployment_channel`；模型给出语义正确的 `deploy` 后被误判。该运行完整保留
  但标记 invalid、永久排除。p1.1 将动作词表对三组等量公开后重新运行；归档时另发现
  SQLite WAL/SHM 消失竞态，模型运行和评分已完成，校验和修复后全部清单逐项通过；
- 建立 ME-01 Pilot p1 candidate：冻结候选 `append_only`、
  `structured_no_direct_reentry`、`full_morphz` 三核心 arm，明确 full arm 必须运行生产
  Morphz、真实 SQLite/ContextEngine 与真实 `context_tx`，旧路演的本地 JSON 状态机不得
  作为论文证据；Pilot 改为先跑 5 个 paired cells（15 episodes），Gate 通过后才增加
  第二批 15 episodes，避免未验证 runner 和评分器前消耗大批模型额度。协议见
  [`me_01_structured_context_reentry_pilot_protocol_p1.md`](./me_01_structured_context_reentry_pilot_protocol_p1.md)；
- ME-01 fixture/scorer 无模型 Gate 完成：5 个任务族、三组 15 个正例全部 strict pass，
  非法 JSON、错误来源、伪造 full 提交、只读组提交和输入 hash 漂移 5 类负例全部被拒绝；
  新增默认不影响产品路径的 `MORPHZ_CONTEXT_TRANSACTIONS_ENABLED=false`，从生产 Registry
  移除 `context_tx` 并在 Context 协议中报告不可用。当前仍未实现生产 arm adapters，
  `ready_for_real_model_smoke=false`，本 Gate 没有模型调用。完整记录见
  [`me_01_no_model_fixture_scorer_gate_2026_08_25.md`](./me_01_no_model_fixture_scorer_gate_2026_08_25.md)；
- ME-01 生产 Runtime 内嵌因果 Gate 通过：deterministic fake Provider 下，full arm 通过
  实际 `MorphzRuntime → context_tx → SQLite commit → act projection` 产生 1 次尝试和
  1 次提交，提交 Frame 同时出现在 act 请求与最终 Context；同一生产路径的只读 arm
  对 Provider 隐藏该工具，0 尝试、0 提交、0 Frame。该结果只证明接线真实性，不是模型
  成绩；该阶段尚未覆盖独立进程、跨 Session、重启和重评分，随后由下一 Gate 补齐；
- ME-01 独立进程 Gate 完成：5 个 fixture × 3 arms 的 15/15 接线正例通过；两个
  Morphz arms 的 10/10 episode 均用不同 PID 执行重启前后阶段、从 10 个相互独立的
  SQLite 恢复，跨 Session 同 Context 和双 Context 隔离通过，15/15 原始 observed
  episode 重评分逐字节一致。该 Gate 使用 deterministic fake Provider，真实模型调用为
  0，尚不能作为效果数据；脱敏原始 JSON 与证据索引见
  [`artifacts/ME01_NO_MODEL_GATES_20260825.md`](./artifacts/ME01_NO_MODEL_GATES_20260825.md)。
  下一 Gate 是正式 `morphz` 二进制、精确 Sol/max/no-fallback/full-access 与同 Provider
  append-only adapter 的三臂真实 smoke；
- ME-01 精确模型绑定零调用预检通过：当前 `roadshow-demo-001` Profile 仍解析为
  `custom` CLIProxyAPI 路由、逻辑/物理模型均为 `gpt-5.6-sol`、reasoning=`max`、单候选
  且 `fallback=false`；本次 completion 调用数为 0。记录见
  [`me_01_model_binding_preflight_2026_08_25.md`](./me_01_model_binding_preflight_2026_08_25.md)。
  该检查不替代正式二进制、full-access 与真实请求 usage 审计；
- 完成 `terminal-bench-four-arm-prior-40-v1` 四臂正式运行，160/160 trial 均保留。以
  Harbor/Terminal-Bench 官方评分器为对外主口径：原生 Morphz 30/40（75.0%）、官方
  Codex CLI 28/40（70.0%）、Morphz+v0.5 23/40（57.5%）、Morphz+辩证实践 Mind
  Frame 24/40（60.0%）。四臂均为 `gpt-5.6-sol` / `max`、同任务环境、一次尝试、零重试；
  结果归档见
  [`artifacts/terminal_bench_four_arm_prior_40_20260825/RESULT.md`](./artifacts/terminal_bench_four_arm_prior_40_20260825/RESULT.md)；
- 纠正附加完整性扫描器的地位：本地规则将 Codex 的
  `find / -path /tests -prune ...` 误判为私有测试访问，产生 67.5% 的辅助 strict 值；
  该值不是官方成绩，不再作为对外或主要比较口径，原始审计文件继续保留；
- 决定 Terminal-Bench 当前停在既有前 40 题，不补剩余 49 题、不再运行 89×5；40 题
  作为开发集上的通用 Agent 能力和同环境 Codex 对照，不作为结构化 Context 因果证据，
  论文资源转入 ME-01。完整决策与未来补跑条件见
  [`terminal_bench_2_1_prior_40_stop_decision_2026_08_25.md`](./terminal_bench_2_1_prior_40_stop_decision_2026_08_25.md)；
- 本轮没有启用宿主机历史采样，无法事后恢复完整负载曲线；日志发现一次任务容器自身
  memcg OOM，不是 64 GiB 宿主机耗尽。海外节点现已启用 `sysstat`，每 10 分钟记录
  CPU、内存、Load、磁盘和网络并保留 28 天；下一次运行同时采集容器级资源指标。

### 2026-08-24

- 冻结 `terminal-task@0.5.0` 极简候选：将 v0.4 的任务合同、收敛命令、验证纪律和领域
  守则移出 Harness，只保留 deliverable/evidence/uncertainty/checkpoint/next-action-value
  五类可选认知对象；新增最小干预静态门禁，v0.5 为 4 个作用域、995 字符、0 强命令命中，
  v0.4 原包保留为关闭的历史证据。设计见
  [`terminal_harness_minimal_intervention_design_2026_08_24.md`](./terminal_harness_minimal_intervention_design_2026_08_24.md)；
- 按用户要求完整通读《实践论》《矛盾论》中文原文及注释，记录 93/330 行 Jina 快照、长度
  和 SHA-256；从全文的实践—认识循环、具体分析、主要矛盾/主要方面、条件和转化关系中
  形成独立 `terminal-task-dialectical-practice@0.1.0` Mind Frame。该包不复制长篇原文、
  不含固定任务流程，作为探索性第四 Arm；来源见
  [`dialectical_practice_mind_frame_provenance_2026_08_24.md`](./dialectical_practice_mind_frame_provenance_2026_08_24.md)；
- 新增 `terminal-bench-four-arm-prior-40-v1` 协议：在用户和实验统筹已经观察过、但每个
  Agent trial 均以独立空 Context 启动的两个 20 题 cohort 上，分别运行原生 Morphz、
  Morphz+v0.5、官方 Codex CLI 和 Morphz+辩证实践 Mind Frame，各 40×1、零重试；四臂
  同时各并发 1，总并发 4。该实验用于开发归因，不是公开榜分；协议见
  [`terminal_bench_2_1_four_arm_prior_40_protocol_2026_08_24.md`](./terminal_bench_2_1_four_arm_prior_40_protocol_2026_08_24.md)；
- 完成 `raman-fitting` 三种 Agent 方式的同题单次归因对照：原生 Morphz（明确无
  Harness）raw/strict reward 1.0，18 次模型求值并正常写入结果；v0.4 Harness 继续为
  0 分且无结果文件；官方 Codex CLI 0.149.1 正常创建、校验并提交结果，但因 2D 拟合
  窗口和参数选择得 0 分。该案例排除了“Sol 本身做不了”和“Morphz 必然弱于 Codex”的
  简单判断，也显示 v0.4 的命令式收口文本不应继续加强。后续应提供交付物状态、假设、
  验收证据、下一步价值和终态决定的方法论，由 Runtime 只实现 progress/terminal 与
  产物存在性的通用协议；不得围绕本题继续调 Prompt。结果见
  [`raman_agent_comparison_result_2026_08_24.md`](./raman_agent_comparison_result_2026_08_24.md)；
- 完成 `terminal-task@0.4.0` 唯一允许的 `raman-fitting` 事后收口回归：raw/strict
  reward 均为 0，未创建 `/app/results.json`；Agent 在约第 869 秒返回“还要生成可视化后
  再写最终 JSON”的进度说明，Harbor 因进程正常返回而未记 `AgentTimeoutError`，但任务
  实际未交付。ATIF 为 24 steps、24 次模型求值、1,004,381 input Token；相比 v0.3
  同题单次轨迹的 18 steps / 612,131 input Token 没有改善，不能作因果比较，但足以否定
  v0.4 已解决收口问题。下一方向必须区分 progress/terminal delivery，并对显式任务产物
  建立可执行终态合同；v0.4 已关闭且不得重试。完整结果见
  [`terminal_bench_2_1_harness_v0_4_raman_result_2026_08_24.md`](./terminal_bench_2_1_harness_v0_4_raman_result_2026_08_24.md)；
- 完成 `terminal-task@0.3.0` 固定 registry 顺序第 21–40 题 × 1 次未见开发验证：
  20/20 完成、官方与严格 verifier 均为 11/20（55%），5 个
  `AgentTimeoutError`，输入 16,323,279 Token；其中 `vulnerable-secret` 被
  Provider `cyber_policy` 拒绝并因 Runtime 错分为 `server_unavailable` 循环至超时，
  同时暴露 public Gate 漏检该错误；另有一次 Provider stream 悬挂、三次长程不收敛
  （其中 `train-fasttext` 超时但通过）及五个正常结束的方案错误。当前禁止继续第 41–60
  题，先修复永久错误分类、Gate 覆盖和调用悬挂诊断；完整结果见
  [`terminal_bench_2_1_harness_v0_3_unseen_20_result_2026_08_24.md`](./terminal_bench_2_1_harness_v0_3_unseen_20_result_2026_08_24.md)；
- 用户在查看 `terminal-task@0.3.0` 单题结果后决定不再围绕已观察的
  `torch-pipeline-parallelism` 调试，改为保持 v0.3 与 Runtime v4 不变，验证固定 registry
  顺序第 21–40 题；新批次为 20×1、并发 5、零重试、无上传，不与使用不同 Agent/Harness
  身份的前 20 题拼接；协议见
  [`terminal_bench_2_1_harness_v0_3_unseen_20_protocol_2026_08_24.md`](./terminal_bench_2_1_harness_v0_3_unseen_20_protocol_2026_08_24.md)；
- 完成通用 `terminal-task@0.3.0` 收敛合同及唯一预注册单题诊断：
  `torch-pipeline-parallelism` 仍因 `AgentTimeoutError` 得 0 分，但相比 v0.2 将
  ATIF steps 从 21 降至 17、tool calls 从 35 降至 26，并取得 world size 1/2
  forward、backward 与 parameter-gradient 零误差的调用侧实测；最后一个验证成功后
  没有生成最终答复，问题收敛为缺少可靠的 proof-to-final transition；v0.3 已关闭，
  不再补跑或扩大；详见
  [`terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md`](./terminal_bench_2_1_harness_v0_3_torch_result_2026_08_24.md)；
- 按用户缩小后的停止条件完成 Terminal-Bench 2.1 官方固定顺序前 20 题 × 1 次诊断：
  20/20 完成、官方 verifier 15/20（75%）、0 Runtime/Harness error、0 Provider
  429/503；输入 9,181,663 Token，证明在扩大到 89×1 前必须先分析轨迹和控制成本；
  完整记录见
  [`terminal_bench_2_1_diagnostic_20x1_result_2026_08_24.md`](./terminal_bench_2_1_diagnostic_20x1_result_2026_08_24.md)；
- 五个失败中，`pypi-server` 确认为 Harbor 适配层在 verifier 前关闭
  `keep_running` 服务 I/O 所有者的生命周期错误；第一版“保留服务、终止 Runtime”修复的
  1×1 定向复测仍为 0，证明只保留进程组不够，结果不得拼入 15/20；第二版改为冻结
  Runtime 直至 Harbor 销毁容器，以保留服务输出管道，云端真实 HTTP verifier 边界集成
  测试通过，连同相关测试共 15 项通过；第二版尚未再次调用模型；另外四题目前归因为
  模型方案、资料判断或缺少实际验证，未发现 Runtime/Harness exception；
- 修正严格审计对任务指定的公开 MTEB 上游 URL 的误报；原始审计必须保留，修正结果
  以带新审计器 commit 的独立派生产物保存。该更正不改变 `mteb-leaderboard` 的 0 分，
  批次仍为 15/20；
- 未经用户再次明确确认，禁止启动剩余 69 题、89×1 或 89×5；
- 一次 Terminal-Bench 2.1 运行错误地以 `89 tasks × 5 attempts` 启动，违反了
  “先完成 89×1 诊断、再优化、最后才考虑 89×5”的预定顺序；发现后于
  `2026-08-24 04:28:04 +08:00` 立即停止，14 个完整结果和 5 个中断 trial 原样
  保留，统一标记为 `aborted-nonreportable`，不得拼接或作为成绩；详见
  [`terminal_bench_2_1_aborted_89x5_run_2026_08_24.md`](./terminal_bench_2_1_aborted_89x5_run_2026_08_24.md)；
- 下一步只能在用户明确确认后启动新的 89×1 诊断 Run；完成全轨迹分析、改进和定向
  复测前，不得启动 89×5；
- Runtime v4 海外节点五题真实 Pilot 已完成：raw verifier 3/5（60%），严格反作弊
  审计后为 2/5（40%）；`db-wal-recovery` 因读取 exact solution、private tests 和
  原始任务数据改判 0，正式 89 题批次被阻止；完整报告见
  [`terminal_bench_2_1_pilot_v4_result_2026_08_24.md`](./terminal_bench_2_1_pilot_v4_result_2026_08_24.md)；
- 五份 ATIF 轨迹全部通过官方 validator，五题每步均记录 exact `gpt-5.6-sol` /
  `max`；Provider 429/503/认证/额度错误均为 0，43.2 MB 产物凭据命中 0；基础设施
  Gate 通过，但 anti-cheat Gate 未实现，当前 `formal_v2_permitted=false`；
- `financial-document-processor` 在 v3 Pilot、正式 v1 五次和 v4 Pilot 中形成 7/7
  超时；下一版本须先完成反作弊 Activation/轨迹 Gate，并设计通用的批量文档处理与
  时间预算策略，再重新运行全部五题 Pilot，不能只补跑失败题；
- Terminal-Bench 2.1 已迁移到 OpenAI 支持地区的海外节点 `8.221.120.170`；Codex
  设备授权成功，CLIProxyAPI 发布精确 `gpt-5.6-sol`，正式在线 `preflight` 已核对
  Harbor 0.21.0、Docker、固定 Runtime/Watcher、`max` 与 `full_access` 并全部通过；
- 海外节点 89/89 官方任务 digest 已缓存，固定 5 题 Pilot `install-only` 为 5/5
  完成、0 错误，adapter 测试 7/7 通过；当前允许在用户明确授权后启动 5 题单次
  真实 Pilot，但尚未在新节点调用模型或产生新成绩；
- 修正 Linux Runtime 可复现身份：构建时显式注入 v4 完整 commit，两次导出均得到
  `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67`；基础设施
  commit 更新为 `30a9f1fae1aebc155a550eededbb9bd9ccb39d88`；
- Terminal-Bench 2.1 中国区云节点已完成无模型门禁：89 题官方数据集已缓存，固定
  5 题 Pilot `install-only` 为 5/5 完成、0 错误，Harbor adapter 云端全量测试
  7/7 通过；详见
  [`terminal_bench_2_1_cloud_node_readiness_2026_08_24.md`](./terminal_bench_2_1_cloud_node_readiness_2026_08_24.md)；
- 云节点 CLIProxyAPI 只监听 Docker bridge，长运行由 systemd 托管并通过文件锁防止
  重复启动；中国大陆出口的 Codex device-code 请求被 Provider 以
  `403 unsupported_country_region_territory` 明确拒绝，须先迁移到支持地区节点或提供
  稳定境外上游出口，再完成精确 `gpt-5.6-sol` 在线预检；本轮没有调用模型、没有消耗
  额度；
- 将尚未启动的新论文、路演与公开 Benchmark 实验默认基线提升为
  `paper-eval-runtime-v4` / `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- v4 纳入 Session 模型切换后的定向恢复、`路由 × 账户` Provider 健康隔离、
  持久 Plan 的异步任务边界，以及多项并发取消/恢复测试的确定性收口；
- 默认环境完整 `morphz --lib` Gate 为 984 passed、0 failed、6 ignored，Clippy、
  Store conformance、全目标检查和 Dashboard 160 项测试均通过；
- Linux/AMD64 正式二进制已在固定 Rust `1.97.1` builder 上生成；中国区构建只把
  Rustup/Cargo 传输路径切换到 RSProxy，工具链、Cargo.lock 和最终 SHA-256 仍固定；
- Terminal-Bench 2.1 历史 v1 结果继续保留 v3 身份，不追写为 v4。

### 2026-08-21

- Terminal-Bench 2.1 正式批次 v1 已完成：89 tasks × 5 attempts，445/445 个试次完成，`max_retries=0`，未选择性补跑；
- 官方 verifier 原始结果为 319/445（71.69%），原始 pass@5 为 85.39%；
- 依据 Harbor `unearned_credit` 规则完成逐轨迹审计：8 个成功试次确认直接读取 exact solution/private tests/reference data，另 3 个成功试次按“故意尝试也判失败”的严格规则判 0；
- 对外严格审计结果为 308/445（69.21%），SE 2.19 个百分点，Wilson 95% CI [64.78%, 73.32%]，pass@5 83.15%；
- v1 原始数据与 Harbor reward 原样封存，不追改；完整报告见 [`terminal_bench_2_1_formal_v1_result_2026_08_21.md`](./terminal_bench_2_1_formal_v1_result_2026_08_21.md)；
- 下一公开榜版本须先加入 anti-cheat Activation/Gate、修复缺失 `/app` 的 workspace 启动边界，并优化“任务已完成但 Runtime 未及时终止”的 28 个 timeout-pass 案例；正式 v2 如启动，必须重新运行全部 445 个 trial，不与 v1 混算。

### 2026-08-20

- 完成 Terminal-Bench 2.1 无推理执行门禁：固定 Harbor `0.21.0`、官方 89-task 数据集 commit、Linux/AMD64 Runtime 与等待器校验值；`path-tracing` 的 `install-only` 通过；
- 修正公开榜协议：正式运行默认使用 Harbor registry 的 canonical dataset digest，不再使用本地 `--path`；固定 89 tasks × 5 trials、`max_retries=0`、默认 timeout/resource，并在 Harbor agent kwargs 中显式记录 `reasoning_effort=max`；
- Harbor adapter 已实现 ATIF-v1.7 只读投影并通过官方 validator；下一 Gate 为单任务、单次真实模型 smoke，尚无可报告 Benchmark 成绩；
- 冻结新实验统一运行约束：`gpt-5.6-sol` + `max` + CLIProxyAPI、`full-access`、独立 Morphz 节点/数据库/Context；
- 将尚未启动的新论文、路演与公开 Benchmark 实验默认基线提升为 `paper-eval-runtime-v3`；
- v3 对应 commit `f875b93869282a14b738edec2f3a4069fd003600`；
- 纳入 v2 之后的并发投递、Shared Runtime 恢复、Principal 绑定、Provider Account CAS、响应 continuation 和 Managed SSH 存活边界修复；
- 保留 v1/v2 及既有 DEMO-001 运行的历史身份，不追写为 v3；
- 第一次真实模型 Pilot 前，仍需从 v3 的干净 checkout 重新执行并记录完整验证门禁。

### 2026-08-17

- 将新论文实验与路演 Runtime 默认基线提升为 `paper-eval-runtime-v2`；
- v2 对应 commit `03a32f864a3c38026672b4076855137e0bbb5627`；
- 记录 v1 在 Git 历史作者邮箱重写后的等价 commit `cbfc540cedcdba8fba2dcbfbe6f37f1cc37d6df5`；
- 冻结论文实验 Runtime 基线 `paper-eval-runtime-v1`；
- v1 原始历史中的 commit 为 `45ed92a1535f952cdac1b5b08dcce19b7d627c55`；
- 记录全量测试、release 构建、真实数据库迁移和部署运行验证状态；
- 从该基线开始，核心语义进入实验期冻结，阻塞性修复须建立新的版本化基线。

### 2026-08-11

- 建立实验总计划、总账和三类模板；
- 将历史实验统一降噪为 `D/F` 证据，不再与未来确认性结果混算；
- 确定第一执行目标为 ME-00 → ME-01 Pilot，并行整理 ME-04 的确定性覆盖；
- 尚未启动新的模型实验，也未产生 API 成本。
