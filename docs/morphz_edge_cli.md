# morphz-edge

`morphz-edge` 是 Morphz 的独立 Execution Target 客户端。它适合安装在用户电脑或执行主机上，主动连接 Morphz Server，接收经过授权的文件、Shell 和其他物理工具任务。

完整的 `morphz` 二进制仍保留原有的 `morphz edge ...` 命令。两条入口共用同一套 Edge Node 实现和协议，不会形成两套行为：

```text
morphz-edge pair ...          = morphz edge pair ...
morphz-edge run ...           = morphz edge run ...
morphz-edge status            = morphz edge status
morphz-edge rotate-key        = morphz edge rotate-key
morphz-edge local-leases      = morphz edge local-leases
morphz-edge revoke-local-lease = morphz edge revoke-local-lease
```

## 安装与构建

从源码构建独立客户端：

```bash
cargo build --release -p morphz --bin morphz-edge
```

产物位于 `target/release/morphz-edge`。发布系统可以只分发这个文件；用户不需要安装完整的 Morphz Server CLI。

## 配对与运行

管理员先在 Morphz Server 上生成一次性配对码：

```bash
morphz edge pairing-code --name "My laptop"
```

用户在执行主机上配对并启动：

```bash
morphz-edge pair \
  --server-url https://morphz.example.com \
  --pairing-code PAIRING_CODE \
  --node-name "My laptop"

morphz-edge run --workspace /path/to/workspace
```

`morphz-edge` 使用出站连接，不要求用户开放本地监听端口。默认设备凭证沿用 Morphz Edge 的既有路径；可用 `--credential-file` 显式指定。执行状态默认隔离在 `~/.morphz/edge/`，也可通过 `MORPHZ_EDGE_STATE_DIR` 覆盖。

## 能力边界

独立客户端会读取本机 Morphz 配置中的执行策略，包括 Workspace、Sandbox、后台任务、Edge 并发和 Managed SSH 设置，但不会继承 Provider、OAuth 账号或模型路由。它不进行模型求值，也不启动 Dashboard、Session、Context 或普通 Runtime 调度器。

以下服务端管理命令仍由完整 `morphz` 提供：

```text
morphz edge pairing-code
morphz edge nodes
morphz edge revoke
```

这种划分让 `morphz-edge` 保持清晰的用户侧执行节点定位，同时保留 `morphz edge` 的兼容性和完整管理能力。
