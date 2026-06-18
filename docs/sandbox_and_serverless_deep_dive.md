# 运行环境沙箱与 Serverless 宿主源码深度剖析

大模型生成的不可信代码存在死循环、磁盘撑爆、越权访问宿主机等重大安全隐患。本报告对 `openclaw` 的环境变量保护机制与 `hermes-agent` 的多云隔离沙箱架构（Daytona, Modal）及通用增量文件同步（File Sync）进行深度剖析。

---

## 1. OpenClaw 的宿主环境变量屏障

在 `openclaw` 中，如果 Agent 获取了执行 Shell 脚本的权限，即使在容器中运行，如果泄露了宿主机的 Docker 控制权同样非常危险（例如被注入 `DOCKER_HOST` 控制宿主机宿主进程）。
在 `openclaw/src/infra/host-env-security.ts` 中设计了极严格的安全防线：
*   **物理抹除敏感环境变量**：系统在生成执行环境前，会在 `host-env-security` 中遍历所有的宿主环境变量。
*   **高危黑名单拦截**：`DOCKER_HOST`、`DOCKER_CONTEXT`、`DOCKER_CERT_PATH`、`DOCKER_TLS_VERIFY` 等变量被判定为危险变量，在将环境变量传递给沙箱子进程前会被全部剔除并置为 `undefined`。
*   **重置机制**：禁止 Agent 覆盖这些底层 Docker 变量，从而彻底截断了大模型通过容器套娃或直接控制宿主机守护进程（docker daemon）的可能。

---

## 2. Hermes 进程生命周期与执行流架构 (`base.py`)

Hermes 的执行环境并没有采用极其低效的“全程交互式 Shell”模式，而是设计了**单次派生与快照恢复模式（Spawn-per-call with snapshot restore）**：

### 2.1 状态持久化机制
*   **初次会话（`init_session`）**：在容器启动时，通过 `bash -l` 执行引导脚本，将所有的环境变量（`export -p`）、别名（`alias -p`）、函数定义（`declare -f`）合并保存至沙箱内部的临时脚本文件 `{temp_dir}/hermes-snap-{session_id}.sh` 中。
*   **后续执行（`execute`）**：每一次 Agent 工具执行都会派生一个全新的 `bash -c` 短进程，并通过前置 `source {snapshot_path}` 来恢复历史上下文状态。
*   **CWD 跟踪**：在执行完用户指令后，追加执行 `pwd -P` 并向 `stdout` 输出特殊的 `__HERMES_CWD_{session_id}__` 标记，外部宿主拦截该标记更新 `self.cwd`，并在给大模型返回时将其过滤抹除，从而制造了连续 CD 目录的假象。

### 2.2 排水与轮询性能优化 (`_wait_for_process`)
*   **非阻塞多路复用排水**：为避免子进程将某些 grandchild 进程置于后台导致 stdout 管道无法 EOF 的 hang 死 Bug，采用专门的 `_drain` 线程，在 Linux/macOS 下使用 `select.select` 进行轮询读取，一旦 Bash 进程退出且管道处于空闲，读取三轮后强制关闭管道，不无限期等候后台孙子进程。
*   **自适应轮询（Adaptive Poll）**：在检测 Bash 进程退出时，前几轮休眠 5ms（让 `echo`, `pwd` 等微秒级指令能以 6ms 以内的高响应迅速返回），若命令执行时间较长，自动呈指数级回退（exponential back-off）至 200ms 的 Tick，控制 CPU 开销。
*   **心跳与异常中止保证**：每 10 秒向网关发送 Activity 回调证明 Agent 存活。若主进程接收到打断信号，利用 `try/finally` 块强制对沙箱调用 `_kill_process` 销毁沙箱进程组，坚决不残留僵尸进程。

---

## 3. Daytona 云沙箱与批量上传优化 (`daytona.py`)

Daytona 提供了基于云端的持久隔离开发工作区。其在 Hermes 中的集成实现包含以下关键优化：

