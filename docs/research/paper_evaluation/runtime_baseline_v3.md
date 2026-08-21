# Morphz 论文、路演与 Benchmark Runtime 基线 v3

> 基线 ID：`paper-eval-runtime-v3`
>
> 冻结日期：2026-08-20（Asia/Shanghai）
>
> 状态：当前默认 Runtime 源码基线

## 1. 权威代码身份

| 字段 | 值 |
| --- | --- |
| Git tag | `paper-eval-runtime-v3` |
| Morphz commit | `f875b93869282a14b738edec2f3a4069fd003600` |
| Commit subject | `fix: recover provider and managed execution paths` |
| Commit time | `2026-08-20T13:01:52+08:00` |
| Author / committer | `fearless <shafreeck@gmail.com>` |

该提交是 2026-08-20 之后新启动的论文预实验、路演真实能力验证和公开
Benchmark 接入的默认 Runtime 源码起点。每个 Run 仍须记录实际 Runtime commit；
只有实际 commit 等于本基线时，才能简写为 `paper-eval-runtime-v3`。

该 tag 只冻结 Git 已提交内容。创建 tag 时工作区中的未跟踪文档、生成文件、
本地 Morphz 状态和临时目录均不属于本基线。

## 2. 为什么从 v2 提升到 v3

v2 冻结之后，Runtime 的并发、恢复、身份和 Provider 状态机发生了多项会影响
实验结果的实质修复，不能继续把新结果记在 v2 名下。v3 主要纳入：

- Objective 等待条件、后台唤醒投递和模型配置变更后的恢复；
- Shared Runtime、后台执行可见性和持久化恢复路径加固；
- Provider Account 生命周期、额度与认证错误分类、健康账户故障转移，以及
  SQLite/PostgreSQL revision CAS 并发状态迁移；
- reasoning-only 响应续接、无效响应纠错 continuation 和工具调用执行历史保留；
- Principal 与求值 Context 的绑定及身份作用域工具；
- Managed SSH 连接建立超时与失活检测，同时保留普通非托管 SSH 的拒绝边界；
- Structured Context 编码缩减及默认 Observation 状态的隐式表示。

这些变化会影响跨 Session、并发、恢复、长程执行、模型调用失败分类和成本测量，
因此 v2 与 v3 的结果不得在未分析 Runtime 差异的情况下直接合并。

## 3. 冻结时验证状态

开发任务在形成该提交前记录了以下验证：

- `cargo fmt --check`：通过；
- `cargo clippy --all-targets -- -D warnings`：通过；
- response/attempt-loop 定向回归 67 项：通过；
- Provider 路由、Account 状态迁移和 SQLite/PostgreSQL CAS 回归：通过；
- Managed SSH 存活边界与普通 SSH 拒绝回归：通过；
- Provider/Account 修复阶段的完整测试曾达到 0 失败；
- 随后的完整并行/串行运行仍出现过三条不同 Objective 时序测试的非稳定超时或
  计数竞争，且各用例独立复跑通过。

因此 v3 是当前正确的功能基线，但不得表述为“完整并发测试套件已稳定无波动”。
第一次真实模型 Pilot 前，必须从该 tag 的干净 checkout 重新记录完整测试、定向
并发压力测试、Clippy、构建和实验 adapter 验证结果。

## 4. 使用规则

1. 新的论文 Pilot、路演真实 Morphz E2E 和公开 Benchmark 接入默认使用 v3；
2. v1/v2 已有结果保留原基线身份，不追写成 v3；
3. 已执行的 DEMO-001 frozen-v2/v2.1 结果继续保留其历史 commit，且不得作为
   新路演结论；
4. Run manifest 同时记录 Runtime commit、实验包 commit/tag、dirty 状态、模型、
   Provider、协议版本和原始产物；
5. Benchmark adapter、fixture、scorer 或提交协议变化时提升实验包版本，不移动
   `paper-eval-runtime-v3` tag；
6. 若后续 Runtime 修复会影响求值、状态、调度、权限、恢复或 Provider 行为，建立
   v4，而不是移动 v3。

## 5. 历史关系

- v1：历史论文实验基线；
- v2：截至 2026-08-17 的持久 Session 协调基线；
- v3：纳入 2026-08-18 至 2026-08-20 的 Runtime 并发、恢复、身份、Provider 和
  Managed Execution 修复，作为当前新实验基线。
