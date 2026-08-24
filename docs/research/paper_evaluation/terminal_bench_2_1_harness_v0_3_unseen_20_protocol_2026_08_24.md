# Terminal-Bench 2.1 Harness v0.3 未见 20 题验证协议（2026-08-24）

> 状态：`completed / user-directed product validation`
>
> 性质：开发验证，不是完整 89 题成绩，不上传，不与历史批次拼接
>
> 结果：20/20 完成，11/20 通过，raw = strict = 55%；详见
> [`terminal_bench_2_1_harness_v0_3_unseen_20_result_2026_08_24.md`](./terminal_bench_2_1_harness_v0_3_unseen_20_result_2026_08_24.md)

## 1. 决策背景

`terminal-task@0.3.0` 的预注册单题诊断在 `torch-pipeline-parallelism` 上因
`AgentTimeoutError` 得 0 分，但已取得 world size 1/2 的调用侧可执行证据，并把当前失败
收敛到最后一次模型求值未在外部时限前返回。原单题协议据此关闭并禁止自动扩大。

用户在看到完整结果后作出新的产品验证决定：不继续围绕这一道已观察任务调试，保持 v0.3
源文件、Runtime、模型、reasoning、授权、数据集和评分器不变，选择后续未检查 trajectory 的
20 道官方任务验证整体表现。该决定是一个新的、明确记录的扩大授权，不追改原单题协议的预注册
事实，也不把两个阶段合并成同一个统计样本。

## 2. 固定任务集

任务顺序来自 Harbor `0.21.0` 对固定 Terminal-Bench 2.1 registry digest
`sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`
返回的原始 `task_version_id` 顺序。本轮固定为第 21–40 项：

1. `build-pov-ray`
2. `cobol-modernization`
3. `mcmc-sampling-stan`
4. `gpt2-codegolf`
5. `filter-js-from-html`
6. `sam-cell-seg`
7. `mteb-retrieve`
8. `adaptive-rejection-sampler`
9. `vulnerable-secret`
10. `extract-elf`
11. `nginx-request-logging`
12. `make-doom-for-mips`
13. `configure-git-webserver`
14. `build-cython-ext`
15. `train-fasttext`
16. `compile-compcert`
17. `fix-ocaml-gc`
18. `gcode-to-text`
19. `dna-insert`
20. `raman-fitting`

在本轮完成前不得查看这些任务的历史 trajectory、按预期难度替换任务，或根据单题中途结果修改
Harness。公开任务名称仅用于精确选择固定 registry 项，不用于外部搜索。

## 3. 冻结运行形状

- dataset：`terminal-bench/terminal-bench-2-1`，固定 registry digest；
- tasks：上述精确 20 题；
- attempts：`1`；
- concurrency：`5`；
- Harbor retries：`0`；
- model：精确 `gpt-5.6-sol`；
- reasoning effort：`max`；
- fallback：`false`；
- permission mode：`full_access`；
- Runtime：`paper-eval-runtime-v4` / commit
  `5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；
- Harness：`terminal-task@0.3.0`，source SHA-256
  `7e9fb42a80c08280da7c4c6c09126d76ce1ea2ec92eea6518f27917d504b8c11`，artifact
  SHA-256 `ba35a184e8d40f5cad925d66a4c125cfec28dfd9cc94ab06148e563aa5692e4e`；
- isolation：每 trial 独立容器、Context、Session 和 SQLite 数据库；
- upload：禁用；
- 运行期间不修改 Runtime、adapter、Harness、任务指令或 scorer。

## 4. 无模型 Gate

真实模型运行前必须完成：

1. 海外节点无其他 Harbor/model job 运行；
2. Git tracked worktree clean，冻结 commit 包含本协议与精确 profile；
3. CLIProxyAPI active，在线 preflight 确认物理模型、`max`、无 fallback 和
   `full_access`；
4. exact 20-task selector 解析为 20 个唯一任务，与本协议清单一致；
5. 对同一 20-task selector 运行 `install-only`，20/20 环境建立成功；
6. adapter、Harness source/hash、Runtime binary/watcher SHA 和凭据临时注入检查通过。

任一 Gate 失败则不调用模型，先记录基础设施问题。

## 5. 运行与停止规则

- 只运行本批 `20 × 1`，不启动剩余 49 题、89×1 或 89×5；
- 单题失败不即时重试，不根据中途结果调整提示词、Harness 或超时；
- Provider quota/认证/区域故障导致批次不完整时，保留原始结果并停止，不静默补跑；
- 运行完成后先执行 integrity/public Gate，再查看和分类失败 trajectory；
- 本批通过率只描述该未见 20 题的一次开发验证，不作为 leaderboard score；
- 因前 20 题使用了不同的 Agent/Harness 身份，不得把两个 20 题直接相加声称 40 题统一成绩。

## 6. 输出

完成后至少记录：

- 20/20 完成性、raw/strict reward 与逐题结果；
- Agent/Runtime/Harness/Provider/环境错误分层；
- input/cache/output Token、模型调用、墙钟时间；
- Harness binding、Context/Session/数据库隔离、凭据与完整性 Gate；
- 对失败 trajectory 的通用分类，以及是否存在新的重复性收敛问题；
- 是否值得在新版本修订后重新冻结代表性验证，或继续保持当前产品身份。
