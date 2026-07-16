# Morphz Dashboard

Dashboard 是 Morphz Runtime 的浏览器界面。它围绕 Morphz 自身的三层结构组织，而不是复制传统聊天产品：

- `Agent`：拥有一个或多个 Cognitive Context；
- `Context`：承载共享 Mind、Frame、关系与 Session working set；
- `Session`：负责输入输出路由和局部进展。

主界面有三个共享同一视口的视图：

- **对话**：只保留用户、Agent 回复和少量可见进度，不让工具事件冲刷消息流；
- **任务**：展示 Runtime 可验证的 Objective、Evaluation、后台进程和 Delegation；
- **认知**：展示 Mind Frame、关系、来源、版本、生命周期与 Context pressure。

`Ctrl+W` 切换任务视图，`Ctrl+M` 切换认知视图，`Esc` 返回对话。输入框始终可用，因此 Agent 工作时仍可继续对话。

顶部主题菜单支持鸢尾紫、电光青、暖珊瑚和纯单色四种强调色。选择保存在浏览器本地，不会写入 Runtime 或认知 Context。

## 开发

```bash
npm ci
npm run dev
```

开发服务器把 `/api`、`/ws` 和 `/health` 代理到 `127.0.0.1:8080`。也可以通过 `VITE_MORPHZ_HTTP_URL`、`VITE_MORPHZ_WS_URL` 和 `VITE_MORPHZ_TOKEN` 连接其他 Runtime。

## 单二进制交付

```bash
npm run build
cargo build --release -p morphz
```

Vite 使用确定的 `assets/app.js` 和 `assets/app.css` 文件名生成 `dashboard/dist`。Rust 通过 `include_bytes!` 把已经验证过的构建产物编译进 `morphz`，由同一个 Axum 服务提供页面和 API。

因此最终运行只需要一个 `morphz` 二进制，不需要 Node、npm、Vite 或外部静态资源目录。`dashboard/dist` 会进入版本控制，使纯 Rust release 构建也不依赖前端工具链。

`morphz dashboard` 会为当前进程生成临时随机 Token、启动服务并打开默认浏览器。Token 放在 URL fragment 中，不会随 Dashboard 首页的 HTTP 请求发送到服务器。
