# Morphz 全仓审计 — 2026-08-16

> 修订 2：补齐第一轮未覆盖的模块（sexpr 求值器、provider/auth、approval_authority、
> permission、activation_admission、timer、execution_target、edge/artifact 数据面、
> recovery/reconciler、SQLite↔Postgres 对等性）；撤回第一轮中基于陈旧数据库得出的
> 结论。
>
> 方法：源码审阅 + 对生产代码路径的可执行验证。标注「已实测」的结论都由本次运行的
> 探针在真实调用路径上复现；未实测的推断显式标明。
>
> 基线：`cargo check --workspace --all-targets` 通过无警告。

---

## 0. 第一轮结论的更正

| 原结论 | 状态 | 说明 |
| --- | --- | --- |
| `chat/context_inspect` 占 463 MB，Agent Trajectory 缺容量治理 | **撤回** | 我读的是仓库根目录的 `morphz.db`，最后一条事件是 2026-07-23。该 topic 已于 2026-08-15 停写，问题已解决。基于该库的容量结论全部不成立。 |
| 「单行 payload 无上限」 | **缩小到 `read` 工具** | 后台 exec 输出有 8,192 字符上限并落 archive（`config.rs:1246`、`tool.rs:3941`）；`list_files`/`search` 有结果数上限。**但 `read` 不传 `start_line`/`end_line`/`query` 时返回整文件**（`tool.rs:4841` `selected.extend(start..=end)`），无字节上限。System Prompt 里有「不要整读长文件」的告诫（`orchestrator.rs:518`），那是提示词层约束，不是执行层约束。 |

---

## 1. 严重：SExpr Parser 无递归深度限制 → 整进程 SIGABRT（已实测）

**位置** `morphz/src/sexpr.rs:239`（`Parser::parse_value`）

`parse_value` 遇到 `(` 就递归调用自身，**没有任何深度上限**：

```rust
if c == '(' {
    self.advance();
    let mut list = Vec::new();
    loop {
        ...
        let child = self.parse_value()?;   // 无界递归
        list.push(child);
    }
}
```

`SExpr` 的 `Display`（`to_string()`）同样是无界递归。

**实测结果**（本次运行，2 MiB 栈 = tokio worker 默认值）：

| 构建 | 存活深度 | 崩溃深度 |
| --- | --- | --- |
| debug | 1,000 | 2,000 |
| release | 4,000 | 8,000 |

崩溃形式是 `fatal runtime error: stack overflow, aborting` → **SIGABRT**。这不是
panic，`catch_unwind` 接不住，tokio 也无法隔离——**整个 Runtime 进程死亡，所有
Context/Session 一起死**。release 下约 5 KB 的输入（`"(".repeat(5000)`）即可触发。

**可达路径**（全部是模型可控输入）：

1. `orchestrator.rs:16810` `normalize_context_tx_key(context_id, &call.arguments)`
   → `sexpr::parse(transaction)` → `.to_string()`。
   触发条件：模型在**一个回合里发出 ≥2 个 `context_tx` 调用**（`orchestrator.rs:12935`
   的去重分支），`transaction` 字段是模型原样写出的字符串，无任何预校验。
2. `sexpr_eval.rs:392` `validate(source, ..)` → `parse_all(source)`。
3. `harness_package.rs:115/699/722` → `parse_all(source)`，Harness 文件由 Agent 编写。

**为什么现有防御没兜住**：`sexpr_eval.rs:27` 定义了 `MAX_PROGRAM_DEPTH = 16`，
`check()` 在 `depth > MAX_PROGRAM_DEPTH` 时正确拒绝——但 `check` 跑在
`parse_all()` **之后**。深度限制作用于已经构造好的树，而栈早在构造树的过程中就
爆了。这个守卫的位置错了一层。

**影响定级**：这是全仓最严重的问题。Morphz 的整个定位是「确定性事务内核」，而这里
一个非确定性语义处理器（LLM）的一次畸形输出就能让内核**非优雅终止**——没有事务
回滚、没有 Agent Trajectory 收口、没有错误事件。而且它落在项目自称的核心（「一套语言两个
求值器」）上。通过工具输出做提示词注入即可远程触发。

**修复方向**：
- `Parser` 加 `depth` 字段，超过上限返回 `ParserError`（与 `MAX_PROGRAM_DEPTH`
  对齐或略宽），在**构造期**拒绝而不是构造后校验；
- `Display` 改迭代实现，或同样设深度上限；
- 补一条断言「深度 100k 的输入返回 `Err` 而不是崩溃」的回归。

---

## 2. 严重：macOS Seatbelt 的 protected 读禁令完全失效（已实测）

**位置** `morphz/src/sandbox.rs:519-531`（`macos::build_profile`）

生成的 SBPL 规则顺序：

