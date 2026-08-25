# ME-01 p1.1 Context Isolation 三组结果

> 日期：2026-08-25  
> 证据等级：`P`（ME-01 Stage A Pilot）  
> 协议：`me01-context-reentry-p1.1-candidate`  
> Fixture：`me01-p1-context-isolation-01`  
> Suite：`ME-01-real-smoke-20260825T075545.033Z-64678`

## 结论

两个 Context 含有同名对象 `report-daily`，但分别绑定 `red-vault` 和 `blue-archive`。三个
实验组最终均正确选择当前 primary Context 的状态：

```json
{
  "action": "set_delivery_target",
  "object_id": "report-daily",
  "value": "blue-archive",
  "evidence_id": "ev-ci-002"
}
```

没有任何一组复用 foreign Context 的 `red-vault`。生产 Morphz 两组证明了两个不同 Session
分别挂载两个不同 Context；完整 Morphz 的两次事务分别在 foreign 和 primary Context 内形成
`tenant_red_report_daily_delivery` 与 `tenant-blue-report-daily-delivery`。行动前 primary
Context 投影只含 blue Frame，不含 red Frame。

## 结果

| Arm | 严格成功 | Context 路由 | foreign 值污染 | 重启 |
| --- | ---: | --- | ---: | --- |
| `append_only` | 1/1 | 完整消息记录中的 Context 标签 | 0 | 不适用 |
| `structured_no_direct_reentry` | 1/1 | 两个真实 Session → 两个不同 Context | 0 | 已证明 |
| `full_morphz` | 1/1 | 两个真实 Session → 两个不同 Context | 0 | 已证明 |

`context_tx` 对前两组不适用。完整 Morphz 产生 2 次事务尝试和 2 次成功提交，仅作为实现
轨迹。该 cell 支持 Context 隔离和简单任务不退化，不支持 Morphz 在最终行动正确率上优于
带完整 Context 标签的消息基线。

## 调用与完整性

- requested / physical model：`gpt-5.6-sol`；reasoning：`max`；fallback：`false`；
- Provider：`custom` OpenAI Responses；Morphz 权限：`full_access`；
- `append_only`：3 次调用，Provider 未返回 usage；
- `structured_no_direct_reentry`：3 次调用，51,341 Provider-reported total tokens；
- `full_morphz`：5 次调用，91,812 Provider-reported total tokens；
- runner source commit：`0e4e643d103eeaa95567987331abaa487de6b90d`；
- runner 二进制 SHA-256：`4896eb631f2faf2e0619fe7e84e0ac603f49f14de899d3038797eb339f8684a4`；
- Morphz 二进制 SHA-256：`0e24c92ee797d72d6b79725284dd181de76de4f6f6bd9bec771ed151d6535db4`；
- 无 Provider、Runtime 或评分故障；所有归档校验和逐项通过。

原始目录：

```text
/private/tmp/morphz-me01-real-cells-20260825/
  ME-01-real-smoke-20260825T075545.033Z-64678/
```

## ME-01 Stage A 累计结论

五个预注册任务族、三个实验组共 15 个有效 episode 全部严格通过：延迟引用、显式修订、
来源权威、跨 Session 连续性和 Context 隔离。结果支持三种运行路径在无 Context 压力下均
有效，且 Structured Context、进程恢复、跨 Session 共享和 Context 隔离没有造成观察到的
最终行动退化；完整 Morphz 的真实 Frame/事务链成立。

所有组 100% 同时构成明确天花板效应。p1.1 Stage A 到此完成，不继续对同类简单题机械扩样，
也不把该 Pilot 提升为优越性或正式统计非劣效结论。强 compaction 对照和长程区分性任务进入
ME-06；ME-01 后续先修订主张和确认性必要性，再决定是否需要 p2。

