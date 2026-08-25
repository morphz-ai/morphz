# ME-01 p1.1 Supersession Conflict 三组结果

> 日期：2026-08-25  
> 证据等级：`F`（Pilot 前真实模型可行性 cell）  
> 协议：`me01-context-reentry-p1.1-candidate`  
> Fixture：`me01-p1-supersession-conflict-01`  
> Suite：`ME-01-real-smoke-20260825T053954.305Z-59200`

## 结论

三组均正确处理了两级显式 supersession：`/hooks/v2` 先取代 `/hooks/v1`，随后
`/hooks/v3` 又取代 `/hooks/v2`。最终三组都返回：

```json
{
  "action": "route_webhook",
  "object_id": "billing-webhook",
  "value": "/hooks/v3",
  "evidence_id": "ev-sc-003"
}
```

没有任何一组错误复用 `/hooks/v1` 或 `/hooks/v2`。因此，这个 cell 继续支持当前的有限
结论：在完整历史仍可容纳于 Context 的简单修订任务上，Structured Context 与 Mind Frame
没有降低最终行动正确性。本结果不证明 Morphz 优于完整消息历史。

## 主要比较结果

| Arm | 严格成功 | 当前值 | 正确证据 | 进程重启 |
| --- | ---: | --- | --- | --- |
| `append_only` | 1/1 | `/hooks/v3` | `ev-sc-003` | 不适用 |
| `structured_no_direct_reentry` | 1/1 | `/hooks/v3` | `ev-sc-003` | 已证明 |
| `full_morphz` | 1/1 | `/hooks/v3` | `ev-sc-003` | 已证明 |

三组的主要指标只有最终行动是否严格正确。`context_tx` 对前两组不适用，不把原始零计数
解释成零分。

## 完整 Morphz 的补充机制轨迹

完整 Morphz 在任务语义要求保留和修订状态时，自主选择了两次 `context_tx`。这不是三组
比较指标，只用于证明真实生产机制被执行。进程重启前的行动投影中：

- `mind_version = 2`；
- `billing-webhook-route-current` revision 2，当前值为 `/hooks/v3`；
- `/hooks/v1` 和 `/hooks/v2` 分别作为 superseded 状态保留；
- relation chain 为 `/hooks/v3 → /hooks/v2 → /hooks/v1`；
- 最终行动合同被保留；
- 共 4 个行动前 Frame，均有来源链。

该结果表明，当通用任务明确要求“保留当前与被取代状态、吸收权威修订”时，Morphz 能把
这些语义组织成 Mind Frame 并在重启后使用。它不能证明没有此类任务提示时 Agent 会自然
选择提交，也不涉及 Context 压力。

## 模型、调用与异常

- requested / physical model：`gpt-5.6-sol`；
- reasoning：`max`；Provider：`custom` OpenAI Responses；fallback：`false`；
- Morphz 权限：`full_access`；各组状态目录隔离；
- `append_only`：3 次成功模型调用；兼容 Provider 未返回 usage；
- `structured_no_direct_reentry`：3 次调用，54,231 Provider-reported total tokens；
- `full_morphz`：5 次调用，103,216 Provider-reported total tokens；
- runner commit：`9511710`；
- 实验使用的 Morphz 二进制 SHA-256：
  `0e24c92ee797d72d6b79725284dd181de76de4f6f6bd9bec771ed151d6535db4`。

完整 Morphz 在第二次事务后的工具结果求值阶段遇到 4 次 HTTP 500 stream establishment
失败，随后 shared Provider circuit 短暂打开；Runtime 在同一 episode 内恢复，继续完成
回复、进程重启与最终行动。该异常完整保留在 `full_morphz/agent.stdout.log`，没有删除、
另开 episode 或把失败尝试伪装成独立成功样本。

## 无效的预连接启动

第一次启动在任何模型响应产生前被本地执行沙箱阻止解析 `mini-m4.local`，错误类别为
`TransientNetwork`。该目录没有可计分 episode，也没有消耗成一个任务结果；随后在已有
外部网络授权下，以相同冻结代码、fixture 和模型配置重新启动。

无效启动的可见 fixture 和预检保存在 `invalid_preconnect_launch/`，机器可读说明见
`invalid_preconnect_launch/failure_receipt.json`。它不与三组结果混算。

## 产物

仓库归档包含 summary、preflight、可见 fixture、三组 observed episode 与 score、完整
Morphz/只读组的 Event History、Context 投影、usage、PID 和日志，以及 append-only 的完整
消息 transcript 和调用 receipt。SQLite 主库和 Provider 控制数据库未提交 Git。

原始目录：

```text
/private/tmp/morphz-me01-real-cells-20260825/
  ME-01-real-smoke-20260825T053954.305Z-59200/
```

`checksums.sha256` 覆盖仓库归档并已逐项验证。

## 当前累计判断

ME-01 目前完成两个真实 cell，共 6 个有效 arm episode，严格正确率均为 100%。这仍是小规模
可行性结果，且存在明显天花板效应；不能提升为确认性统计结论。下一项应优先测试
source authority 或跨 Session continuity，而不是重复本题。

