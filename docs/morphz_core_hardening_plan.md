# Morphz Core Hardening 整体方案

> 历史文档说明（2026-07-13）：本文记录早期 `workspace jail` 方案。该实现已被统一的 `PermissionProfile + PermissionBroker + SandboxBackend` 取代；`allow_absolute_paths`、`allow_parent_traversal`、独立 jail 开关和手写命令黑名单不再是当前架构。请以 [`morphz_sandbox_execution_and_approval_architecture.md`](morphz_sandbox_execution_and_approval_architecture.md) 为准。

本文档定义 Morphz 下一阶段的核心夯实路线：**暂不引入 yao-lang / run_skill，不扩展大型新运行时，而是先把现有 Agent Runtime 做稳、做准、做安全**。

核心原则：

1. **Agent 决策优先**：Runtime 负责监控、约束和事件化，不替 LLM 做高层任务决策。
2. **安全可配置**：默认保守，但允许高级用户显式关闭部分限制。
3. **状态一致性优先**：大脑 Context 不能半损坏、半提交。
4. **测试先行锁主链路**：核心 Attempt Loop 必须可回归验证。
5. **不引入大型新运行时**：本阶段不接 Yao、不接 Wasm skill。

---

## 1. 总体目标

当前阶段定义为：

> **Morphz Core Hardening：把已有 Agent Runtime 做稳、做准、做安全。**

完成后应达到：

- SExpr Context 不会因一次错误 `eval` 被污染。
- Context 结构有 schema 校验，不会隐性腐化。
- Orchestrator Attempt Loop 有端到端测试保护。
- `read` / `write` / `exec` 工具有明确、可配置的边界。
- 后台任务超时后唤醒 LLM，由 LLM 决定继续等还是 kill。
- Curator 不向记忆图谱写入垃圾知识。
- 日志与事件可复盘每一轮 Attempt。

---

## 2. Phase A：SExpr Eval 事务化

### 2.1 问题

当前 `begin` 指令不是事务性的。例如：

```lisp
(begin
  (set (state plan goal) "分析项目")
  (set (meta session) "非法修改")
)
```

可能出现：

- 第一条 `set` 成功；
- 第二条因为只读路径失败；
- Context 处于半修改状态。

这会让 Agent 的长期心智状态产生隐性污染。

### 2.2 方案

在 `morphz/src/orchestrator/evaluator.rs` 新增事务执行函数：

```rust
pub fn eval_instruction_transactional(
    context: &mut SExpr,
    instruction: &SExpr,
) -> Result<(), String> {
    let mut shadow = context.clone();
    eval_instruction(&mut shadow, instruction)?;
    validate_context_schema(&shadow)?;
    *context = shadow;
    Ok(())
}
```

核心逻辑：

1. clone 当前 context；
2. 在 shadow 上执行 eval；
3. 执行成功后校验 schema；
4. 全部成功才 commit；
5. 任意失败则原 context 不变。

### 2.3 接入点

替换 Orchestrator 中 proposal fold：

```rust
eval_instruction(&mut context_state, &inst_sexpr)
```

为：

```rust
eval_instruction_transactional(&mut context_state, &inst_sexpr)
```

### 2.4 测试

新增：

```rust
test_transactional_eval_commits_on_success
test_transactional_eval_rolls_back_on_begin_failure
test_transactional_eval_blocks_readonly_path_without_partial_write
```

### 2.5 验收标准

- 合法 `begin` 全部提交。
- 非法 `begin` 任意一步失败时，原 context 完全不变。
- 只读路径攻击不会留下半成功写入。
- 现有 evaluator 安全测试不回归。

---

## 3. Phase B：Context Schema 校验

### 3.1 问题

SExpr 是灵活结构，但过于灵活会导致 LLM 写坏结构。例如：

```lisp
(set (state history) "oops")
```

后续代码仍假设 `history` 是 list，可能引发一系列隐性错误。

### 3.2 方案

新增模块：

```text
morphz/src/orchestrator/context_schema.rs
```

核心函数：

```rust
pub fn validate_context_schema(ctx: &SExpr) -> Result<(), String>
```

### 3.3 最小 Schema

Context 必须满足：

```lisp
(context
  (meta ...)
  (facts ...)
  (state
    (plan
      (goal ...)
      (todo_stack
        (doing ...)
        (todo ...)
        (done ...)))
    (registers ...)
    (history ...)
    (step N)))
```

### 3.4 校验规则

| 路径 | 要求 |
|---|---|
| root | 必须是 `context` list |
| `meta` | 必须存在且为 list |
| `facts` | 必须存在且为 list |
| `state` | 必须存在且为 list |
| `state plan` | 必须存在且为 list |
| `state plan todo_stack` | 必须存在且为 list |
| `state plan todo_stack doing` | 必须存在 |
| `state plan todo_stack todo` | 必须存在且为 list |
| `state plan todo_stack done` | 必须存在且为 list |
| `state registers` | 必须存在且为 list |
| `state history` | 必须存在且为 list |
| `state step` | 必须存在且可解析为整数 |

