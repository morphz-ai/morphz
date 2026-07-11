# Morphz 工业化重构计划文档 (Industrial-Grade Refactoring Plan)

本文档基于对 Morphz MVP 代码库的全面诊断，制定从原型到工业化可用的系统性重构路线图。目标是在不改变核心架构的前提下，消除安全隐患、提升可靠性、增强可观测性，并建立工程化基础设施。

---

## 1. 诊断总览 (Diagnostic Summary)

### 1.1 项目现状

| 指标 | 当前值 | 工业化目标 |
|------|--------|-----------|
| 生产代码行数 | ~3,600 行 | 重构后预估 ~4,500 行 |
| 单元测试数 | 26 个 | ≥80 个 |
| 测试覆盖率 | 未度量 | ≥70% |
| 结构化日志 | 无（`println!/eprintln!`） | `tracing` 全覆盖 |
| CI/CD | 无 | GitHub Actions |
| 配置管理 | 硬编码 + `.env` | TOML 配置文件 + 环境变量覆盖 |
| 进程崩溃风险 | `unwrap()` 3 处 | 零生产 `unwrap()` |

### 1.2 问题分级矩阵

```
┌─────────────┬──────────────────────────────────────────────┐
│  优先级      │  问题                                         │
├─────────────┼──────────────────────────────────────────────┤
│  P0 紧急    │  unwrap() 崩溃、SQL 注入、无沙箱、无日志       │
│  P1 重要    │  代码重复、魔法数字、无事务、配置硬编码          │
│  P2 优化    │  N+1 查询、速率限制、阈值脆弱性                │
│  P3 基建    │  CI/CD、Dockerfile、集成测试、Graceful Shutdown │
└─────────────┴──────────────────────────────────────────────┘
```

---

## 2. Phase 0 — 安全与稳定性加固 (Safety & Stability Hardening)

**预计工期：1-2 天**
**目标：消除所有可导致进程崩溃或数据泄露的隐患**

### 2.1 消除生产代码 `unwrap()`

**问题定位：**

| 文件 | 行号 | 代码 | 风险等级 |
|------|------|------|---------|
| `orchestrator.rs` | 209 | `crate::sexpr::parse(&snap_data).unwrap()` | 🔴 高 — 数据库损坏即 panic |
| `tool.rs` | 73 | `self.output.lock().unwrap()` | 🔴 高 — Mutex poisoned 连锁崩溃 |
| `tool.rs` | 98 | `self.output.lock().unwrap()` | 🔴 高 — 同上 |
| `sqlite.rs` | 184 | `chunk.try_into().unwrap()` | 🟡 中 — 理论安全但不规范 |

**重构方案：**

```rust
// orchestrator.rs:209 — 替换前
let ctx = crate::sexpr::parse(&snap_data).unwrap();

// 替换后
let ctx = crate::sexpr::parse(&snap_data).map_err(|e| {
    format!("快照 SExpr 解析失败 (session={}): {:?}", session_id, e)
})?;
```

```rust
// tool.rs:73 — 替换前
let mut buf = self.output.lock().unwrap();

// 替换后
let mut buf = match self.output.lock() {
    Ok(guard) => guard,
    Err(poisoned) => {
        eprintln!("⚠️ [ExecutionBuffer] Mutex poisoned, recovering: {}", poisoned);
        poisoned.into_inner()
    }
};
```

**验收标准：**
- `cargo clippy -- -D unwrap_used` 无生产代码警告
- 所有 `unwrap()` 仅存在于 `#[cfg(test)]` 模块中

### 2.2 修复 LanceDB SQL 注入

**问题定位：** `sqlite.rs` 第 386、411、455 行

```rust
// 修复前
self.lance_table.delete(&format!("id = '{}'", node.id)).await;

// 修复后 — 使用参数化转义
fn escape_lance_id(id: &str) -> String {
    id.replace('\'', "''")
}

self.lance_table.delete(&format!("id = '{}'", escape_lance_id(&node.id))).await;
```

**长期方案：** 追踪 `lancedb` crate 版本更新，待其支持参数化查询后迁移。

