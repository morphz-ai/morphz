# Morphz

Morphz 是一个由 Rust 实现、能够通过 SExpr DSL 自主管理自身 Context 的 AI Agent。它的核心不只是运行工具，而是把工作注意力的语义控制权交给 LLM：Agent 自己决定保留、派生、修订、保护、退役和恢复哪些信息，Runtime 只负责事务、版本、权限、资源压力、持久化与恢复。

当前 Agent-Owned Context v1 将状态分成：

- `kernel`：Runtime 拥有的只读 Context、当前求值的 active Session、version 和 Context pressure；
- `mind`：LLM 拥有的自由格式 Context Frames；
- `inbox`：Event Ledger 中尚未被 Agent 主动退役的原始 Observation。

`context_tx` 提供 `create/derive/revise/retire/restore/protect/unprotect/place/relate/unrelate/checkpoint/rollback/drop-checkpoint/retire-session/restore-session` 原语；`recall` 用于按稳定引用分页读取 Ledger 原文或恢复 Frame。主链路不会自动摘要历史、按轮数裁剪信息或把 Graph 检索结果静默注入 Mind。完整设计见 [Agent-Owned Context 设计文档](docs/morphz_agent_owned_context_design.md)。

长期架构把 Agent 视为持续存在的逻辑认知主体，把 Session 视为可多路复用的交互连接，把 Context 视为可共享、COW 分支、合并和重置的一等版本化对象；多个 Session 可以共享一个 Mind，一个 Session 也可以由多个 Sub Agent/算力节点并行推进。该方向不代表当前能力已经全部实现，完整边界见 [共享 Context、多会话与并行认知架构](docs/morphz_shared_context_multisession_architecture.md)。

Agent 拥有 Mind 的认识论与语义控制权；Runtime 则负责不可伪造的事件顺序、直接因果、身份、来源、版本、事务、权限和控制反馈。Runtime 不替 Agent 判断业务真理，而是为自由认知提供符合现实的坐标系。该分工见 [现实约束下的自主认知 Context](docs/morphz_reality_constrained_epistemic_context.md)。

Reality Contract v1 已将上述现实约束与认识纪律统一生成到 System Prompt、Context Protocol 和 `context_tx` 工具说明，并完成 Gemini 跨领域五次回归。实现细节、Prefix Cache 编排和真实结果见 [Reality Contract v1 验证报告](docs/morphz_reality_contract_v1_validation.md)。

当前各项真实测试的最终结果、模型身份、结论边界和未完成项见 [Morphz 当前评测状态总览](docs/morphz_eval_status.md)。日常主测 Agent 为 `gemini-3-flash-agent`，其他模型用于能力对照与 Provider 协议覆盖验证。

Experience Transfer v1 以相关经验、无关经验和全新 Agent 三 arm 同条件比较已有 Mind 对后续任务的影响。初版结果后来发现 Inbox 可以替 Mind 通过的评分缺陷；当前已改为严格检查活动 Mind Frame/Relation。场景设计、无效夹具与历史结果更正见 [Experience Transfer Benchmark v1](docs/morphz_experience_transfer_benchmark_v1.md)。

Cognitive SExpr VM Prompt 将 LLM 定义为持续运行的 S 表达式认知机器的非确定性语义处理器。严格 Mind-only 评分下的五次 Gemini 配对实验中，VM related 为 15/15、原 Agent Prompt 为 14/15，三 arm 总语义为 31/45 对 26/45；模型尝试略降但物理工具增加，且尚未形成显式抽象原则。候选已证明当前任务族中非退化，完整判据、Mind 审计和结论见 [Cognitive S-Expression VM Prompt A/B](docs/morphz_cognitive_sexpr_vm_prompt_ab.md)。

