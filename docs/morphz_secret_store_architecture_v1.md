# Morphz Secret Store 架构 v1

## 1. 目标

Secret Store 是 Runtime 的核心安全能力，用来把“模型知道需要哪一种凭证”和“可信执行边界取得真实凭证值”严格分开。

模型只允许看到：

- 环境变量形式的别名，例如 `DEPLOY_TOKEN`；
- 不可解析的引用，例如 `secret://runtime/DEPLOY_TOKEN`；
- 作用域、值后端和更新时间等非敏感元数据。

模型、Prompt、Mind、Session、Event Ledger、审批请求和普通日志都不应看到凭证值。

## 2. 跨平台后端

默认实现通过 Rust `keyring` 的统一接口接入操作系统凭证库：

| 平台 | 默认值后端 |
|---|---|
| macOS | Keychain Services |
| Windows | Credential Manager |
| Linux / 其他桌面 Unix | Secret Service（D-Bus） |

参考：

- [keyring crate](https://docs.rs/keyring/latest/keyring/)
- [keyring v1 跨平台映射](https://docs.rs/keyring/latest/src/keyring/v1.rs.html)

Morphz 只维护一份 `SecretValueBackend` 契约。平台差异位于后端内部，不进入工具、审批、SDK 或 HTTP API。

这里的“跨平台覆盖”只指 Secret Store 与系统凭证库的适配。Morphz Runtime
中 Shell 进程组、原生沙箱等其他执行能力仍需各自完成 Windows 平台验证，
不能因为凭证 backend 能在 Windows 编译就宣称整个 Runtime 已完成 Windows
端到端支持。

### 2.1 Headless Linux

没有 Secret Service、D-Bus 会话或已解锁凭证库的 Linux 节点不能使用默认后端。此时 Runtime 必须：

1. 返回明确错误；
2. 要求部署者配置可用的 Secret Service，或通过 Runtime Builder 注入 Vault/KMS/云 Secret Manager 后端；
3. 绝不静默降级为明文文件。

这不是“Linux 不受支持”，而是服务器部署必须显式选择它的凭证权威。

## 3. 数据分层

```text
Managed Secret metadata
  name
  secret_ref
  scope_kind / scope_id
  value_backend
  created_at / updated_at
        │
        │ locator
        ▼
SecretValueBackend
  put(locator, value)
  get(locator)
  delete(locator)
```

元数据保存在用户级 catalog 中；Unix 上创建为 `0600`，Windows 上位于用户
`APPDATA` 配置目录并继承该目录的访问控制。catalog 不包含真实值，默认值保存在
系统凭证库中。

HTTP API 与 Dashboard 只有：

- 列出元数据；
- 创建或替换值；
- 删除；

不存在读取值的 API。

通过非 loopback 地址管理凭证时，HTTP API 必须部署在 HTTPS 或等价的可信
隧道之后。系统凭证库保护的是静态值，不能替代传输层加密。

## 4. 作用域

v1 支持五种作用域：

| 作用域 | 使用条件 |
|---|---|
| `runtime` | 当前 Runtime 均可申请 |
| `context` | 当前权威 `context_id` 必须匹配 |
| `session` | 当前权威 `session_id` 必须匹配 |
| `objective` | 当前 Activation 绑定的 `objective_id` 必须匹配 |
| `execution_target` | 当前 Execution Job 的 `target_id` 必须匹配 |

作用域由 Runtime 的任务本地权威状态决定，不接受模型在参数中自报 Context、Session、Objective 或 Target。

## 5. 发现、审批与注入

执行流程：

```text
list_secrets
  → 模型只发现当前作用域可用的别名
  → exec(requested_permissions.secret_env = ["DEPLOY_TOKEN"])
  → 现有 Permission Broker / Reviewer 审批
  → Runtime 再次检查权威作用域
  → Secret Store 解析值
  → 只注入本次获批的单个子进程
  → 子进程结束后值随进程环境消失
```

Secret Store 不创造第二套权限模型。`full_access`、自动审批、人工审批和自定义策略仍由统一的 Permission Profile 决定；Secret Store 只负责值的保管与作用域校验。

为了兼容 Runtime 启动与部署引导，尚未登记为受管凭证的别名仍可解析当前 Runtime 的同名环境变量。这个兼容入口不改变模型只能按别名申请的契约。

## 6. 输出隔离

Runtime 记录本次实际注入的值，并在 stdout/stderr 进入模型、Ledger、后台输出归档或 Artifact 之前按精确值替换。

不使用 `sk-`、`Bearer` 等字符串形状启发式修改普通数据，因为这会破坏真实证据；只隔离 Runtime 已知实际注入的值。

这个边界不能保证一个已获准使用秘密的恶意程序不会主动编码或传输它。因此：

- 审批仍需判断命令和网络能力；
- `secret_env` 只对单个准确命令授权；
- Secret Store 不能被描述为防止所有外泄的万能机制。

## 7. Execution Target 与 Edge Node

凭证值属于实际执行节点的信任域：

- 本地 Target 使用本地 Runtime 的 Secret Store；
- Edge Node 使用 Edge Node 自己的 Secret Store；
- 云端 Runtime 不应读取本地 Edge 凭证再通过网络转发；
- Managed SSH 的凭证应位于建立 SSH 连接的 Provider Node。

因此 `execution_target` 作用域既是逻辑授权，也是部署位置约束。Edge 协议传输别名和权限请求，不传输真实值。

## 8. 可插拔性

公网站点或企业部署可以实现 `SecretValueBackend`，并通过 `MorphzRuntimeBuilder::secret_store(...)` 注入：

- HashiCorp Vault；
- AWS Secrets Manager；
- Google Secret Manager；
- Azure Key Vault；
- 自建 KMS/HSM；
- Edge Node 本地凭证服务。

工具、SDK、HTTP API 和 Dashboard 保持相同契约。

## 9. 明确不做

v1 不做：

- 从聊天文本中自动识别并保存 Token；
- 向模型提供读取值工具；
- 把凭证值写入 `.env`、配置文件或数据库；
- 在 Linux 凭证服务不可用时自动使用明文后备；
- 把 Runtime 本地凭证透明复制到远端 Target；
- 声称注入秘密后仍能阻止获批进程的一切外泄行为。

这些边界保证 Secret Store 是一项可推理、可审计的 Runtime 能力，而不是一套隐含魔法。
