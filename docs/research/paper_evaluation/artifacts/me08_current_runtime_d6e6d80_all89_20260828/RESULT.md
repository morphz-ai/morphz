# ME-08 当前 Runtime：Terminal-Bench 2.1 完整 89 题结果

## 主结果

- Morphz Runtime：`d6e6d80053d95577811971e6048033374e4d6901`
- 评测基础设施：`09477921ae35ac94823cb026bf5394a9445b6667`
- 模型：GPT-5.6 Sol，最高推理强度
- 任务：Terminal-Bench 2.1 全部 89 题，每题一次
- 并发：8；重试：0；Harness：无
- 官方验证器原始得分：**72/89（80.90%）**

与冻结的 Codex CLI 0.149.1 完整 89 题对照逐题配对后：

- Codex：74/89（83.15%）
- Morphz−Codex：−2.25 个百分点
- 仅 Morphz 通过：6
- 仅 Codex 通过：8
- 共同通过：66
- 共同失败：9
- 任务级自助法 95% 区间：`[−10.11,+5.62]` 个百分点
- 双侧精确配对检验：`p=0.791`

本次单次配对没有解析出稳定的系统差异。

## 工程指标

| 指标 | Morphz | Codex |
| --- | ---: | ---: |
| 输入加输出词元 | 57,105,318 | 83,361,987 |
| 每题平均词元 | 641,633 | 936,652 |
| 端到端墙钟 | 5,320.2 秒 | 7,065.2 秒 |

Morphz 的总逻辑词元少 31.50%，端到端墙钟短 24.70%。本轮缓存率和按价表折算的 API 等效成本受已确认的显式缓存封装缺陷影响，不作为论文结果。原始数值与 Runtime usage 对账保留在 [API_COST_AUDIT.md](./API_COST_AUDIT.md)，缺陷证据和逐调用分析见 [PREFIX_CACHE_ANALYSIS.md](./PREFIX_CACHE_ANALYSIS.md)。

## 主机资源

Morphz 运行窗口共采样 178 次。主机有 16 个逻辑处理器和 61.52 GiB 内存；整机平均已用内存 3.86 GiB、峰值 7.26 GiB，1 分钟平均负载 2.443。

## 证据入口

- `launcher_manifest.json`：冻结任务、并发、Runtime 与二进制身份
- `launcher_result.json`：完整运行终态
- `job_audit/result.json`：Harbor 官方汇总与 usage
- `job_audit/strict_result.json`：89 题官方原始奖励和本地辅助审计
- `all_89_morphz_summary.json`：单臂汇总
- `paired_summary_vs_codex_20260829.json`：与 Codex 的新逐题配对统计
- `resource_samples.jsonl`：主机资源采样