```
(deny file-write*)
(allow file-write* <write_roots> "/dev/null")
<denied_write_rules>          ; deny 在 allow 之后 → 生效
<denied_write_pattern_rules>  ; deny 在 allow 之后 → 生效
<denied_read_rules>           ; deny 在 allow 之前 → 被覆盖
<denied_read_pattern_rules>   ; deny 在 allow 之前 → 被覆盖
(allow file-read* <allowed_read_roots>)
(allow file-read* <read_roots + write_roots>)
```

SBPL 是**后匹配胜出**。写方向的 deny 排在 allow 之后，正确生效；读方向的 deny 排在
两条宽 allow **之前**，所以凡是落在 workspace 内部的受保护路径，读禁令被末尾的
`(allow file-read* (subpath workspace))` 整体覆盖。

`PermissionProfile::sandbox_protected_patterns`（`permission.rs:358`）产出的正是
workspace 内的 `**/.env`、`**/.git/**`；`deny_path`（`sandbox.rs:70`）同时写入
`denied_read_paths` / `denied_write_paths`，读侧同样失效。

**实测证据**：走生产路径 `NativeSandbox::prepare_shell`，工作区 `.env` 标为
protected，沙箱内 `cat .env` 返回 **exit 0**，stdout 为 `SECRET_KEY=leak-me`；
把同一条 deny 移到 allow 之后即正确返回 `Operation not permitted`。

**影响**：`exec` 的 shell 可读取全部本应受保护的文件。`read`/`edit` 走
`inspect_path` 有独立拦截（返回 `PathDecision::Denied`），但 `exec` 只依赖 Seatbelt
profile，因此 `exec cat .env` 是完整绕过。写保护不受影响。

**为什么没被测出来**：`sandbox.rs:789` 的 `macos_profile_compiles_symbolic_protected
_globs` 等测试只断言 deny 规则**出现在 profile 文本里**，从不断言它**实际生效**。

---

## 3. 高：`morphz serve` 默认零认证 + `CORS: allow_origin(Any)`

**位置** `web.rs:762`（CORS）、`web.rs:5918`（`is_operator_authorized`）、`web.rs:626`、
`web.rs:1155`

`Server::start()` 从 `MORPHZ_DASHBOARD_TOKEN` 读令牌。未设置时 `auth_token = None`，
`token_is_authorized(None, ..)` **直接返回 `true`**，`is_operator_authorized` 在
`identity.mode == Default` 且无 gateway token 时返回 `true`。`web.rs:1155` 的守卫只
在**非 loopback 监听**时要求令牌，因此默认的 `127.0.0.1:8080` 上全部 API 与 `/ws`
完全无认证。

叠加 `CorsLayer::allow_origin(Any)`（允许任意来源跨域并读取响应体），以及 `/ws`
（`handle_ws_upgrade`）没有任何 `Origin` 校验（WebSocket 本就不受 CORS 约束）：
用户浏览器打开的任意网页都能读走完整 Agent Trajectory/Mind/Session/Secret 元数据，并能 POST
创建 Session、发消息、批准 Approval（进而触发 `exec`）。

`morphz dashboard` / `morphz setup` 走 `generate_dashboard_token()`（`main.rs:870`）
自动生成随机令牌，并用 URL fragment `#token=` 传递（fragment 不发往服务端，这个设计
是对的）。**只有 `serve` 这条路径敞开。**

**附带**（低）：`token_is_authorized`（`web.rs:5933`）用 `==` 比较令牌，非常量时间；
且接受 query string 传令牌，会进入访问日志、浏览器历史与 `Referer`。

---

## 4. 高：Context Encoding 热路径的 O(会话数 × 事件体量) 重复物化

**位置** `orchestrator/context.rs:2869-2947`

Token 预算收敛循环每淘汰**一个** Session 就把全部 Observation 从零重建一次，迭代
上限是 Working Set 的 Full Session 数（默认 50）。单次 `to_observation`
（`context.rs:4159`）成本不低：`event_text()`（`context.rs:8937`）对 payload 文本做
**完整 String 拷贝**；`text.chars().count()` 全量扫描；recall 类事件还要对全文做
一次 `serde_json::from_str`；`estimate_text_tokens` 再逐字符 fold。

这条路径在**每一次** LLM 调用前都跑（`build_context_encoding_for_session`）。

**修复方向**：`to_observation` 结果按 `event_id` 物化一次，循环内只做集合过滤与
预算求和。

---

## 5. 中高：Context Encoding 快照查询无上界

**位置** `memory/sqlite.rs:19745`（`read_context_encoding_projection_snapshot`）

查询**没有 LIMIT**，且拉取**完整 payload**。文档
（`morphz_context_transaction_scalability_and_mind_projection_v1.md`）声称
「Context Encoding 与 Snapshot 增量恢复都使用有界 SQL 查询」，这条不满足。

