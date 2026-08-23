# Morphz 论文、路演与 Benchmark Runtime 基线 v4

> 基线 ID：`paper-eval-runtime-v4`
>
> 冻结日期：2026-08-24（Asia/Shanghai）
>
> 状态：当前默认 Runtime 源码基线

## 1. 权威代码身份

| 字段 | 值 |
| --- | --- |
| Git tag | `paper-eval-runtime-v4` |
| Morphz commit | `5e4b0ffcd89245f19d84ec3569605ae27a44e02b` |
| Commit subject | `fix(runtime): isolate provider recovery and stabilize execution` |
| Commit time | `2026-08-24T00:14:22+08:00` |
| Author / committer | `fearless <shafreeck@gmail.com>` |
| Linux/AMD64 reproducible binary SHA-256 | `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67` |
| Superseded pre-migration binary SHA-256 | `960a7d49089969bb0bbd6517307561fa2d83fd5a4bad68856b47fc8a75eb68ac` |
| Harbor watcher SHA-256 | `d41c6c5789421d0b957d78269d886a638c1def323b8b2098763fbfadee8f9063` |

该提交是 2026-08-24 之后新启动的论文实验、路演真实能力验证和公开
Benchmark 的默认 Runtime 源码起点。每个 Run 仍须记录实际 Runtime commit；只有
实际 commit 等于本基线时，才能简写为 `paper-eval-runtime-v4`。

该 tag 只冻结 Git 已提交内容。创建 tag 时工作区中的未跟踪文档、生成文件、
本地 Morphz 状态和临时目录均不属于本基线。

## 2. 为什么从 v3 提升到 v4

v3 的 Terminal-Bench 2.1 运行暴露了 Provider 恢复、长程求值和测试并发时序方面的
问题；随后开发又修复了会影响新实验结果的 Runtime 行为，因此不能继续沿用 v3：

- Session 模型或推理配置改变后，精确唤醒该 Session 中等待旧 Provider 路由的
  Thread/Objective；不再要求旧模型先恢复，也不误唤醒其他 Session；
- 将 Provider 临时健康状态从账户级拆为 `路由 × 账户`，一个模型的限流、额度耗尽
  或冷却不再污染同账户下的其他模型；账户禁用、撤销和凭证失效仍保持全局语义；
- 在持久 Plan 执行边界建立独立 Tokio 任务，切断嵌套求值的同步 poll 栈，同时
  保留父子结构化取消，消除默认测试线程栈溢出；
- 修正 Objective Timer、Artifact Transfer 取消 revision CAS 和重启恢复测试中的
  非确定性竞争，使测试断言与生产并发语义一致，而不是通过增大线程栈或降低并发
  掩盖问题。

这些变化会影响模型故障恢复、跨 Session 隔离、长程任务收敛、后台任务终态与
Benchmark 稳定性，因此 v3 与 v4 结果不得静默混合。已经完成的 TB2.1 v1 结果仍
属于 v3；基于 v4 的新试次必须建立新 Run 身份。

## 3. 冻结时验证状态

开发任务在形成该提交前记录了以下默认环境 Gate：

- `cargo test -q -p morphz --lib`：984 passed、0 failed、6 ignored；
- `cargo clippy -j 1 -p morphz --lib -- -D warnings`：通过；
- `cargo test -p morphz --test runtime_store_conformance`：5 passed；
- `cargo check -p morphz --all-targets`：通过；
- `cargo fmt --all -- --check`：通过；
- Dashboard：160 tests、lint、production build 全部通过；
- Objective 中断回归连续 10 次通过，Artifact Transfer 取消回归连续 20 次通过；
- 默认线程栈下的持久 Harness/Plan 回归通过，未设置 `RUST_MIN_STACK`。

Linux/AMD64 二进制使用固定的
`rust:1.97.1-bullseye@sha256:02d78ca3f928195c2a907543de778adfd728ad7e2a24fdc6aef582b7c77842e0`
构建。境外冻结节点使用 Rust 官方分发端点获取固定 Rustup 组件，并继续使用已检入
配置的 Cargo sparse index；Rustup、Cargo.lock 和最终二进制哈希仍承担内容校验，
传输路径不改变冻结版本。

2026-08-24 迁移时在全新节点发现：旧 Dockerfile 将 `.git` 排除出构建上下文，却未将
Runtime commit 显式传给 `morphz/build.rs`；挂载的 Cargo target cache 可能沿用历史
build-script 输出。因此旧 artifact 虽对应同一源码树，其自报构建身份不可由干净节点
可靠重现。修订后的 Dockerfile 强制要求
`MORPHZ_BUILD_GIT_COMMIT=5e4b0ffcd89245f19d84ec3569605ae27a44e02b`；替换 artifact
自报该完整 commit，并以相同冻结参数二次导出、逐字节一致。旧哈希仅保留作审计，
不得用于新 Run。该修订不改变 Runtime 源码和 v4 tag，只修正 artifact 身份冻结。

## 4. 使用规则

1. 新论文 Pilot、路演真实 Morphz E2E 和公开 Benchmark 默认使用 v4；
2. v1/v2/v3 已有结果保留原基线身份，不追写成 v4；
3. 每个 Run manifest 同时记录 Runtime commit、实验包 commit/tag、dirty 状态、
   Linux 二进制哈希、模型、Provider、协议版本和原始产物；
4. Benchmark adapter、fixture、scorer 或提交协议变化时提升实验包版本，不移动
   `paper-eval-runtime-v4` tag；
5. `gpt-5.6-sol`、reasoning `max`、无 fallback、full-access 和逐 trial 独立容器/
   SQLite/Context/Session 仍是当前 TB2.1 对比约束；
6. 若后续 Runtime 修复会影响求值、状态、调度、权限、恢复或 Provider 行为，建立
   v5，而不是移动 v4。

## 5. 历史关系

- v1：历史论文实验基线；
- v2：截至 2026-08-17 的持久 Session 协调基线；
- v3：2026-08-20 首次 Terminal-Bench 2.1 正式批次基线；
- v4：纳入 Session 定向恢复、Provider 路由健康隔离、持久执行栈隔离和并发测试
  收口，作为当前新实验基线。
