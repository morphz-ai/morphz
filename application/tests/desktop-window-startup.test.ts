import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, type Context } from "node:vm";

const require = createRequire(import.meta.url);
const desktopDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/desktop",
);
const mainSource = readFileSync(join(desktopDirectory, "main.cjs"), "utf8");
const { failurePath, failurePage, errorSummary } =
  require("../apps/desktop/startup-page.cjs") as {
    failurePath: string;
    failurePage(message: string, mainURL: string): Response;
    errorSummary(error: unknown): string;
  };
const { emptyPage } = require("../apps/desktop/preferences.cjs") as {
  emptyPage(): Response;
};
const { trustedMainURL } = require("../apps/desktop/security.cjs") as {
  trustedMainURL(url: string, origin: string): boolean;
};
const { rendererURL } = require("../apps/desktop/development.cjs") as {
  rendererURL(center: string, hot: boolean, packaged: boolean): string;
};
const restoreURL = "morphz://app/__desktop_restore";
const mainURL = "morphz://app/";
const failureURL = "morphz://app" + failurePath;

function deferred() {
  let resolve!: () => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = () => yes();
    reject = no;
  });
  return { promise, resolve, reject };
}

// Extract the actual production control flow and protocol route. The fixture
// imports no Electron, opens no real window, and never touches a user profile.
function sourceSection(
  source: string,
  startExpression: RegExp,
  endMarker: string,
) {
  const match = startExpression.exec(source);
  assert.ok(
    match,
    "production startup section must be available to the lifecycle test",
  );
  const end = source.indexOf(endMarker, match.index);
  assert.ok(
    end > match.index,
    "production startup section boundary must be available",
  );
  return source.slice(match.index, end);
}

