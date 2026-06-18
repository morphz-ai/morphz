# 专题五：运行环境沙箱与 Serverless 宿主剖析方案

在大模型 Agent 体系中，不可信代码的执行安全是整个系统的命脉。本专题我们将深入剖析 `openclaw` 与 `hermes-agent` 中关于代码执行环境的隔离与沙箱技术，并为 `Morphz` 的执行沙箱与外部辅助容器设计出一套完整的方案。

---

## 1. 研读内容与源码目录

本专题我们将重点走读并对比以下两个方向的沙箱隔离实现：

### 1.1 Hermes-Agent 的多云沙箱环境系统
在 `hermes-agent` 中，执行环境是插件化、高隔离的。我们将走读其底层环境管理代码：
*   [environments/base.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/environments/base.py)：所有沙箱环境的基类，负责定义文件同步、代码执行的统一定义。
*   [environments/daytona.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/environments/daytona.py)：使用 Daytona SDK 构建的云端开发沙箱，解密其实时同步与进程守护方式。
*   [environments/modal.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/environments/modal.py) 与 [managed_modal.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/environments/managed_modal.py)：剖析 Serverless 容器 Modal 上的极速容器创建与进程通信。
*   [environments/docker.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/environments/docker.py) 和 [ssh.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/environments/ssh.py)：了解基础的本地 Docker 隔离和 SSH 通道指令执行。
*   [environments/file_sync.py](file:///Users/shafreeck/Codes/Morphz/hermes-agent/tools/environments/file_sync.py)：剖析如何在宿主机和隔离容器之间进行文件的差异化增量双向同步。

### 1.2 OpenClaw 的 Docker 执行与环境变量安全屏障
在 `openclaw` 中，重点关注它对宿主机环境的保全措施：
*   **指令隔离**：走读 Docker 沙箱启动与 CLI 容器挂载。
*   **安全防御**：研究 `infra/host-env-security.ts` 及安全策略中对 `DOCKER_HOST`、`DOCKER_CONTEXT` 等敏感宿主环境变量的严格拦截与物理抹除机制。

---

## 2. 拟产生的设计报告

完成源码剖析后，我们将撰写并提交以下两篇报告：

1.  **`sandbox_and_serverless_deep_dive.md`**：
    *   深度总结 Daytona、Modal、Docker 及 SSH 隔离架构的核心执行流与文件双向同步（`file_sync`）的算法细节。
    *   剖析宿主环境变量注入与安全保全机制。
2.  **`morphz_sandbox_design.md`**（Morphz 混合沙箱设计）：
    *   **本地轻量沙箱**：基于 `yao-lang`（中文 DSL）源码通过 `yao-parser` 构造 AST 静态白盒检测，并利用编译成的 `.wasm` 字节码在宿主内置虚拟机中（Wasmtime/Wasmer）跑微秒级计算，防御基本系统级危害。
    *   **远程重型沙箱**：针对需要运行大体积 Python、Bash 脚本或系统级测试的高危复杂任务，设计如何对接外部云端 Docker 或 Daytona 沙箱容器作为 Morphz 的可选备用 Runtime，并设计轻量的双向文件增量同步（FileSync）机制。

---

## 3. 验证与分析方法
*   在工作区中详细阅读 `hermes-agent/tools/environments` 下的文件及 openclaw 的安全校验模块。
*   结合前几个专题沉淀的并发与通讯总线设计，确保沙箱层与系统总线有清晰的解耦边界。
