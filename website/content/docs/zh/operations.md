---
title: 运维与故障排查
description: 沿模型、认知、调度、执行和存储边界定位问题，并安全更新或恢复运行时。
section: operations
order: 300
status: current
---

排障应沿一次请求真实经过的边界进行。不断新建会话、重新登录或重复执行工具，可能掩盖原始因果路径并制造更多状态。

## 先确认版本、配置与整体状态

```bash
morphz version
morphz config check
morphz config explain --format=json
morphz doctor
```

`config check` 校验所有配置层；`config explain` 显示每个最终值来自用户配置、项目偏好、环境变量还是命令行；`doctor` 检查存储、工作区、权限和模型服务配置。诊断成功不等于真实模型请求或远端工具一定成功，后续仍要检查对应边界。

## 模型已经登录但不响应

登录成功只说明认证材料存在。依次确认：

1. 当前选择的是哪个模型路由；
2. 路由解析到哪个模型服务实例、物理模型和账号；
3. 账号是否启用、过期或处于冷却；
4. 服务目录是否包含该物理模型，或运维者是否明确配置了它；
5. 实测返回的是认证、模型名、协议、容量还是网络错误。

```bash
morphz provider account test <account-id> --route=<model-route>
morphz model route test <model-route> --account=<account-id>
```

连接建立、首字节等待和流读取都有独立超时。模型服务临时失败时，线程可以进入退避并等待资源恢复；日志中的模型尝试次数不是整条线程从头执行的次数。

## 认知投影与召回异常

```bash
morphz context status <context-id>
morphz context audit <context-id>
morphz context recall-index inspect <context-id> --format=json
```

`context audit` 用权威事件回放验证当前认知投影。若事件和认知正确、只有搜索结果缺失，可以重建派生召回索引：

```bash
morphz context recall-index rebuild <context-id> --format=json
```

不要通过手工编辑数据库修补认知帧，也不要把重建搜索索引误当作恢复权威状态。

## 线程、目标或交付没有继续

```bash
morphz scheduler show --context=<context-id> --include-terminal --limit=100
morphz scheduler thread show <thread-id> --context=<context-id>
morphz objective show <objective-id> --format=json
```

检查具体依赖与所有者：

- 等待模型服务恢复；
- 等待工具任务、线程组或委派结果；
- 等待审批、用户输入、定时器、外部事件或资源；
- 线程被显式暂停；
- 目标受阻，需要修改目标或提供新条件；
- 结果已经形成，但交付仍处于待处理或延迟状态；
- 所有者已经终态，触发了生命周期不变量错误。

最后一种情况不应靠反复“继续”处理。保留线程、激活、根请求和触发事件标识，用于定位因果断点。

## 物理工具与执行节点

```bash
morphz target show <target-id> --format=json
morphz execution show <job-id> --format=json
morphz execution output <job-id> --after=0 --limit=100
morphz lease list --target-id=<target-id> --format=json
```

先区分节点离线、节点被禁用、范围授权不匹配、沙箱拒绝、审批待定、能力租约失效和工具自身失败。普通命令错误不自动等于权限失败。

边缘设备还应检查：

```bash
morphz-edge status
morphz-edge local-leases --json
```

边缘节点通过主动出站连接工作。网关无法主动访问设备并不等于节点实现有误，但设备凭证被撤销、身份密钥不匹配或心跳超时都会让节点离线。

## 存储与多实例

SQLite 是默认物理存储；存在 PostgreSQL 连接环境变量不会让运行时自动切换。切换物理后端前，应先确认所有实例使用同一配置和迁移版本。

上下文数据库是默认认知权威。显式迁移命令会把认知状态同步到选定权威，并返回可审计结果：

```bash
morphz storage migrate-cognitive-store --to context_db --format=json
```

运行时启动绝不会隐式迁移认知状态。不要让两个实例在不同认知权威下同时写入同一逻辑部署。

## 控制台与网络

`morphz serve` 默认监听 `127.0.0.1:8080`。绑定非环回地址时必须设置 `MORPHZ_DASHBOARD_TOKEN`，并由部署环境提供 TLS、访问控制、防火墙和正确的长连接转发。

模型、授权或认知协调请求经过代理时，先使用 `config explain` 确认最终代理策略和 `NO_PROXY`。不要因为一条协调链路不可达而同时改动模型服务路由。

## 更新与回滚

```bash
morphz update status
morphz update
morphz version
```

更新器从配置的 GitHub Release 仓库读取版本和平台资产，校验发布元数据与 SHA-256 后原子替换主程序，并保存上一个二进制。若需要撤回已经安装的新版本：

```bash
morphz update rollback
```

回滚只恢复主程序二进制，不回滚数据库中的业务状态或外部副作用。如果新二进制已经完全无法执行，应直接运行安装器保留的上一个二进制或重新执行安装脚本，而不能依赖它自行回滚。独立的 `morphz-edge` 不随主程序更新。

## 时间与问题报告

提交问题时保留版本、完整错误、相关稳定标识和带时区的 RFC 3339 时间。物理事件序列表示持久化先后，不等于业务因果；不要只凭“哪个日志更晚”判断谁触发了谁。