### 2.3 `exec` 工具沙箱增强

**当前状态：** 仅检查 `:(){:|:&};:` fork bomb 字符串。

**重构方案 — 命令黑名单 + 警告机制：**

```rust
/// 危险命令模式黑名单
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "mkfs.",
    ":(){:|:&};:",
    "> /dev/sda",
    "dd if=",
    "mv /* ",
    "chmod -R 777 /",
    "curl.*\\|.*sh",
    "wget.*\\|.*sh",
];

fn check_command_safety(cmd: &str) -> Result<(), String> {
    let lowered = cmd.to_lowercase();
    for pattern in DANGEROUS_PATTERNS {
        if lowered.contains(pattern) {
            return Err(format!(
                "⛔ 命令被安全策略拦截：匹配危险模式 '{}'",
                pattern
            ));
        }
    }
    Ok(())
}
```

**注意：** 这是纵深防御层，不应作为唯一安全措施。工业化部署应配合容器/namespace 隔离。

### 2.4 引入 `tracing` 结构化日志

**依赖添加：**

```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json", "time"] }
```

**替换映射：**

| 当前代码 | 替换为 |
|---------|-------|
| `println!("⚙️ [BGE Model] 本地内存加载成功")` | `tracing::info!(target: "bge_model", "本地内存加载成功")` |
| `eprintln!("⚠️ [BGE Model] 本地内存加载失败: {}", e)` | `tracing::error!(target: "bge_model", error = %e, "本地内存加载失败")` |
| `eprintln!("⚠️ [Curator] 异步知识提炼失败: {:?}", e)` | `tracing::warn!(target: "curator", error = ?e, "异步知识提炼失败")` |

**初始化（`main.rs` 入口）：**

```rust
use tracing_subscriber::{fmt, EnvFilter};

fn init_logging() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,morphz=debug"));

    fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_timer(fmt::time::UtcTime::rfc_3339())
        .init();
}
```

**验收标准：**
- 所有 `println!` / `eprintln!` 替换为 `tracing` 宏
- 支持 `RUST_LOG` 环境变量动态调整日志级别
- JSON 格式输出可选（生产环境）

---

## 3. Phase 1 — 可维护性重构 (Maintainability Refactoring)

**预计工期：3-5 天**
**目标：消除代码重复，集中配置，提升代码一致性**

### 3.1 提取共享上下文重建方法

**问题：** `handle_chat_event`（约 500 行）与 `get_current_context`（约 300 行）存在大量重复的事件折叠逻辑。

**重构方案 — 提取 `replay_events_to_context` 方法：**

```rust
impl Orchestrator {
    /// 从指定快照之后的事件重放，构建当前 SExpr 上下文
    async fn replay_events_to_context(
        &self,
        session_id: &str,
        snapshot_id: Option<i64>,
    ) -> Result<SExpr, Box<dyn Error + Send + Sync>> {
        // 1. 加载基础上下文（从快照或初始状态）
        let mut context = self.load_base_context(session_id, snapshot_id).await?;

        // 2. 查询快照之后的事件
        let filter = QueryFilter {
            topic: Some("chat/*".to_string()),
            after_id: snapshot_id,
            ..Default::default()
        };
        let events = self.store.query(filter).await?;

        // 3. 过滤当前 session 的事件并折叠
        for event in events.iter().filter(|e| {
            e.payload.get("session_id")
                .and_then(|v| v.as_str())
                == Some(session_id)
        }) {
            self.fold_event(&mut context, event).await?;
        }

        Ok(context)
    }

    /// 将单个事件折叠到上下文状态机
    async fn fold_event(
        &self,
        context: &mut SExpr,
        event: &Event,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        // ... 原有折叠逻辑
    }
}
```

**受影响文件：**
- `orchestrator.rs` — 提取公共方法，`handle_chat_event` 和 `get_current_context` 调用共享方法
- 预计减少 ~300 行重复代码

**验收标准：**
- `handle_chat_event` 和 `get_current_context` 共享同一折叠路径
- 现有测试全部通过
- 新增测试覆盖 `replay_events_to_context` 的边界情况

