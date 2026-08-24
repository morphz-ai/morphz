# Terminal-Bench 2.1 Harness v0.3 未见 20 题结果（2026-08-24）

> 状态：`completed / product-development evidence / not leaderboard score`
>
> 结果：20/20 完成，11/20 通过，raw = strict = 55%，5 个 `AgentTimeoutError`
>
> 结论：暂不扩大到下一组 20 题；先修复永久 Provider 拒绝分类、Gate 漏检与模型调用悬挂诊断

## 1. 运行范围与身份

本轮严格执行冻结协议中的 registry 顺序第 21–40 题；每题一次、并发 5、Harbor
零重试、无上传。运行期间没有修改 Runtime、Harness、任务指令或评分器。

| 项目 | 固定值 |
| --- | --- |
| dataset | `terminal-bench/terminal-bench-2-1` |
| registry digest | `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` |
| model | 精确 `gpt-5.6-sol`，`max`，无 fallback |
| Morphz permission | `full_access` |
| Runtime | `paper-eval-runtime-v4` / `5e4b0ffcd89245f19d84ec3569605ae27a44e02b` |
| Runtime binary | `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67` |
| Harness | `terminal-task@0.3.0` |
| Harness artifact | `sha256:ba35a184e8d40f5cad925d66a4c125cfec28dfd9cc94ab06148e563aa5692e4e` |
| cloud infrastructure commit | `72fd308ab2471362d667106aa7a0fe04810383d4` |
| attempts / concurrency / retries | `1 / 5 / 0` |
| job | `unseen-20-v03-r1/2026-08-24__13-59-22` |
| 墙钟时间 | 1 小时 31 分 10 秒 |

真实运行前的 exact 20-task `install-only` 为 20/20 成功、零异常；模型、Runtime、Watcher、
Harness、授权和隔离预检均通过。

## 2. 主要结果

- Harbor 原始 reward：`11 / 20 = 55%`；
- 严格完整性 reward：`11 / 20 = 55%`；
- 完整性审计：20/20 完整，0 个 trial 被取消资格；
- 完成性：20/20 trial 结束，5 个 trial 带 `AgentTimeoutError`；
- Context、Session、SQLite 数据库：20 组唯一身份，隔离检查通过；
- Harbor retries：0；
- 输入 Token：16,323,279；缓存 Token：1,438,720；输出 Token：360,425；
- 凭据扫描：0 命中；
- 任务 workspace 或隐藏 verifier 未进入安全归档。

逐题结果：

| # | 任务 | reward | Harness 异常 | 轨迹结论 |
| ---: | --- | ---: | --- | --- |
| 21 | `build-pov-ray` | 0 | — | 自测渲染成功，但官方图像校验失败；方案正确性差异 |
| 22 | `cobol-modernization` | 1 | — | 通过 |
| 23 | `mcmc-sampling-stan` | 1 | — | 通过 |
| 24 | `gpt2-codegolf` | 0 | — | 生成并编译 3924-byte C，但行为校验失败 |
| 25 | `filter-js-from-html` | 0 | — | 自建 XSS 用例通过，官方功能校验失败 |
| 26 | `sam-cell-seg` | 1 | — | 通过 |
| 27 | `mteb-retrieve` | 1 | — | 通过 |
| 28 | `adaptive-rejection-sampler` | 0 | timeout | R 安装完成后，空响应 retry 的模型流悬挂至外部超时 |
| 29 | `vulnerable-secret` | 0 | timeout | Provider `cyber_policy` 永久拒绝；Runtime 错误恢复循环 |
| 30 | `extract-elf` | 1 | — | 通过 |
| 31 | `nginx-request-logging` | 1 | — | 通过 |
| 32 | `make-doom-for-mips` | 0 | timeout | 大范围实现后首次完整编译失败，未在时限内修正 |
| 33 | `configure-git-webserver` | 1 | — | 通过 |
| 34 | `build-cython-ext` | 1 | — | 通过 |
| 35 | `train-fasttext` | 1 | timeout | 产物已满足 verifier，后续继续优化导致超时但仍通过 |
| 36 | `compile-compcert` | 1 | — | 通过 |
| 37 | `fix-ocaml-gc` | 1 | — | 通过 |
| 38 | `gcode-to-text` | 0 | — | 形成并提交猜测文本，但解码答案错误 |
| 39 | `dna-insert` | 0 | — | 自建重构与 Tm 校验通过，官方引物校验失败 |
| 40 | `raman-fitting` | 0 | timeout | 持续试验拟合窗口，未形成任务产物与终态 |

## 3. 失败分层

### 3.1 Provider 安全拒绝与 Runtime 分类错误：1 题

`vulnerable-secret` 的 ATIF 只有用户消息，因为 Provider 在模型输出前返回
`code=cyber_policy`。Morphz 日志中出现 40 次该错误；当前 Runtime 把它归为
`server_unavailable`，健康探针又持续成功，于是产生 38 次“恢复—重新请求”循环，直到
Harbor 的 15 分钟外部时限结束。