Runtime 现在提供三个可运行的 System Prompt Profile，并默认使用 `semantic_sexpr_vm`：整个稳定 Prompt 是一棵 SExpr，`seq/call/fallback/bind/if/reply` 的自然语言语义位于各自节点内部。`cognitive_sexpr_vm` 与 `agent_owned_context` 仍可通过 `MORPHZ_SYSTEM_PROMPT_MODE` 选择。三者共享 Context Protocol、DSL、工具和持久化状态；普通无工具文本直接回复当前 active Session，`no_reply` 表示显式静默，`send_message` 用于主动联系另一 Session。完整响应协议见 [单 Session 求值与响应路由协议 v1](docs/morphz_response_routing_protocol_v1.md)。

Context-Owned Session Service v1 提供持久化 Context/Session Registry、消息幂等、按 Session 的消息与回复路由、共享 Context Encoding、过滤 WebSocket 和取消语义。一个 Context 拥有一个共享 Mind 和多个可并发活跃的 Session；同一 Session 的独立 Work Item 也可以并发求值，回复和工具 continuation 通过 `root_turn_id` 保持因果隔离，`context_tx` 仍按 Context 加锁串行提交。接口与边界见 [Session Service v1](docs/morphz_session_service_v1.md)。

Agent / Context / Session Lifecycle v1 在统一 Mount/Seed/Projection 底层上提供四个高层语义：`create_session` 在当前 Context 创建共享会话，`create_independent_session` 继承 Mind 但隔离原 Session/Inbox，`create_agent` 创建全新 Agent/Root Context/初始 Session，`delegate` 把共享 Mind 与可选的当前 Session 证据交给隔离 Sub Agent，并将结果返回父 Session 验证和整合。设计、不变量、API 与验证结果见 [Lifecycle 与 Delegation v1](docs/morphz_agent_context_session_lifecycle_v1.md)。

Coding Tools v1 提供 `list_files/search/read/edit/write/exec` 最小开发闭环：`read` 返回 SHA-256 文件版本，`edit` 使用版本前提执行唯一匹配的原子局部修改，`write` 只允许显式 create 或带版本前提的 overwrite，所有成功修改都会产生带 Diff 的 `file_change` Observation。接口与安全边界见 [Coding Tools v1](docs/morphz_coding_tools_v1.md)。

真实 Coding Agent 测试使用独立 fixture、数据库、Artifact 目录和 macOS Seatbelt exec 边界；v2 提供多文件重试状态机任务，并在 Agent 不可见的 verifier 副本中注入隐藏测试。创建、探针、固定验证、范围审计与 Ledger 评分见 [Coding Eval Sandbox](docs/morphz_coding_eval_sandbox.md)。

Attempt Runtime 将物理工作与 Context transaction 分开控制。当前 Protocol v16 以 Evaluation Work Item、Session Working Set、Session attention 和因果可见边界承载并发；每个模型请求只有一个 active Session，不再保留多 Session 合并求值。无工具非空文本是当前 Work Item 的可投递终态，独占 `no_reply` 是静默终态；空响应或非法混用会有限纠错后安全熔断。物理工具结果只恢复所属因果链，更晚到达的并发消息不会倒灌进旧 Work Item；终态唯一性也按 Work Item 提交，因此同一 Root Turn 的后台唤醒可以产生新的、不会被早先响应抑制的结果。

Session Working Set 默认选择当前 Session 与最近 24 小时内最多 50 个活跃 Session；共享 Mind 始终保留，超出窗口、数量或 Token Budget 的 Session 只退出完整 Observation 投影。Agent 可用 `retire-session/restore-session` 持久维护注意力，新定向消息或工具结果会自动恢复目标 Session。可用 `MORPHZ_SESSION_ACTIVE_WINDOW` 和 `MORPHZ_SESSION_WORKING_SET_MAX` 调整策略；`morphz context status`、TUI 顶栏以及 `/api/contexts/:context_id/working-set`、`/api/contexts/:context_id/work-items` 可查看实际编译状态。完整实现与真实 Gemini 并发结果见 [并发 Session 与认知工作集 v1](docs/morphz_concurrent_session_working_set_v1.md)。