function configuredUI(hot: boolean, center: string) {
  const initialUI = /^  let uiURL = .+;$/m.exec(mainSource);
  assert.ok(initialUI, "the actual main-frame default must remain explicit");
  const hotSelection = sourceSection(
    mainSource,
    /      if \(hot\) \{/,
    "      microphone =",
  );
  const context = createContext({
    hot,
    connection: { mode: "remote", url: center },
    app: { isPackaged: false },
    developmentBundle: false,
    rendererURL,
  });
  runInContext(
    initialUI[0] + "\n" + hotSelection + "\nglobalThis.selectedUI = uiURL;",
    context,
  );
  assert.equal(typeof context.selectedUI, "string");
  return context.selectedUI as string;
}

type LifecycleEvent = [kind: string, windowId?: number, detail?: string];
type FileWrite = [path: string, body: string, options: unknown];
type Dialog = {
  window: { id: number };
  options: { type: string; title: string; message: string; detail: string };
};
type FixtureOptions = {
  hot?: boolean;
  uiURL?: string;
  preferences?: boolean;
  rootFailure?: Error;
  restoreFailure?: Error;
  fallbackFailure?: Error;
  restoreGate?: (window: { id: number }) => Promise<void>;
};
type StartupState = Context & {
  windowReady: boolean;
  startupFailure: string;
  windowStartup?: Promise<void>;
  api: { createWindow(): Promise<void>; reopenMainWindow(): void };
};

function fixture({
  hot = false,
  uiURL = "morphz://app",
  preferences = true,
  rootFailure,
  restoreFailure,
  fallbackFailure,
  restoreGate,
}: FixtureOptions = {}) {
  const configuredRoot = uiURL + "/";
  const applicationResponse = () =>
    new Response(
      '<!doctype html><title>Morphz fixture</title><div id="root">fixture only</div>',
    );
  const events: LifecycleEvent[] = [],
    windows: Window[] = [],
    dialogs: Dialog[] = [],
    fileWrites: FileWrite[] = [];
  const guestHistory = { clears: 0 },
    storageErases: unknown[][] = [];
  let restores = 0,
    protocolHandler!: (request: Request) => Response | Promise<Response>;
  let context!: StartupState;
  class Window {
    id: number;
    destroyed = false;
    visible = false;
    url = "";
    html = "";
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    history: string[] = [];
    historyClears = 0;
    webContents = {
      setWindowOpenHandler() {},
      on() {},
      session: {
        fetch() {
          throw new Error("unexpected network access");
        },
      },
      getURL: () => this.url,
      isDestroyed: () => this.destroyed,
      navigationHistory: {
        clear: () => {
          this.historyClears++;
          this.history = [this.url];
          events.push(["clear-history", this.id, this.url]);
        },
        getAllEntries: () => this.history.map((url) => ({ url })),
        canGoBack: () => this.history.length > 1,
      },
      executeJavaScript: async (code: string) => {
        events.push(["execute", this.id, code]);
        return undefined;
      },
    };
    static getAllWindows() {
      return [
        ...windows,
        {
          webContents: {
            navigationHistory: {
              clear() {
                guestHistory.clears++;
              },
            },
          },
        },
      ];
    }
    constructor() {
      this.id = windows.length + 1;
      windows.push(this);
    }
    on(name: string, callback: (...args: unknown[]) => unknown) {
      this.handlers.set(name, callback);
    }
    once(name: string, callback: (...args: unknown[]) => unknown) {
      this.on(name, callback);
    }
    async loadURL(url: string) {
      if (this.destroyed) throw new Error("Object has been destroyed");
      events.push(["load", this.id, url]);
      if (url === configuredRoot && rootFailure) throw rootFailure;
      if (url === failureURL && fallbackFailure) throw fallbackFailure;
      // Hot renderer HTTP is an in-memory response, not a custom-protocol route
      // or a real development server; these tests verify only entry selection.
      const response =
        new URL(url).protocol === "morphz:"
          ? await protocolHandler(new Request(url))
          : applicationResponse();
      const html = await response.text();
      if (this.destroyed) throw new Error("Object has been destroyed");
      this.url = url;
      this.html = html;
      this.history.push(url);
    }
    show() {
      if (this.destroyed) throw new Error("show on destroyed window");
      this.visible = true;
      events.push(["show", this.id, this.url]);
    }
    focus() {
      events.push(["focus", this.id]);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    close() {
      this.handlers.get("close")?.();
      this.destroyed = true;
      this.handlers.get("closed")?.();
    }
  }
  const appSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    clearStorageData: (...args: unknown[]) => storageErases.push(args),
    protocol: {
      handle: (scheme: string, handler: typeof protocolHandler) => {
        assert.equal(scheme, "morphz");
        protocolHandler = handler;
      },
    },
  };
  context = createContext({
    BrowserWindow: Window,
    window: undefined,
    windowStartup: undefined,
    windowReady: false,
    startupFailure: "",
    browser: undefined,
    appearance: undefined,
    windowAppearanceOptions: () => ({}),
    nativeTheme: {},
    process: { platform: "darwin" },
    webPreferences: {},
    __dirname: desktopDirectory,
    appPartition: "fixture-only",
    uiURL,
    join,
    application: { invalidate() {} },
    DesktopAppearance: class {},
    DesktopBrowser: class {
      close() {}
      stop() {}
    },
    microphoneRequest: 0,
    microphone: { cancel() {}, request() {} },
    capture: { hiddenWindow: false, cancel() {} },
    scriptExports: undefined,
    session: { fromPartition: () => appSession },
    appSession,
    URL,
    Request,
    Response,
    trustedMainURL,
    emptyPage,
    restorePath: "/__desktop_restore",
    failurePath,
    failurePage,
    errorSummary,
    resources: applicationResponse,
    preferences: preferences ? { prefix: "fixture-only:" } : undefined,
    hot,
    restorePreferences: async (window: Window) => {
      restores++;
      await window.loadURL(restoreURL);
      if (restoreGate) await restoreGate(window);
      if (restoreFailure) throw restoreFailure;
      return { restored: 0, ownerRestored: true };
    },
    writeFileSync: (path: string, body: string, options: unknown) =>
      fileWrites.push([path, body, options]),
    app: { getPath: () => "/fixture-only-not-created" },
    dialog: {
      showMessageBox: async (window: Window, options: Dialog["options"]) => {
        dialogs.push({ window, options });
        return { response: 0 };
      },
    },
    require,
  }) as StartupState;
  const create = sourceSection(
    mainSource,
    /  (?:async )?function createWindow\(\) \{/,
    "  app\n    .whenReady()",
  );
  const reopen = sourceSection(
    mainSource,
    /  const reopenMainWindow = \(\) => \{/,
    '  app.on("activate", reopenMainWindow)',
  );
  const route = sourceSection(
    mainSource,
    /      appSession.protocol.handle\("morphz", \(request\) => \{/,
    "      if (!hot",
  );
  runInContext(
    route +
      "\n" +
      create +
      "\n" +
      reopen +
      "\nglobalThis.api = { createWindow, reopenMainWindow };",
    context,
  );
  return {
    context,
    windows,
    events,
    dialogs,
    fileWrites,
    guestHistory,
    storageErases,
    get restores() {
      return restores;
    },
    ...context.api,
  };
}

async function tick() {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

function assertVisibleFallback(
  window: {
    visible: boolean;
    url: string;
    html: string;
  },
  expectedMainURL = mainURL,
) {
  assert.equal(window.visible, true);
  assert.equal(window.url, failureURL);
  assert.match(window.html, /界面未能载入/);
  assert.match(window.html, /数据和设置没有被重置/);
  assert.ok(
    window.html.includes(`<a href="${expectedMainURL}">重新加载界面</a>`),
  );
  assert.ok(
    !window.html.includes('id="root"'),
    "the actual startup route must serve its error page, not the application resource fallback",
  );
}

test("正式入口加载失败时显示真实恢复页而非迁移空白页", async () => {
  const f = fixture({ rootFailure: new Error("ERR_ABORTED (-3)") });
  await f.createWindow();
  assert.equal(f.windows.length, 1);
  assertVisibleFallback(f.windows[0]!);
  assert.deepEqual(f.windows[0]!.history, [failureURL]);
  assert.equal(f.windows[0]!.webContents.navigationHistory.canGoBack(), false);
  assert.deepEqual(
    f.events.filter(([kind]) => kind === "clear-history"),
    [["clear-history", f.windows[0]!.id, failureURL]],
    "the main-frame history is cleared only after the error page has loaded",
  );
  assert.ok(
    f.events.findIndex(([kind]) => kind === "clear-history") <
      f.events.findIndex(([kind]) => kind === "show"),
    "the error page must have no Back destination before it is shown",
  );
  assert.equal(f.guestHistory.clears, 0);
  assert.deepEqual(f.storageErases, []);
  assert.ok(
    f.events
      .filter(([kind]) => kind === "show")
      .every(([, , url]) => url !== restoreURL),
  );
  const recorded = f.fileWrites.find(([path]) =>
    path.endsWith("desktop-startup-failure.json"),
  );
  assert.ok(recorded);
  assert.equal(JSON.parse(recorded[1]).phase, "main-page");
  assert.equal(
    f.dialogs.length,
    0,
    "the usable fallback needs no dismissible modal",
  );
});

test("旧窗口恢复失败不得给重开的新窗口弹错或显示迁移页", async (t) => {
  const old = deferred(),
    next = deferred();
  t.after(() => {
    old.resolve();
    next.resolve();
  });
  const f = fixture({
    restoreGate: (window) => (window.id === 1 ? old.promise : next.promise),
  });
  const first = f.createWindow();
  await tick();
  f.windows[0]!.close();
  const second = f.createWindow();
  await tick();
  old.reject(new Error("Object has been destroyed (old window)"));
  await first;
  assert.equal(f.dialogs.length, 0);
  assert.equal(
    f.fileWrites.length,
    0,
    "obsolete restore must not publish its receipt or failure",
  );
  assert.equal(f.events.filter(([kind]) => kind === "show").length, 0);
  next.resolve();
  await second;
  assert.equal(f.windows[1]!.url, mainURL);
  assert.equal(f.context.window, f.windows[1]);
});

test("正式入口成功后仅清理该主窗口历史，不清存储或来宾浏览历史", async () => {
  const f = fixture();
  await f.createWindow();
  const main = f.windows[0]!;
  assert.equal(main.url, mainURL);
  assert.equal(main.historyClears, 1);
  assert.deepEqual(main.history, [mainURL]);
  assert.deepEqual(
    f.events.filter(([kind]) => kind === "clear-history"),
    [["clear-history", main.id, mainURL]],
    "successful startup clears only the loaded main root, never the migration page",
  );
  assert.equal(f.guestHistory.clears, 0);
  assert.deepEqual(f.storageErases, []);
  assert.equal(f.fileWrites.length, 1);
  assert.match(f.fileWrites[0]![0], /embedded-preferences-recovery\.json$/);
  assert.ok(
    !f.events.some(
      ([kind, , code]) =>
        kind === "execute" &&
        /(?:localStorage|sessionStorage)\.(?:clear|removeItem)/.test(
          code ?? "",
        ),
    ),
  );
  assert.deepEqual(
    f.events.filter(([kind]) => kind === "show"),
    [["show", main.id, mainURL]],
  );
});

test("恢复失败进入可见错误页，不显示迁移页或伪造恢复成功", async () => {
  const f = fixture({
    restoreFailure: new Error("fixture restoration failure"),
  });
  await f.createWindow();
  assertVisibleFallback(f.windows[0]!);
  assert.ok(
    !f.fileWrites.some(([path]) =>
      path.endsWith("embedded-preferences-recovery.json"),
    ),
  );
  const recorded = f.fileWrites.find(([path]) =>
    path.endsWith("desktop-startup-failure.json"),
  );
  assert.ok(recorded);
  assert.equal(JSON.parse(recorded[1]).phase, "preferences");
  assert.ok(
    !f.events.some(([kind, , url]) => kind === "load" && url === mainURL),
  );
});

test("重复创建与激活共用正在启动的窗口和Promise，不提前展示迁移页", async (t) => {
  const gate = deferred();
  t.after(gate.resolve);
  const f = fixture({ restoreGate: () => gate.promise });
  const first = f.createWindow();
  await tick();
  const second = f.createWindow();
  f.reopenMainWindow();
  assert.equal(first, second);
  assert.equal(f.windows.length, 1);
  assert.equal(f.restores, 1);
  assert.equal(f.events.filter(([kind]) => kind === "show").length, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.windows[0]!.url, mainURL);
  assert.equal(f.context.windowReady, true);
});

test("错误兜底已就绪时激活显示同一窗口，不再恢复偏好或重载页面", async () => {
  const f = fixture({ rootFailure: new Error("root unavailable") });
  const startup = f.createWindow();
  await startup;
  assertVisibleFallback(f.windows[0]!);
  assert.equal(f.context.windowReady, true);
  const loadsBefore = f.events.filter(([kind]) => kind === "load").length;
  const shownBefore = f.events.filter(([kind]) => kind === "show").length;
  f.reopenMainWindow();
  assert.equal(f.createWindow(), startup);
  assert.equal(f.windows.length, 1);
  assert.equal(f.restores, 1);
  assert.equal(
    f.events.filter(([kind]) => kind === "load").length,
    loadsBefore,
  );
  assert.equal(
    f.events.filter(([kind]) => kind === "show").length,
    shownBefore + 1,
  );
  assert.deepEqual(f.events.slice(-2), [
    ["show", f.windows[0]!.id, failureURL],
    ["focus", f.windows[0]!.id],
  ]);
});

test("旧窗口迟到的closed回调不能清空新窗口及启动Promise", async (t) => {
  const old = deferred(),
    next = deferred();
  t.after(() => {
    old.resolve();
    next.resolve();
  });
  const f = fixture({
    restoreGate: (window) => (window.id === 1 ? old.promise : next.promise),
  });
  const first = f.createWindow();
  await tick();
  const original = f.windows[0]!;
  original.handlers.get("close")?.();
  original.destroyed = true;
  const second = f.createWindow();
  await tick();
  original.handlers.get("closed")?.();
  assert.equal(f.context.window, f.windows[1]);
  assert.equal(f.context.windowStartup, second);
  old.resolve();
  await first;
  next.resolve();
  await second;
  assert.equal(f.windows[1]!.url, mainURL);
});

test("错误页自身也加载失败时只对原窗口报错并关闭，不显示空白页", async () => {
  const f = fixture({
    rootFailure: new Error("root unavailable"),
    fallbackFailure: new Error("fallback unavailable"),
  });
  await f.createWindow();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0]!.window, f.windows[0]);
  assert.equal(f.dialogs[0]!.options.type, "error");
  assert.equal(f.windows[0]!.destroyed, true);
  assert.equal(f.windows[0]!.historyClears, 0);
  assert.equal(f.events.filter(([kind]) => kind === "show").length, 0);
});

test("真实错误页包含主入口重试链接，禁止脚本、业务调用和外部资源", async () => {
  const response = failurePage("fixture unavailable", mainURL),
    html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Type"),
    "text/html; charset=utf-8",
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(
    response.headers.get("Content-Security-Policy"),
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
  assert.match(html, /<a href="morphz:\/\/app\/">重新加载界面<\/a>/);
  assert.equal(trustedMainURL(mainURL, "morphz://app"), true);
  assert.ok(!/<(?:script|iframe|form|img|link)\b/i.test(html));
  assert.ok(!/\bon[a-z]+\s*=|morphzDesktop|fetch\(/i.test(html));
});

test("错误正文与链接转义，URL错误详情不暴露认证、query或fragment", async () => {
  const message = '<img src=x onerror="steal()"> & "quoted" \'value\'';
  const html = await failurePage(message, 'morphz://app/?q="<tag>&').text();
  assert.match(
    html,
    /&lt;img src=x onerror=&quot;steal\(\)&quot;&gt; &amp; &quot;quoted&quot; &#39;value&#39;/,
  );
  assert.match(html, /href="morphz:\/\/app\/\?q=&quot;&lt;tag&gt;&amp;"/);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<tag>"));
  const summary = errorSummary(
    new Error(
      "failed https://user:password@example.test/retry?token=secret#private and http://other:credential@127.0.0.1:65420/?key=hidden#value",
    ),
  );
  assert.equal(
    summary,
    "failed https://example.test/retry and http://127.0.0.1:65420/",
  );
  assert.equal(errorSummary(new Error("x".repeat(2000))).length, 1000);
});

test("显式hot使用真实配置的开发入口，跳过恢复，失败重试链接仍指开发root", async () => {
  const center = "http://127.0.0.1:65420";
  const uiURL = configuredUI(true, center);
  const expectedRoot = rendererURL(center, true, false) + "/";
  assert.equal(uiURL + "/", expectedRoot);
  assert.notEqual(
    uiURL,
    center,
    "the private application center is not the Vite renderer origin",
  );
  const f = fixture({ hot: true, uiURL });
  await f.createWindow();
  assert.equal(f.restores, 0);
  assert.equal(f.windows[0]!.url, expectedRoot);
  assert.equal(f.fileWrites.length, 0);
  assert.deepEqual(
    f.events.filter(([kind]) => kind === "load"),
    [["load", 1, expectedRoot]],
  );
  const failed = fixture({
    hot: true,
    uiURL,
    rootFailure: new Error("development renderer unavailable"),
  });
  await failed.createWindow();
  assertVisibleFallback(failed.windows[0]!, expectedRoot);
  assert.equal(failed.restores, 0);
  assert.ok(
    !failed.fileWrites.some(([path]) =>
      path.endsWith("embedded-preferences-recovery.json"),
    ),
  );
});

test("默认remote配置仍加载内置morphz主页面，不把center origin当renderer入口", async () => {
  const center = "https://fixture-center.example.test";
  const uiURL = configuredUI(false, center);
  assert.equal(uiURL, "morphz://app");
  // Remote startup collects no local preference seed. No remote bridge/API is
  // simulated here: the production entry-selection branch is the assertion.
  const f = fixture({ uiURL, preferences: false });
  await f.createWindow();
  assert.equal(f.windows[0]!.url, mainURL);
  assert.equal(f.restores, 0);
  assert.equal(f.fileWrites.length, 0);
  assert.deepEqual(
    f.events.filter(([kind]) => kind === "load"),
    [["load", 1, mainURL]],
  );
  const failed = fixture({
    uiURL,
    preferences: false,
    rootFailure: new Error("embedded renderer unavailable"),
  });
  await failed.createWindow();
  assertVisibleFallback(failed.windows[0]!);
  assert.ok(!failed.windows[0]!.html.includes(center));
});