### 3.2 魔法数字集中管理

**新增配置结构体：**

```rust
// config.rs 新增

/// Orchestrator 运行时配置
pub struct OrchestratorConfig {
    /// 工具输出压缩阈值（字符数）
    pub max_tool_output_len: usize,
    /// 消息历史压缩触发阈值（条数）
    pub max_history_len: usize,
    /// 快照保存间隔（步数）
    pub snapshot_interval: usize,
    /// 并发信号量限制
    pub concurrency_limit: usize,
    /// 回复等待超时（秒）
    pub reply_timeout_secs: u64,
    /// 工具执行超时（秒）
    pub tool_timeout_secs: u64,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_tool_output_len: 2000,
            max_history_len: 10,
            snapshot_interval: 10,
            concurrency_limit: 4,
            reply_timeout_secs: 120,
            tool_timeout_secs: 30,
        }
    }
}

/// 记忆检索配置
pub struct MemoryConfig {
    /// SQLite 连接池大小
    pub sqlite_pool_size: usize,
    /// FTS5 搜索结果上限
    pub fts_search_limit: usize,
    /// 向量检索结果上限
    pub vector_search_limit: usize,
    /// 语义过渡锚点候选数
    pub transition_anchor_count: usize,
    /// Embedding 相似度低阈值（语义过渡）
    pub semantic_low_threshold: f32,
    /// Embedding 相似度高阈值（语义过渡）
    pub semantic_high_threshold: f32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            sqlite_pool_size: 8,
            fts_search_limit: 5,
            vector_search_limit: 5,
            transition_anchor_count: 3,
            semantic_low_threshold: 0.55,
            semantic_high_threshold: 0.85,
        }
    }
}
```

**影响范围：** `orchestrator.rs`、`sqlite.rs`、`main.rs`、`web.rs` 中所有硬编码数字替换为配置引用。

### 3.3 Curator 事务安全

**问题：** `curator.rs:40` 的 `extract_and_store_impl` 方法写入多个节点和边，无事务包裹。

**重构方案：**

```rust
async fn extract_and_store_impl(
    &self,
    session_id: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    // ... LLM 提取逻辑不变 ...

    // 事务包裹写入
    let mut tx = self.store.begin_transaction().await?;

    for node in &nodes {
        tx.upsert_node(node).await?;
    }
    for edge in &edges {
        tx.upsert_edge(edge).await?;
    }

    tx.commit().await?;
    Ok(())
}
```

**依赖变更：** `EventStore` trait 需新增 `begin_transaction()` 方法，`SqliteStore` 实现为 `sqlx::SqliteConnection::begin()`。

### 3.4 配置外部化

**新增 `morphz.toml` 配置文件格式：**

```toml
[server]
bind = "127.0.0.1:8080"

[database]
path = "morphz.db"
pool_size = 8

[llm]
model = "gemini-3.5-flash-low"
embedding_model = "text-embedding-004"

[orchestrator]
max_tool_output_len = 2000
max_history_len = 10
snapshot_interval = 10
concurrency_limit = 4
reply_timeout_secs = 120
tool_timeout_secs = 30

[memory]
vector_search_limit = 5
semantic_low_threshold = 0.55
semantic_high_threshold = 0.85
```

**加载优先级：** `morphz.toml` < 环境变量 < `.env` 文件

---

## 4. Phase 2 — 性能与可观测性优化 (Performance & Observability)

**预计工期：1-2 周**
**目标：消除性能瓶颈，建立生产级可观测性**

### 4.1 N+1 查询批量优化

**问题定位：** `sqlite.rs` 的 `get_neighbors` 和 `query_path` 方法。

