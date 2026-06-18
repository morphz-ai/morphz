# Hermes Agent 通道网关 Python 重写与迁移设计

在 Nous Research 开发 Hermes Agent 时，为了实现极致的系统整合、简化依赖管理，并与 Python 强大的多进程及 AI 生态完美融合，设计团队用 **Python (基于 asyncio 及 python-telegram-bot 等协程库)** 彻底重写了 openclaw 的网关系统。

本报告聚焦于这一架构迁移的设计细节、Python 协程实现，以及在容错和体验上的深度优化。

---

## 1. 迁移设计：从 TS 动态插件到 Python 协程基类

### 1.1 为什么要用 Python 重写 Gateway？
1.  **单进程与协程统一调度**：在 openclaw 中，如果需要运行沙箱 Docker 或者本地 Python 自动化脚本，Node.js 必须开辟子进程（child_process），这导致跨进程的 IPC 通信复杂。而 Hermes 完全使用 Python，网关与智能体核心都在同一个 Python 解释器下运行，可以通过协程通道（Queue / Stream）非常轻量地进行数据流式传输，消除了跨语言跨进程的开销。
2.  **异步子进程支持**：通过 `asyncio.create_subprocess_exec`，网关在处理阻塞任务（例如运行本地编译、代码测试）时，完全不需要担心事件循环被卡住。
3.  **平滑迁移 (Claw Migrate)**：为了吸引 openclaw 社区用户，Hermes 提供了一套完善的 `hermes claw migrate` 迁移逻辑。它读取 `~/.openclaw` 下的 `SOUL.md` (人格)、`auth-profiles.json` (凭据) 和 SQLite 数据库，使用 Python 脚本将其字段映射转化到 `~/.hermes/config.yaml` 中，甚至可以自动将原先的技能（Skills）打包迁移到新目录下。

### 1.2 BasePlatformAdapter 基类生命周期
在 `gateway/platforms/base.py` 中，定义了所有平台适配器的抽象基类。所有适配器都需要实现以下四个核心异步生命周期：

*   `async def start(self)`：开启网络长连接（如长轮询监听更新，或建立 WebSocket 长连接）。
*   `async def stop(self)`：安全下线，排空当前正在出站的数据队列。
*   `async def send(self, target, message, ...)`：向指定的用户/群组/话题发送标准化的消息。
*   `async def send_or_update_status(self, ...)`：向平台下发或编辑状态气泡 Emoji。

---

## 2. 核心优化设计走读（以 Telegram.py 为例）

在使用 Python 重写 Telegram 适配器时，Hermes 设计团队引入了数项极具含金量的性能与容错优化：

### 2.1 消息节流合并 (Text & Media Batching)
当用户在手机上连发三条短消息，或者一次性上传 4 张照片（Telegram 会将其拆分成 4 个 Update 发送）时，如果网关立即响应，会导致 Agent 被自我打断，触发 4 个并行的 Agent 推理，极度浪费算力。

Hermes 采用了**“攒批延时合并机制”**：
```python
# 核心缓存字典
self._pending_photo_batches: Dict[str, MessageEvent] = {}
self._pending_text_batches: Dict[str, MessageEvent] = {}
```
当接收到一条照片或文字 Update 时：
1.  网关不立即派发，而是将它塞入 `_pending_text_batches`，并启动一个定时的 `asyncio.Task`。
2.  如果在这段延时内（例如短文本延时 180ms，长文本 300ms，照片 800ms）有新的消息或照片进来，网关会将它们追加合并到同一个事件中，并刷新定时器。
3.  当定时器触发，攒批完毕，生成一个合并后的标准事件投递给 Agent。这保证了多图发送和连发文本在 Agent 看来是一个完整的 turn，彻底避免了并发自我打断问题。

### 2.2 自动兼容的 Markdown 表格重构译码
由于 Telegram 官方不支持 GFM 管道表格语法（Pipe Tables），纯文本表格在手机端由于字体宽度不一，排版会完全坍塌。

Hermes 实现了 `_wrap_markdown_tables` 解析器：
*   **算法思路**：
    *   解析未处于 ` ``` ` 块中的 markdown 文本。
    *   通过正则 `_TABLE_SEPARATOR_RE` 匹配表头分割线（如 `|---|---|`）。
    *   如果匹配成功，启动 GFM 管道解析，将表格的每一行单元格拆分出来。
    *   **排版重构**：将每一行数据，翻译转换成 `**[行标题/第一列名称]**`，并在下方以无序列表（Bullet Items，形如 `• [表头1]: [值1]`）的形式流式排版。
*   **体验升级**：这成功解决了移动端屏幕狭窄导致表格被严重截断的问题，极大地提高了数据可读性。

### 2.3Stale 锚点重试机制 (Fallback Retry)
在 IM 对话中，如果 Agent 试图回复某一条已被用户删除的旧消息（Stale Message Id），或者试图在已被管理员关闭的话题（Topic Closed）下发言时，Telegram Bot API 会直接报 `BadRequest` 错误，导致消息发送失败。

Hermes 在 `_send_with_dm_topic_reply_anchor_retry` 中实现了一套极其鲁棒的退回重试逻辑：
```python
async def _send_with_dm_topic_reply_anchor_retry(self, send_fn, send_kwargs, metadata, ...):
    try:
        return await send_fn(**send_kwargs) # 首次尝试发送（带 Reply 锚点和 Topic 路由）
    except Exception as send_err:
        # 捕获并检查是否为 Stale 锚点导致的 BadRequest 报错
        if not self._should_retry_without_dm_topic_reply_anchor(send_err, metadata, ...):
            raise
        # 自动降级：去掉 reply_to_message_id，去掉 message_thread_id
        retry_kwargs = dict(send_kwargs)
        retry_kwargs["reply_to_message_id"] = None
        retry_kwargs.pop("message_thread_id", None)
        # 重新进行无路由的降级发送，确保用户一定能收到回复
        return await send_fn(**retry_kwargs)
```
这套降级重试机制极大增强了网关对外部环境变动的适应能力，避免因用户撤回消息等偶发事件而使 AI 会话中断。
