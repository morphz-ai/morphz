# Morphz Coding Eval Sandbox

当前每个 Coding Eval 夹具都会生成独立且不同的 `context_id`、`session_id`、SQLite 和 Workspace，
并把两项路由同时写入环境变量。Ledger 评分将 `context_tx/no_reply` 视为 Runtime 控制调用，
不会把它们误计为代码开发的物理 work Attempt。

Coding Eval Sandbox 为每次真实模型代码修复测试创建独立、可审计的运行环境，避免把主仓库直接暴露给 Agent 或让测试命令以无限制宿主 Shell 运行。

## 边界模型

每个 run 使用随机私有目录：

```text
/private/tmp/morphz-eval-runs/<run-id>/
├── manifest.json       # Runtime/evaluator 可见，Agent 不可见
├── morphz.db           # 独立 Event Ledger
├── artifacts/          # 仅允许 Agent 只读的 exec 输出
├── verifier/           # 独立验证副本与 verifier-only 测试，Agent 不可见
└── workspace/          # Agent 唯一可读写的任务文件系统
```

环境创建器会：

1. 从只读、受版本控制的 fixture 复制干净 workspace；
2. 拒绝 fixture 中的符号链接和超过 1 MiB 的单文件；
3. 记录所有初始文件 SHA-256；
4. 声明唯一允许修改的路径、固定验证命令和任务 Prompt；
5. 为数据库、Artifact 和 workspace 分配独立路径；
6. 启用严格 Coding Eval 工具注册表，移除 `list_skills/spawn`。

## 创建环境

```bash
cargo run -p morphz-evals --bin coding_eval_env -- create v1
cargo run -p morphz-evals --bin coding_eval_env -- create v2
```

也可指定 run 根目录：

```bash
cargo run -p morphz-evals --bin coding_eval_env -- create v2 /private/tmp/morphz-eval-runs
```

输出 JSON 包含启动所需环境变量：

- `MORPHZ_WORKSPACE_ROOT`
- `MORPHZ_DB_PATH`
- `MORPHZ_ARTIFACT_DIR`
- `MORPHZ_PERMISSION_MODE=auto_review`
- `MORPHZ_EXEC_NETWORK=false`
- `MORPHZ_CODING_EVAL_MODE=true`

## macOS Seatbelt

评测模式中的 `exec` 通过 `/usr/bin/sandbox-exec` 启动。Profile：

- 禁止网络；
- 禁止全局文件写入；
- 只允许 workspace 和 `/dev/null` 写入；
- 禁止读取用户 HOME，重新只读开放 `.cargo/.rustup` 工具链；
- 禁止读取 `/private/tmp` 其他目录，重新开放当前 workspace；
- cwd、文件工具与 Shell 使用相同 Permission Profile；边界外 cwd 必须显式申请并审批。

这使 Agent 不能通过 `exec` 读取主仓库的用户文件、读取 run 外 manifest，或在 workspace 外创建文件。Seatbelt 只覆盖 macOS 路径；Linux 和 Windows 必须由各自原生 Backend 通过相同攻击契约后才能启用，当前会 fail-closed，不以容器作为默认依赖。

## 固定探针与验证

验证读写逃逸被阻止：

```bash
cargo run -p morphz-evals --bin coding_eval_env -- probe RUN_ROOT
```

运行 manifest 中不可由 Agent 改写的固定验证命令：

```bash
cargo run -p morphz-evals --bin coding_eval_env -- verify RUN_ROOT
```

`verify` 不在 Agent workspace 中直接执行。它复制一份不含 `target/.morphz` 的 workspace 快照，在 run 的私有 verifier 目录中注入编译进 evaluator 的隐藏测试，再通过同样禁止网络和越界写入的 Seatbelt 执行。结果写入 workspace 外的 `verification.json`，后续评分优先使用该结果。Agent 无法读取隐藏测试，也无法通过修改公开测试伪造最终正确性。

检查文件修改范围：

```bash
cargo run -p morphz-evals --bin coding_eval_env -- audit RUN_ROOT
```

## Ledger 评分

