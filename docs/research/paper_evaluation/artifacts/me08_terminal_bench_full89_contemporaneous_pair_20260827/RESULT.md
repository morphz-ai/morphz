# ME-08 Terminal-Bench 2.1 完整 89 题同期配对结果

> 日期：2026-08-27  
> 协议：`ME-08-terminal-bench-2.1-full-89-contemporaneous-pair-v2`  
> 主评分：Terminal-Bench 官方验证器原始奖励  
> 采样：每个智能体对全部 89 题各运行一次；实验组内并发 8；零重试

## 1. 运行身份

两组都是独立、完整的 89 题运行，不使用前 40 题与后 49 题拼接：

| 项目 | Morphz | 官方 Codex |
| --- | --- | --- |
| 模型 | `gpt-5.6-sol` / `max` / `fallback=false` | `gpt-5.6-sol` / `max` / `fallback=false` |
| 主机与数据集 | 同一 Linux/amd64 主机；同一 Terminal-Bench 2.1 registry digest | 同左 |
| 授权 | `full_access` | `dangerously-bypass-approvals-and-sandbox` |
| 并发 / 重试 | 8 / 0 | 8 / 0 |
| Runtime / Agent | Morphz `4bbc3d63f4bda09947dc79dc5656edc71f8c02fa` | Codex CLI `0.149.1` |
| 二进制 | SHA-256 `31f6cdd3de8ddf4a76e190eb4c0863ff9de7c9159c7acbf7ac2765b474ec0575` | 官方 Codex CLI |
| 评测基础设施 | `926b9230c1965cf9c2ca004143eab3d1e15125b4` | `a226bfef1b555e2d83fa4b3ce6d90790bc522705` |
| 运行窗口 | 05:21–06:57 | 00:32–02:29 |

## 2. 官方得分与配对统计

| 智能体 | 通过 | 正确率 | Wilson 95% 区间 |
| --- | ---: | ---: | ---: |
| Morphz | 72/89 | 80.90% | [71.52%, 87.72%] |
| 官方 Codex | 74/89 | 83.15% | [74.04%, 89.51%] |

逐题配对结果：

- 共同通过：65；
- 共同失败：8；
- 仅 Morphz 通过：7；
- 仅 Codex 通过：9；
- Morphz−Codex：−2.25 个百分点；
- 固定种子 `20260827`、10,000 次任务级自助法 95% 区间：
  [−11.24,+6.74] 个百分点；
- 双侧精确配对检验：`p=0.803619`。

这次单次配对没有解析出稳定的系统差异；区间过宽，也不能据此宣称等价或非劣。

## 3. 官方评分器与本地扫描器

冻结协议以官方验证器原始奖励为主。附加本地完整性扫描器在 Codex 组取消了
`install-windows-3.11` 和 `password-recovery` 两个试次的资格，其中只有前者的官方原始奖励为
1，因此本地严格分为 73/89。该扫描器不是官方评分器，不覆盖官方 74/89；原始 finding 仍保留
在 `codex/strict_result.json` 中供审计。

Morphz 的官方原始分与附加严格分均为 72/89，完整性门禁通过。

## 4. 完整智能体工程画像

| 指标 | Morphz | 官方 Codex | 描述性差异 |
| --- | ---: | ---: | ---: |
| 模型服务方报告输入词元 | 57,541,202 | 82,153,524 | — |
| 模型服务方报告输出词元 | 1,246,760 | 1,208,463 | — |
| 输入加输出 | 58,787,962 | 83,361,987 | Morphz 少 29.5% |
| 每个已尝试任务输入加输出 | 660,539 | 936,652 | Morphz 少 29.5% |
| 缓存输入子集 | 9,389,568 | 76,503,680 | 单列，不作独立效率分数 |
| 端到端墙钟 | 5,722.7 秒 | 7,065.2 秒 | Morphz 短 19.0% |
| Harbor 终态异常 | 3 次超时 | 3 次安全拒绝、3 次超时 | 全部保留并计零 |

两组错误封装方式不同，不能仅按异常类名称推断失败原因相同或不同。词元与墙钟是这一次匹配
运行的描述性结果，不单独证明结构化上下文的因果效率优势，也不外推到其他模型、任务或接口。

## 5. 主机资源

两组均运行在 16 个逻辑处理器、61.52 GiB 内存的同一主机。Morphz 窗口平均已用内存
4.75 GiB、峰值 7.52 GiB，1 分钟负载平均 2.256；Codex 窗口平均已用内存约 6.03 GiB、
峰值约 10.56 GiB，1 分钟负载平均 5.918。两段都是整机采样，不能直接归因到单个智能体进程。

## 6. 归档文件

- `paired_summary.json`：官方原始分、逐题配对、区间、词元、墙钟与主机资源汇总；
- `morphz/strict_result.json`、`codex/strict_result.json`：89 个唯一任务及完整性审计；
- `morphz/result.json`、`codex/result.json`：Harbor 运行汇总；
- `morphz/launcher_manifest.json`：Morphz 冻结任务、模型、Runtime 与二进制身份；
- `morphz/all_89_morphz_summary.json`：Morphz 完整批次和资源摘要；
- `morphz/resource_samples.jsonl`、`codex/host-resource-samples.jsonl`：整机采样；
- `checksums.sha256`：上述归档文件的 SHA-256。

原始云端目录分别为：

- `/opt/morphz-benchmark/repeat-runs/me08-4bbc3d6-r1-20260827`；
- `/opt/morphz-benchmark/repeat-runs/me08-new-account-codex-r2-20260827`。

归档文件已检查，不包含模型服务凭据。
