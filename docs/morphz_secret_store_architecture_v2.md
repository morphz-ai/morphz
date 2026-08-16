# Morphz 托管凭证与 Secret Store 架构 v2

> 状态：核心实现完成；Catalog/Scope、系统凭证库与 Morphz `.env` 值后端、CLI/Dashboard 管理工作流已落地，Headless 平台体验与企业后端仍待持续验证
>
> 日期：2026-08-01

## 1. 定位

托管凭证是 Runtime 的核心安全能力。它把以下两件事严格分开：

1. 模型知道“需要哪一种凭证”；
2. 可信执行边界在获批后取得真实凭证值。

模型只允许看到：

- 环境变量形式的别名，例如 `DEPLOY_TOKEN`；
- 不可解析的引用，例如 `secret://runtime/DEPLOY_TOKEN`；
- 作用域、值后端和更新时间等非敏感元数据。

模型、Prompt、Mind、Session、Event History、审批请求、HTTP 响应和普通日志都不能看到凭证值。Dashboard 只提供写入、轮换、导入别名和撤销，不提供“显示值”。

## 2. 数据分层

```text
Managed Secret Catalog
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
  list_aliases()
```

Catalog 是 Runtime 的授权与发现投影，不包含真实值。别名只有显式进入 Catalog 后才可被模型发现。

同名环境变量仍可作为启动和现有部署的解析入口，但它是不可发现的：模型不能因为进程环境中存在变量就自动看到其名称。

## 3. 值后端

每项凭证都显式记录 `value_backend`。后端不可用时返回明确错误，绝不静默切换保存位置。

### 3.1 系统凭证库

默认后端通过 Rust `keyring` 接入：

| 平台 | 后端 |
|---|---|
| macOS | Keychain Services |
| Windows | Credential Manager |
| Linux / 桌面 Unix | Secret Service（D-Bus） |

系统凭证库适合有正常用户登录会话的桌面环境。通过 SSH、launch daemon、CI 或其他无交互方式启动时，macOS Keychain 可能返回 `User interaction is not allowed`；Linux 也可能没有可用的 Secret Service/D-Bus 会话。这是后端不可用，不应触发明文回退。

### 3.2 Morphz 主机 `.env`

无图形、无系统凭证服务的部署可以显式选择 `morphz_env_file`：

- 路径为 `$MORPHZ_ENV_FILE`，未指定时为 `$MORPHZ_HOME/.env`；
- Unix 上目录权限收紧为 `0700`，文件权限为 `0600`；
- 保存的是明文，因此 Dashboard 必须明确提示风险；
- 只接受单行值；
- 写入使用临时文件与原子替换；
- 它不是系统凭证库失败后的自动后备。

已有 `.env` 变量不会自动进入托管目录。Operator 必须显式执行“导入别名”；导入只把名称与授权作用域写入 Catalog，值仍留在 `.env`。

### 3.3 后续后端

公网站点或企业部署可以实现相同的 `SecretValueBackend`：

- HashiCorp Vault；
- AWS、Google、Azure Secret Manager；
- KMS/HSM；
- Edge Node 本地凭证服务。

SDK、HTTP API、Dashboard 和工具不因后端变化而改变。

## 4. 作用域

| 作用域 | 使用条件 |
|---|---|
| `runtime` | 当前 Runtime 均可申请 |
| `context` | 当前权威 `context_id` 必须匹配 |
| `session` | 当前权威 `session_id` 必须匹配 |
| `objective` | 当前 Activation 绑定的 `objective_id` 必须匹配 |
| `execution_target` | 当前 Execution Job 的 `target_id` 必须匹配 |

作用域由 Runtime 权威状态决定，不接受模型自报 ID。

Dashboard 不要求用户手抄内部 ID。它从 Runtime 查询 Context、Session、Objective 和 Execution Target 实体，用户选择实体后由前端提交准确 ID；原始 ID只作为可复制的诊断信息呈现。

## 5. 发现、审批和注入

```text
Operator 写入或导入别名
  → Catalog 建立别名与作用域
  → list_secrets 只返回当前作用域获准的别名元数据
  → exec(requested_permissions.secret_env = ["DEPLOY_TOKEN"])
  → Permission Broker / Reviewer 审批
  → Runtime 重新校验权威作用域
  → Secret Store 从条目指定的后端解析值
  → 只注入本次获批的子进程
```

Secret Store 不创造第二套权限模型。`full_access`、自动审批、人工审批和自定义策略仍由统一 Permission Profile 决定；Secret Store 只负责值的保管、发现边界和作用域校验。

## 6. Operator Dashboard

托管凭证是独立的 Operator 控制面，不附属于某个 Runtime 诊断卡片。页面提供：

- 后端可用性、保存类型和是否支持导入；
- 显式选择值后端；
- 写入或轮换凭证；
- 从 `.env` 发现并显式导入尚未登记的别名；
- Runtime、Context、Session、Objective、Execution Target 实体作用域选择；
- 只含元数据的托管凭证目录；
- 撤销入口；
- 最近使用审计。

值输入是一次性、只写的。刷新、HTTP GET、浏览器状态和使用审计均不返回值。

## 7. 使用审计

成功解析受管凭证时记录：

- 别名与 `secret_ref`；
- 值后端；
- 实际 Context、Session、Objective、Target；
- 使用时间。

不记录凭证值或命令环境快照。主机 JSONL 审计采用有界保留，避免长期运行后无限增长；它是 Operator 诊断数据，不替代 Event History。

## 8. 输出隔离

Runtime 记录本次实际注入的值，并在 stdout/stderr 进入模型、Event History、后台输出归档或 Artifact 前按精确值替换。

不使用 `sk-`、`Bearer` 等字符串形状猜测秘密，因为这会破坏正常数据。这个边界也不能保证已获准使用秘密的恶意程序不会主动编码或传输它，因此网络、命令和凭证能力仍需统一审批。

## 9. Execution Target 与 Edge Node

凭证属于实际执行节点的信任域：

- 本地 Target 使用本地 Runtime 的 Secret Store；
- Edge Node 使用节点自己的 Secret Store；
- 云端 Runtime 不读取本地 Edge 凭证再通过网络转发；
- Managed SSH 凭证位于真正建立 SSH 连接的 Provider Node。

Edge 协议只传输别名和权限请求，不传输真实值。`execution_target` 作用域同时表达逻辑授权和部署位置约束。

## 10. 明确不做

- 从聊天文本自动识别和保存 Token；
- 向模型提供读取值工具；
- 自动暴露进程环境或 `.env` 中的所有变量名；
- 系统凭证库失败后静默写入 `.env`；
- 在 HTTP、Dashboard、Event History 或审计中提供值读取；
- 将 Runtime 本地凭证透明复制到远端 Target；
- 宣称注入秘密后仍能阻止获批进程的一切外泄行为。

这些边界使托管凭证成为可推理、可配置、可审计的 Runtime 能力。