```rust
// 修复前 — N+1 更新
for edge in edges {
    self.execute("UPDATE edges SET last_accessed = ?1 WHERE id = ?2", ...).await?;
}
for node in nodes {
    self.execute("UPDATE nodes SET last_accessed = ?1 WHERE id = ?2", ...).await?;
}

// 修复后 — 批量更新
let now = Utc::now().to_rfc3339();
let edge_ids: Vec<String> = edges.iter().map(|e| e.id.clone()).collect();
let node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();

self.execute(
    "UPDATE edges SET last_accessed = ?1 WHERE id IN (SELECT value FROM json_each(?2))",
    &[&now, &serde_json::to_string(&edge_ids)?],
).await?;

self.execute(
    "UPDATE nodes SET last_accessed = ?1 WHERE id IN (SELECT value FROM json_each(?2))",
    &[&now, &serde_json::to_string(&node_ids)?],
).await?;
```

**预期收益：** 度数为 $N$ 的节点，写入次数从 $O(N)$ 降至 $O(1)$。

### 4.2 LLM 调用速率限制

**新增 `RateLimiter` 结构：**

```rust
use tokio::sync::Semaphore;

pub struct RateLimiter {
    /// 每秒最大 token 数
    tokens_per_second: usize,
    /// 当前可用 token
    available: Arc<Semaphore>,
}
```

**集成点：** `Orchestrator` 在调用 `client.create_completion()` 前获取许可。

### 4.3 向量检索阈值基于模型元数据

**问题：** 当前用 `dim == 256` 判断模型类型，换模型即失效。

**方案：** 在 `SqliteStore` 初始化时记录模型元数据表：

```sql
CREATE TABLE IF NOT EXISTS model_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR REPLACE INTO model_metadata (key, value, updated_at)
VALUES ('embedding_model', 'bge-small-zh-1.5', datetime('now'));
INSERT OR REPLACE INTO model_metadata (key, value, updated_at)
VALUES ('embedding_dim', '512', datetime('now'));
INSERT OR REPLACE INTO model_metadata (key, value, updated_at)
VALUES ('similarity_low', '0.55', datetime('now'));
INSERT OR REPLACE INTO model_metadata (key, value, updated_at)
VALUES ('similarity_high', '0.85', datetime('now'));
```

**运行时读取：** 查询 `model_metadata` 表获取阈值，而非硬编码维度判断。

### 4.4 WebSocket 断连重连与事件补偿

**当前问题：** `web.rs:152` 的 `RecvError::Lagged` 静默丢弃事件，客户端无感知。

**重构方案：**

```rust
// 服务端：记录每个客户端的最后序列号
struct ClientState {
    last_seq: u64,
    tx: broadcast::Sender<Event>,
}

// 客户端重连时携带 last_seq
// 服务端查询 last_seq 之后的事件进行回放
```

---

## 5. Phase 3 — 工程化基础设施 (Engineering Infrastructure)

**预计工期：1-2 周**
**目标：建立持续集成、部署和测试能力**

### 5.1 CI/CD — GitHub Actions

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all -- --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test --all
      - run: cargo audit
```

### 5.2 Dockerfile — 多阶段构建

```dockerfile
# 构建阶段
FROM rust:1.82-slim AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

# 运行阶段
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/morphz /usr/local/bin/
COPY --from=builder /app/models /app/models
COPY --from=builder /app/.env.example /app/.env
EXPOSE 8080
CMD ["morphz"]
```

### 5.3 集成测试框架

**新增 `tests/` 目录：**

```
tests/
├── integration_test.rs      # 端到端 Agent Loop 测试
├── orchestrator_test.rs     # Orchestrator 单元测试补充
└── memory_test.rs           # 记忆系统集成测试
```

**端到端测试示例：**

```rust
#[tokio::test]
async fn test_full_agent_loop() {
    let bus = Arc::new(InMemoryEventBus::new());
    let store = Arc::new(SqliteStore::new(":memory:").await.unwrap());
    let client = Arc::new(MockClient::new(vec![
        // 模拟 LLM 返回工具调用
        mock_tool_call_response("write", json!({"path": "test.txt", "content": "hello"})),
        // 模拟 LLM 返回最终回复
        mock_final_reply("文件已创建"),
    ]));

    // ... 构建 Orchestrator 并发送用户消息 ...
    // 验证：文件被创建、回复正确、事件序列完整
}
```

### 5.4 Graceful Shutdown

```rust
use tokio::signal;

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("收到关闭信号，正在优雅退出...");
}

