# ME-01 p1.1 Cross-Session Continuity 三组结果

> 日期：2026-08-25  
> 证据等级：`P`（ME-01 Stage A Pilot）  
> 协议：`me01-context-reentry-p1.1-candidate`  
> Fixture：`me01-p1-cross-session-continuity-01`  
> 有效 Suite：`ME-01-real-smoke-20260825T075147.210Z-64422`

## 结论

三组均正确返回：

```json
{
  "action": "set_fulfillment_mode",
  "object_id": "order-nova-82",
  "value": "bonded-express",
  "evidence_id": "ev-cs-001"
}
```

生产 Morphz 两组的原始 Event History 和 Session 投影证明：建立与修订发生于 Session A，
最终行动发生于独立的 Session B；两个 Session 均真实挂载同一个 Context。完整 Morphz 在
Session A 提交并修订 `order_nova_82_fulfillment_state`，该 Frame 随后出现在 Session B 的
行动前投影中。两个 Morphz 组均更换了进程 PID，并从同一 SQLite 状态恢复。

该 cell 支持 Morphz 跨 Session 共享同一认知状态的实现能力，也继续支持简单任务下未观察
到最终行动正确率退化。由于 `append_only` 基线保留了带 Session 标签的完整共享消息记录，
三组全对仍属于预期的天花板结果，不支持优越性结论。

## 结果

| Arm | 严格成功 | Session A/B 路由 | 当前值/证据 | 重启 |
| --- | ---: | --- | --- | --- |
| `append_only` | 1/1 | 共享消息记录中的 Session 标签 | `bonded-express / ev-cs-001` | 不适用 |
| `structured_no_direct_reentry` | 1/1 | 两个真实 Session → 同一 Context | `bonded-express / ev-cs-001` | 已证明 |
| `full_morphz` | 1/1 | 两个真实 Session → 同一 Context | `bonded-express / ev-cs-001` | 已证明 |

`context_tx` 对前两组不适用。完整 Morphz 产生 2 次事务尝试和 2 次成功提交；这些只是机制
轨迹，不是额外比较得分。

## 调用与完整性

- requested / physical model：`gpt-5.6-sol`；reasoning：`max`；fallback：`false`；
- Provider：`custom` OpenAI Responses；Morphz 权限：`full_access`；
- `append_only`：3 次调用，Provider 未返回 usage；
- `structured_no_direct_reentry`：3 次调用，54,772 Provider-reported total tokens；
- `full_morphz`：5 次调用，97,227 Provider-reported total tokens；
- runner source commit：`0e4e643d103eeaa95567987331abaa487de6b90d`；
- runner 二进制 SHA-256：`4896eb631f2faf2e0619fe7e84e0ac603f49f14de899d3038797eb339f8684a4`；
- Morphz 二进制 SHA-256：`0e24c92ee797d72d6b79725284dd181de76de4f6f6bd9bec771ed151d6535db4`；
- 本次没有 Provider、Runtime 或评分故障；归档校验和逐项通过。

当前 `morphz --version` 只报告 `git unknown`，因此本 cell 以源码基线文档、runner commit 和
两个二进制 SHA-256 固定身份。这也是 ME-00 尚未完全自动闭环的剩余问题之一。

原始有效目录：

```text
/private/tmp/morphz-me01-real-cells-20260825/
  ME-01-real-smoke-20260825T075147.210Z-64422/
```

## 无效的首次运行

Suite `ME-01-real-smoke-20260825T073155.372Z-63212` 的答案虽然正确，但 runner 将全部阶段
硬编码为 `session-a / primary`，没有真正建立 Session B。旧评分器只检查挂载证据非空，
因而产生了实现有效的假阳性。该运行完整保存在 `invalid_hardcoded_session_routing/`，不计入
累计结果。修复后的评分器要求 Context 和 Session 挂载集合与 fixture 完全一致，并新增回归
测试；真实重跑和无模型独立进程 Gate 均通过。

