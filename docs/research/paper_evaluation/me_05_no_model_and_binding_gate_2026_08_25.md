# ME-05 p1 无模型与九模型精确绑定 Gate

> 日期：2026-08-25  
> 模型 completion 调用：`0`  
> 结论：`ready_for_stage_a=true`

## 确定性 Gate

- ME-02：6 个冻结任务 × 3 个表示 arm；semantic digest、共同 system contract、隐藏答案
  防泄漏、原生类型、正例 scorer 和负例 scorer 全部通过；
- ME-03：3 个任务 × 4 个条件；每个非确定性 Context 均存在多个合法值，Base/Intervention
  合法集合不相交，确定性控制结果唯一，正负 scorer 和 Prompt contract 全部通过；
- ME-05 launcher：6 个标准库测试通过，覆盖 144-cell 矩阵规模、Claude 精确协议、独立
  SQLite、错误 episode 数、协议替换和非空 stage 目录复用；
- `morphz-evals`：93 个库测试、3 个 Harness 测试通过；
- Clippy：`-D warnings` 通过；`git diff --check` 通过。

## 九模型零 completion 绑定

| 模型 | Provider / account | 物理模型 | 协议 | endpoint | max 请求 | completion |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-5.6-sol` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |
| `claude-opus-5` | `custom/custom-default` | 同名 | `anthropic-messages` | `mini-m4.local:8317/v1` | 是 | 0 |
| `grok-4.6` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |
| `gemini-3.7-flash-high` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |
| `deepseek-v4-pro` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |
| `bai-deepseek-v4-flash` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |
| `k3-256k` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |
| `glm-5.3` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |
| `qwen3.8-max-preview` | `custom/custom-default` | 同名 | `openai-responses` | `mini-m4.local:8317/v1` | 是 | 0 |

Claude 的 `anthropic-messages` 是 Morphz 在同一个 CLIProxyAPI endpoint 上记录的精确 wire
protocol，不是直连 Anthropic，也不是 fallback。全部九条 route 均为单 candidate、
`fallback=false`；此前九模型各一次返回固定探针文本的 completion 只证明线路可用，不计入
论文结果。

## 隔离与费用边界

冻结配置不包含固定数据库路径。ME-05 runner 为每个 `model × stage × ME` 创建独立目录，
ME-02/ME-03 再于各自 run 目录创建唯一 `provider-control.db`。凭据只由宿主环境变量解析，
不写入 manifest、stdout 或仓库。

Stage A 是正式矩阵的预注册第一部分，不在成功后重复运行。Kimi K3 约 100 元额度只作为
用户当前账户余额信息，不作为结果选择或提前停止阈值；runner 保存 Provider usage，若出现
异常请求膨胀、重复计费或线路故障，先暂停审计。

## 下一步

从包含 frozen protocol、配置、ME-02/ME-03 runner、共享精确绑定检查和 ME-05 launcher 的
干净 commit 构建固定二进制；随后以最大并发 3 运行 Stage A 的 45 个 cell。只有九模型的
报告、绑定、episode 数和独立数据库完整性全部通过且代码未改动，才进入 Stage B。