实际边界是「活跃 Inbox」——`session_projections` 行在退休时删除
（`sqlite.rs:5314`），但退休是 **Agent 自主行为**，Runtime 侧无硬上限。叠加 §0 里
`read` 整文件返回无字节上限，单个 Observation 可以很大。

另外 `ORDER BY event_sequence` 在 `session_id IN (...)` 多值时无法走
`idx_session_projections_context_session_sequence` 排序，退化为临时 B-tree 排序。

---

## 6. 中：Token 硬上限只是建议值，存在「上下文死锁」风险

**位置** `context.rs:2869`、`context.rs:7787`（`pressure_for`）

淘汰循环用 `rposition(|e| Full && !ready_set.contains(id))` 选目标，**当前 Session
永不降级**。当单个 Session 自身的活跃 Inbox 就超预算时，循环直接 `break`，带着超限
的 `candidate_tokens` 继续构造请求。`context_hard_token_limit`（默认 262,144）只被
翻译成 `pressure.level = "critical"` 交给模型，Runtime 侧无截断兜底。

**影响**：一旦当前 Session 的 Inbox 超过模型上下文窗口，请求被 Provider 拒绝；而
Agent 需要读到这个 Context 才能执行 `retire`——它连提示词都装不下，无法自救。

这与 Agent-Owned Context 的设计取向一致，但至少需要一个 Runtime 侧保底降级。

---

## 7. 中：启动恢复的全量跨 Context 扫描与 N+1

**位置** `orchestrator/orchestrator.rs:3303-3316`

启动串行执行约 12 个恢复/对账 pass，多个各自遍历全部 Context：

- `audit_active_supervision_invariants`（`orchestrator.rs:3631`）：每 Context 至少
  6 次查询。内部对 group/thread/objective 已做 500 一批的分片，但 **Context 维度
  本身不分页**。
- `runtime.rs:4301`：外层遍历全部 Context，内层**对每个 Activation 单独调用
  `get_thread_by_root`** —— 典型 N+1。

全部串行打在同一个 SQLite 池上。启动耗时随历史 Context 总数线性增长。

`web.rs:1406`（`handle_secret_scope_options`）也有同类 N+1：逐个 Context 调
`list_context_objectives`。

---

## 8. 低

| 项 | 位置 | 说明 |
| --- | --- | --- |
| Linux/Windows 无沙箱 | `sandbox.rs:318` | `UnsupportedNativeBackend`。`tool.rs:6216` 的 WorkspaceWrite 路径设 `fail_closed: true`，**拒绝执行**而非降级，行为正确；但仓库有 `Dockerfile`，意味着 Linux 部署下 `exec` 不可用。能力缺口，非安全漏洞。 |
| 错误分类靠字符串匹配 | `scheduler/kernel.rs:32`、`memory/sqlite.rs:104` | `message.contains("database is locked")` / `"(code: 5)"` 判断可重试。依赖驱动文案，升级 sqlx 可能静默失效。建议改用 `sqlx::Error::Database(e).code()`。 |
| Kernel generation fence 非原子 | `scheduler/kernel.rs:130` | `get_thread` 读 generation 与 `control_thread` 的 CAS 是两次独立调用。当前 revision CAS 覆盖了该窗口，不是活 bug，但这个不变量没有被断言。 |
| Edge 取消错误被吞 | `runtime.rs:4023/4026` | `let _ = request_edge_command_cancel(..).await;`，而同文件 `3566` 用 `.await?`。有 `reconcile_edge_execution` 兜底收敛，但两处语义不一致。 |
| 冗余 pragma | `memory/sqlite.rs:163` | `PRAGMA foreign_keys = ON` 用 `execute(&pool)` 只作用于池中一条连接。实际由 `SqliteConnectOptions::foreign_keys(true)`（`:136`）逐连接保证，无害但会误导。 |
| WAL 未调优 | `memory/sqlite.rs:135` | 未设 `synchronous` 与 `wal_autocheckpoint`。 |
| 上传越限残留 | `web.rs:4045` | `PAYLOAD_TOO_LARGE` 分支未 `remove_file(&partial_path)`，其他失败分支都清理了。 |

---

## 9. 本轮验证为「无问题」的部分

这些是我这轮实际读进去、确认正确的地方，记录下来以免后续误改：

- **Tar 解包**（`execution_target.rs:2698`）：路径分量校验（拒绝绝对路径 / `..` /
  Prefix）、symlink target 单独校验、`unpack_in` 越界返回 false 时报错、非
  file/dir/symlink 条目拒绝。zip-slip 与 symlink 逃逸都堵住了。
- **Approval 身份摘要**（`approval_authority.rs:27/193`）：域分隔 + 长度前缀
  （`digest_parts` 对每段写 `len().to_be_bytes()`）+ canonical JSON + 集合归一化。
  拼接歧义与顺序歧义都处理了。
