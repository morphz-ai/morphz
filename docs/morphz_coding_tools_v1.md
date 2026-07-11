# Morphz Coding Tools v1

> 状态：最小可用开发工具闭环

Coding Tools v1 的目标不是把 Shell 包装成万能工具，而是让 Agent 能通过标准 Function Calling 安全、精确、可审计地发现、读取和修改工作区代码。Context 的语义所有权仍属于 Agent；Runtime 只强制路径、版本、原子性和事件审计。

## 1. 最小工具集

| 工具 | 责任 |
| --- | --- |
| `list_files` | 在 workspace jail 内按 glob 递归发现文件 |
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

- 复用 workspace jail、extra roots 和 deny patterns；
- 默认不跟随符号链接、不进入隐藏目录；
- 默认排除 `.git`、`.env`、`target`、`models` 等敏感路径；
- 使用结果上限，避免把整个仓库注入 Context；
- `search` 只读取不超过 2 MiB 的 UTF-8 文件，并返回结构化路径、行号和上下文。

## 7. Exec 边界

`exec.cwd` 必须是 workspace_root 内已存在目录，并经过相同路径策略校验。`exec` 适合运行测试、编译和格式化；代码发现与修改应优先使用结构化工具。

cwd 限制不是完整 Shell 沙箱。Shell 仍继承 Morphz 进程的操作系统权限，当前只额外执行危险模式拦截与敏感环境变量剥离。生产部署和不可信任务必须使用外层容器、namespace 或等价系统隔离。

在 macOS Coding Eval 模式下，Runtime 额外强制启用 Seatbelt：禁网、workspace-only 写入，并阻止读取用户 HOME 与其他 `/private/tmp` run。具体生命周期与探针见 [Coding Eval Sandbox](morphz_coding_eval_sandbox.md)。

## 8. v1 暂不覆盖

- 通用 unified-diff patch 解析与多文件单事务；
- 文件删除、移动和重命名的结构化工具；
- 二进制和非 UTF-8 文件编辑；
- 真实文件系统/网络 namespace 沙箱；
- 用户审批策略和命令 allowlist；
- 跨多个文件的整体回滚。

这些能力应由长程 Coding Agent 基准中的实际失败驱动，而不是提前扩张工具接口。
