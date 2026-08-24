# Terminal-Bench 2.1 Harness v0.3 Torch 单题结果（2026-08-24）

## 1. 结论

`terminal-task@0.3.0` 在预先限定的唯一任务 `torch-pipeline-parallelism` 上得 **0 分**，公开
结果将本轮归类为 `AgentTimeoutError`。本轮没有追加任务、重试或修改后补跑。

但 v0.3 并非没有改善。Agent 更早形成产物，减少了跨版本阅读，并完成了当前安装版本下的真实
`LlamaForCausalLM` 验证：world size 1 和 2 的 decoder-layer forward activation、backward
activation 与所负责参数的 gradient 相对本轮自建 reference 均为零误差。最后一个双进程验证成功
后，模型没有紧接着生成最终答复，而是在 Agent 时限耗尽时被终止。

因此，本轮把问题进一步定位为：**v0.3 的语义收敛合同改善了证据路径，但没有建立可靠的
“最后一个实质证据缺口关闭 → 下一次求值立即完成交付”的转换。** 单靠当前提示词合同仍不足以
保证 GPT-5.6 Sol 在长程任务中及时结束。

本轮关闭，不扩大到其他题目，也不把该 0 分作为 Morphz 的公开 Benchmark 成绩。

## 2. 冻结身份

- job：`/opt/morphz-benchmark/source/jobs/2026-08-24__08-43-34`；
- trial：`torch-pipeline-parallelism__XSu9XxL`；
- infrastructure commit：`1638f8b7feffe05f566928d1785e3f0f26469d74`；
- Runtime：`paper-eval-runtime-v4` / `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- Runtime binary SHA-256：`f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67`；
- model：`gpt-5.6-sol`，reasoning `max`，fallback `false`；
- permission mode：`full_access`；
- attempts / concurrency / retries：`1 / 1 / 0`；
- Harness：`terminal-task@0.3.0`；
- Harness source SHA-256：`7e9fb42a80c08280da7c4c6c09126d76ce1ea2ec92eea6518f27917d504b8c11`；
- Harness artifact SHA-256：`ba35a184e8d40f5cad925d66a4c125cfec28dfd9cc94ab06148e563aa5692e4e`；
- trajectory SHA-256：`6ddd83f1f9a61cf53bb181801291e0750828de0bb677c4201877333f2fbc8ce9`。

## 3. 与 v0.2 对比

| 指标 | v0.2 | v0.3 | 观察 |
| --- | ---: | ---: | --- |
| Reward | 0.0 | 0.0 | 均未形成有效完成 |
| Agent exception | `AgentTimeoutError` | `AgentTimeoutError` | 未改善最终状态 |
| Input tokens | 784,337 | 790,493 | 增加约 0.8% |
| Cached tokens | 26,624 | 102,400 | 仅记录，不作为收敛结论 |
| Output tokens | 35,601 | 27,738 | 减少约 22.1% |
| Model attempts with usage | 20 | 20 | 没有减少 |
| ATIF steps | 21 | 17 | 减少约 19.0% |
| Tool calls | 35 | 26 | 减少约 25.7% |
| 可执行证据 | 未完成 PyTorch 行为验证 | world size 1/2 均完成 | 明显改善 |
| 最终答复 | 无 | 无 | 仍是决定性失败 |

v0.3 的探索宽度和工具活动已经下降，输出 token 也明显下降；但长上下文下的模型调用数没有下降，
总 input token 没有改善。缓存 token 受 Provider 缓存命中影响，不能直接解释为 Harness 或架构效率。

## 4. Trajectory 观察

以下观察只基于公开任务说明和 Morphz 自有 Agent trajectory，不读取隐藏 verifier/private tests：

1. 初始容器没有 Python、PyTorch 或 Transformers。Agent 先写出
   `/app/pipeline_parallel.py`，再建立验证环境，没有把首次实现推迟到研究结束。
2. v0.2 比较了七个 Transformers 版本；v0.3 只检查了主分支、v4.40 和 v4.31，随后转向
   当前可执行环境。重复阅读问题显著缓解。
3. 产物为 12,336 bytes，SHA-256 为
   `5d11b16f3a54cb384d3c4483b1955c2f9b7d9e952aa5e2160d9adbdf85372bcc`；随后通过
   `py_compile`、AST 签名检查和 world size 1/2 的连续、平衡 partition 检查。
4. Agent 安装隔离的 CPU PyTorch 与 Transformers，并用小型真实 `LlamaForCausalLM` 做
   world size 1 对照；所有 forward、backward 和 parameter-gradient 最大误差均为 `0.0`。
5. 首次双进程测试只因临时脚本目录隐藏 `/app` 而出现 `ModuleNotFoundError`。Agent 将
   `PYTHONPATH=/app` 加到同一测试调用后，world size 2 对照成功，输出为：
   `forward=0.0 backward=0.0 parameter_grad=0.0`。
6. 成功结果已经关闭本轮自行声明的最后一个重要验证缺口，但 trajectory 在该工具结果处结束，
   没有后续 Agent 最终消息。公开结果随后记录 `AgentTimeoutError`。

上述自建测试是强有力的调用侧证据，但不能替代隐藏 verifier，也不能据此声称题目本应通过。
可以确定的是，本轮 0 分的公开异常是 Agent 超时；不能把 0 分归因于 Provider、凭据、Harness
安装、Context 隔离或审计故障。

## 5. 对收敛机制的判断

v0.3 的四种终态和“行动必须具有决策相关预期价值”是正确方向，但目前仍缺少一个通用的
proof-to-final transition：

> 当最新 observation 已关闭 Agent 自己声明的最后一个实质 acceptance gap，下一次模型求值
> 应首先执行 final-readiness 判断；若产物仍有效且没有新出现的实质风险，就直接返回最终答复，
> 不再开启新的研究、验证或改写分支。

这条规则不需要注入 Terminal-Bench 的 900 秒时限，也不应包含 PyTorch、任务名称或特定工具
顺序。它约束的是“证据满足后的控制转移”，而不是用 Runtime 替模型决定任务完成。

当前单次结果还不能区分以下两种后续实现：

1. 继续强化模型拥有的 Harness 合同，要求显式维护未关闭 acceptance gaps，并在最后一个 gap
   关闭后优先交付；
2. 由 Structured Context 保存结构化的 evidence/gap 状态，Runtime 只把状态变化投影给模型，
   仍由模型判断并生成最终答复。

不建议用任务倒计时、固定阶段或题目专用提示词修补。若以后验证下一版，应先形成新的通用设计和
版本身份，再预注册少量开发题；本轮不自动生成 v0.4，也不补跑。

## 6. 审计

- strict integrity gate：通过；
- public run gate：通过；
- task count / Harness binding / Context、Session 与数据库隔离：通过；
- 0 retry，0 disqualification；
- Provider 429、503、usage limit、auth 和 request failure：均为 0；
- credential scan：完成，未发现凭据落盘；
- 公开结果：1 trial，raw/strict reward 均为 `0.0`，异常为 `AgentTimeoutError`。

完整的公开结果、Gate 和 Morphz 自有 trajectory 见
[`artifacts/terminal_task_harness_v0_3_torch/`](./artifacts/terminal_task_harness_v0_3_torch/README.md)。