```bash
cargo run -p morphz-evals --bin coding_eval_env -- score RUN_ROOT
```

评分总计 100 分：

| 维度 | 分值 |
| --- | ---: |
| 最终验证、有效文件修改、Context transaction 无失败 | 40 |
| 修改范围与文件约束 | 20 |
| 目标/约束保护、最终 Context 收口 | 20 |
| Attempt 数量与单一最终回复 | 10 |
| 先复现失败、后验证成功 | 10 |

报告同时输出 Attempt、回复数、Context commit、工具集合、未覆盖工具目标及所有范围违规，避免只依据 Agent 的最终自述评分。工具集合只作为能力覆盖遥测，不再要求单个任务机械调用所有工具，也不直接扣分；只有遗漏必要发现或验证最终影响任务结果时，才通过正确性和范围维度扣分。

## 当前 v1 Fixture

`coding_eval_v1` 是一个无第三方依赖的 Rust crate。`parse_retry_after` 初始不能处理 HTTP 首尾 SP/HTAB：

- 初始固定测试：2 通过、1 失败；
- 允许修改：仅 `src/lib.rs`；
- 禁止修改：测试、Cargo 配置及其他文件；
- 禁止 `unsafe`；
- 最终必须引用 `file_change` 与测试输出并维护 Mind。

该 fixture 不包含用户私有代码。只有在用户知情授权后，才会把它发送给配置的外部模型服务。

## 首次真实模型基线

2026-07-11 使用 `gemini-3.5-flash-low` 连续执行两次真实修复测试。第二次运行是在修复 Runtime 并发唤醒问题后的有效基线：

| 指标 | 结果 |
| --- | --- |
| 按当前规则复算 | 100 / 100 |
| 最终固定测试 | 3 / 3 通过 |
| 修改范围 | 仅 `src/lib.rs` |
| 越界创建、删除或写入 | 0 |
| Assistant attempts | 5 |
| Context transactions | 3 次提交，0 次失败 |
| File changes | 1 |
| 最终回复 | 1 |
| 已用必需工具 | `list_files`、`read`、`edit`、`exec`、`context_tx` |
| 未覆盖工具遥测 | `search` |

Agent 先复现了失败测试，再修复 `parse_retry_after` 对首尾 SP/HTAB 的处理，并完成回归验证。独立 verifier 重新执行测试通过，hash audit 只发现允许的目标文件发生变化。旧规则曾因未调用 `search` 给出 95 分；当前规则将它记录为覆盖遥测而不扣分，因此该运行按任务结果为 100 分。

这次测试同时暴露并修复了三个 Runtime 问题：同步 `exec` 的默认等待时间过短、严格评测下 Artifact 未被重新开放为只读、并发 tool-output 唤醒可能生成重复最终回复。修复后第二次运行只产生一次最终回复。

## v2：重试状态机

`coding_eval_v2` 是一个确定性的多文件任务队列 crate，包含 `model/retry/store/worker` 四层。Agent 需要追踪 claim、执行结果分类、退避计算和持久化状态迁移，而不是修改单一函数。

- 公开测试 5 项：初始 2 通过、3 失败；
- verifier-only 隐藏测试 6 项；
- 允许修改：`src/retry.rs`、`src/store.rs`、`src/worker.rs`；
- 禁止修改公共 API、测试和 Cargo 配置，禁止新增依赖、网络与 `unsafe`；
- 公开故障覆盖首次退避、最大尝试次数和取消后的迟到结果；
- 隐藏边界覆盖第二次指数退避、`Retry-After: 0`、过期 lease 的旧结果、取消后的成功结果、三次尝试边界和退避上限。

最小参考修复只需要修改 `retry.rs` 和 `store.rs`。本地基线已经确认公开 5/5、隐藏 6/6 全部通过，范围审计只包含这两个允许文件。该参考修复仅用于证明题目可解，不会复制进 Agent workspace。

## v2 首次同条件真实对比

2026-07-11 分别向 Morphz 的真实外部模型和不继承对话历史的 Codex 子代理提供 hash 完全相同的干净 v2 workspace。两边都只能修改三个声明文件，并由父级使用相同 verifier-only 测试独立复核。

