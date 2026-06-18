# OpenClaw 动态交互画布 (Canvas) 与 A2UI 协议深度剖析

在智能体与人类的协同交互中，仅靠纯文本对话是不够的。OpenClaw 设计了一套**动态交互画布 (Canvas)** 以及配套的 **A2UI (Agent-to-UI) 协议**，使大模型能够直接控制前端渲染，向用户呈现复杂的交互界面、图片、视频、甚至自定义交互组件。

本报告对 OpenClaw 中 Canvas 与 A2UI 机制的底层架构、数据协议、服务器实现和 Native 桥梁设计进行深度剖析。

---

## 1. 什么是 A2UI 协议？

**A2UI (Agent-to-UI)** 是一种声明式的界面协议，设计用于大模型在不需要重新编译代码的情况下，通过生成 JSON/JSONL 文本来动态编排和更新前端 UI 布局。

### 1.1 A2UI 的核心指令
在 `a2ui-jsonl.ts` 中定义了以下 5 个核心指令（Actions）：
*   `createSurface`: 创建一个独立的画布展示层。
*   `surfaceUpdate`: 更新特定 Canvas 视图的组件树结构。
*   `dataModelUpdate`: 局部更新绑定在组件上的数据模型。
*   `deleteSurface`: 销毁特定 Canvas 视图。
*   `beginRendering`: 通知前端开始渲染指定的 `surface`。

### 1.2 A2UI JSONL 消息格式
大模型通过 `a2ui_push` 以 JSONL (JSON Lines) 格式依次输出界面层次结构。示例如下：
```json
{"surfaceUpdate": {"surfaceId": "main", "components": [{"id": "root", "component": {"Column": {"children": {"explicitList": ["text_1", "btn_1"]}}}}, {"id": "text_1", "component": {"Text": {"literalString": "计算已就绪，是否运行？", "usageHint": "body"}}}, {"id": "btn_1", "component": {"Button": {"label": "开始执行", "action": "run_task"}}}]}}
{"beginRendering": {"surfaceId": "main", "root": "root"}}
```
前端通过解析这段 JSONL，将其转换为组件树树状渲染结构。

---

## 2. Canvas 控制工具设计 (`tool.ts`)

在大模型端，Canvas 作为一个通用的 Agent Tool 提供给 LLM。
在 `extensions/canvas/src/tool.ts` 中，`createCanvasTool` 定义了如下功能：

*   **`present` / `hide`**：控制画布的打开与隐藏，可指定坐标 `x, y` 和大小 `width, height`。
*   **`navigate`**：控制画布中的 WebView 导航到指定的外部 URL（如 HTML 文件、PDF 等）。
*   **`eval`**：允许大模型在前端页面中直接执行任意 JavaScript 脚本并捕获执行结果返回。
*   **`snapshot`**：由于大模型无法直接“看”到前端渲染结果，它可以通过 `snapshot` 触发底层 WebView 的截图功能，将当前画布内容以 Base64 图片返回给大模型进行视觉确认（Multimodal Loop）。
*   **`a2ui_push` / `a2ui_reset`**：推送 A2UI 组件树描述或重置画布。

---

## 3. Canvas 宿主服务器架构 (`server.ts` & `a2ui.ts`)

为了支持前端 UI 组件与静态文件的加载，OpenClaw 随核心进程起了一个**本地 Web 服务器**（基于 `node:http` 和 `ws`）。

```
                                  ┌────────────────────┐
                                  │   Chokidar Watch   │ (监听本地目录变更)
                                  └─────────┬──────────┘
                                            │ (变更事件)
                                            ▼
[Browser / WebView] <--- WebSocket ---> [Canvas Host] <--- File System
                         (Live Reload)
```

### 3.1 Chokidar 目录监听与 Live Reload
*   **静态资源服务**：`server.ts` 会将工作区内的临时目录（如 `/canvas` 或 `/a2ui`）暴露为静态服务。
*   **热监听**：使用 `chokidar` 库实时监听此目录下的 `.html`、`.js` 及图片文件变更。
*   **实时刷新**：通过本地 WebSocket 连接（路由为 `/__openclaw__/ws`），一旦检测到本地文件变动，便向前端发送 `"reload"` 消息，前端页面（注入了 Reload JS）自动执行 `location.reload()` 刷新界面。

### 3.2 动态 A2UI 资源分发
在 `a2ui.ts` 中，路由 `/__openclaw__/a2ui` 用来专门托管 A2UI 前端框架自身的静态文件（`index.html` 和 `a2ui.bundle.js`），支持将大模型写入或生成的静态网页在此宿主环境中展示。

---

## 4. 前端渲染与 Native 桥梁

A2UI 不仅能显示界面，还能将用户的操作回传给大模型。其底层核心是**双向通信 Bridge**。

### 4.1 前端组件挂载
在 `bootstrap.js` 中，前端基于 **Lit**（轻量级 Web Components 框架）实现了一个自定义元素 `<openclaw-a2ui-host>`。它主要工作是：
*   **处理 CSS 样式**：定义了 `openclawTheme` 主题包，包括 `Card`、`Button`、`Text` 等组件的圆角、阴影、间距。
*   **处理事件分发**：利用 `@a2ui/lit` 中自带的 `MessageProcessor` 逐条消费 JSONL 消息并更新视图。

### 4.2 双向通信 Bridge 的实现
当用户点击了 A2UI 中的按钮（如 `action: "run_task"`），会触发 `a2uiaction` 事件。其底层通过 JS Bridge 将事件反写给后端：

```javascript
// a2ui-shared.ts 中定义的桥接代码
function postToNode(payload) {
  try {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    // 适配 iOS WKWebView
    const iosHandler = globalThis.webkit?.messageHandlers?.["openclawCanvasA2UIAction"];
    if (iosHandler) {
      iosHandler.postMessage(raw);
      return true;
    }
    // 适配 Android WebView
    const androidHandler = globalThis["openclawCanvasA2UIAction"];
    if (androidHandler) {
      androidHandler.postMessage(raw);
      return true;
    }
  } catch {}
  return false;
}
```

*   **iOS**: 利用 WebKit 的 `messageHandlers` 注入。
*   **Android**: 利用 `JavascriptInterface` 注入。
*   **Electron / Web 浏览器**：通过在本地建立的 WebSocket / Server-Sent Events (SSE) 链路发送 `userAction` 回调到 Agent 后端，以触发后续的 Agent 思考和工具执行循环。
