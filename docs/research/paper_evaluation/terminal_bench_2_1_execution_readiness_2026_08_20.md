# Terminal-Bench 2.1 执行就绪记录

> 日期：2026-08-20（Asia/Shanghai）
>
> 状态：`formal-v1-complete / strict-audit-complete`
>
> 本记录范围：工具链、数据集、Linux 产物、Morphz adapter、ATIF、模型路由、权限、隔离，以及一项真实模型 smoke。Smoke 用于验证评测闭环，不作为 Benchmark 总成绩。

## 1. 冻结身份

| 项目 | 冻结值 |
| --- | --- |
| Morphz Runtime | `paper-eval-runtime-v3` / `f875b93869282a14b738edec2f3a4069fd003600` |
| Harbor | `0.21.0` / tag `v0.21.0` / commit `64afbbcb62165950301e1a6407c729aa26d844ff` |
| Terminal-Bench | `2.1` / commit `7131e4375048a0e408a8fb404b5f499d726b695b` / 89 tasks |
| 官方 Harbor dataset ref | `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` |
| 数据集归档 SHA-256 | `aa992a8848a1f3ed5191a34fa72ed5700d67dd9f968413a0e0a567b6188cb527` |
| 模型 | physical model `gpt-5.6-sol` / reasoning `max` / fallback `false` |
| Provider | OpenAI Responses compatible CLIProxyAPI / `mini-m4.local` / 本次解析 `192.168.1.62` |
| 运行权限 | Morphz `full_access`；`shell_environment_policy=remove_sensitive` |
| 容器平台 | `linux/amd64`；Apple Silicon 上由 Docker Desktop 模拟，不改为 ARM64 |

权威机器可读记录见 `benchmarks/harbor/toolchain.lock.json`。

## 2. 已完成门禁

### 2.1 Linux 运行时

- 使用固定 Bullseye Rust builder 构建 x86-64 ELF；
- Morphz SHA-256：`ba9b2e648037917d41b9a4623969fc6c28d473627f5422ca0f4fd2f061b38586`；
- 等待器 SHA-256：`8d016553b42548363444e86796dfee98291af25895b5bf806ea6202141696dce`；
- Morphz 在 `debian:bullseye-slim` 与 `debian:bookworm-slim` 中均能启动；
- 使用 benchmark 配置和假凭据完成一次无联网的完整 Runtime 初始化/EOF 退出，日志确认 SQLite `3.53.3`、`full_access` 和全部工具注册成功；
- Morphz 不动态依赖 `libssl`/`libcrypto`，等待器不动态依赖 `libsqlite`；
- 等待器在合成终态数据库上返回成功。

x86_64 构建曾暴露 Morphz 有意并存的两套 SQLite archive 被 LLD 拒绝的问题。Benchmark Dockerfile 已显式采用“先定义者生效”的既有链接策略；该处理只用于重现源码原有的 hotbundle 设计，不改变 Runtime 语义。

### 2.2 Harbor 与官方任务安装

- `preflight=passed`；Harbor 版本、Docker daemon、运行时架构与校验值均通过；
- `/models` 宿主预检确认 CLIProxyAPI 精确发布 `gpt-5.6-sol`；
- 使用本地路径的开发安装 Gate 和使用官方 Harbor registry 固定 digest 的正式安装 Gate 均通过；
- 正式 `path-tracing` `install-only` 无异常、无模型调用、无 verifier；Harbor job：`jobs/2026-08-20__15-37-43`；
- 正式 job 记录 `source=terminal-bench/terminal-bench-2-1`、canonical task ref、`reasoning_effort=max`、默认 timeout、无 agent/verifier/resource override；
- 任务镜像 `alexgshaw/path-tracing:20251031` 确认为 `linux/amd64`。

### 2.3 ATIF 与审计轨迹