*   **持久化容器重连**：当 `persistent_filesystem=True` 时，构造阶段优先在 Daytona 平台中通过 `get(sandbox_name)` 获取已有沙箱并执行 `start()`。在 `cleanup()` 时执行 `stop()` 挂起而不是 `delete` 销毁。
*   **批量接口打包（Multi-part POST）**：为杜绝传输数千小文件时的巨大网络握手开销，利用 Daytona 提供的批量 API `sandbox.fs.upload_files()`，将所有更新文件打在同一个 Multipart HTTP 报文中提交，并合并 `mkdir -p` 目录命令至一条指令，将上传耗时缩短 99%。
*   **Tar 下载归档**：在回收远程 `.hermes/` 变动数据时，在沙箱中通过命令行 `tar cf` 打包成单文件并下载，下载完成后在 host 解压，免去了多文件循环下载的网络往返开销。

---

## 4. Modal 容器与多线程 AsyncIO Worker (`modal.py`)

Modal 是一个以异步 Coroutine 为基础的 Serverless 容器托管平台。其与 Hermes（同步多线程模型）的对接展现了出色的工程设计：

### 4.1 异步到同步的桥接器 (`_AsyncWorker`)
Modal 的 Python SDK 强制要求异步调用。Hermes 创建了 `_AsyncWorker` 守护线程，该线程专享一个独立的 asyncio Event Loop 并保持在后台运行。Hermes 主线程通过 `safe_schedule_threadsafe` 向其派发协程并阻塞等待 `future.result()` 返回，成功实现了同步框架对异步 SDK 的兼容。

### 4.2 文件系统快照机制 (`snapshot_filesystem`)
由于 Modal 容器每次都是全新创建，不具备云盘持久化的概念：
*   **退出时**：Hermes 退出时调用 `sandbox.snapshot_filesystem.aio()`，Modal 会把当前容器内发生了读写的所有变动层融合成一个新的 **Modal Image**，并返回快照 ID（如 `im-xxxx`）。
*   **保存元数据**：Hermes 将该快照 ID 写入本地映射文件。
*   **重启时**：下一次任务启动时读取该快照 ID，基于 `Image.from_id(snapshot_id)` 重建容器，从而间接实现了 Serverless 下容器磁盘的完美持久化。

### 4.3 管道化 Tar 流传输
*   **Tar Stdin 流式上传**：受限于 SDK 执行命令时 ARG_MAX 只有 64KB，无法通过命令参数上传大文件。Modal 选用在 Host 端将同步文件在内存中打包为 `.tar.gz` 压缩流，然后分成 1MB 块流式写入 Sandbox 的 `stdin` 管道。沙箱在容器端配合执行 `base64 -d | tar xzf - -C /` 实时还原。

---

## 5. 增量同步管理器 (`file_sync.py`)

`FileSyncManager` 是连接宿主机与远程沙箱环境（SSH, Daytona, Modal）的底层中枢，提供了强悍的事务级同步：

```
Local Host                                        Remote Sandbox
+-----------------+   mtime + size diff          +------------------+
| Credentials     | ---------------------------> | /root/.hermes/   |
| Skills, Cache   |   (Transactional Commit)     | (Files modified) |
+-----------------+                              +------------------+
        ^                                                 |
        |                                                 | tar archive
        |                SHA-256 Compare                  v
        +------------------------------------------- [ Staging dir ]
                     (Last-Write-Wins / flock)
```

*   **变动差分检测**：通过比对 local 文件的 `(mtime, size)` 元组发现新增/修改项。
*   **事务性状态提交**：所有的同步操作（上传与删除）被包裹在 `try/except` 中，只要有一次失败，内存记录回滚到旧版本，下一次同步将重新全量比对，保障数据一致性。
*   **增量回收（`sync_back`）与安全防御**：
    *   在会话结束时，打包远程 `.hermes/` 目录并下载。
    *   **大文件炸弹防御**：如果下载回来的 `.tar` 归档文件大小超过 2GB 限制，立即拒绝解压抛出警告，防止磁盘被黑客利用沙箱写满。
    *   **SHA-256 差分回写**：只针对与当初上传时 SHA-256 哈希不同的已修改文件进行解压覆盖。
    *   **智能路径推导（`_infer_host_path`）**：对 AI 新建的无映射关系文件，利用已有技能文件夹前缀，自动推导出应回写在本地的哪个文件夹内。
    *   **并发冲突排他锁**：利用本地 `.sync.lock` 进行 `flock` 锁定，解决多会话并发释放时的文件覆盖踩踏。
    *   **信号延迟处理（Deferred SIGINT）**：在 `sync_back` 写入敏感磁盘时期，临时屏蔽 `SIGINT` (Ctrl+C) 指令，待写入完毕后再行处理信号，绝不留下写到一半的损坏文件。