Context Pressure Eval 使用合成长历史和缩小阈值验证 Agent 自主 `derive/protect/retire`：首次真实运行将 estimated tokens 从 9,177 降至 2,140，并完整保留四项长期事实。设计、命令和结论边界见 [Context Pressure Eval](docs/morphz_context_pressure_eval.md)。

生产 Prompt pressure 已不再只统计 Frame 与 Inbox 字符：Orchestrator 在 completion 前计量完整工作请求，并在 Context Encoding 中显示来源、范围与可信度。核心路径禁止为 Token 计数产生额外远程请求；当前 OpenAI-compatible Client 使用完整请求估算和 completion `usage.prompt_tokens` 校准，后续可按 profile 显式接入本地 tokenizer/chat-template。设计与边界见 [Prompt Token Accounting v1](docs/morphz_prompt_token_accounting_v1.md)。

Context Long-Run Eval 从 normal 开始连续注入六批历史，分别评估容量、语义保真和维护效率。首次完整运行的 Capacity/Fidelity 通过、Efficiency 未通过：56 条原始历史全部退休且峰值仅 4,491/8,000，但模型发生多事务循环并线性保护批次 Frame。协议、轨迹与下一步见 [Context Long-Run Eval](docs/morphz_context_long_run_eval.md)。

## 本地启动

1. 编译核心，并把二进制放到独立运行目录。不要把 Morphz 源码仓库同时作为 Agent 的工作区：

   ```bash
   cargo build --release -p morphz
   mkdir -p ../morphz-runtime
   cp target/release/morphz ../morphz-runtime/morphz
   cd ../morphz-runtime
   ./morphz setup
   ./morphz
   ```

   全屏 `setup` 可选择 OpenAI、Anthropic、Gemini 或自定义 Provider，并把协议、凭证
   引用和模型选择保存到用户级 Morphz 配置目录。API Key 可存入系统 Keychain、权限为
   `0600` 的用户级明文 Morphz secrets 文件，或引用既有环境变量；本地无认证服务不需要 Key。
   工作目录中的 `.env` 不会被隐式加载，防止不可信项目把宿主凭证重定向到项目指定端点。

   默认 `workspace_root = "."`、数据库和 Agent 产物都会落在独立运行目录。Runtime 会把
   实际加载的 `MORPHZ_CONFIG_PATH`、当前可执行文件、SQLite 主库及 `-wal/-shm` 强制
   加入不可覆盖保护，Agent 不能通过文件工具、Shell 或自动审批修改 Runtime 自身；
   `.env`、`.git`、`.ssh` 同样默认受保护。

   交互式 TTY 默认进入 Ratatui 界面：Enter 发送，Shift/Alt+Enter 换行，Ctrl+W 打开任务概览，
   Tab 按需展开任务诊断，Ctrl+K 打开 Mind；`/ctx`、`/jobs`、`/cancel`、`/help` 可检查或控制当前运行。Provider 返回的模型正文和工具参数按统一流式事件
   展示；无工具正文完整返回后会提交为持久化 Session 消息。`/theme` 可在与 Dashboard
   一致的电光青、鸢尾紫、暖珊瑚和纯单色四套主题间切换。`--plain` 可选择
   行式界面；非 TTY 与 `morphz exec` 自动使用纯文本，适合脚本和管道。

   CLI 也可以直接携带提示词；未被已注册命令和选项消费的文本都会交给 Agent：

   ```bash
   morphz 帮我检查当前项目
   morphz --sandbox=workspace-write --approval=auto 继续优化坦克大战
   morphz exec --session=session_123 -- 只执行这一轮并输出最终答复
   ```

   裸启动和裸提示词会在所选共享 Context 中新建一个 Session。`morphz resume` 默认恢复
   最近活跃的 Session；指定通信通道可使用 `morphz resume ID`、`--session=ID` 或
   `morphz session resume ID`。它不是“恢复记忆”，因为新 Session
   本来就能读取共享 Context 的认知结构。`morphz session create --independent` 会从
   当前 Mind snapshot 创建一个隔离 Context，再把新 Session 挂载上去。可用
   `morphz context/session/agent/job --help` 查看总览，或直接运行 `morphz --help`。

   Provider 与配置诊断命令：

   ```bash
   morphz provider list
   morphz provider test <provider-id>
   morphz model list --provider=<provider-id>
   morphz config explain --format=json
   morphz doctor
   ```

