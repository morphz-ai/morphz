# ME-01 p1.1 Source Authority 三组结果

> 日期：2026-08-25  
> 证据等级：`F`（Pilot 前真实模型可行性 cell）  
> 协议：`me01-context-reentry-p1.1-candidate`  
> Fixture：`me01-p1-source-authority-01`  
> Suite：`ME-01-real-smoke-20260825T063035.871Z-60579`

## 结论

三组都正确遵守“来源权威性优先于时间新旧”：保留正式安全审议机构批准的 `R-45`，没有
让较新的未批准草案 `R-07` 或传闻 `R-90` 覆盖权威政策。三组最终输出完全一致：

```json
{
  "action": "set_retention_tier",
  "object_id": "audit-export",
  "value": "R-45",
  "evidence_id": "ev-sa-001"
}
```

本 cell 继续支持“Structured Context 与 Mind Frame 没有使简单状态判断退化”的有限结论，
不支持 Morphz 优于完整消息历史。任务提示本身明确给出了权威来源和“recency 不等于
authority”的约束，因此它主要验证三种表示/运行路径能否正确保留和执行同一语义，而不是
测试模型能否自行发明权威规则。

## 主要比较结果

| Arm | 严格成功 | 采用值 | 采用证据 | 拒绝非权威值 | 进程重启 |
| --- | ---: | --- | --- | --- | --- |
| `append_only` | 1/1 | `R-45` | `ev-sa-001` | `R-07`, `R-90` | 不适用 |
| `structured_no_direct_reentry` | 1/1 | `R-45` | `ev-sa-001` | `R-07`, `R-90` | 已证明 |
| `full_morphz` | 1/1 | `R-45` | `ev-sa-001` | `R-07`, `R-90` | 已证明 |

`context_tx` 对前两组不适用，不作为比较得分。

## 完整 Morphz 的补充机制轨迹

在通用任务要求保留来源约束并吸收非权威新证据时，完整 Morphz 自主执行了两次
`context_tx`。这只证明正式机制确实被执行：

- `mind_version = 2`；
- 行动前存在一个 revision 2 的 `audit_export_retention_policy` Frame；
- Frame 明确保留 `security-review-board` 的权威角色和 `R-45 / ev-sa-001`；
- `R-07` 与 `R-90` 被记录为后来的非权威证据，`decision-effect = none`；
- 进程重启后的最终行动仍引用权威证据。

该轨迹不意味着前两组“得零分”，也不证明没有保存语义提示时 Agent 会自然提交 Mind
Frame。

## 模型、调用与完整性

- requested / physical model：`gpt-5.6-sol`；reasoning：`max`；
- Provider：`custom` OpenAI Responses；fallback：`false`；
- Morphz 权限：`full_access`；不同组使用隔离状态目录；
- `append_only`：3 次调用，Provider 未返回 usage；
- `structured_no_direct_reentry`：3 次调用，53,600 Provider-reported total tokens；
- `full_morphz`：5 次调用，97,221 Provider-reported total tokens；
- runner commit：`9511710`；
- Morphz 二进制 SHA-256：
  `0e24c92ee797d72d6b79725284dd181de76de4f6f6bd9bec771ed151d6535db4`；
- 本次没有 Provider 传输失败或可计分前的无效启动。

归档包含 summary、preflight、三组 observed episode/score、完整 Event History、Context 投影、
usage、PID、日志和 append-only transcript。SQLite 与 Provider 控制数据库不提交 Git。

原始目录：

```text
/private/tmp/morphz-me01-real-cells-20260825/
  ME-01-real-smoke-20260825T063035.871Z-60579/
```

`checksums.sha256` 覆盖仓库归档并已逐项验证。

## 当前累计判断

ME-01 已完成三个真实 cell，共 9 个有效 arm episode，严格正确率均为 100%。这进一步说明
当前简单任务存在天花板效应：它们适合验证机制可工作、结果没有退化，但不足以区分三组
能力上限。下一步若继续，应进入跨 Session continuity 或 Context isolation，而不是重复
单 Session 的短历史判断。