// 在 main() 中：
// tokio::select! {
//     _ = run_server() => {},
//     _ = shutdown_signal() => {},
// }
// // 清理：关闭事件总线、刷新数据库连接池、等待进行中的工具执行完成
```

---

## 6. 重构影响分析 (Impact Analysis)

### 6.1 文件影响矩阵

| 文件 | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|------|---------|---------|---------|---------|
| `orchestrator.rs` | unwrap 修复 | 方法提取、配置化 | 速率限制 | — |
| `tool.rs` | Mutex 修复、沙箱 | 配置化 | — | — |
| `sqlite.rs` | SQL 注入修复 | — | 批量查询、元数据表 | — |
| `curator.rs` | — | 事务包裹 | — | — |
| `web.rs` | — | 配置化 | 断连补偿 | — |
| `main.rs` | tracing 初始化 | 配置加载 | — | shutdown |
| `config.rs` | — | 配置结构体 | — | — |
| `event.rs` | — | — | — | — |
| `sexpr.rs` | — | — | — | — |
| `llm.rs` | — | — | — | — |

### 6.2 风险评估

| 重构项 | 风险 | 缓解措施 |
|--------|------|---------|
| `tracing` 替换 `println!` | 低 — 纯输出层变更 | 保持原有 emoji 前缀风格 |
| unwrap 消除 | 低 — 错误传播路径变更 | 现有测试回归验证 |
| 方法提取 | 中 — 核心逻辑重构 | 完整单元测试覆盖后再重构 |
| 事务包裹 | 中 — 新增 trait 方法 | 先添加 trait，再逐步迁移 |
| N+1 批量优化 | 低 — SQL 层变更 | 对比前后查询计划 |
| Graceful Shutdown | 中 — 进程生命周期变更 | 需要新增信号处理测试 |

---

## 7. 执行节奏 (Execution Rhythm)

```
Week 1:
├── Day 1-2: Phase 0 — 安全与稳定性加固
│   ├── 消除 unwrap()
│   ├── 修复 SQL 注入
│   ├── exec 沙箱增强
│   └── 引入 tracing
└── Day 3-5: Phase 1 — 可维护性重构
    ├── 提取共享上下文重建方法
    ├── 魔法数字集中管理
    ├── Curator 事务安全
    └── 配置外部化

Week 2:
├── Day 1-3: Phase 2 — 性能与可观测性优化
│   ├── N+1 查询批量优化
│   ├── LLM 速率限制
│   ├── 向量检索阈值元数据化
│   └── WebSocket 断连补偿
└── Day 4-5: Phase 3 — 工程化基础设施
    ├── CI/CD 配置
    ├── Dockerfile
    ├── 集成测试框架
    └── Graceful Shutdown
```

---

## 8. 验收标准 (Acceptance Criteria)

### 8.1 代码质量

- [ ] `cargo clippy -- -D unwrap_used` 生产代码零警告
- [ ] `cargo fmt --all -- --check` 格式检查通过
- [ ] 所有 `println!` / `eprintln!` 替换为 `tracing` 宏
- [ ] 魔法数字全部提取为命名常量或配置项

### 8.2 安全性

- [ ] LanceDB 无字符串拼接 SQL
- [ ] `exec` 工具黑名单覆盖常见危险命令
- [ ] Mutex poisoned 不再导致进程 panic

### 8.3 可靠性

- [ ] 单元测试数 ≥ 80
- [ ] `cargo test --all` 全部通过
- [ ] Curator 写入具备事务原子性

### 8.4 可观测性

- [ ] 支持 `RUST_LOG` 动态日志级别
- [ ] 日志包含结构化字段（session_id, error, duration）
- [ ] WebSocket 客户端可感知事件丢失并触发重连

### 8.5 工程化

- [ ] GitHub Actions CI 绿色通过
- [ ] Docker 镜像可构建并运行
- [ ] `Ctrl+C` 优雅关闭，不丢失进行中的工具执行结果

---

*文档版本: v1.0 | 创建日期: 2026-04-28 | 最后更新: 2026-04-28*
