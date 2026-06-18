# Morphz 并发共享上下文与沙箱机制设计提案

本提案旨在针对 openclaw 剖析报告的评审意见（Review Comments），解答关键技术疑问，并为 `Morphz` 智能体框架在 Go 语言选型下的 **“Token 估算”**、**“沙箱隔离”** 以及 **“并发共享 Context（非阻塞）”** 提供具体的架构设计方案。

---

## 1. 评审问题逐一解答

### 1.1 后台通道（Background Lane）是不阻塞用户交互的吗？
**是的，完全不会阻塞。**
在 openclaw 中，后台任务（如 cron 定时器、自动记忆梳理 memory 等）被赋予低优先级，前后台任务的处理机制如下：
1.  **全局队列抢占 (CommandQueue Enqueue)**：前后台任务在分发时会被赋予 `foreground` 或 `background` 优先级。在排队调度器中，一旦前台用户消息到来，它会优先抢占执行卡位（优先执行）。
2.  **非阻塞执行**：后台任务（如 memory 梳理）是由独立的 event / command 触发的，在异步单线程（Node.js Event Loop）下，它们只是交替占用 CPU 时片。由于 I/O 全是非阻塞的，用户的前台流式打字与渲染不会感受到卡顿。
3.  **弱一致性保障**：后台任务在写数据库或更新 Context 文件时，通常会带有 `skipMaintenance: true` 或局部轻量锁，以避开前台主交互的数据锁定。

### 1.2 沙箱隔离（Sandbox）是怎么做到的？
OpenClaw 把运行环境的安全隔离剥离为 `SandboxBackend` 抽象层，核心实现了以下两种方式：
*   **Docker 沙箱（主打本地与沙箱容器）**：
    *   **原理**：在 Attempt 启动前，检测到 Sandbox 开启，它会调用 `docker` 命令或 Docker API 在宿主机上拉起一个独立的轻量容器（Image 通常为带有 python/node/git 的基础镜像）。
    *   **文件映射**：通过 Docker Bind Mount（绑定挂载），将当前会话的 `sandboxWorkspaceDir` 挂载到容器的特定工作目录（如 `/workspace`）。
    *   **接管执行**：所有被 LLM 调用的 `bash` 工具（运行指令、脚本执行）不会在宿主机直接跑，而是通过 `docker exec <container_id> bash -c "<command>"` 委托给容器执行。命令结束后，将 stdout/stderr 捕获回来。这完美隔离了宿主机的文件系统、进程和网络空间。
*   **SSH 远程沙箱（主打云端隔离）**：
    *   **原理**：对于无法直接操作宿主机 Docker 的云端多租户环境，它使用 `runSshSandboxCommand` 方案。
    *   将代码与 workspace 目录打包上传到一个远程隔离的 VM/容器节点，然后通过 SSH 连接以受限用户身份在远程节点上执行指令。

