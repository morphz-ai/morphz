require("./stdio.cjs").protectStandardStreams();
const {
  normalizeApplicationEnvironment,
  desktopProfile,
  persistentPartition,
} = require("./configuration.cjs");
normalizeApplicationEnvironment();
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  session,
  ipcMain,
  systemPreferences,
  nativeTheme,
  screen,
  shell,
  protocol,
} = require("electron");
const { join, isAbsolute } = require("node:path");
const { writeFileSync } = require("node:fs");
const {
  trustedMainURL,
  webPreferences,
  connectionFromArgs,
} = require("./security.cjs");
const { DesktopBrowser } = require("./browser.cjs");
const { MicrophoneGate } = require("./microphone.cjs");
const { DesktopCapture } = require("./capture.cjs");
const { RegionPicker } = require("./region-picker.cjs");
const {
  DesktopAppearance,
  windowAppearanceOptions,
} = require("./appearance.cjs");
const { rendererURL } = require("./development.cjs");
const { registerApplicationBridge } = require("./application-bridge.cjs");
const { createScriptExportSaver } = require("./script-export.cjs");
const {
  restorePath,
  emptyPage,
  legacyOrigins,
  collectLegacyPreferences,
  restorePreferences,
} = require("./preferences.cjs");
const {
  failurePath,
  failurePage,
  errorSummary,
} = require("./startup-page.cjs");
const developmentBundle =
  app.isPackaged &&
  require(join(app.getAppPath(), "package.json")).morphzDevelopmentBundle ===
    true;
