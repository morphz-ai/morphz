# ME-XX Run 记录

## 1. 身份

| 字段 | 值 |
| --- | --- |
| Run ID |  |
| 实验/阶段 |  |
| 协议版本 |  |
| Arm |  |
| 开始/结束时间 |  |
| 执行人/执行 Agent |  |
| Artifact root |  |
| 备份位置 |  |

## 2. 代码与环境

| 字段 | 值 |
| --- | --- |
| Morphz commit |  |
| Worktree dirty |  |
| Dirty diff hash/补丁位置 |  |
| Runner/scorer commit |  |
| OS/架构 |  |
| Rust/Python/Node 版本 |  |
| 关键依赖锁文件 hash |  |
| Morphz 节点 ID/实例 |  |
| 授权模式 | `full-access` |
| 数据库类型与实例/路径 |  |
| 数据库初始快照 hash |  |
| Context ID |  |
| 共享 Context/历史 Session 检查 |  |

## 3. 模型与预算

| 字段 | 值 |
| --- | --- |
| Provider |  |
| CLIProxyAPI 路由/账户标识（脱敏） |  |
| Requested model | `gpt-5.6-sol` |
| Physical model |  |
| Reasoning effort | `max` |
| Fallback | `false` |
| API/协议 | OpenAI Responses compatible |
| temperature/top_p/seed |  |
| 输出/上下文预算 |  |
| 并发数/限流 |  |
| 价格快照或成本口径 |  |

## 4. 输入批次

- fixture set/version：
- episode 数：
- 执行顺序文件：
- 配对组：
- 已知偏差：

## 5. 执行结果

| 计数 | 数量 |
| --- | ---: |
| 计划 episodes | 0 |
| 完成 | 0 |
| 语义成功 | 0 |
| 严格成功 | 0 |
| 模型失败 | 0 |
| Runtime 失败 | 0 |
| Provider 故障 | 0 |
| Harness/评分故障 | 0 |

主要指标摘要：

- （待填写）

## 6. 异常与处置

逐条记录时间、episode ID、错误分类、是否补跑、依据的协议条款。不得只写“重试成功”。

| Episode | 异常 | 分类 | 处置 | Replacement Run |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 7. 产物完整性

- [ ] manifest；
- [ ] episodes 索引；
- [ ] 原始请求/响应；
- [ ] 工具和 Runtime trace；
- [ ] Context/Event History 快照；
- [ ] 逐项 scores；
- [ ] summary；
- [ ] checksums；
- [ ] 已完成备份。

## 8. Run 结论

本 Run 是正常结果、需要补跑的服务故障，还是协议/实现问题？它是否可以并入预定统计？这里只做 Run 层判断，不越级写论文结论。