### 3.5 调用点

- 初始 context 创建后；
- snapshot parse 后；
- transactional eval commit 前；
- `get_current_context` 返回前；
- 保存 snapshot 前。

### 3.6 验收标准

- 非法 schema 的 eval 被拒绝。
- schema 错误信息明确指出损坏路径。
- snapshot 损坏不会 panic，而是返回清晰错误。

---

## 4. Phase C：Attempt Loop E2E 测试

### 4.1 目标

把核心主循环锁住，避免以后改 Orchestrator 时引入隐藏回归。

### 4.2 新增测试文件

```text
morphz/tests/attempt_loop.rs
```

### 4.3 测试用 Mock LLM

实现测试用 LLM client：

```rust
struct MockClient {
    responses: Mutex<VecDeque<Response>>,
}
```

每次 `create_completion` 弹出一个预设响应。

### 4.4 测试用例

#### C1. 无工具直接回复

Mock LLM 返回：

```rust
Response {
    content: "hello user".to_string(),
    tool_calls: vec![],
}
```

断言：

- `chat/reply` 被发布；
- payload 中 `session_id` 正确；
- text 为 `hello user`。

#### C2. 工具调用后再回复

Mock LLM 第一次返回：

```json
{ "tool": "read", "path": "notes.txt" }
```

第二次返回最终回答。

断言：

- `assistant_call` 事件存在；
- `tool_output` 事件存在；
- 第二轮 attempt 被唤醒；
- 最终 `chat/reply` 存在。

#### C3. eval 失败不污染 context

Mock LLM 调用非法 eval：

```lisp
(begin
  (set (state plan goal) "A")
  (set (meta session) "evil")
)
```

断言：

- eval 返回错误；
- goal 没有变成 `"A"`；
- context schema 仍有效；
- 后续用户消息仍可继续触发 attempt。

#### C4. 并行工具 barrier

Mock LLM 同时返回 3 个 tool calls。

断言：

- 3 个工具都执行；
- 前 N-1 个 `tool_output` 只 append 到 store；
- 最后一个 `tool_output` publish；
- 下一轮 attempt 只被触发一次。

### 4.5 验收标准

- E2E 测试覆盖无工具、有工具、eval 失败、并行工具四条主链路。
- 所有测试可在 CI 中稳定运行。
- 不依赖真实 LLM。

---

## 5. Phase D：工具路径安全，可关闭 Workspace Jail

### 5.1 目标

默认保护宿主文件系统，但允许高级用户显式关闭 workspace 限制。

这是重要设计修正：**workspace jail 应该是可配置策略，而不是写死的框架假设。**

### 5.2 配置结构

在 `config.rs` 增加：

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct ToolSecurityConfig {
    pub workspace_jail_enabled: bool,
    pub workspace_root: String,
    pub allow_absolute_paths: bool,
    pub allow_parent_traversal: bool,
    pub extra_read_roots: Vec<String>,
    pub extra_write_roots: Vec<String>,
    pub deny_patterns: Vec<String>,
}
```

默认：

```rust
impl Default for ToolSecurityConfig {
    fn default() -> Self {
        Self {
            workspace_jail_enabled: true,
            workspace_root: ".".to_string(),
            allow_absolute_paths: false,
            allow_parent_traversal: false,
            extra_read_roots: vec!["/tmp".to_string()],
            extra_write_roots: vec!["/tmp".to_string()],
            deny_patterns: vec![
                ".env".to_string(),
                ".env.*".to_string(),
                ".git/**".to_string(),
                "**/.ssh/**".to_string(),
                "target/**".to_string(),
                "models/**".to_string(),
            ],
        }
    }
}
```

加入 `AppConfig`：

```rust
pub struct AppConfig {
    // ...
    pub tool_security: ToolSecurityConfig,
}
```

### 5.3 TOML 配置

```toml
[tool_security]
workspace_jail_enabled = true
workspace_root = "."
allow_absolute_paths = false
allow_parent_traversal = false

extra_read_roots = ["/tmp"]
extra_write_roots = ["/tmp"]

deny_patterns = [
  ".env",
  ".env.*",
  ".git/**",
  "**/.ssh/**",
  "target/**",
  "models/**"
]
```

### 5.4 新增路径检查器

新增：

```text
morphz/src/tool_security.rs
```

核心 API：

```rust
pub enum ToolAccess {
    Read,
    Write,
}