- `MorphzAgent.SUPPORTS_ATIF = True` 已由真实转换器实现，不再是声明性占位；
- Morphz SQLite Event History 只读投影为 ATIF-v1.7 `agent/trajectory.json`；
- 投影覆盖用户输入、模型调用、工具调用/结果、reply、usage、reasoning、物理模型绑定与 Context transaction；
- 合成事件库同时通过 Harbor Pydantic 模型和官方 `TrajectoryValidator`；
- adapter 明确 `SUPPORTS_RESUME = False`，不虚报尚未实现的 Harbor session resume。

### 2.4 权限、凭据与隔离

- `full_access` 是 Morphz 的实验控制，不是 Harbor 或 Terminal-Bench 的官方要求；目的在于排除审批等待与 reviewer 决策对成功率和时延的干扰；
- 当前冻结数据集 89/89 个任务自身声明 `allow_internet=true`，adapter 不修改任务网络政策；
- 每个 trial 使用新的 Harbor 容器、SQLite 数据库、Context 和 Session；runner 检测到数据库复用会直接拒绝；
- benchmark profile 只记录模型、reasoning 和权限 overlay，不复制 endpoint credential；
- launcher 复用现有 `mini-m4.local` 配置，凭据只进入运行进程环境，不写入 profile、命令行或 job manifest；Shell 子进程采用 `remove_sensitive`；
- 出于最小暴露原则，没有把凭据注入与正式任务无关的通用容器做网络探针。真正的容器到 Provider 路径由下一步单任务 smoke 验证。

## 3. 校验结果

以下检查通过：

```text
ATIF projection unit test                         PASS
Harbor Pydantic + official TrajectoryValidator    PASS
Python compilation                                PASS
runner shell syntax                               PASS
git diff whitespace check                         PASS
Linux/AMD64 artifact architecture                 PASS
Bullseye and Bookworm execution                   PASS
benchmark config and SQLite 3.53.3 startup        PASS
dynamic-library portability checks                PASS
exact model route host preflight                  PASS
official task install-only                        PASS
```

## 4. 真实模型 Smoke 结果

第一次调用发生在订阅额度重置前，Provider 返回 `HTTP 429 usage_limit_reached`。该次探针没有模型输出，保留失败记录，不计作任务结果，也没有自动重试或切换模型。

额度恢复后重新启动独立 job：

| 项目 | 结果 |
| --- | --- |
| Harbor job | `jobs/2026-08-20__15-51-27` |
| 任务 | `terminal-bench/path-tracing` |
| attempts / concurrency / retries | `1 / 1 / 0` |
| 模型 | physical `gpt-5.6-sol` / reasoning `max` |
| Reward | `1.0`（单题满分，5/5 verifier tests passed） |
| Harbor exception | `0` |
| Agent execution | 5 分 22 秒 |
| Job total | 6 分 34 秒 |
| Provider input / cached / output tokens | `830552 / 11776 / 9631` |
| ATIF | Pydantic 与官方 `TrajectoryValidator` 均通过 |
| 凭据原文扫描 | `0` 处命中 |

该任务确实由 Morphz Runtime 在真实任务容器内完成：模型检查和反汇编输入程序、生成并编译 `image.c`、运行结果检查；官方 verifier 验证文件存在、可编译、无外部依赖、可执行并满足图像相似度阈值。该结果只说明端到端链路和这一题成功，不能外推到 89 题准确率。

## 5. 下一 Gate

下一步运行预先固定的五题 Pilot，每题一次、禁止重试。用户在成功启动前明确把并发度从 1 调整为 5：

```bash
python3 benchmarks/harbor/run_benchmark.py full \
  --attempts 1 --concurrency 5 \
  --task git-multibranch \
  --task db-wal-recovery \
  --task polyglot-rust-c \
  --task financial-document-processor \
  --task cancel-async-tasks
```

任务清单及选择原则固化在 `benchmarks/harbor/pilot_tasks_v1.json`。Pilot 的目的不是估算最终准确率，而是覆盖多服务系统管理、数据库恢复、跨语言构建、文档/OCR 和异步并发语义，确认 adapter、Runtime、Provider、日志、ATIF 和 verifier 在不同任务类型下仍然成立。选择过程只读取任务元数据和公开 instruction，不读取 solution 或 verifier 实现。

