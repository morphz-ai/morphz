# Terminal-Bench 2.1 Harness v0.2 Torch 单题结果（2026-08-24）

## 1. 结论

`terminal-task@0.2.0` 在预先限定的唯一任务 `torch-pipeline-parallelism` 上仍得 **0 分**，并因
`AgentTimeoutError` 在 900 秒 Agent 时限处终止。

v0.2 确实纠正了 v0.1 “没有运行时就只做文件读回并声明完成”的证据缺陷：Agent 安装了最小
Python、执行 `py_compile`、读取公开 Transformers 上游实现并核对接口。但它没有在时限内得到
PyTorch forward/backward 行为证据，也没有提交最终回复。严谨性提高了，收敛、成本和任务完成率
反而恶化。因此关闭 v0.2，不运行 `dna-assembly` 或 `mteb-leaderboard`。

## 2. 冻结身份

- job：`/opt/morphz-benchmark/source/jobs/2026-08-24__07-18-58`；
- trial：`torch-pipeline-parallelism__6YJdaKA`；
- infrastructure commit：`831a1c06a8657b9f029d06321528b2d2fed0c751`；
- Runtime：`paper-eval-runtime-v4` / `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- model：`gpt-5.6-sol`，reasoning `max`，fallback `false`；
- permission mode：`full_access`；
- attempts / concurrency / retries：`1 / 1 / 0`；
- Harness：`terminal-task@0.2.0`；
- Harness source SHA-256：`8ed270e268692d205cd6ba6c5d75b95f4ef88a11e99cc2b35accb6f2cce059d8`；
- Harness artifact SHA-256：`f5461dae8a8ff9c72c5c44da888c88f9602d6a00fda64ab26e67467a6a6c3c73`；
- trajectory SHA-256：`168b686a1753e94ee446baa8968b72ca7ddc5f9fafd2437a4385a8b52e7f591e`。

## 3. 与 v0.1 对比

| 指标 | v0.1 | v0.2 |
| --- | ---: | ---: |
| Reward | 0.0 | 0.0 |
| Agent exception | 无 | `AgentTimeoutError` |
| Input tokens | 167,476 | 784,337 |
| Cached tokens | 6,656 | 26,624 |
| Output tokens | 20,177 | 35,601 |
| ATIF steps | 8 | 21 |
| Agent 路径 | 写文件、静态读回、返回 | 安装 Python、静态编译、上游接口研究、超时 |

v0.2 input token 是 v0.1 的约 4.68 倍。v0.1 的总 trial 时间约 14 分 40 秒，其中包含较长的
verifier 依赖安装；v0.2 单是 Agent 阶段就用满 15 分钟，随后 verifier 继续运行。

## 4. Trajectory 观察

以下观察只基于公开任务说明和 Agent trajectory，不读取隐藏 verifier/private tests：

1. Agent 很早建立了真实产物 `/app/pipeline_parallel.py`，没有因研究而推迟首次实现。
2. 发现容器没有 Python 后，Agent 没有像 v0.1 一样直接结束，而是检查包管理器并安装
   `python3-minimal`/`python3`，随后完成 `py_compile` 和 AST 级签名检查。
3. 因环境仍没有 PyTorch/Transformers，Agent转向下载并比较 Transformers v4.31、v4.40、
   v4.44、v4.48、v4.55 和主分支的 LLaMA 实现。
4. 该比较没有关闭当前任务的关键证据缺口：实际评测依赖版本未知，且没有 forward/backward、
   world size 1/2、激活或梯度的可执行对照。
5. v0.2 的“关键行为必须有可执行证据”被模型解释成了持续扩大证据搜索，而不是在有限时间内
   平衡“交付最可能正确的实现”和“保留未验证风险”。

## 5. 审计

- strict integrity gate：通过；
- public run gate：通过；
- task count / Harness binding / Context 与 Session 隔离：通过；
- 0 retry，0 disqualification；
- Provider 429、503、usage limit、auth 和 request failure：均为 0；
- credential scan：完成，未发现凭据落盘。

本轮 0 分属于 Agent 超时和未完成，不是 Provider、Harness 安装、Runtime 生命周期、隔离或审计故障。

## 6. 下一版通用修订方向

若继续开发 v0.3，应同时保留证据门槛和增加证据预算：

1. 可执行验证仍是首选，但只允许一次有界的环境建立尝试；缺少重量级依赖或实际版本时，不得遍历
   多个假设版本来追求普适兼容。
2. 验证不可得时，应交付最小、最可能正确的实现，明确标记行为未验证，而不是以“不允许声明完成”
   为由耗尽整个时限。
3. 研究必须绑定实际环境或单一权威稳定接口；任务未要求跨版本兼容时，不开启跨版本矩阵。
4. 为探索分支设置明确停止条件：新工具调用必须关闭一个 acceptance gap，否则回到交付与最终检查。

任何 v0.3 运行都必须使用新的 Harness 版本和 artifact hash，不能与本轮结果合并。
