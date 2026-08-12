---
title: 运维与故障排查
description: 从模型路径、调度状态、日志和存储边界定位问题。
section: operations
order: 300
status: current
---

排障应沿着实际请求路径进行，不要通过不断新建 Session 或重新登录来碰运气。

## 从 Doctor 开始

```bash
morphz doctor
```

Doctor 检查存储、工作区、权限和 Provider 配置。它用于发现结构性问题，但不能替代真实模型请求。

## 模型已经登录但不响应

依次确认：

1. 当前选择的是哪个模型路由；
2. 路由解析到哪个 Provider Instance、物理模型和账号；
3. 账号是否启用、过期或处于冷却；
4. 模型目录是否确实包含该物理模型，或 Operator 是否明确配置了它；
5. 实测请求返回的是认证、模型名、协议还是网络错误。

```bash
morphz provider account test <account-id> --route=<model-alias>
morphz model route test <model-alias> --account=<account-id>
```

## 临时网络失败

Provider 的连接建立和流读取具有重试与超时边界。日志中的 `attempt` 表示当前本地尝试次数；退避时间之外，单次连接或首字节等待也会占用时间。持续失败后，Runtime 可以把工作转入等待资源恢复，但页面必须显示恢复条件。

## Thread 一直等待或暂停

检查等待原因，而不只看状态标签：

- 等待模型服务恢复；
- 等待工具或后台任务结果；
- 等待审批或用户输入；
- 用户显式暂停；
- 所有者已经终态，导致生命周期不变量失败。

最后一种属于 Runtime 或历史数据问题，不应通过反复点击“继续”解决。

## Dashboard 无法访问

`morphz serve` 默认监听 `127.0.0.1:8080`。绑定非环回地址时必须设置 `MORPHZ_DASHBOARD_TOKEN`。远程访问还需要确认防火墙、反向代理和 WebSocket 转发。

## 时间

持久化时间戳和 API 传输可以使用绝对时间表示；面向用户的日志与界面应显示当地时区或明确 offset。排障时复制完整 RFC 3339 时间，避免只提供没有时区的时分秒。