2. 如需 HTTP/WebSocket 与 Inspector，先启动 Server：

   ```bash
   morphz serve
   ```

   再在另一个终端启动 Inspector：

   ```bash
   cd dashboard
   npm ci
   npm run dev
   ```

`morphz serve` 默认监听 `127.0.0.1:8080`。可通过 `--bind`、`MORPHZ_BIND` 和
`MORPHZ_DB_PATH` 覆盖数据库路径；监听地址可用 `--bind` 或 `MORPHZ_BIND` 设置。新项目的
非敏感配置放在 `.morphz/config.toml`，Provider、Credential、权限和监听地址属于用户或
系统控制面，项目配置不能修改。完整分层设计见
[CLI 产品化 v1](docs/morphz_cli_productization_v1.md)。

监听非本机地址时，必须设置 `MORPHZ_DASHBOARD_TOKEN`。Dashboard 可通过 `VITE_MORPHZ_TOKEN` 携带同一 token，也可分别用 `VITE_MORPHZ_HTTP_URL`、`VITE_MORPHZ_WS_URL` 指定 Core 地址。

Docker 示例：

```bash
docker build -t morphz .
docker volume create morphz-config
docker run --rm -it \
  -e OPENAI_API_KEY \
  -v morphz-config:/home/morphz/.config/morphz \
  morphz setup
docker run --rm -p 8080:8080 \
  -e OPENAI_API_KEY \
  -e MORPHZ_DASHBOARD_TOKEN="replace-with-a-long-random-token" \
  -v morphz-config:/home/morphz/.config/morphz \
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

`list_files/search/read/edit/write/exec` 共享同一个 `PermissionProfile` 和 `PermissionBroker`。默认 `auto_review` 模式允许工作区读写、禁止网络，越界能力由独立 AI Reviewer 审查；Reviewer 无法判断时会进入可等待的人工审批通道。CLI 可直接批准或拒绝，Web 使用 `GET /api/approvals` 与 `POST /api/approvals/:id`。`edit/write` 另外使用 SHA-256 乐观并发校验及同目录原子替换。

`exec` 会把相同的路径、protected paths 和网络权限编译到操作系统原生沙箱：macOS Seatbelt 已经过真实越权测试；Linux 与 Windows 后端尚未实机实现，启用沙箱时会 fail-closed。高层模式为 `request_approval`、`auto_review`、`full_access` 和 `custom`；完全访问会关闭文件边界与 OS 沙箱并显示启动警告，但敏感环境变量是否传给 Shell 仍由独立环境策略控制。完整设计和当前边界见 [统一沙箱执行与可插拔审批架构](docs/morphz_sandbox_execution_and_approval_architecture.md)。

## 目录说明

- `morphz/`：Agent Runtime 核心、统一 Application API、CLI 与 Server 适配器。
- `extensions/morphz-memory-vector/`：可选 Graph/Vector/Embedding 召回扩展；默认核心不加载。
- `morphz-evals/`：独立评测框架、评测二进制和测试夹具。
- `executor/`：可选本地 BGE 推理库，仅由启用 `local-bge` 的扩展依赖。
- `dashboard/`：可选 Mind/Context/Session Inspector，不属于 Runtime Core。
- `docs/`：设计与研究文档。
- `app/`：历史 Streamlit Schema 原型，目前不属于 Morphz 核心启动链路。