该并发是五个独立 Harbor trial 同时运行，每个 trial 仍使用独立容器、Morphz 进程、数据库、Context 和 Session；它不作为 Morphz 单任务内部认知并发的能力证据。

### 5.1 Pilot 实际结果

第一次启动在 Harbor 任务筛选阶段即失败：注册表任务名缺少 `terminal-bench/` 命名空间。该尝试没有创建正式 job，也没有模型调用。修正选择器并通过单元测试后成功启动：

| 项目 | 结果 |
| --- | --- |
| Harbor job | `jobs/2026-08-20__16-27-08` |
| tasks / attempts / concurrency / retries | `5 / 1 / 5 / 0` |
| 总耗时 | 23 分 25 秒 |
| 平均 Reward | `0.800` |
| 完成 / 异常 | `5 / 1` |
| Provider input / cached / output tokens | `1715779 / 47104 / 102246` |

逐题结果：

| 任务 | Reward | Agent 时间 | 结果 |
| --- | ---: | ---: | --- |
| `cancel-async-tasks` | 1.0 | 6 分 20 秒 | 6/6 verifier tests passed |
| `db-wal-recovery` | 1.0 | 2 分 13 秒 | 7/7 verifier tests passed |
| `polyglot-rust-c` | 1.0 | 5 分 26 秒 | verifier passed |
| `git-multibranch` | 1.0 | 9 分 54 秒 | verifier passed |
| `financial-document-processor` | 0.0 | 20 分钟 | 官方 `AgentTimeoutError`；7/7 tests failed |

失败项不是 Provider、Harbor、容器或 Runtime 崩溃。Agent 在 1200 秒内进行了 37 次已记录模型调用和大量逐文档读取/认知维护，但在超时前尚未创建要求的分类目录与汇总 CSV。该结果作为真实能力与效率失败保留为 0，不补跑、不改 timeout。

人工审计结论：

- 五个 trial 的容器、SQLite、Context ID 和 Session 均独立；
- 五份轨迹同时通过 Harbor Pydantic 与官方 `TrajectoryValidator`；
- 五题均绑定 physical `gpt-5.6-sol`、reasoning `max`、Runtime `paper-eval-runtime-v3@f875b93869282a14b738edec2f3a4069fd003600`；
- Provider 错误与 429 均为 0；
- job 产物中的 CLIProxyAPI 凭据原文命中数为 0；
- `n_concurrent=5` 的评测隔离和 Provider 路径 Gate 通过。

因此 Pilot 允许进入正式冻结阶段。正式批次继续沿用官方 timeout、资源、`max_retries=0` 和并发度 5，不针对失败题做定向优化；优化建议与后续实验另立版本，避免污染本轮基线。

当前官方仓库已关闭社区 leaderboard submission。因此本地或 Harbor Hub 结果可以作为可复现的公开 Benchmark 结果，但在维护者重新开放或接纳之前，不能表述为“已进入官方排行榜”。

正式批次已经完成。官方 verifier 原始准确率为 71.69%，按官方 reward-hacking 规则进行严格逐轨迹审计后为 69.21%。完整结果、异常、Token、时延、轨迹审计与优化建议见 [Terminal-Bench 2.1 正式批次 v1 结果与审计](./terminal_bench_2_1_formal_v1_result_2026_08_21.md)。

## 6. 正式批次协议边界

- 完整覆盖 89 个官方任务；
- 每题恰好 5 个独立 trial，共 445 个 trial；
- 每个 trial 使用新的容器、数据库、Context 和 Session；
- Harbor `max_retries=0`，模型失败、任务失败和单 trial 基础设施错误均保留并按 0 分计，不按成绩选择性补跑；
- 不修改 task、timeout multiplier、agent/verifier timeout 或 CPU、内存、磁盘资源；
- headline accuracy、standard error、pass@2 至 pass@5、错误数、token、成本、时长和 reward-hacking disqualification 全部报告；
- 若发生使整个批次不再可解释的宿主机级系统故障，保留原批次并整体作废，修复并提升运行协议版本后从零开始，不拼接挑选成功 trial。