### 1.3 Go 语言中 Token 估算现成库与实现难度
**实现极其简单，且有成熟的工业级现成库。**
*   **现成库推荐**：`tiktoken-go` (库地址：[github.com/pkoukk/tiktoken-go](https://github.com/pkoukk/tiktoken-go))。这是 OpenAI 官方 `tiktoken` 算法在 Go 语言下的纯 Go 移植版，性能极高。
*   **实现难度**：极低，只需 3 行核心代码：
    ```go
    import "github.com/pkoukk/tiktoken-go"
    
    tkm, err := tiktoken.GetEncoding("cl100k_base") // 或者是 o200k_base (用于 GPT-4o)
    tokenIds := tkm.Encode(text, nil, nil)
    tokenCount := len(tokenIds)
    ```
*   **非 OpenAI 模型的处理建议**：像 Claude 或 Llama、DeepSeek 有自己的分词词表，但它们在整体分布上与 OpenAI 的 cl100k/o200k 差异非常小。在构建 Morphz 时，**统一使用 `tiktoken-go` 计算出的 Token 数量，并预留 10% ~ 15% 的安全水位（Safety Buffer）**，就完全足以用于 Compaction（上下文压缩）与窗口截断的阈值判断。这避免了为每一个小模型维护单独的词表加载器。

---

## 2. Morphz “并发共享 Context” 非阻塞架构设计

针对您的构想：**“多个并发会话共享同一个上下文 Context，支持并发执行，不阻塞交互 UI”**，我们必须在系统级处理好**多会话并发更新（写竞态 Race Condition）**与**视图一致性**问题。以下是为 `Morphz` 设计的三种可行方案：

```
                              ┌───────────────────────────┐
                              │  共享上下文 Shared Context │
                              └─────────────┬─────────────┘
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               ▼                            ▼                            ▼
      【方案 A：乐观锁 CAS】            【方案 B：Event Sourcing】     【方案 C：Git 分支视图】
      • 带 Version 版本校验          • 只增不减的 Event Stream      • Fork 独立子分支视图
      • 并发冲突时回滚 Attempt      • 各会话 Append 变动事件       • 完结后 Merge 并冲突合并
      • LLM 重新生成 (成本稍高)      • 运行时 Fold 折叠出 Prompt    • LLM 作为合并裁判
```

### 方案 A：CAS（Compare-And-Swap）与乐观锁 + LLM 回滚重试
这是最符合传统数据库事务（MVCC）的方案。
*   **设计机制**：
    1.  共享 Context 在内存/数据库中带有一个自增的版本号（`version`）。
    2.  `Session A` 启动时，读取 `Context(version=5)` 组装 Prompt 开始 LLM 推理。
    3.  `Session B` 几乎同时启动，也读取 `Context(version=5)` 开始推理。由于执行迅速，B 在第 2 秒率先完成了工具链执行，将最新结果写入 Context，并把版本号推向 `Context(version=6)`。
    4.  `Session A` 在第 4 秒结束了长推理，准备提交数据。在提交时，系统发现最新 Context 版本是 6，与 A 启动时的 5 不一致。
    5.  **冲突处理**：A 的提交被拦截，丢弃本次输出（Rollback），拉取最新的 `version=6` 上下文，重新编排 Prompt 发起 attempt 推理重试。
*   **优缺点**：保证了强一致性。但缺点很致命，高并发下会导致大量 LLM 重新推理，耗时极高且 API 费用成倍飙升。

### 方案 B：Event Sourcing (事件溯源) 追加式折叠流（推荐，最适合并发）
这是分布式系统处理并发状态冲突最优雅的做法。
*   **设计机制**：
    1.  **Context 不再是一个需要被并发覆盖的“大 JSON 实体”，而是一个“只增不减的 Event Stream (事件流)”**。
    2.  当 `Session A` 进行工具调用修改了文件，它不会去覆写全局状态，而是往流中追加一个 Event：`{session: "A", action: "write_file", file: "main.go", time: 1738221}`。
    3.  当 `Session B` 推理需要读取上下文时，系统通过一个纯函数（`Reduce / Fold`），从头到尾（或者从最近的一个 Snapshot 检查点开始）快速折叠（Fold）这串 Event Log，计算出最新的全局状态并渲染成 Prompt。
    4.  由于所有并发 Session 的写操作都退化为**只增不减的向流追加（Append-Only）**，在物理数据库层面不需要任何写锁，互不阻塞，也完全不会产生 Race Condition。
*   **优缺点**：并发性能最高，完美解决写锁问题。缺点是需要精细编排 Reduce 逻辑，确保并发会话在 Fold 出来的信息能够符合各自的上下文需求。

### 方案 C：Git-like 逻辑分支视图隔离（适合复杂任务）
这是最贴近人类团队 Git 协作的工程映射。
*   **设计机制**：
    1.  全局有一个主干上下文（`master` 分支）。
    2.  当 `Session A` 启动时，为它 Fork 出来一个临时的逻辑分支视图 `branch-A`。
    3.  在整个任务生命周期中，`Session A` 在 `branch-A` 上读写，不影响 `master`。同时 `Session B` 在 `branch-B` 上运行。这保证了极佳的交互 UI 响应，完全非阻塞。
    4.  当 `Session A` 顺利收尾时，它向主干发起 “Merge Request”（合并请求）。
    5.  **冲突合并（Conflict Resolution）**：如果在合并时，发现 A 改变的内存属性和 B 产生了逻辑冲突（例如修改了同一个 `MEMORY.md` 里的同一个技能），系统拉起一个极其便宜的 LLM 模型（如 GPT-4o-mini 或 Claude Haiku）作为“合并裁判”，进行语义级合并消解，最后写入 `master` 分支，更新版本。
*   **优缺点**：隔离度极佳，交互极其流畅，非常适合复杂的多 Agent 团队协作（Teamwork）。缺点是 Merge 阶段可能需要小模型辅助，带来微量延时。