这道题的 0 分首先是 Provider 安全审核造成的，并非 Agent 解题能力证据；但 Runtime 把永久
内容拒绝当作暂时服务故障无限恢复，也是明确的错误分类。官方子集分数仍保留 0，不做事后剔除；
仅作诊断时，去掉这一个外部审核样本为 `11/19 = 57.9%`，不能对外替代 55%。

同时，运行完成时的 `public_run_gate.json` 仍报告 Provider 错误全 0、
`provider_clean=true`。这说明 Gate 只覆盖既有 429/503/额度/认证模式，漏掉了 Responses
error event 的 `cyber_policy`。原 Gate 产物原样保存，本报告作为事后审计更正。

### 3.2 Provider/模型调用悬挂：1 题

`adaptive-rejection-sampler` 的 R 后台安装在约 30 秒内成功回流；随后模型连续返回两个空
响应，Runtime 启动 response retry。该 retry 进入 `streaming` 后超过 14 分钟没有结束，
Activation 心跳持续正常，最终由 Harbor 超时终止。证据不支持“后台唤醒丢失”；更准确的
归因是一次模型/代理传输调用长期不返回，而 Runtime 缺少低于整题时限的单次调用悬挂诊断与
中止边界。

### 3.3 长程任务没有及时收敛：3 题，其中 1 题仍通过

- `make-doom-for-mips`：用了 18 个 ATIF step 建立 freestanding runtime 和 linker，第一次
  全量编译以 exit 2 失败，尚未进入修复回合；
- `raman-fitting`：18 个 step 持续比较峰形与拟合窗口，外部超时时仍在执行分析，没有写出
  最终产物；
- `train-fasttext`：21 个 step，不断在模型体积和精度之间尝试更多候选；虽然超时，已有产物
  仍被 verifier 判为通过。

`train-fasttext` 很重要：Terminal-Bench 根据容器产物评分，不要求最终自然语言回复。因此，
此前 `torch-pipeline-parallelism` 的失败不能再简化成“只差最终回复”；没有最终回复是明显的
收敛缺陷，但 reward 为 0 仍可能意味着产物或隐藏要求也未完全满足。

### 3.4 正常结束但任务结果错误：5 题

`build-pov-ray`、`gpt2-codegolf`、`filter-js-from-html`、`gcode-to-text` 和 `dna-insert`
均正常结束并主动提交结果，官方 verifier 为 0。轨迹没有 Runtime/Harness 异常。由于不得读取
隐藏 verifier，本报告只把它们归为“模型方案或自验证覆盖不足”，不臆测私有断言。

## 4. 对 Harness v0.3 的判断

本批 5/20（25%）触发整题超时，其中 4 题失败，说明通用收敛合同尚未把长程探索控制到可接受
程度。另一方面，11 题完成通过，且没有 Context/Session/数据库污染、ATIF 缺失或 Harness
binding 错误，证明执行链与隔离链已经能稳定承载一批复杂任务。

55% 不能与此前固定前 20 题的 75% 直接比较：任务集合不同，且前批使用不同 Agent/Harness
身份。也不能把第 21–40 题的较低分数单独归因于 v0.3。

当前不应继续第 41–60 题。下一门槛是：

1. 把 `cyber_policy` 等永久内容拒绝从 `server_unavailable` 中分离，禁止健康探针触发无意义
   恢复循环；
2. 扩充 benchmark Gate，使 Responses error event 和每类 Provider 失败都进入汇总；
3. 为单次 Provider stream 悬挂加入可观测、可取消的调用边界；这不是给任务规定“几分钟必须
   收敛”，而是防止一个没有任何增量的网络/模型请求占满整题预算；
4. 用这 20 条轨迹设计不依赖具体题目的收敛策略，重点是“先形成最小合格产物、验证通过后停止
   可选优化、连续实验没有新增决策价值时提交当前最好结果”；
5. 修改形成新 Harness/Runtime 版本后，只做代表性定向回归与一组新的未见任务，不在这 20 题
   上反复调参并宣称泛化提升。

## 5. 证据位置

- 冻结协议：
  [`terminal_bench_2_1_harness_v0_3_unseen_20_protocol_2026_08_24.md`](./terminal_bench_2_1_harness_v0_3_unseen_20_protocol_2026_08_24.md)
- 安全归档：
  [`artifacts/terminal_task_harness_v0_3_unseen_20/`](./artifacts/terminal_task_harness_v0_3_unseen_20/)
- 安全压缩包 SHA-256：
  `e09d17d10273162ab595889b32968d7dd9e424beb88ff8df4a3b3cff69890714`
- 云端原始 job：
  `/opt/morphz-benchmark/diagnostic-jobs/unseen-20-v03-r1/2026-08-24__13-59-22`

安全归档只含公开结果、完整性报告和 Morphz 所有的 ATIF trajectory；不含隐藏 verifier、
private tests、任务 workspace、数据库、凭据或 verifier 日志。
