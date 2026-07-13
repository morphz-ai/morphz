# Morphz Dashboard

Dashboard 是 Context-Owned Session Service v1 的浏览器客户端，同时保留 Agent-Owned Context 和实验性 Recall 图谱观察能力。

当前支持：

- 创建和选择 Cognitive Context，并在其中创建、选择、改名、归档和恢复 Session；
- 创建全新 Agent（空白 Root Context + 初始 Session）；
- 在当前 Context 创建共享 Session，或继承当前 Mind 创建不含原 Session/Inbox 的独立 Session；
- 查看当前 Session 的 Delegation 总数与运行状态；
- 向指定 Session 发送消息并显示进度与最终回复；
- 观察同一 Context 多 Session 合并求值状态（`BATCH:N`）及各自路由结果；
- 取消当前执行；
- 查看 Mind Frames、Inbox、Pressure、Attempt 预算和模型消息；
- 查看过滤后的 Session Event 流与全局 Recall 图谱。

启动：

```bash
npm ci
npm run dev
```

默认连接 `http://127.0.0.1:8080` 与 `ws://127.0.0.1:8080/ws`。远程 Core 可设置：

```bash
VITE_MORPHZ_HTTP_URL=https://example.test \
VITE_MORPHZ_WS_URL=wss://example.test/ws \
VITE_MORPHZ_TOKEN=replace-me \
npm run dev
```