- **能力子集判定**（`approval.rs:100`）：用 `Path::starts_with`（**分量级**，不是
  字符串前缀），且输入先经 `canonical_permission_root`（`permission.rs:331`，真
  `fs::canonicalize` + protected 路径拒绝）。`/ws-evil` 冒充 `/ws` 和 `/ws/../etc`
  两类绕过都不成立。
- **Admission 控制器**（`activation_admission.rs:301`）：`notified()` 在检查状态
  **之前** `enable()`，杜绝丢唤醒；`notify_change` 用 `notify_waiters()` 而非
  `notify_one()`，不会唤错等待者导致停滞；毒化互斥量用
  `PoisonError::into_inner` 恢复；`WaitingRegistration` 做 RAII 清理。
- **Timer 引擎**（`timer.rs:125`、`sqlite.rs:14577/14593`）：`next_runtime_timer_due_at`
  与 `claim_due_runtime_timers` 的谓词一致（pending 用 `due_at`，claimed 用
  `claim_expires_at`），不会出现「有到期行但claim不到」导致的 sleep(0) 忙转；claim
  前有只读 EXISTS 预检，空队列不抢 SQLite 单写者。
- **Provider refresh lease**（`provider/auth.rs:1434/1575`）：generation 围栏的
  claim/release，Drop 时补偿释放。
- **Execution Job claim**（`sqlite.rs:16781`）：`WHERE id = ? AND revision = ? AND
  status IN (...) AND cancel_requested_at IS NULL`，`rows_affected() != 1` 落显式
  冲突分支。所有状态迁移都是这个形状。
- **Edge Node 认证**（`sdk.rs:2258`）：Ed25519 签名验证 + device token 哈希存储。
- **Artifact 上传**（`web.rs:4053-4090`）：成功路径 `sync_all()` → 摘要与大小双重
  校验 → 原子 rename；失败路径清理临时文件。`let _ = flush()` 只出现在已经返回错误
  的分支上。
- **WebSocket 滞后**（`web.rs:6119`）：`RecvError::Lagged` 直接断连让客户端重拉
  持久快照，而不是继续投递残缺的模型草稿。
- **SQLite ↔ Postgres 对等性**：250 / 267 个 `async fn` 实现，差集只有内部迁移
  helper（sqlite 侧是自由函数、pg 侧是方法），无业务方法缺失。
- **生产代码几乎无 `unwrap()`**：剔除测试后仅 `provider/conformance.rs`（29 处，
  非请求路径）与 `memory/postgres/delivery.rs:538`（1 处）。
- **`let _ = ...await` 68 处**：逐条看过，除 §8 的 edge 取消外全部是错误分支上的
  临时文件清理，符合预期。

---

## 10. 建议处理顺序

1. **§1 SExpr Parser 栈溢出** — 已实测的整进程 SIGABRT，模型输出可直接触发，落在
   项目核心上。改动很小（加 depth 字段 + Display 改迭代）。
2. **§2 Sandbox 读禁令失效** — 已实测的凭据泄露路径，挪两行 + 补行为断言测试。
3. **§3 `serve` 零认证 + CORS Any** — 本地守护进程的完整控制面暴露。
4. **§6 上下文死锁兜底** — 可能导致 Agent 不可恢复。
5. **§4 / §5 编码热路径** — 每次 LLM 调用的固定成本。
6. **§0 `read` 无字节上限** — 与 §5 叠加放大。
7. **§7 N+1** — 影响启动时延，机械修复。

---

## 11. 本轮审计的覆盖边界

**深读**：`sexpr.rs`、`sexpr_eval.rs`（入口与深度校验）、`sandbox.rs`、
`permission.rs`、`approval.rs`、`approval_authority.rs`、`activation_admission.rs`、
`timer.rs`、`recovery/reconciler.rs`、`scheduler/kernel.rs`、`scheduler/command.rs`、
`web.rs`（认证/CORS/WS/artifact 数据面）、`orchestrator/context.rs`（编码路径）、
`memory/sqlite.rs`（schema、索引、claim/CAS、projection 快照、timer）、
`execution_target.rs`（归档解包）、`tool.rs`（exec 边界、read/search/list_files）。

**抽查未深读**：`tui.rs`、`sdk.rs` 其余部分、`provider/routing.rs`、
`provider/conformance.rs`、`model_input.rs`、`i18n.rs`、`setup.rs`、`cli.rs`、
`extension.rs`、`memory/lexical.rs`、`morphz-evals/*`、`dashboard/*`（前端）。

**完全未覆盖**：Postgres 后端的具体 SQL 实现（只做了方法级对等性比对，没有逐条
核对隔离级别与 SQL 语义是否与 SQLite 一致——这是一个值得单独立项的方向）。
