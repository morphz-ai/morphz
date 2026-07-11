# Morphz

Morphz 是一个由 Rust 实现、能够通过 SExpr DSL 自主管理自身 Context 的 AI Agent。它的核心不只是运行工具，而是把工作注意力的语义控制权交给 LLM：Agent 自己决定保留、派生、修订、保护、退役和恢复哪些信息，Runtime 只负责事务、版本、权限、资源压力、持久化与恢复。

当前 Agent-Owned Context v1 将状态分成：

- `kernel`：Runtime 拥有的只读 session、version 和 Context pressure；
- `mind`：LLM 拥有的自由格式 Context Frames；
- `inbox`：Event Ledger 中尚未被 Agent 主动退役的原始 Observation。

`context_tx` 提供 `create/derive/revise/retire/restore/protect/unprotect/place` 原语；`recall` 用于按稳定引用分页读取 Ledger 原文或恢复 Frame。主链路不会自动摘要历史、按轮数裁剪信息或把 Graph 检索结果静默注入 Mind。完整设计见 [Agent-Owned Context 设计文档](docs/morphz_agent_owned_context_design.md)。

Coding Tools v1 提供 `list_files/search/read/edit/write/exec` 最小开发闭环：`read` 返回 SHA-256 文件版本，`edit` 使用版本前提执行唯一匹配的原子局部修改，`write` 只允许显式 create 或带版本前提的 overwrite，所有成功修改都会产生带 Diff 的 `file_change` Observation。接口与安全边界见 [Coding Tools v1](docs/morphz_coding_tools_v1.md)。

真实 Coding Agent 测试使用独立 fixture、数据库、Artifact 目录和 macOS Seatbelt exec 边界；创建、探针、固定验证、范围审计与 Ledger 评分见 [Coding Eval Sandbox](docs/morphz_coding_eval_sandbox.md)。

## 本地启动

1. 复制 `.env.example` 为 `.env`，配置 `OPENAI_API_KEY`，并按需设置 `OPENAI_BASE_URL`、`OPENAI_MODEL`。
2. 确保 `models/bge-small-zh-1.5/` 下存在模型、配置和 tokenizer 文件。
3. 启动核心：

   ```bash
   cargo run -p morphz
   ```

4. 另一个终端启动 Dashboard：

   ```bash
   cd dashboard
   npm ci
   npm run dev
   ```

核心默认监听 `127.0.0.1:8080`。可通过 `MORPHZ_BIND` 和 `MORPHZ_DB_PATH` 覆盖监听地址及数据库路径，其余参数见 `morphz.toml`。

监听非本机地址时，必须设置 `MORPHZ_DASHBOARD_TOKEN`。Dashboard 可通过 `VITE_MORPHZ_TOKEN` 携带同一 token，也可分别用 `VITE_MORPHZ_HTTP_URL`、`VITE_MORPHZ_WS_URL` 指定 Core 地址。

Docker 示例：

```bash
docker build -t morphz .
docker run --rm -p 8080:8080 \
  -e OPENAI_API_KEY \
  -e MORPHZ_DASHBOARD_TOKEN="replace-with-a-long-random-token" \
  -v morphz-data:/home/morphz/data \
  morphz
```

## 验证

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
cargo build --release --workspace

cd dashboard
npm run lint
npm run build
```

## 安全边界

`list_files/search/read/edit/write` 默认受 workspace jail、敏感路径与符号链接规则约束。`edit/write` 使用 SHA-256 乐观并发校验及同目录原子替换。`exec.cwd` 也必须位于 workspace_root，但 Shell 命令本身仍运行在 Morphz 进程权限下，并非容器或 namespace 安全沙箱；部署到不可信环境时，必须在 Morphz 外层使用容器或其他系统级隔离。

## 目录说明

- `morphz/`：Agent Runtime 核心。
- `executor/`：本地 BGE 推理服务与库。
- `dashboard/`：图谱和事件流 Dashboard。
- `docs/`：设计与研究文档。
- `app/`：历史 Streamlit Schema 原型，目前不属于 Morphz 核心启动链路。
