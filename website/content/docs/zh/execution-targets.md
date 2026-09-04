---
title: 工作区与执行节点
description: 选择物理工作发生的位置，并用节点授权、沙箱、审批和能力租约限制副作用。
section: guides
order: 230
status: current
---

模型可以提出行动，但只有运行时能把行动变成物理副作用。执行节点标识“在哪里执行”，节点授权标识“哪些工作可以使用它”，沙箱和能力租约标识“具体允许做什么”。

## 执行节点模型

执行节点以稳定身份表示物理工作目的地。临时工作进程和网络连接都附属于这个身份。当前运行时可以表示：

- 当前进程所在机器；
- 通过主动出站连接接入的边缘设备；
- 由宿主 OpenSSH 管理的 SSH 目的地；
- 由部署方接入的托管云端执行器。

节点记录所有者、提供节点、平台、工作区根目录、能力集合、策略摘要和在线状态。凭证原文禁止写入节点元数据。

```bash
morphz target list --format=json
morphz target show <target-id> --format=json
```

## 本地工作区

本地部署默认启用当前机器作为执行节点，工作区是启动 Morphz 时的当前目录。`--cwd` 可以在加载项目配置前切换目录。

运行时会保护自身配置、数据库、可执行文件、`.git`、`.ssh` 等关键路径，避免智能体通过文件工具或命令行绕过控制面。云端面向终端用户的部署应关闭本地节点，防止用户任务落到服务主机；详见[配置文件](/docs/configuration)。

## 沙箱与审批

沙箱决定物理访问范围；审批策略决定某项行动是否需要一次性或可复用授权。两者不能互相替代：目录可访问不代表命令自动获批，审批通过也不会扩大沙箱根目录。

会话选择的执行节点只影响随后创建的新工作，已经运行的线程不会迁移到另一台机器。尚未选择节点时，对话仍可继续；第一次需要物理工具时，运行时会返回明确的节点缺失状态。

## 执行节点范围授权

节点所有权决定谁能看到和管理节点。所有者还可以把节点进一步限制到某个智能体、认知上下文或线程：

```bash
morphz target authorize <target-id> \
  --scope=context --scope-id=<context-id>

morphz target authorizations <target-id> --format=json
```

一个节点没有任何范围授权历史时，所有者可以直接使用它。一旦创建了第一条范围授权，只有匹配的有效范围才能使用该节点；撤销最后一条授权不会恢复成“所有者内全部开放”。撤销操作要求精确修订号和可审计原因。

## 托管 SSH

Morphz 使用宿主已有 OpenSSH 配置解析远程目的地。智能体只提交主机别名与能力需求；运行时使用宿主 SSH 客户端和严格主机密钥校验，不把凭证值交给模型。

通过节点使用 Morphz 核心文件工具时，远端主机需要提供 Python 3；普通远程命令仍然只依赖 OpenSSH 与远端命令行环境。

```json
{
  "kind": "managed_ssh",
  "host": "production",
  "capabilities": ["exec"]
}
```

直接使用 IP 或域名时可以显式提供用户和端口。没有绑定密钥机密项时，已有 `IdentityFile`、`ProxyJump` 和 SSH 代理设置继续由宿主 OpenSSH 处理。

也可以把私钥内容保存到机密项存储，并只把别名绑定到节点：

```json
{
  "kind": "managed_ssh",
  "host": "login.example.com",
  "user": "researcher",
  "auth_mode": "key_only",
  "private_key_secret": "RESEARCH_SSH_KEY",
  "private_key_passphrase_secret": "RESEARCH_SSH_KEY_PASSPHRASE"
}
```

运行时按当前认知上下文、会话、目标和节点解析绑定，把私钥写入运行时私有目录中的 `0600` 临时身份文件，强制 OpenSSH 只使用该身份，并在连接交接后删除。凭证值不会进入节点元数据、工具参数、事件历史或普通命令环境。

## 边缘执行节点

边缘节点从设备主动连接 Morphz 网关，适用于网关无法直接访问的个人电脑或内网机器。主程序负责在网关侧创建配对码、查看和撤销节点：

```bash
morphz edge pairing-code --ttl=300
morphz edge nodes --format=json
```

远端设备单独安装并运行 `morphz-edge`。它是仅执行程序，不能调用模型，也不随主程序安装或更新：

```bash
morphz-edge bootstrap \
  --server-url=https://agent.example.com \
  --pairing-code=pair_xxx \
  --workspace=/path/to/workspace
```

配对码是短期一次性凭证。引导完成后，设备使用自己的长期身份密钥建立主动出站连接，并可安装为用户级后台服务。设备身份可以轮换或由网关撤销。

## 能力租约

一次审批可以产生可复用的能力租约，范围只能是精确线程、目标或会话。后续行动必须同时匹配：

- 运行主体与智能体；
- 因果范围及其稳定标识；
- 执行节点；
- 物理能力和请求参数子集；
- 当前宿主与节点策略摘要；
- 有效期和未撤销状态。

相似命令、同一目录或同一设备都不足以扩大租约。策略变化会使旧租约无法覆盖新请求。

```bash
morphz lease list --target-id=<target-id> --format=json
morphz lease revoke <lease-id> --revision=<revision> --reason='Access no longer needed'

morphz-edge local-leases --json
morphz-edge revoke-local-lease <lease-id>
```

网关侧租约和设备本地租约都可以撤销；设备不会因为网关曾经批准过一次，就永久开放同类命令。

## 检查物理任务

```bash
morphz execution list --target-id=<target-id> --include-terminal
morphz execution show <job-id> --format=json
morphz execution output <job-id> --after=0 --limit=100
```

物理任务、输出分片和取消状态都是持久记录。取消需要精确任务修订号，避免旧界面误取消已经变化的任务。
