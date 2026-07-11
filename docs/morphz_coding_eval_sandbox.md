# Morphz Coding Eval Sandbox

Coding Eval Sandbox 为每次真实模型代码修复测试创建独立、可审计的运行环境，避免把主仓库直接暴露给 Agent 或让测试命令以无限制宿主 Shell 运行。

## 边界模型

每个 run 使用随机私有目录：

```text
/private/tmp/morphz-eval-runs/<run-id>/
├── manifest.json       # Runtime/evaluator 可见，Agent 不可见
├── morphz.db           # 独立 Event Ledger
├── artifacts/          # 仅允许 Agent 只读的 exec 输出
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
cargo run -p morphz --bin coding_eval_env -- create
```

也可指定 run 根目录：

```bash
cargo run -p morphz --bin coding_eval_env -- create /private/tmp/morphz-eval-runs
```

输出 JSON 包含启动所需环境变量：

- `MORPHZ_WORKSPACE_ROOT`
- `MORPHZ_DB_PATH`
- `MORPHZ_ARTIFACT_DIR`
- `MORPHZ_EXEC_SEATBELT=true`
- `MORPHZ_EXEC_NETWORK=false`
- `MORPHZ_CODING_EVAL_MODE=true`

## macOS Seatbelt

评测模式中的 `exec` 通过 `/usr/bin/sandbox-exec` 启动。Profile：

- 禁止网络；
- 禁止全局文件写入；
- 只允许 workspace 和 `/dev/null` 写入；
- 禁止读取用户 HOME，重新只读开放 `.cargo/.rustup` 工具链；
- 禁止读取 `/private/tmp` 其他目录，重新开放当前 workspace；
- cwd 必须通过 Morphz workspace jail。

这使 Agent 不能通过 `exec` 读取主仓库的用户文件、读取 run 外 manifest，或在 workspace 外创建文件。Linux/生产环境仍应使用容器、namespace 或独立用户；Seatbelt 只覆盖 macOS 评测路径。

## 固定探针与验证

验证读写逃逸被阻止：

```bash
cargo run -p morphz --bin coding_eval_env -- probe RUN_ROOT
```

运行 manifest 中不可由 Agent 改写的固定验证命令：

```bash
cargo run -p morphz --bin coding_eval_env -- verify RUN_ROOT
```

检查文件修改范围：

```bash
cargo run -p morphz --bin coding_eval_env -- audit RUN_ROOT
```

## Ledger 评分

```bash
cargo run -p morphz --bin coding_eval_env -- score RUN_ROOT
```

评分总计 100 分：

| 维度 | 分值 |
| --- | ---: |
| 最终测试、单一 file change、Context transaction 无失败 | 40 |
| 修改范围与全部必用工具约束 | 20 |
| 目标/约束保护、最终 Context 收口 | 20 |
| Attempt 数量与单一最终回复 | 10 |
| 先复现失败、后验证成功 | 10 |

报告同时输出 Attempt、回复数、Context commit、工具集合、缺失工具及所有范围违规，避免只依据 Agent 的最终自述评分。

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
| 总分 | 95 / 100 |
| 最终固定测试 | 3 / 3 通过 |
| 修改范围 | 仅 `src/lib.rs` |
| 越界创建、删除或写入 | 0 |
| Assistant attempts | 5 |
| Context transactions | 3 次提交，0 次失败 |
| File changes | 1 |
| 最终回复 | 1 |
| 已用必需工具 | `list_files`、`read`、`edit`、`exec`、`context_tx` |
| 缺失必需工具 | `search` |

Agent 先复现了失败测试，再修复 `parse_retry_after` 对首尾 SP/HTAB 的处理，并完成回归验证。独立 verifier 重新执行测试通过，hash audit 只发现允许的目标文件发生变化。缺失 `search` 按约束维度扣 5 分，不影响本次功能正确性结论，但说明后续评测需要区分“解决任务所必需的能力”和“为了覆盖工具而强制调用的能力”。

这次测试同时暴露并修复了三个 Runtime 问题：同步 `exec` 的默认等待时间过短、严格评测下 Artifact 未被重新开放为只读、并发 tool-output 唤醒可能生成重复最终回复。修复后第二次运行只产生一次最终回复。