| 指标 | Morphz | Codex 子代理 |
| --- | ---: | ---: |
| 公开测试 | 5 / 5 | 5 / 5 |
| 隐藏测试 | 6 / 6 | 6 / 6 |
| 修改范围审计 | 通过 | 通过 |
| 修改文件 | `retry.rs`、`store.rs` | `retry.rs`、`store.rs` |
| 最终文件 hash | 两个文件均完全相同 | 两个文件均完全相同 |
| 代码修改次数 | 2 次 edit | 1 次联合 patch |
| 代码返工 | 先修 retry，测试后再修 store | 无 |
| 最终回复 | 1 | 1 |
| Context commit | 1 | 不适用 |
| Morphz Attempt | 11 次 assistant call，随后强制 final | 不适用 |
| Morphz Ledger 评分 | 83 / 100 | 不可直接套用 |

Morphz 得到完整的正确性、范围和失败恢复分，但只在开头提交了一次 Mind：目标与约束受到保护，状态仍停留在 `planning`，没有在最终测试后写入根因、修改和验证结论。逐个 tool-output 唤醒耗尽了 12 次 Turn Attempt Budget，导致 final reply 被强制执行；因此 Context 自治为 8/20、效率为 5/10。`search` 未调用只作为遥测，不扣分。

Codex 子代理读取六个源码/测试文件并执行一次搜索，一次 patch 同时完成两个文件修改；随后公开测试和格式检查通过。它也做了两个不适用于无 Git fixture 的 Git 检查并得到预期外的命令错误，但没有造成代码返工。

这次结果表明 Morphz 的代码定位、修复质量和隐藏边界泛化与 Codex 子代理持平，当前主要差距不是 coding tools，而是 Attempt 调度和 Context 收口策略：Runtime 应为最终 Context transaction 预留预算，并允许模型在一次 assistant call 中并行发出更多独立读取，避免工具调用数量机械消耗整个 turn budget。

## v2 Context 收口优化回归

首次对比后，Runtime 引入了以下收口协议：

- `work`：物理工作 Attempt 与 Context transaction 分别计数；
- `context-closure`：物理预算耗尽后保留一次 `context_tx`-only 收口；
- `final-reply`：收口成功或失败后移除所有工具并终止本轮；
- 相同 `context_tx` 经 SExpr 规范化后自动去重，只执行一次；
- 同一响应中的多个不同 transaction 全部拒绝，错误进入 Inbox，要求合并为一个原子 transaction 后重试；
- 成功的 Context 回执仍是控制轨迹，不进入 Inbox；失败或拒绝信息必须对 Agent 可见；
- 一个 transaction 可同时包含多个 frame 的 `create/derive/revise/retire/restore/protect/unprotect/place`，并整体提交或整体回滚。

优化过程中真实模型曾在一个响应中返回 15 个 `context_tx`；其中绝大多数是同一个完整 `revise task` 的重复调用，并非 DSL 表达能力不足。该证据促使 Runtime 从“只执行第一个”细化为“相同事务去重、不同事务拒绝”。另一次随机运行证明 Context-only 调用若与物理 Attempt 共用预算，会让 Agent 正确诊断后没有机会编辑，因此两种预算被正式分离。

最终真实回归结果：

| 指标 | 结果 |
| --- | ---: |
| 总分 | 95 / 100 |
| 公开测试 | 5 / 5 |
| 隐藏测试 | 6 / 6 |
| 修改范围 | 仅 `src/retry.rs`、`src/store.rs` |
| Context commit | 4 |
| Context failure/rejection | 0 |
| 物理 work Attempt | 9 |
| Context Attempt | 4 |
| 最终回复 | 1 |

最终 Mind version 为 4：受保护 `task` frame 的状态是 `completed`，包含三个根因、约束和五项公开测试结论；另有从最终 `exec` 输出派生的 `test_evidence` frame。Context 使用量为 4/6，未挤占物理工作预算。95 分中的 5 分损失来自 9 次物理 work Attempt 超过效率满分阈值，不再来自 Context 维护。
