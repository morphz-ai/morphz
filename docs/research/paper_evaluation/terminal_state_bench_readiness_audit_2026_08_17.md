# Terminal-Bench 2.0 / STATE-Bench Agent Learning 适配就绪审计

> 日期：2026-08-17
>
> 状态：Readiness only；未安装 Harbor/STATE-Bench，未下载 Benchmark 数据或容器，未运行模型，未修改 Morphz Runtime
>
> 适用阶段：2026-08-27 路演后首批公开 Benchmark 工作
>
> 关联：ME-00 实验基础设施、ME-07 公开 Benchmark 外部验证
>
> 非目标：多语言/文言 Context 对比已降级为 Deferred Proposal，不进入本路线，也不进入 ME-07/ME-08 当前计划

> 后续路由更新：本审计对 **TB2.0 提交关闭、现有 Harbor 复用与 ATIF gap** 的判断仍有效；新发现的 [Terminal-Bench 2.1 开放提交流程](https://github.com/harbor-framework/terminal-bench-2-1)已成为路演后推广首跑。2.1 readiness delta 与推荐顺序见[主路线图](./benchmark_leaderboard_matrix_and_roadmap_2026_08_17.md)和[推广热度 Watchlist](./mainstream_leaderboard_promotion_heat_watchlist_2026_08_17.md)，不应继续等待 2.0 重开。

## 0. 结论先行

本审计修正了候选矩阵中的一个关键排期假设：

1. **Terminal-Bench 2.0 是当前代码最接近“能跑”的候选，但不是当前最快“能上榜”的候选。** Morphz 已有 Harbor `BaseAgent`、容器内 runner 和回归 fixture；但当前 [Terminal-Bench 2.0 提交页](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard)明确显示 **SUBMISSIONS CLOSED**，等待新提交流程。同时，2026-04-19 后[所有通过 trial 必须提供 ATIF trajectory](https://www.tbench.ai/news/leaderboard-integrity-update)，而现有 adapter 明确设置 `SUPPORTS_ATIF = False`。因此，在“主办方确认 2.0 仍可提交 + 新通道开放 + ATIF 合规”三项完成前，只能形成协议兼容的内部结果，不能形成新官方榜成绩。
2. **STATE-Bench Agent Learning 的官方提交路径目前更明确，但适配和凭据更重。** 官方允许自定义 `BaseAgent`/client 和只读学习检索，要求三个领域、每领域 50 个 held-out task、每 task 5 runs、`top_k=3`、锁定 GPT-5.4 simulator/judge，并通过 GitHub issue 提交全部 scored trajectories 与 metrics。Morphz 尚无专用 adapter，且必须取得 Azure GPT-5.4 evaluation deployment。
3. **路演后建议顺序：** 先同时发出两个主办方确认请求；Terminal-Bench 只做 Harbor/ATIF 兼容性工作，不在提交关闭时烧 445-trial 预算；STATE-Bench 先走“冻结的 Morphz 学习产物 + 官方只读 retrieval hook”低风险路径，再决定是否投入完整 Morphz custom-agent bridge。
4. **官方性标签必须四级分开：** `adapter-smoke`、`protocol-compatible local`、`submitted-unverified`、`official-verified`。前三级一律不得写成“官方榜单成绩”。

| 项目 | 代码就绪 | 环境就绪 | 提交就绪 | 当前判定 |
| --- | --- | --- | --- | --- |
| Terminal-Bench 2.0 | 中高：已有 Harbor adapter/runner | 低：本机无 Harbor/Docker，只有 macOS binary | **阻塞**：提交关闭；ATIF 缺失；新流程未知 | 先修 adapter 合规，不启动正式跑分 |
| STATE-Bench Agent Learning | 中低：无专用 adapter，可复用 bridge/实验地基 | 低：未 checkout；缺 Azure GPT-5.4 eval deployment | 中：issue 提交流程公开 | 路演后优先做 adapter smoke 和凭据 preflight |

## 1. 审计口径与估算方法

### 1.1 官方成绩边界

- `adapter-smoke`：自建 fixture、单任务、部分领域、减少 runs、改过 runner 或假 client；只证明接线。
- `protocol-compatible local`：使用官方数据、官方 scorer 和规定参数得到的完整本地结果，但尚未被主办方接收或验证。
- `submitted-unverified`：已按官方通道提交，尚未通过校验/人工审核。
- `official-verified`：主办方接受并在官方 leaderboard 标为 verified/正式条目。

### 1.2 预算不是测量结果

本文的调用、时间、成本和磁盘均为**规划区间**。正式预算必须在路演后用 smoke 的真实 provider usage、Azure 账单、Harbor job 大小和容器 cache 大小重算，并写入 ME-00 manifest。

---

## 2. A — Terminal-Bench 2.0

### 2.1 已有 adapter / runner / fixture 可复用清单

#### 可直接复用

| 本地资产 | 可复用内容 | 就绪判断 |
| --- | --- | --- |
| `benchmarks/harbor/morphz_agent.py` | 当前 Harbor `BaseAgent` 接口；上传 Linux Morphz binary、非密钥配置和 runner；从 env/agent env 注入 provider key；按 Harbor trial 分配 Session/Context；把 workspace、SQLite、artifact 定位到容器路径 | **核心可复用**，但需对当前 Harbor 版本做 API/ATIF 审计 |
| `benchmarks/harbor/run_morphz_harbor.sh` | line-mode 启动；提交 `/multi` 指令；只读轮询 SQLite 中 Objective、reply 和 activation，直到终态/静默窗口后再让 Harbor verifier 接管 | **核心可复用**，适合 Morphz 长程 Objective 生命周期 |
| `benchmarks/harbor/README.md` | Linux binary、provider 环境变量和 secret injection 的既有运行约定 | 可转为新 CLI 的正式 runbook；当前示例是旧 `harbor trials start` 语法 |

#### 只作为回归 fixture，不是 Terminal-Bench 2.0 成绩

| 本地资产 | 用途 | 禁止误用 |
| --- | --- | --- |
| `benchmarks/harbor/forgedepot-concurrent/` | 自建 Harbor task；4 CPU、8 GB RAM、20 GB storage；包含 instruction、Dockerfile、oracle 和隐藏 verifier；可验证并发 Objective、文件写入和最终产品状态 | 任务来源是 `morphz-native-benchmark`，不能写成 Terminal-Bench task 或官方 score |
| `benchmarks/results/forgedepot_qwen_20260720.json` | 三次内部运行观测到约 15.4–45.2 分钟、25–81 model attempts、40–105 physical tool calls；可作为容量规划锚点 | dirty Runtime、非官方 task、且当时没有可用 Harbor Docker；不能外推为 TB2.0 实测分数 |

#### 可复用到证据链

- `morphz-evals/src/eval_sandbox.rs`：Run root、manifest、workspace snapshot、hidden verifier 和变更审计的部分实现；需要从 coding-specific manifest 抽出 ME-00 通用层。
- `docs/research/paper_evaluation/templates/run_record_template.md`：commit、dirty diff、runner/scorer、provider/model、失败分类和 artifact checksum 字段。
- `docs/research/paper_evaluation/templates/protocol_template.md` 与 `result_report_template.md`：协议冻结、pilot gate、排除规则、重评分和 validity 报告。

### 2.2 缺失依赖、环境、凭据、数据与官方提交步骤

#### 当前本机静态 preflight

- OS/arch：macOS arm64。
- `uv` 已存在。
- `harbor` 未安装。
- Docker/Podman CLI 未安装。
- 现有 `target/release/morphz` 是 macOS binary；正式容器需要与 Harbor task 容器匹配的 Linux binary。
- 本审计未安装上述软件、未拉取 task、未构建镜像。

#### 路演后需要补齐

1. **Linux 执行环境**
   - 推荐独立 Linux x86_64 host/runner；先确认官方 task image 架构，再编译对应 Morphz binary。
   - 安装主办方确认版本的 Harbor 和受支持 container backend。
   - 正式并发 4 之前建议至少 16 vCPU、64 GB RAM；先用并发 1/2 实测，不能覆盖官方 task 的 timeout/resource。
2. **Harbor 版本/API 兼容**
   - 官方仓库示例使用 `terminal-bench@2.0`，榜单页同时展示 `terminal-bench/terminal-bench-2`；当前 Harbor 已把 custom import path 合并到 `--agent`，旧 `--agent-import-path` 仍可能只是兼容别名。安装后必须以 `harbor run --help` 和 `harbor datasets list` 为准并冻结版本。
   - 对 `BaseAgent.setup/run`、`extra_env`、`logs_dir`、`session_id/context_id` 做无模型 contract test。
3. **凭据**
   - `MORPHZ_HARBOR_BINARY`、`MORPHZ_PROVIDER_PROTOCOL`、`MORPHZ_PROVIDER_BASE_URL`、`MORPHZ_PROVIDER_MODEL`。
   - provider credential 默认 `MORPHZ_PROVIDER_API_KEY`；只通过 Harbor agent env 注入，不写入 config、image、trajectory 或提交包。
   - 若使用 Harbor cloud environment，另需对应 provider credential；本路线首批不需要。
4. **网络完整性**
   - [官方完整性政策](https://www.tbench.ai/news/leaderboard-integrity-update)禁止通过网络获取答案，并要求对 passing trial 做 trajectory 审查。
   - 当前 Morphz 设置 `MORPHZ_EXEC_NETWORK=false` 只约束 Morphz exec tool，不等于 Harbor agent phase 网络已限制。需要确认是否可用 Harbor phase-scoped allowlist 仅放行模型 endpoint，并确保 agent 无法访问 Terminal-Bench 网站、GitHub repo 或解答镜像。
5. **ATIF 硬门槛**
   - 当前 `MorphzAgent.SUPPORTS_ATIF = False`，而新政策要求每个 passing trial 有 ATIF。
   - 榜单专用 adapter 必须把 Morphz Session/Event/Objectives/model attempts/tool calls/最终回复转换为 Harbor 接受的 ATIF，写入规定路径，并通过官方 judge/validator。不得伪造缺失事件。
6. **数据和镜像**
   - [TB2 官方仓库](https://github.com/harbor-framework/terminal-bench-2)说明 Harbor 首次运行会自动下载 89 个 task；Docker build/cache 是主要磁盘来源。
   - smoke 只取一个公开 task；正式 run 前再下载/构建全量。不得把 `forgedepot-concurrent` 混入官方 dataset。
7. **提交**
   - 旧流程要求 job、`metadata.yaml`、完整 trial artifacts、每 task 至少 5 trials、无 timeout/resource override，再由 bot/maintainer 校验。
   - 但当前官方 dataset card 已明确 **SUBMISSIONS CLOSED**，并称新流程将实施完整性新规；因此旧 PR 上传步骤只能作为历史参考，不能视为当前可执行入口。

### 2.3 最小 smoke 与正式 run 预算

#### 预算表

| 层级 | 规模 | 模型调用量 | 时间 | 成本 | 磁盘 |
| --- | --- | --- | --- | --- | --- |
| 无模型 contract smoke | import adapter、生成 config、ATIF schema fixture、CLI dry/help | 0 | 10–30 分钟 | $0 | <1 GB（不含安装 cache） |
| 最小模型 smoke | 1 个官方 task × 1 attempt × concurrency 1 | 规划 10–100 calls；内部 ForgeDepot 锚点为 25–81 attempts，但不是官方分布 | 15–90 分钟；官方只给出“minutes to hours”量级 | 官方 2026 对普通 Terminal-Bench 给出约 **$1–$100/task** 的宽区间；必须以本次 usage 重算 | 建议预留 10–30 GB free，主要是单 task image/build cache |
| 适配 pilot | 3 个不同 task 类型 × 1 attempt | 30–300 calls | 1–5 小时串行；并发 2 可缩短 | 约 $3–$300 | 30–80 GB free |
| 正式协议 | 89 tasks × 5 attempts = **445 trials** | 规划 4,450–44,500 calls；按内部 ForgeDepot 锚点为 11,125–36,045 attempts | 假设 15–90 分钟/trial：并发 4 约 28–167 小时；并发 8 约 14–84 小时，另加 build/retry | 按官方 $1/$10/$100 每 trial 三档：**$445 / $4,450 / $44,500** | 建议 host 保留 **150–300 GB free**；pilot 后拆分 image cache、writable layer、job artifacts 和归档实测 |

成本来源：[Terminal-Bench 团队 2026-06 对普通 Terminal-Bench 的时间/成本量级](https://www.tbench.ai/news/terminal-bench-challenges)。该区间跨模型和 agent 差异很大，不是 Morphz 报价。

#### 正式预算闸门

在一个官方 task 成功完成且 ATIF validator 通过后，记录：

- agent/model API 请求数、input/output/cached tokens、provider 实付；
- image cache 增量、trial artifact 大小、ATIF 大小；
- agent phase、verifier phase 和总 wall time；
- 失败类型与可重试性；
- 按 `445 × pilot 均值` 和 P90 重新出正式预算。

未完成这一步，不批准 445-trial 正式 run。

### 2.4 ME-00 通用设施与榜单专用改动

#### 应进入 ME-00 的通用部分

- 统一 Run ID、目录、manifest、commit/dirty diff hash、协议/runner/scorer 版本。
- provider/model/推理参数、并发、timeout、网络策略、容器/OS/arch 审计。
- secret 名称记录与 artifact secret scan；绝不落盘 secret value。
- 原始请求/响应、tool calls、Morphz Context/Event/Objectives、官方 result 的不可变归档与 checksum。
- 模型失败、Runtime 失败、adapter 失败、container/build 失败、verifier 失败、provider 故障分类。
- token/cost ledger、wall-time、磁盘增量、重试次数。
- raw artifact 与 derived summary 分离，支持从 raw 重新评分得到相同结果。
- 官方性状态机：smoke → local complete → submitted → verified；对外文案由状态机门控。

#### Terminal-Bench 专用

- Harbor `BaseAgent` 兼容层和 Linux binary 上传。
- Morphz Event → ATIF 转换与 passing-trial 完整性 validator。
- Terminal-Bench dataset/version/89-task 集合、5 attempts、无资源覆盖检查。
- agent-phase 网络 allowlist 与 reward-hacking 审查。
- Harbor job/metadata/new leaderboard upload package。

### 2.5 官方可比成绩边界与主办方确认问题

#### 可以怎样表述

- 自建 ForgeDepot：`Morphz Harbor adapter regression` 或 `internal Harbor-format task result`。
- 单个/部分 TB2 task：`protocol-compatible local smoke on Terminal-Bench 2.0 task(s)`，必须写 task 数和 attempts。
- 89×5 完整本地 run：`complete local run under the published TB2.0 protocol`；在接受前仍不是官方榜成绩。
- 只有新提交流程接受并由官方页展示/verified 后，才能写“Terminal-Bench 2.0 官方榜成绩”。

#### 必须先问主办方

1. Terminal-Bench 2.0 还会重开新 submission，还是已由 2.1/后续版本取代？预计通道和截止时间是什么？
2. 新流程是主办方复跑 custom agent，还是接收自跑 Harbor job？若复跑，Morphz binary/source/许可证和 provider 凭据如何交付？
3. 当前唯一接受的 dataset slug、Harbor 版本和 `-k 5`/`--n-attempts 5` 语义是什么？
4. ATIF 当前 schema/version、输出路径、validator 和 agent judge 命令是什么？`BaseAgent` custom agent 是否必须 `SUPPORTS_ATIF=True`？
5. Morphz 是 persistent Objective system；单 trial 内后台 Objective 完成后再结束 agent phase是否符合规则？
6. 只允许 provider endpoint 的 agent-phase network allowlist 是否被接受？哪些 host 必须额外允许？
7. 由 Morphz 内部调用模型时，leaderboard 的 agent/model 元数据和多模型使用应如何申报？
8. 现有 adapter 生成 SQLite、Event/Objectives 和本地 artifact 是否都要随 job 上传？哪些可能包含敏感 provider/request 数据？
9. 通过 trial 中缺少部分 ATIF event 应计 0、排除还是整份 submission 无效？
10. 新流程是否仍禁止所有 timeout/resource override，并保留旧 metadata/5-trial 校验规则？

### 2.6 路演后第一条命令与操作清单

#### 第一个操作不是跑模型

先在官方 issue/Discord `#tb-2` 发出上节 1–4、6 三组问题，取得书面回复。提交关闭期间不启动 445-trial run。

#### 主办方确认后，在独立 Linux host 执行

```bash
# 1. 安装主办方确认的精确版本；<...> 必须替换后再执行
uv tool install 'harbor==<confirmed-version>'
harbor --version
harbor datasets list
harbor run --help

# 2. 构建与 task container 架构一致的 Linux binary
cargo build --locked --release -p morphz --bin morphz
file target/release/morphz
```

先运行自建 fixture 验证 adapter 生命周期；它不是官方结果：

```bash
MORPHZ_HARBOR_BINARY="$PWD/target/release/morphz" \
MORPHZ_PROVIDER_PROTOCOL="<protocol>" \
MORPHZ_PROVIDER_BASE_URL="<base-url>" \
MORPHZ_PROVIDER_MODEL="<exact-model>" \
PYTHONPATH="$PWD" harbor run \
  --path benchmarks/harbor/forgedepot-concurrent \
  --agent benchmarks.harbor.morphz_agent:MorphzAgent \
  --model "custom/<exact-model>" \
  --n-attempts 1 \
  --n-concurrent 1 \
  --ae MORPHZ_PROVIDER_API_KEY="$MORPHZ_PROVIDER_API_KEY"
```

再跑一个官方 task 的内部 smoke；最终 flag 以已冻结的 `harbor run --help` 为准：

```bash
MORPHZ_HARBOR_BINARY="$PWD/target/release/morphz" \
PYTHONPATH="$PWD" harbor run \
  --dataset terminal-bench@2.0 \
  --include-task-name "<confirmed-task-id>" \
  --agent benchmarks.harbor.morphz_agent:MorphzAgent \
  --model "custom/<exact-model>" \
  --n-attempts 1 \
  --n-concurrent 1 \
  --ae MORPHZ_PROVIDER_PROTOCOL="<protocol>" \
  --ae MORPHZ_PROVIDER_BASE_URL="<base-url>" \
  --ae MORPHZ_PROVIDER_MODEL="<exact-model>" \
  --ae MORPHZ_PROVIDER_API_KEY="$MORPHZ_PROVIDER_API_KEY"
```

只有下列全部为绿灯才生成正式 89×5 run plan：

- [ ] 官方确认 2.0 接受新提交；
- [ ] Harbor/dataset/ATIF 版本冻结；
- [ ] ATIF validator 与 reward-hacking judge 通过；
- [ ] 无 timeout/resource override；
- [ ] provider-only 网络策略确认；
- [ ] 单 task usage/cost/disk 进入 ME-00；
- [ ] artifact secret scan 通过；
- [ ] 预算审批完成。

---

## 3. B — STATE-Bench Agent Learning

### 3.1 已有 adapter / runner / fixture 可复用清单

#### 当前没有的内容

- 仓库没有 `STATE-Bench` checkout、专用 `BaseAgent`、`BaseLLMClient`、`retrieve_learnings` hook 或 domain fixture。
- 因此当前不能直接执行官方 runner；“已有 π/Harbor adapter”不能等价称为 STATE-Bench adapter。

#### 可复用资产

| 本地资产 | 可复用部分 | 不能直接复用的部分 |
| --- | --- | --- |
| `benchmarks/pi_bench/morphz_bridge.py` | 纯 stdlib HTTP client；稳定 Principal/Context/Session ID；Session 创建；event cursor/poll；reply 等待；trace 落盘 | π-Bench chat/test-server 协议、trace schema 和工具执行语义 |
| `morphz-evals/src/long_horizon_agent_eval.rs` | `related_experience` / `unrelated_experience` / `fresh` 三臂设计；experience-transfer manifest；正/负迁移与调用量差分 | 内部 fixture、内部 scorer 和 Runtime runner不能代替官方 STATE scorer |
| `morphz-evals/src/eval_sandbox.rs` | Run root、artifact、workspace/database、hash、verification record 的通用思路 | coding-specific 字段与 hidden verifier 实现 |
| ME-00 三份模板 | 版本、模型、预算、失败、artifact、重评分和 validity 记录 | 需要新增 STATE protocol ID、domain、run、top-k、Azure eval deployment 字段 |

#### 推荐两级适配路径

1. **B1：学习产物路径（首批推荐）**
   - 仅使用官方 `datasets/train_task_trajectories/` 构建冻结的 Morphz learnings artifact。
   - 在 STATE-Bench 内 subclass 官方 `StateBenchAgent`，只实现 `retrieve_learnings(query, top_k=3) -> list[str]`。
   - 优点：官方 hook 原生、工具仍由 STATE 执行、工作量最小。
   - 诚实边界：它证明“由 Morphz 机制生成/组织的学习产物改善官方 agent”，不能声称完整 Morphz Runtime/Objective system 作为 outer agent 获得该分数。
2. **B2：完整 custom agent 路径（后续）**
   - 新建 `clients/MorphzClient(BaseLLMClient)` 和 `agents/MorphzLearningAgent(BaseAgent)`。
   - 把 STATE canonical conversation/tool schema 转成 Morphz 输入，再把 Morphz 候选 tool request 转为 `AgentToolCallRequest`；domain tool 必须继续由 STATE harness 执行。
   - 每个 test task 必须使用 fresh agent/session，跨 task 只能读取冻结 learnings artifact；不得让 test 轨迹反向污染共享 Context。

### 3.2 缺失依赖、环境、凭据、数据与官方提交步骤

1. **代码与 Python 环境**
   - fresh checkout 并冻结 commit；公开榜当前展示的最新 benchmark group 是 `0.8.0`，但 `main` 可能继续变化，正式版本必须由主办方确认。
   - [官方要求 Python 3.12+ 和 uv](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md)。本机 Python 3.14.4 名义上满足下限，但应优先用 upstream lock/`.python-version` 对应的 3.12 环境，避免新版本兼容漂移。
   - 官方文档未要求 Docker；依赖通过 `uv sync` 安装。
2. **锁定的 evaluation client**
   - 官方 run 必须有 Azure GPT-5.4 endpoint 和 deployment：`STATE_BENCH_EVAL_ENDPOINT`、`STATE_BENCH_EVAL_DEPLOYMENTS`。
   - `STATE_BENCH_EVAL_API_KEY` 可选；缺省时会尝试 Azure CLI token 和 `DefaultAzureCredential`。
   - 多 deployment 可逗号分隔并负载均衡。没有这组凭据，就不能产生官方可比 scored trajectory。
3. **agent provider 凭据**
   - B1 使用官方 built-in client 时，按官方 OpenAI/Azure agent-client 文档配置。
   - B2 的 `MorphzClient.from_env()` 自行读取 provider key/base URL/model；STATE 不解释第三方变量。
   - 自定义 agent 每次 provider call 应调用 `add_cost_usd`，并尽可能报告 input/output/cached tokens。
4. **数据**
   - 官方提供三个领域各 100 条 train trajectories 和 50 条 held-out test tasks。
   - 学习提取只能读取 `datasets/train_task_trajectories/<domain>/`；test definition/environment 不能作为学习 oracle 输入。
   - 建议首批只生成 JSON learnings artifact，避免引入大型 embedding/vector 依赖。若后续需要向量索引，其模型、版本、cost 和生成 hash 都进 manifest。
5. **官方 runner**
   - 正式参数：三个领域分别运行，`--num-runs 5`、`--retrieve-learnings-top-k 3`；自定义路径还需 `--agent-class` 和 `--agent-client-class`。
   - runner 每个 task 创建 fresh agent instance；STATE 执行 domain tools；custom agent 只返回 provider-neutral tool request。
   - 官方 domain config 的 agent turn 上限为 15；custom tool loop 每 agent turn 最多 8 rounds。超限是失败，不应改协议。
6. **评分与提交**
   - 每 domain 用官方 `compute_metrics` 生成 `metrics.json`；正式提交不能用 `--ignore-missing-runs`。
   - 打包三个领域全部 scored trajectories + metrics 为 `outputs.zip`，通过 STATE-Bench GitHub issue 提交；主办方验证后才进入官方榜。

### 3.3 最小 smoke 与正式 run 预算

#### 调用量上界与规划区间

每 episode 的官方结构为：

- agent：最多 `15 agent turns × 8 tool rounds = 120` 次 `generate_next_turn`/provider calls；正常 task 通常远低于此上限；
- locked simulator：首个 opening 已在 task 中，之后最多 14 次 GPT-5.4 calls；
- locked judge：task-requirements 与 UX judge 最多约 2 次 GPT-5.4 calls；部分确定性/空要求可少于此数；
- 理论粗上限：约 **136 LLM calls/episode**。

用于规划而非协议事实的常态区间取 5–30 agent calls、2–14 simulator calls、1–2 judge calls，即约 **8–46 calls/episode**。

| 层级 | 规模 | 模型调用量 | 时间 | 成本 | 磁盘 |
| --- | --- | --- | --- | --- | --- |
| 无模型 contract smoke | import 两个 extension class；canonical tool schema 转换；top-k/read-only；fake response；artifact hash | 0 | 30–90 分钟 | $0 | <1 GB（不含依赖） |
| 单 task micro-smoke | 通过公开 `run_task` 写一个榜单专用内部 wrapper，1 episode；不是官方结果 | 规划 8–46；粗上限 136 | 2–10 分钟 | 暂按 $0.10–$2 预留，必须以 agent+Azure 实付替换 | <100 MB output；环境整体仍建议 5–10 GB free |
| 官方 CLI 最小 batch smoke | 当前公开 `run_batch` 未文档化 task selector；因此 1 domain × 50 tasks × 1 run = 50 episodes | 规划 400–2,300；粗上限 6,800 | workers=10 时约 0.5–3 小时，含限流/重试预留 1–6 小时 | 按正式单臂预算的 1/15，先预留约 $7–$100 | 5–10 GB free |
| 正式单臂 | 3 domains × 50 tasks × 5 runs = **750 episodes** | 规划 6,000–34,500；粗上限 102,000 | workers≈10 时预留 8–36 小时；取决于 agent 与 Azure rate limit | 公开 Main Track 的 agent-only cost/task 示例约 $0.04–$0.18，即 $30–$135；simulator/judge 与 Morphz 构建成本不在该指标内。总预算先按 **$100–$1,500/arm** 预留 | 10–20 GB/arm；保留 raw/provider debug 时上调 |
| 论文 paired baseline + Morphz | 两个完整单臂 = 1,500 episodes | 上述翻倍 | 16–72 小时 | **$200–$3,000** 规划预留，另计 offline learning build | 建议 20–40 GB free |

公开榜 cost/task 是 agent 自报的 agent cost，并不等于 Azure simulator/judge 的总账：[STATE-Bench leaderboard](https://microsoft.github.io/STATE-Bench/leaderboard/)、[官方 cost reporting 说明](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md)。因此 `$100–$1,500/arm` 只是采购/限额预留，不是官方测量或报价。

#### 50-episode smoke 后必须重算

- 每 episode 的 agent/simulator/judge call 数与 latency；
- 三类 token/cost ledger，尤其 Azure evaluation client；
- 429/timeout/retry 比例与可用 workers；
- scored trajectory 平均/P95 大小；
- 按 15 倍外推 750 episodes，并保留至少 20% retry/variance buffer。

### 3.4 ME-00 通用设施与榜单专用改动

#### 应进入 ME-00 的通用部分

- 与 Terminal-Bench 共用的 Run manifest、artifact root、hash、provider/model/params、usage/cost、失败分类和 re-score 记录。
- baseline/treatment 配对、同模型同预算、run order 与随机种子/任务顺序记录。
- 数据 lineage：允许读取的 train 路径、禁止用于 learning 的 test 路径、输入文件 hash、artifact build command/hash。
- Principal/Context/Session/task 的稳定映射和隔离审计；test task 间共享写入为 0。
- raw trajectory、Morphz Event/Context 因果链、官方 scored trajectory 和 derived metrics 的 join keys。
- officiality 状态、submission receipt、主办方反馈和最终 leaderboard URL。

#### STATE-Bench 专用

- `StateBenchAgent.retrieve_learnings` 或 custom `BaseAgent.memory_tool_schemas/handlers`。
- canonical conversation/tool schema 与 Morphz/provider schema 的转换。
- train trajectories → Morphz learnings artifact 的离线 extractor。
- `top_k=3` 强制、返回 `list[str]`、read-only handler 和 per-task fresh instance 检查。
- Azure GPT-5.4 eval client/多 deployment preflight。
- 三领域 `run_batch`、`compute_metrics`、完整性校验和 `outputs.zip`。

### 3.5 官方可比成绩边界与主办方确认问题

#### 可以怎样表述

- fake client、single task、`num-runs=1`、单领域或自写 selector：`STATE-Bench adapter smoke/internal pilot`。
- 三领域 5 runs、官方 protocol/scorer 完整本地结果：`protocol-compliant local STATE-Bench Agent Learning run`；提交接受前仍不是官方榜成绩。
- 若使用 B1，只能写“Morphz-derived learnings artifact + 官方/指定 agent”，不能把 outer agent 写成完整 Morphz Runtime。
- 只有 issue 验证并在 Agent Learning Track official page 展示后，才能写“STATE-Bench Agent Learning 官方验证成绩”。

#### 必须先问主办方

1. Agent Learning Track 当前接受的新 submission 对应哪个 benchmark version/commit？公开页在 Agent Learning filter 下当前未呈现可核验条目，是否正在接收首批结果？
2. B1 路径——从官方 train trajectories 生成本地 JSON/Context artifact，再由 `StateBenchAgent.retrieve_learnings` 只读返回——是否是预期的 official Agent Learning submission？
3. 学习 artifact 的每条 string、总 token、文件大小是否有未文档化限制？结构化 S-expression/JSON 作为 string 是否允许？
4. offline extraction 可否调用 LLM；其 cost 是否必须在方法说明中报告，即使不进入 public Cost/Task？
5. test episode 内的临时 agent/context 状态是否允许更新，只要 episode 结束即丢弃；哪些行为会被认定为 retrieval 非只读？
6. 对 B2 custom agent，server-side Morphz Session 是否允许，只要每 task fresh 且 STATE 仍执行全部 domain tools？
7. Azure GPT-5.4 eval endpoint 是否只能使用 Azure OpenAI，是否有主办方托管/额度申请路径？deployment API/version 是否需冻结？
8. baseline 与 Morphz treatment 是否可作为两个独立 official entries；如何在 metadata 中表明同模型、同预算和 learning/no-learning 差异？
9. 自定义 cost categories（agent turn、memory ingestion、memory retrieval）哪些会汇总到 public Cost/Task？
10. 除 `outputs.zip` 外，是否需要提交 learnings artifact、生成脚本、commit、环境 lock 或完整 provider telemetry？

### 3.6 路演后第一条命令与操作清单

#### 第一操作

先向 STATE-Bench issue 确认上节 1、2、4、7；同时申请/确认 Azure GPT-5.4 evaluation deployment。没有 locked eval client 时不启动模型 batch。

#### 环境 preflight；此处为未来命令，本审计未执行

```bash
git clone https://github.com/microsoft/STATE-Bench.git external/STATE-Bench
cd external/STATE-Bench
git rev-parse HEAD
uv sync --python 3.12
cp .env.example .env
uv run python -m state_bench.scripts.run_batch --help
uv run python -m state_bench.scripts.compute_metrics --help
```

随后完成以下无模型 gates：

- [ ] 冻结官方 commit、protocol ID 和 lockfile hash；
- [ ] `.env` 只保存于本地且被 ignore；
- [ ] Azure eval client 与 agent client 分开记录 credential 名称；
- [ ] train-only allowlist 和 test-oracle deny check；
- [ ] learnings artifact hash、build command、输入 hash 完整；
- [ ] `retrieve_learnings` 返回 `list[str]`、最多 3 项、无写入；
- [ ] 每 task fresh Session/Context，test task 之间无共享写状态；
- [ ] cost/token hooks 与 ME-00 manifest 联通。

当前官方 CLI 没有文档化 task selector；完成 single-task 内部 wrapper 后先做 micro-smoke。B1 学习产物路径使用 built-in client，只需 memory-enabled `StateBenchAgent` subclass，不传 custom client：

```bash
uv run python -m state_bench.scripts.run_batch \
  --domain travel \
  --agent-class MorphzMemoryAgent \
  --agent-model-name "<exact-model>" \
  --num-runs 1 \
  --retrieve-learnings-top-k 3 \
  --num-workers 2 \
  --output-dir outputs/smoke/travel/
```

B2 完整 custom-agent 路径才同时传 agent/client class：

```bash
uv run python -m state_bench.scripts.run_batch \
  --domain travel \
  --agent-class MorphzLearningAgent \
  --agent-client-class MorphzClient \
  --agent-model-name "<exact-model>" \
  --num-runs 1 \
  --retrieve-learnings-top-k 3 \
  --num-workers 2 \
  --output-dir outputs/smoke/travel/
```

上述命令都只产生内部 smoke，不是 official submission。以下以 B2 为例；正式单领域命令必须改为 5 runs：

```bash
uv run python -m state_bench.scripts.run_batch \
  --domain travel \
  --agent-class MorphzLearningAgent \
  --agent-client-class MorphzClient \
  --agent-model-name "<exact-model>" \
  --num-runs 5 \
  --retrieve-learnings-top-k 3 \
  --num-workers "<pilot-confirmed-workers>" \
  --output-dir outputs/travel/

uv run python -m state_bench.scripts.compute_metrics \
  --domain travel \
  --results-dir outputs/travel/ \
  --num-runs 5 \
  --output-dir outputs/travel/
```

对 `customer_support`、`shopping_assistant` 重复；三领域缺一不可。完成后做完整性、secret 和 checksum 校验，再按[官方提交结构](https://github.com/microsoft/STATE-Bench/blob/main/docs/SUBMIT.md)生成 `outputs.zip` 和 issue；在验证前保持 `submitted-unverified` 标签。

---

## 4. 两条路线与 ME-00 的共同交付物

路演后不应各自生长一套一次性脚本。先把下列最小共同层补进 ME-00：

| 共同交付物 | Terminal-Bench | STATE-Bench |
| --- | --- | --- |
| `run_manifest.json` | Harbor/dataset/agent/ATIF/network/resource | protocol/domain/top-k/eval deployment/data lineage |
| `usage.jsonl` | Morphz provider calls、tokens、cost、latency | agent/simulator/judge 分 category |
| `failures.jsonl` | build/container/agent/ATIF/verifier/provider | extraction/client/agent/tool/simulator/judge/provider |
| `artifact_index.json` | job/result/ATIF/Morphz DB/Event checksum | learnings/trajectory/metrics/Morphz Event checksum |
| `officiality.json` | closed/open、local/submitted/verified、leaderboard URL | local/submitted/verified、issue/leaderboard URL |
| `rescore` receipt | Harbor verifier/result 汇总重放 | 官方 `compute_metrics` 重放 |
| data/secret gate | task repo/website 网络禁访，secret scan | train-only learning allowlist，test oracle deny，secret scan |

ME-00 当前仍是 `planned`，已有 runner/模板只是“部分地基”。在上述 schema、目录、重评分与至少一个无模型模拟 Run 冻结前，不应启动任一正式批次。

## 5. 路演后可执行路线图

### Gate 0：主办方与凭据，0 模型调用

1. Terminal-Bench：确认 2.0 是否重开、ATIF validator、新提交通道、dataset/Harbor 版本。
2. STATE-Bench：确认 Agent Learning version、B1 合规性和 Azure GPT-5.4 取得方式。
3. 预算 owner 确认单臂/paired 的 API 限额与磁盘 host。

### Gate 1：ME-00 + 无模型 adapter contracts

1. 冻结共同 manifest/usage/failure/artifact/officiality schema。
2. Terminal：Harbor API import、Linux binary smoke、ATIF fixture validator。
3. STATE：class import、tool-schema conversion、train-only、top-k/read-only/fresh-task tests。

### Gate 2：最小模型 smoke

1. Terminal：自建 ForgeDepot 1 run → 官方 TB2 单 task 1 attempt；保持 internal 标签。
2. STATE：single-task micro-wrapper → 1 domain × 50 tasks × 1 run。
3. 用实测 usage/time/disk 重算正式预算。

### Gate 3：正式运行决策

- Terminal 只有提交通道已开、ATIF 和完整性检查全绿才跑 89×5；否则停在 readiness/pilot，不浪费模型预算。
- STATE 只有三领域凭据、data firewall、cost ledger 和 50-task pilot 全绿才跑 750 episodes。
- 论文若需要因果主张，必须有同模型、同任务、同预算的 no-learning baseline；官方单条绝对分数不替代 ME-01/ME-07 的对照分析。

## 6. 主要官方来源

- [Terminal-Bench 2.0 official repository and Harbor quickstart](https://github.com/harbor-framework/terminal-bench-2)
- [Terminal-Bench 2.0 leaderboard, custom agent command and verification note](https://www.tbench.ai/leaderboard/terminal-bench/2.0)
- [Terminal-Bench 2.0 submission dataset card — currently closed](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard)
- [Terminal-Bench leaderboard integrity update — ATIF and reward-hacking policy](https://www.tbench.ai/news/leaderboard-integrity-update)
- [Harbor custom agent interface](https://github.com/harbor-framework/harbor/blob/main/docs/content/docs/agents/index.mdx)
- [STATE-Bench Agent Learning Track](https://github.com/microsoft/STATE-Bench/blob/main/docs/AGENT_LEARNING_TRACK.md)
- [STATE-Bench locked GPT-5.4 evaluation client](https://github.com/microsoft/STATE-Bench/blob/main/docs/setup/eval-client.md)
- [STATE-Bench custom client + agent contract](https://github.com/microsoft/STATE-Bench/blob/main/docs/USE_CUSTOM_CLIENT.md)
- [STATE-Bench custom read-only memory hook](https://github.com/microsoft/STATE-Bench/blob/main/docs/memory/custom-hook.md)
- [STATE-Bench run_batch reference](https://github.com/microsoft/STATE-Bench/blob/main/docs/eval/run-batch.md)
- [STATE-Bench submission structure](https://github.com/microsoft/STATE-Bench/blob/main/docs/SUBMIT.md)
- [STATE-Bench official leaderboard](https://microsoft.github.io/STATE-Bench/leaderboard/)

## 7. 审计声明

本轮只新增 readiness 文档。没有安装大型环境，没有下载 Benchmark 数据/镜像，没有运行模型，没有修改 Morphz Runtime，也没有生成或宣称任何新的官方成绩。所有预算区间均等待路演后 smoke 实测校准。
