# terminal-task v0.2 Torch 执行轨迹

来源：

- job：`/opt/morphz-benchmark/source/jobs/2026-08-24__07-18-58`
- trial：`torch-pipeline-parallelism__6YJdaKA`
- Harness：`terminal-task@0.2.0`
- model：`gpt-5.6-sol` / reasoning `max`
- Runtime：`paper-eval-runtime-v4@5e4b0ffcd89245f19d84ec3569605ae27a44e02b`

文件：

- `trajectory.atif.json`：从权威 Morphz SQLite Event Store 投影的原始 ATIF-v1.7；
- `trajectory.readable.md`：原始 ATIF 的完整机械展开，便于逐轮阅读。

原始 ATIF SHA-256：

`168b686a1753e94ee446baa8968b72ca7ddc5f9fafd2437a4385a8b52e7f591e`

导出仅包含公开任务说明、Agent/model 消息、工具调用、工具结果、usage 和 Harness
绑定。未读取或加入隐藏 verifier、private tests、reward 文件内容。
