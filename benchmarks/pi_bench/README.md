# Morphz × π-Bench adapter

本目录提供将 Morphz 接入官方 [π-Bench](https://github.com/Simplified-Reasoning/Pi-Bench) 的第一层适配。它不把 Morphz 伪装成裸模型，而是替换官方默认的 NanoBot Gateway，保留官方 User Agent、Test Channel、持久工作区与 PROC/COMP 评分器。

## 语义映射

| π-Bench | Morphz |
| --- | --- |
| `sender_id` / persona | Principal |
| 一个 persona 的整段 episode | 一个 Agent 下、该 persona 专属的共享 Context/Mind |
| `chat_id` / task | 一个 Session |
| 同一 task 的多轮消息 | 同一 Session 的多个 Dialogue Turn |
| 持久 artifact workspace | `MORPHZ_WORKSPACE_ROOT` |

这个映射使每个 task 的对话记录结构隔离，同一个 persona 在跨 task 时继续使用同一 Mind，而不同 persona 的 Context 相互隔离。这样既能验证跨 Session 认知迁移，也不会让官方的不同 persona episode 互相污染。

## 桥接协议

`morphz_bridge.py` 只使用 Python 标准库：

1. 从官方 Test Server `GET /poll` 取得消息；
2. 以 `X-Morphz-Principal` 将 persona 绑定到 Morphz 权威 Principal；
3. 按 `chat_id` 幂等创建挂载于共享 Context 的 Session；
4. 通过 Morphz HTTP API 发送消息并以 Event sequence 等待终态回复；
5. 把回复送回官方 `POST /send`；
6. 从不可变 persisted Event 生成π-Bench 评分器需要的 `turn_*.json` 轨迹。

`/new` 只是官方 Channel 的 task 边界握手：桥接器创建/确认对应 Session 并返回 `New session started`，不会清空共享 Mind。

## 运行前提

- 在π-Bench 容器中放入 Linux Morphz 二进制与一份由 `morphz.pibench.toml.example` 生成的可信配置；
- 启动 `morphz --config-file ... serve --bind=127.0.0.1:8081`；
- 用相同 `MORPHZ_API_TOKEN` 启动 `morphz_bridge.py`；
- 将官方 `entrypoint.sh` 中的 `nanobot gateway` 替换为上述两个常驻进程；
- 保留官方 test server、User Agent、AppWorld 服务和 run/eval 命令不变。

## 尚未伪装成“已完成”的边界

π-Bench 任务依赖 AppWorld MCP 工具。当前桥接已完成多 Session、身份、回复和评分轨迹的协议层，但 Morphz 还需要一个受管的 MCP 工具后端，才能在不依赖模型手写 `curl` 的情况下完整执行 AppWorld 操作。在该后端接入前，不应宣称 Morphz 已获得可与官方榜单直接比较的 PROC/COMP 分数。

## 验证层级

1. **Protocol smoke**：使用伪 Test Server 验证 `/new`、多 chat 路由、稳定 Session ID 和错误收口；
2. **Trace compatibility**：使用官方 `collect_model_task_turn_sessions` 读取桥接轨迹；
3. **Single task**：接入 AppWorld 后运行一个 task；
4. **Single persona episode**：运行一个 persona 的完整任务序列；
5. **Official three-run protocol**：全量五 persona，每组三次并报告方差。
