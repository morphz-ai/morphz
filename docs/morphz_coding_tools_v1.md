# Morphz Coding Tools v1

> 状态：最小可用开发工具闭环

Coding Tools v1 的目标不是把 Shell 包装成万能工具，而是让 Agent 能通过标准 Function Calling 安全、精确、可审计地发现、读取和修改工作区代码。Context 的语义所有权仍属于 Agent；Runtime 只强制路径、版本、原子性和事件审计。

## 1. 最小工具集

| 工具 | 责任 |
| --- | --- |
| `list_files` | 在 Permission Profile 允许的根中按 glob 递归发现文件 |
| `search` | 在已授权 UTF-8 文件中执行带行号的字面文本搜索 |
| `read` | 读取全文、查询结果或行范围，并返回 SHA-256 文件版本 |
| `edit` | 基于 expected SHA-256 执行一个或多个精确局部替换 |
| `write` | 原子创建新文件，或在版本前提下显式覆盖文件 |
| `exec` | 在经过校验的工作目录中运行测试、编译与格式化命令 |

建议工作流：

```text
list_files/search → read → edit/write → file_change → exec(test) → context_tx → reply
```

## 2. Read 与版本前提

`read` 的每次成功结果都包含：

```text
[path=src/lib.rs, bytes=1234, sha256=<64 hex chars>]
```

Agent 后续修改既有文件时必须把该 SHA-256 传给 `edit.expected_sha256` 或 `write.expected_sha256`。如果文件在读取后发生变化，Runtime 拒绝写入，要求 Agent 重新读取，而不是覆盖并发修改。

长文件应优先使用：

- `query/context_lines/max_matches` 查找窄证据；
- `start_line/end_line` 精确分页。

## 3. Edit

`edit` 是修改既有源码的默认工具：

```json
{
  "path": "src/lib.rs",
  "expected_sha256": "...",
  "edits": [
    {
      "old_text": "fn answer() -> i32 { 41 }",
      "new_text": "fn answer() -> i32 { 42 }"
    }
  ]
}
```

Runtime 保证：

1. `old_text` 默认必须在原始快照中唯一匹配；
2. 零匹配、多匹配或编辑范围重叠时整次调用失败；
3. `replace_all=true` 必须由 Agent 显式声明；
4. 所有 replacement 在内存中完成校验后一次提交；
5. 使用同目录临时文件、`sync_all` 和 rename 原子替换；
6. 既有文件权限被保留；
7. 成功结果返回新 hash 与统一 Diff。

## 4. Write

`write` 不再允许无条件覆盖：

- `mode=create`：目标必须不存在；
- `mode=overwrite`：目标必须存在，并提供匹配的 `expected_sha256`。

修改既有代码应优先使用 `edit`。`overwrite` 适合由 Agent 有意完整重建的小型文件，不能用来绕过局部编辑的并发保护。

## 5. File Change Event

每次成功 `edit/write` 都发布不可变 `chat/file_change` 事件，至少包含：

- session、path、operation；
- before/after SHA-256；
- before/after bytes；
- Diff 与文本摘要。

`file_change` 进入下一 Attempt 的 Inbox，是“文件已经提交变化”的物理证据。它不自动修改 Mind；Agent 可以基于它派生进度、记录决策或在验证后退役。

## 6. 发现与搜索

`list_files/search`：

- 与 `read/edit/write/exec` 复用同一个 Permission Broker；
- 绝对路径和 `..` 不再作为独立禁令，按 canonical 路径的最终授权边界判断；
- 默认不跟随符号链接、不进入隐藏目录；
- 默认保护 `.git`、`.env` 和 `.ssh`；不再默认排除 `target`、模型权重等任务特化路径；
- 使用结果上限，避免把整个仓库注入 Context；
- `search` 只读取不超过 2 MiB 的 UTF-8 文件，并返回结构化路径、行号和上下文。

## 7. Exec 边界

`exec.cwd` 必须是已存在目录，并经过统一权限策略校验。工作区外 cwd 会成为能力差量，必须使用 `require_escalated` 接受审批。`exec` 适合运行测试、编译和格式化；代码发现与修改应优先使用结构化工具。

Shell 子进程树由 `SandboxBackend` 施加操作系统原生边界；旧的命令字符串黑名单已经删除，不再把可绕过的文本匹配冒充安全边界。敏感环境变量继承是独立策略，默认从 Shell 环境中移除 Token、Secret、Password、Credential 和常见云凭证变量。

在 macOS 的 `workspace-write` 模式下，Runtime 强制启用 Seatbelt：默认禁网、按 Profile 限制写入，并阻止读取未授权的用户 HOME 与临时目录。Coding Eval 使用同一条生产执行链路；具体生命周期与探针见 [Coding Eval Sandbox](morphz_coding_eval_sandbox.md)。

## 8. v1 暂不覆盖

- 通用 unified-diff patch 解析与多文件单事务；
- 文件删除、移动和重命名的结构化工具；
- 二进制和非 UTF-8 文件编辑；
- Linux/Windows 原生沙箱 Backend；
- 可复用审批规则和前缀规则；
- 跨多个文件的整体回滚。

这些能力应由长程 Coding Agent 基准中的实际失败驱动，而不是提前扩张工具接口。
