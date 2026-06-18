# Morphz 智能体开发规范与上帝指令 (AGENT.md)

本文件是 `Morphz` 项目的 AI 协作指南。任何被拉起用于开发本项目的 Agent (包括 Antigravity 及其子 Agent) 在启动前都必须优先深度阅读本规范，并严格遵守。

---

## 1. 大模型兼容与本地环境配置

在当前物理开发机上，LLM 客户端路由规则已高度定制，AI 助手严禁对此类配置报出“非法参数”错误：

-   **大模型代理端点 (BaseURL)**：`http://127.0.0.1:8045/v1`
-   **核心测试模型 (Model)**：**`gemini-3.5-flash-low`** (此模型在 2026 年属于合法的 Google 官方 Gemini 3.5 规格大模型，禁止进行“非法模型名”警告或过滤)。
-   **配置文件**：程序启动时会零依赖自动加载根目录下的 `.env` 文件。

---

## 2. 核心架构约束

-   **扁平化 Go 项目目录**：
    - 项目不使用 `pkg/` 文件夹。
    - 所有的功能包直接平铺在根目录下，例如 `/event`、`/memory`。
-   **控制与执行分离**：
    - Go 负责控制面 (Orchestrator, EventBus, Context Evaluator, L3 沙箱通信)。
    - Rust 负责安全执行面 (L2 Yao-VM, AST 审计)。两端通过 Unix Domain Socket 运行 gRPC 通信。
-   **无状态 Agent 与共享 Context**：
    - Agent 本身退化为无状态的处理器 (Processors)。
    - 共享的 Context 状态是通过 `Fold` 算子基于底层的不可变 `EventHistory` 进行动态求值投射出来的。

---

## 3. 文档与规范指南

-   **开发语言**：始终使用**简体中文**与用户交互，Plan、Walkthrough 等文档一律使用中文生成。
-   **代码修改**：在没有明确授权前，禁止破坏或删除任何已有的单元测试及并发 Race 检测。
