# Morphz 论文实验 Runtime 基线 v1

> 基线 ID：`paper-eval-runtime-v1`
>
> 冻结日期：2026-08-17（Asia/Shanghai）
>
> 状态：已冻结，可用于论文实验的工程基线

## 1. 权威代码身份

| 字段 | 值 |
| --- | --- |
| Git tag | `paper-eval-runtime-v1` |
| Morphz commit | `cbfc540cedcdba8fba2dcbfbe6f37f1cc37d6df5` |
| Commit subject | `fix: recover durable activation causality` |
| Commit time | `2026-08-17T02:54:25+08:00` |

上述完整 commit 是论文实验开始前冻结的 Runtime 代码边界。实验运行记录必须保存实际 commit；只有实际 commit 等于本基线，才能简写为 `paper-eval-runtime-v1`。

> 2026-08-17 仓库统一重写历史 author/committer 邮箱后，本基线由原 SHA
> `45ed92a1535f952cdac1b5b08dcce19b7d627c55` 映射为上述 SHA；代码树和提交主题未变。
> 当前新实验默认使用 [Runtime 基线 v3](./runtime_baseline_v3.md)，本文件仅保留历史追溯。

## 2. 冻结依据

在该 commit 上已完成：

- `cargo fmt --all -- --check`；
- `cargo clippy -p morphz --all-targets -- -D warnings`；
- `cargo test -p morphz` 全量测试；
- release 二进制构建；
- 使用既有真实数据库启动和迁移；
- 部署后服务运行正常。

后两项由项目负责人在实际部署环境中于 2026-08-17 验证。

## 3. 基线含义

本基线冻结的是论文实验所依赖的 Runtime 语义和实现起点，不代表任何实验协议、模型配置或数据集自动冻结，也不代表系统从此不存在缺陷。

每个正式 Run 仍须独立记录：

- 实际 Runtime commit 与 dirty 状态；
- Provider、物理模型和推理参数；
- Morphz 配置、Context 容量与权限策略；
- 实验协议、fixture、随机种子、Runner 和评分器版本；
- 原始产物位置与校验值。

## 4. 基线变更规则

1. 实验期间不在本 tag 上移动或覆盖代码；
2. 非阻塞性优化和架构重构不得静默混入同一实验批次；
3. 若发现阻塞实验的正确性问题，修复后建立新的版本化基线，并在 Run 记录中声明受影响范围；
4. 不同 Runtime commit 的结果不得在未分析实现差异的情况下直接合并；
5. Git tag、本文档和单次 Run 的 `manifest.json` 三者共同构成可追溯链路。

## 5. 已知非阻塞后续项

以下事项没有纳入本次冻结前的扩大修改范围：

- Context 主动维护完整读—决策—写周期的进一步合并与性能优化；
- 数据库表结构的物理合并；
- 不改变正确性语义的其他性能和产品体验优化。

这些事项不是当前论文实验启动的阻塞条件；若后续修改影响实验变量或运行语义，必须提升基线版本。