pub fn resolve_tool_path(
    input: &str,
    access: ToolAccess,
    config: &ToolSecurityConfig,
) -> Result<PathBuf, String>
```

规则：

1. 展开相对路径；
2. canonicalize parent；
3. 检查 deny_patterns；
4. 如果 jail 开启：resolved path 必须在 workspace_root 或 extra roots 内；
5. 如果 jail 关闭：不做 workspace 限制，但 deny_patterns 仍生效；
6. 如果绝对路径且 `allow_absolute_paths=false`：拒绝。

### 5.5 read/write 接入

`ReadFileTool`：

```rust
let absolute_path = resolve_tool_path(&args.path, ToolAccess::Read, &config)?;
```

`WriteFileTool`：

```rust
let absolute_path = resolve_tool_path(&args.path, ToolAccess::Write, &config)?;
```

### 5.6 Tool 构造改造

当前：

```rust
registry.register(Arc::new(WriteFileTool));
registry.register(Arc::new(ReadFileTool));
```

改为：

```rust
let tool_security = Arc::new(app_config.tool_security.clone());

registry.register(Arc::new(WriteFileTool::new(Arc::clone(&tool_security))));
registry.register(Arc::new(ReadFileTool::new(Arc::clone(&tool_security))));
```

### 5.7 验收标准

| 场景 | 默认结果 |
|---|---|
| `read("src/main.rs")` | 允许 |
| `read("../foo")` | 拒绝 |
| `read("/etc/passwd")` | 拒绝 |
| `read("/tmp/a.txt")` | 如果 `/tmp` 在 extra_read_roots，允许 |
| `write(".env")` | 拒绝 |
| `workspace_jail_enabled=false` | 不限制 workspace |
| deny_patterns 命中 | 始终拒绝 |

---

## 6. Phase E：后台任务超时唤醒 LLM，而不是自动 kill

### 6.1 目标

Runtime 不擅自终止任务，只负责监控并在任务运行过久时唤醒 LLM 决策。

**是否继续等、是否 kill、是否问用户，应由 LLM 决定。**

### 6.2 背景任务结构扩展

当前：

```rust
pub struct BackgroundTask {
    pub id: String,
    pub cmd_str: String,
    pub pgid: i32,
}
```

扩展为：

```rust
pub struct BackgroundTask {
    pub id: String,
    pub cmd_str: String,
    pub pgid: i32,
    pub session_id: String,
    pub started_at: DateTime<Utc>,
    pub last_output_at: DateTime<Utc>,
    pub output_bytes: usize,
    pub wake_generation: u64,
    pub next_wakeup_at: Option<DateTime<Utc>>,
}
```

### 6.3 配置项

```rust
pub struct BackgroundTaskConfig {
    pub timeout_notify_secs: u64,
    pub timeout_notify_enabled: bool,
    pub max_output_buffer_bytes: usize,
}
```

TOML：

```toml
[background_task]
timeout_notify_enabled = false # 默认只由完成事件唤醒；需要 watchdog 时显式开启
timeout_notify_secs = 300
max_output_buffer_bytes = 65536
```

### 6.4 等待检查器

> 当前公开工具名为 `check_task_after(task_id, check_after_secs)`，强调它只注册
> 一次监督检查点而不代表普通等待。以下 `wait_task(wait_secs)` 是旧协议记录；
> Runtime 仅以不向新模型展示的别名继续接受持久化旧调用。

任务转后台后启动默认检查点；Agent 也可以通过 `wait_task(task_id, wait_secs)` 重新安排下一次检查：

```rust
let generation = task.replace_wakeup_after(wait_secs);
tokio::spawn(async move {
    tokio::time::sleep(Duration::from_secs(wait_secs)).await;
    if task_still_running(task_id) && task.wake_generation == generation {
        publish_task_wait_elapsed_event(...).await;
    }
});
```

注意：

- **不 kill**；
- **不 remove task**；
- **只 publish event**；
- 新的 `wait_task` 调用以 generation 取代尚未触发的旧定时器。

### 6.5 事件设计

复用现有 `chat/tool_output`，因为 Orchestrator 已经监听它，会自动唤醒 LLM。

payload：

```json
{
  "session_id": "session_x",
  "tool_name": "wait_task",
  "task_id": "task_...",
  "event": "background_task_wait_elapsed",
  "wake_source": "agent_requested",
  "wait_secs": 300,
  "elapsed_secs": 300,
  "text": "为后台任务 task_x 安排的 300 秒等待已经结束，任务仍在运行。\n最近输出如下：...\n继续等待时请设置新的 wait_secs，或调用 kill_task。"
}
```

### 6.6 LLM 可选行为

收到等待到期事件后，LLM 可以：

1. 调用 `wait_task` 并设置新的 `wait_secs`，随后静默进入事件驱动等待；
2. 调用 `kill_task`；
3. 根据已有输出继续其他动作；
4. 回复用户当前状态或询问是否终止。

### 6.7 可重置而不轮询

每次 `wait_task` 只安排一个未来唤醒点，并递增 `wake_generation`。旧定时器发现 generation 已变化后静默退出；任务完成或收到 kill 请求时也会取消尚未触发的唤醒。这样 Agent 可以多次决定新的等待长度，但不会靠连续工具调用轮询。

### 6.8 验收标准

- 后台任务超过阈值不被 kill。
- 发布 `background_task_wait_elapsed` 事件。
- Orchestrator 被唤醒。
- LLM 可以选择新的等待长度或调用 `kill_task`。
- 新等待会取代旧等待，任务完成后不会产生过期唤醒。

---

## 7. Phase F：Memory Quality Hardening

### 7.1 Curator 输出校验

在 Curator 写入前加验证：

```rust
fn validate_relation(rel: &ExtractedRelation) -> Result<(), String>
```

规则：

| 字段 | 规则 |
|---|---|
| `from` / `to` | 非空，长度 <= 80 |
| `from_type` / `to_type` | 必须是 `Concept` / `Issue` / `Solution` / `Lesson` |
| `relation` | 必须是 `Causes` / `Resolves` / `AssociatedWith` |
| 内容 | 不得包含代码块、长路径、大段日志 |
| from != to | 防止自环垃圾 |

非法 relation 直接跳过，并打 warn 日志。

### 7.2 去重

在 batch 写入前：

```rust
HashSet<(from_id, to_id, relation)>
```

### 7.3 facts 注入长度限制

建议：

```rust
const MAX_FACTS_INJECTION: usize = 12;
const MAX_FACT_CHARS: usize = 200;
```

每条 story：

```rust
truncate_chars(story, MAX_FACT_CHARS)
```

最多注入 top 12 条。

### 7.4 验收标准

- Curator 不写入非法类型。
- 不写入超长日志型节点。
- 不写入明显路径/命令噪声节点。
- facts 注入不会爆 context。

---

## 8. Phase G：可观测性补强

### 8.1 目标

每一轮 Attempt 都可复盘。

### 8.2 增加 ID

生成：

```rust
attempt_id = format!("attempt_{}_{}", session_id, timestamp)
turn_id = current_step
```

日志字段统一携带：

- `session_id`
- `attempt_id`
- `event_id`
- `tool_call_id`
- `tool_name`

### 8.3 事件中加入 attempt_id

例如：

```json
{
  "session_id": "...",
  "attempt_id": "...",
  "text": "..."
}
```

### 8.4 验收标准

日志中可以完整追踪：

```text
user_message -> context_fold -> llm_call -> assistant_call -> tool_output -> reply
```

---

## 9. 推荐落地顺序

建议顺序：

```text
1. Phase A：eval 事务化
2. Phase B：Context Schema 校验
3. Phase C：Attempt Loop E2E 测试
4. Phase D：read/write workspace jail（可关闭）
5. Phase E：后台任务超时唤醒 LLM
6. Phase F：Memory Quality Hardening
7. Phase G：可观测性补强
```

原因：

1. **A/B** 先保护大脑状态。
2. **C** 锁住主循环，防止后续改动破坏核心行为。
3. **D/E** 收紧工具和后台任务，但保持 Agent 决策权。
4. **F/G** 提高长期运行质量。

---

## 10. Batch 1：Brain Safety（建议第一批实施）

### 10.1 范围

第一批只做：

1. `eval_instruction_transactional`
2. `validate_context_schema`
3. evaluator + orchestrator 接入
4. 单元测试

### 10.2 预期改动文件

```text
morphz/src/orchestrator/evaluator.rs
morphz/src/orchestrator/context_schema.rs
morphz/src/orchestrator/mod.rs
morphz/src/orchestrator/orchestrator.rs
```

### 10.3 测试

```rust
test_transactional_eval_commits_on_success
test_transactional_eval_rolls_back_on_begin_failure
test_context_schema_valid_initial_context
test_context_schema_rejects_broken_todo_stack
```

### 10.4 价值

范围小、收益大、风险低，是最适合立即启动的基础夯实包。

---

## 11. 非目标（本阶段明确不做）

本阶段不做：

- yao-lang 集成；
- run_skill；
- write_skill；
- WASM VM；
- Curator 自动生成可执行技能；
- 动态工具挂载。

这些能力留到 Core Hardening 完成之后再评估。

---

## 12. 总结

本方案的核心不是添加炫技能力，而是让 Morphz 的底座变得可信：

> **大脑不坏、循环不乱、工具不越权、任务不擅杀、记忆不污染、日志可复盘。**

等这几个基础条件成立后，再考虑 yao-lang / run_skill / 自演化技能闭环，风险会低很多。
