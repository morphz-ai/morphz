const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  session,
  ipcMain,
  systemPreferences,
  shell,
} = require("electron");
const { join, isAbsolute } = require("node:path");
const {
  trustedAppURL,
  webPreferences,
  centerFromArgs,
} = require("./security.cjs");
const { DesktopBrowser } = require("./browser.cjs");
const { MicrophoneGate } = require("./microphone.cjs");
const { DesktopCapture } = require("./capture.cjs");
const { rendererURL, loadDevelopmentWindow } = require("./development.cjs");
app.setName("Morphz");
app.enableSandbox();
const testProfile = process.env.MORPHZWORK_TEST_PROFILE;
if (testProfile && !isAbsolute(testProfile))
  throw new Error("Test profile must be absolute");
app.setPath(
  "userData",
  testProfile || join(app.getPath("appData"), "MorphzWork", "desktop"),
);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window;
  let sources;
  let browser;
  function requireMain(event) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedAppURL(event.senderFrame.url, uiURL)
    )
      throw new Error("请求不来自受信任的应用主窗口。");
  }
  const url = centerFromArgs(process.argv);
  const hot = process.argv.includes("--hot");
  const uiURL = rendererURL(url, hot, app.isPackaged);
  const microphone = new MicrophoneGate(uiURL);
  const capture = new DesktopCapture();
  let microphoneRequest = 0;
  async function createWindow() {
    window = new BrowserWindow({
      title: "Morphz",
      width: 1380,
      height: 920,
      minWidth: 760,
      minHeight: 540,
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset",
            trafficLightPosition: { x: 20, y: 20 },
          }
        : {}),
      backgroundColor: "#11141c",
      show: false,
      webPreferences: {
        ...webPreferences,
        preload: join(__dirname, "preload.cjs"),
        partition: "persist:morphzwork-app",
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    browser = new DesktopBrowser(window, url, (input, init) =>
      window.webContents.session.fetch(input, {
        ...init,
        credentials: "include",
      }),
    );
    // Reloading/crashing the trusted renderer must end its native capabilities.
    // React cleanup cannot run reliably when the renderer is replaced.
    const releaseRenderer = () => {
      microphoneRequest++;
      microphone.cancel();
      capture.cancel();
      browser?.close();
    };
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isInPlace) releaseRenderer();
    });
    window.webContents.on("render-process-gone", releaseRenderer);
    window.on("close", () => {
      microphoneRequest++;
      microphone.cancel();
      capture.cancel();
      browser?.stop();
    });
    window.on("closed", () => {
      browser = null;
      window = null;
    });
    window.webContents.on("will-navigate", (event, destination) => {
      if (!trustedAppURL(destination, uiURL)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, destination) => {
      if (!trustedAppURL(destination, uiURL)) event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    const appSession = session.fromPartition("persist:morphzwork-app");
    appSession.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(
          microphone.request(
            contents === window?.webContents && window?.isFocused(),
            permission,
            details,
          ),
        ),
    );
    // Always go through the one-use request gate, including after a previous recording.
    appSession.setPermissionCheckHandler(() => false);
    appSession.on("will-download", (event) => event.preventDefault());
    try {
      if (hot) await loadDevelopmentWindow(window, url, uiURL);
      else await window.loadURL(url);
      window.show();
    } catch {
      await dialog.showMessageBox(window, {
        type: "info",
        title: "尚未连接本机中心",
        message: "请先启动 Morphz 本机中心。",
        detail:
          "开发模式运行 npm run dev；构建模式先运行 npm run build，再运行 npm start。桌面端与 Web 使用同一份中心数据。",
      });
      window.show();
    }
  }
  app.whenReady().then(async () => {
    ipcMain.handle("capture:select", async (event) => {
      requireMain(event);
      if (!window.isFocused()) throw new Error("请先回到 Morphz 窗口。");
      const result = await capture.select();
      requireMain(event);
      return result;
    });
    ipcMain.handle("capture:cancel", (event) => {
      requireMain(event);
      capture.cancel();
    });
    ipcMain.handle("voice:microphone", async (event) => {
      requireMain(event);
      if (!window.isFocused()) throw new Error("请先回到 Morphz 窗口。");
      const generation = ++microphoneRequest;
      const allowed =
        process.platform !== "darwin" ||
        (await systemPreferences.askForMediaAccess("microphone"));
      requireMain(event);
      if (generation !== microphoneRequest || !window.isFocused()) return false;
      if (allowed) microphone.arm();
      return allowed;
    });
    ipcMain.handle("voice:cancel-microphone", (event) => {
      requireMain(event);
      microphoneRequest++;
      microphone.cancel();
    });
    for (const name of [
      // Browser operations stay object-scoped; external links have a separate,
      // scheme-limited handler and never expose an arbitrary shell command.
      "open",
      "navigate",
      "control",
      "layout",
      "close",
      "state",
    ]) {
      ipcMain.handle("browser:" + name, (event, ...args) => {
        requireMain(event);
        if (!browser) throw new Error("浏览器尚未准备好。");
        return browser[name](...args);
      });
    }
    ipcMain.handle("open-external", async (event, value) => {
      requireMain(event);
      if (typeof value !== "string" || value.length > 8192)
        throw new Error("链接地址无效。");
      const parsed = new URL(value);
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error("只能打开不含登录凭据的 HTTP 或 HTTPS 链接。");
      await shell.openExternal(parsed.href);
    });
    const { DesktopSources } =
      await import("../../dist/service/apps/service/src/desktop-sources.js");
    sources = new DesktopSources(
      join(app.getPath("userData"), "source-grants.json"),
      url,
      (input, init) =>
        session
          .fromPartition("persist:morphzwork-app")
          .fetch(input, { ...init, credentials: "include" }),
    );
    ipcMain.handle("sources:list", (event) => {
      requireMain(event);
      return sources.list();
    });
    ipcMain.handle("sources:choose", async (event, projectId, kind) => {
      requireMain(event);
      if (
        typeof projectId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(projectId) ||
        !["file", "directory"].includes(kind)
      )
        throw new Error("来源选择参数无效。");
      const result = await dialog.showOpenDialog(window, {
        title: "接入外部资料（只读）",
        properties: [kind === "file" ? "openFile" : "openDirectory"],
        ...(kind === "file"
          ? {
              filters: [
                { name: "文本资料", extensions: ["md", "markdown", "txt"] },
              ],
            }
          : {}),
      });
      requireMain(event);
      if (result.canceled || !result.filePaths[0]) return sources.list();
      return sources.addSelection(result.filePaths[0], projectId);
    });
    ipcMain.handle("sources:control", async (event, id, action) => {
      requireMain(event);
      if (
        typeof id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(id) ||
        !["resume", "pause", "remove", "refresh"].includes(action)
      )
        throw new Error("来源操作参数无效。");
      return sources.control(id, action);
    });
    sources.start();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
    return createWindow();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) void createWindow();
    else {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let closingSources = false;
  app.on("before-quit", (event) => {
    if (sources && !closingSources) {
      event.preventDefault();
      closingSources = true;
      void sources.stop().finally(() => app.quit());
    }
  });
}