app.setName("Morphz");
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "morphz",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
app.setPath("userData", desktopProfile(app.getPath("appData")));
const appPartition = persistentPartition(app.getPath("userData"), "app");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window;
  let windowStartup;
  let windowReady = false;
  let startupFailure = "";
  let browser;
  let appearance;
  let host;
  let application;
  let connection;
  let preferences;
  let scriptExports;
  app.on("web-contents-created", (_event, contents) =>
    browser?.created(contents),
  );
  function requireMain(event) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !trustedMainURL(event.senderFrame.url, uiURL)
    )
      throw new Error("请求不来自受信任的应用主窗口。");
  }
  const hot = process.argv.includes("--hot");
  let uiURL = "morphz://app";
  let microphone;
  const regionPicker = new RegionPicker({ BrowserWindow, screen, ipcMain });
  const capture = new DesktopCapture({
    chooseRegion: (signal) => regionPicker.select(signal),
    getWindow: () => window,
  });
  let microphoneRequest = 0;
  function createWindow() {
    if (window && !window.isDestroyed()) return windowStartup;
    // Set translucency before Electron creates the native/compositor surfaces.
    // Converting an opaque window later can leave stale sidebar tiles behind.
    const appearanceOptions = windowAppearanceOptions(nativeTheme);
    window = new BrowserWindow({
      title: "Morphz",
      width: 1380,
      height: 920,
      minWidth: 760,
      minHeight: 540,
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset",
            // Native button origins use device-independent pixels, not CSS
            // zoom. Fit the cluster inside the compact sidebar with breathing
            // room before its divider and resize hit area.
            trafficLightPosition: { x: 8, y: 16 },
          }
        : {}),
      ...appearanceOptions,
      show: false,
      webPreferences: {
        ...webPreferences,
        // Only DesktopBrowser's pre-authorized isolated guest is attachable.
        webviewTag: true,
        preload: join(__dirname, "preload.cjs"),
        partition: appPartition,
        additionalArguments: ["--morphz-application-bridge"],
      },
    });
    const createdWindow = window;
    const isCurrent = () =>
      window === createdWindow && !createdWindow.isDestroyed();
    windowReady = false;
    appearance = new DesktopAppearance(
      window,
      nativeTheme,
      process.platform,
      appearanceOptions,
    );
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    browser = new DesktopBrowser(
      createdWindow,
      uiURL,
      (input, init) =>
        createdWindow.webContents.session.fetch(input, {
          ...init,
          credentials: "include",
        }),
      application,
    );
    const createdBrowser = browser;
    // Reloading/crashing the trusted renderer must end its native capabilities.
    // React cleanup cannot run reliably when the renderer is replaced.
    const releaseRenderer = () => {
      if (!isCurrent()) return;
      microphoneRequest++;
      microphone.cancel();
      capture.cancel();
      scriptExports?.invalidate();
      application.invalidate();
      // Revoke browser access on the fresh connection; invalidating afterward
      // would abort the asynchronous exchange that clears the broker grant.
      createdBrowser.close();
    };
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isInPlace) releaseRenderer();
    });
    window.webContents.on("render-process-gone", releaseRenderer);
    window.on("close", () => {
      if (!isCurrent()) return;
      microphoneRequest++;
      microphone.cancel();
      capture.cancel();
      scriptExports?.invalidate();
      application.invalidate();
      createdBrowser.stop();
    });
    window.on("closed", () => {
      if (window !== createdWindow) return;
      browser = null;
      appearance = null;
      window = null;
      windowReady = false;
      windowStartup = undefined;
    });
    window.webContents.on("will-navigate", (event, destination) => {
      if (!trustedMainURL(destination, uiURL)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, destination) => {
      if (!trustedMainURL(destination, uiURL)) event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event, preferences, params) =>
      createdBrowser.willAttach(event, preferences, params),
    );
    window.webContents.on("did-attach-webview", (_event, contents) =>
      createdBrowser.didAttach(contents),
    );
    const appSession = session.fromPartition(appPartition);
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
    windowStartup = (async () => {
      let phase = "preferences";
      try {
        if (!hot && preferences) {
          const restored = await restorePreferences(createdWindow, preferences);
          if (!isCurrent()) return;
          writeFileSync(
            join(app.getPath("userData"), "embedded-preferences-recovery.json"),
            JSON.stringify({
              ...restored,
              scope: preferences.prefix,
              restoredAt: new Date().toISOString(),
            }),
            { mode: 0o600 },
          );
        }
        phase = "main-page";
        await createdWindow.loadURL(uiURL + "/");
        if (!isCurrent()) return;
        if (!trustedMainURL(createdWindow.webContents.getURL(), uiURL))
          throw new Error("正式界面未进入受信任的主页面。");
        // The migration page is implementation detail, never a Back destination.
        // This affects only this main frame, not browser guests or stored data.
        createdWindow.webContents.navigationHistory.clear();
        windowReady = true;
        createdWindow.show();
      } catch (error) {
        if (!isCurrent()) return;
        startupFailure = errorSummary(error);
        try {
          writeFileSync(
            join(app.getPath("userData"), "desktop-startup-failure.json"),
            JSON.stringify({
              phase,
              message: startupFailure,
              at: new Date().toISOString(),
            }),
            { mode: 0o600 },
          );
        } catch {}
        try {
          await createdWindow.loadURL("morphz://app" + failurePath);
          if (!isCurrent()) return;
          createdWindow.webContents.navigationHistory.clear();
          windowReady = true;
          createdWindow.show();
        } catch (failureError) {
          if (!isCurrent()) return;
          await dialog.showMessageBox(createdWindow, {
            type: "error",
            title: "Morphz 界面未能加载",
            message:
              "界面恢复页也未能载入。请重新打开 Morphz。数据和设置未重置。",
            detail: errorSummary(failureError),
          });
          if (isCurrent()) createdWindow.close();
        }
      }
    })();
    return windowStartup;
  }
  app
    .whenReady()
    .then(async () => {
      const { dataDirectory } =
        await import("../../dist/service/packages/application/src/paths.js");
      const { openEmbeddedApplication, embeddedResources } =
        await import("../../dist/service/apps/desktop/application-host.js");
      connection = connectionFromArgs(process.argv, dataDirectory);
      if (hot) {
        if (connection.mode !== "remote")
          throw new Error(
            "显式热更新需要 --center 开发服务；本机内嵌模式使用打包界面。",
          );
        uiURL = rendererURL(
          connection.url,
          true,
          app.isPackaged && !developmentBundle,
        );
      }
      microphone = new MicrophoneGate(uiURL);
      const appSession = session.fromPartition(appPartition);
      if (connection.mode === "local") {
        const { createReadingOcrEngine } = require("./reader-ocr.cjs");
        const ocrResources = embeddedResources(
          join(__dirname, "../../dist/web"),
          {
            resource() {
              throw new Error("OCR cannot read application resources");
            },
          },
        );
        host = await openEmbeddedApplication(
          connection.directory,
          app.getPath("userData"),
          async (name) => {
            for (const origin of legacyOrigins(process.argv)) {
              const cookies = await appSession.cookies.get({
                url: origin,
                name,
              });
              if (cookies.length === 1) return `${name}=${cookies[0].value}`;
            }
          },
          createReadingOcrEngine({
            BrowserWindow,
            session,
            ipcMain,
            resources: ocrResources,
          }),
        );
        application = host.connection;
      } else {
        const { RemoteApplicationConnection } =
          await import("../../dist/service/apps/desktop/remote-host.js");
        application = new RemoteApplicationConnection(
          connection.url,
          (input, init) =>
            appSession.fetch(input, { ...init, credentials: "include" }),
        );
      }
      const resources = embeddedResources(
        join(__dirname, "../../dist/web"),
        application,
      );
      appSession.protocol.handle("morphz", (request) => {
        const url = new URL(request.url);
        if (
          url.host === "app" &&
          url.pathname === failurePath &&
          request.method === "GET"
        )
          return failurePage(startupFailure, uiURL + "/");
        return url.host === "app" &&
          url.pathname === restorePath &&
          request.method === "GET"
          ? emptyPage()
          : resources(request);
      });
      if (!hot && connection.mode === "local") {
        try {
          const identity = await application.call("platform.bootstrap");
          preferences = await collectLegacyPreferences(
            BrowserWindow,
            appSession,
            legacyOrigins(process.argv),
            identity,
          );
        } catch (error) {
          if (error?.status !== 401) throw error;
          // A logged-out team center must not restore another identity's storage.
        }
      }
      registerApplicationBridge(ipcMain, application, requireMain, () => {
        // A confirmed login/logout changes the owner of persistent guest
        // storage. Disconnecting a stream alone must not discard a form, but
        // an identity transition must never retain another Principal's page.
        browser?.close();
        host?.persistAuthentication();
      });
      const { buildScriptDocx } =
        await import("../../dist/service/packages/core/src/script-studio-docx.js");
      scriptExports = createScriptExportSaver({
        connection: application,
        requireMain,
        getWindow: () => window,
        dialog,
        buildDocx: buildScriptDocx,
      });
      ipcMain.handle("script-exports:save", (event, request) =>
        scriptExports.save(event, request),
      );
      if (process.platform === "darwin") {
        app.setActivationPolicy("regular");
        // Use the bundle icon. A runtime NSImage override bypasses the system's
        // app-icon masking/normalization and displays our square avatar raw.
      }
      ipcMain.handle("appearance:mode", (event, mode) => {
        requireMain(event);
        return appearance.setMode(mode);
      });
      ipcMain.handle("capture:select", async (event, options) => {
        requireMain(event);
        if (!window.isFocused()) throw new Error("请先回到 Morphz 窗口。");
        const result = await capture.select(options);
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
        if (generation !== microphoneRequest || !window.isFocused())
          return false;
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
        "visibility",
        "close",
        "state",
        "reveal",
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
      ipcMain.handle(
        "directories:choose",
        async (event, projectId, conversationId) => {
          requireMain(event);
          if (
            !host ||
            ![projectId, conversationId].every(
              (value) =>
                typeof value === "string" &&
                /^[a-zA-Z0-9_-]{1,100}$/.test(value),
            )
          )
            throw new Error("目录授权范围无效。");
          const before = await application.call("platform.bootstrap");
          await application.call(
            "directories.scope",
            { projectId, conversationId },
            { identityGeneration: before.csrfToken },
          );
          const result = await dialog.showOpenDialog(window, {
            title: "授权 Agent 读写目录",
            buttonLabel: "允许读写",
            message: "允许此对话中的 Agent 读写文本文件，可随时撤销。",
            properties: ["openDirectory"],
          });
          requireMain(event);
          if (result.canceled || !result.filePaths[0]) return null;
          const current = await application.call("platform.bootstrap");
          if (
            current.csrfToken !== before.csrfToken ||
            current.principalId !== before.principalId
          )
            throw new Error("身份已切换，请重新授权目录。");
          await application.call(
            "directories.scope",
            { projectId, conversationId },
            { identityGeneration: current.csrfToken },
          );
          return host.localFiles.authorizeDirectory(
            result.filePaths[0],
            projectId,
            conversationId,
            { principalId: current.principalId, actantId: current.actantId },
          );
        },
      );
      ipcMain.handle("files:choose", async (event, projectId, kind) => {
        requireMain(event);
        if (
          !host ||
          typeof projectId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(projectId) ||
          !["file", "directory"].includes(kind)
        )
          throw new Error("本机文件打开参数无效。");
        const before = await application.call("platform.bootstrap");
        const project = await application.call(
          "projects.get",
          { projectId },
          { identityGeneration: before.csrfToken },
        );
        if (project.deletedAt)
          throw new Error("项目已删除，不能打开本机文件。");
        const result = await dialog.showOpenDialog(window, {
          title:
            kind === "directory"
              ? "打开工作目录（原位读取）"
              : "打开文件（原位读取）",
          properties: [kind === "directory" ? "openDirectory" : "openFile"],
        });
        requireMain(event);
        if (result.canceled || !result.filePaths[0]) return null;
        const current = await application.call("platform.bootstrap");
        if (
          current.csrfToken !== before.csrfToken ||
          current.principalId !== before.principalId
        )
          throw new Error("身份已切换，请重新打开文件。");
        const currentProject = await application.call(
          "projects.get",
          { projectId },
          { identityGeneration: current.csrfToken },
        );
        if (currentProject.deletedAt)
          throw new Error("项目已删除，不能打开本机文件。");
        return host.localFiles.select(result.filePaths[0], projectId, {
          principalId: current.principalId,
          actantId: current.actantId,
        });
      });
      for (const action of ["read", "revoke"])
        ipcMain.handle("files:" + action, async (event, request) => {
          requireMain(event);
          if (!host) throw new Error("本机文件访问仅在本机桌面应用可用。");
          const boot = await application.call("platform.bootstrap");
          return application.call("local-files." + action, request, {
            identityGeneration: boot.csrfToken,
          });
        });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
      return createWindow();
    })
    .catch(async (error) => {
      if (host) await host.close();
      else application?.close();
      dialog.showErrorBox(
        "Morphz 启动失败",
        String(error?.message ?? error) + "\n既有数据和配置未重置。",
      );
      app.quit();
    });
  const reopenMainWindow = () => {
    if (!application) return;
    // Activating an auxiliary picker must not bring the hidden app into the shot.
    if (capture.hiddenWindow) return;
    if (!window || window.isDestroyed()) void createWindow();
    else {
      if (window.isMinimized()) window.restore();
      if (!windowReady) return;
      window.show();
      window.focus();
    }
  };
  app.on("activate", reopenMainWindow);
  app.on("second-instance", reopenMainWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let closingApplication = false;
  app.on("before-quit", (event) => {
    if (application && !closingApplication) {
      event.preventDefault();
      closingApplication = true;
      void (async () => {
        if (host) await host.close();
        else application?.close();
      })().finally(() => {
        // A fast cleanup can resolve within the native before-quit callback's
        // microtask checkpoint. Retry on the next event-loop turn, after that
        // cancelled native quit has unwound, rather than re-entering it.
        setImmediate(() => app.quit());
      });
    }
  });
}
