const { session, app } = require("electron");
const { persistentPartition } = require("./configuration.cjs");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { webPreferences, trustedAppURL } = require("./security.cjs");
const { pageAction, pageSelection } = require("./browser-page.cjs");
function browserURL(value, center) {
  const u = new URL(value);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    trustedAppURL(u.href) ||
    (center && trustedAppURL(u.href, center))
  )
    throw new Error("不允许在网站区域打开这个地址。");
  return u.href;
}
class DesktopBrowser {
  constructor(window, centerURL, request = fetch, application) {
    this.window = window;
    this.centerURL = centerURL;
    this.request = request;
    this.application = application;
    this.current = null;
    this.guestOwners = new WeakMap();
    this.generation = 0;
    this.timer = setInterval(() => void this.tick(), 700);
  }
  async boot() {
    if (this.application)
      return this.application.call("workspace", undefined, {
        signal: AbortSignal.timeout(4000),
      });
    const r = await this.request(this.centerURL + "/api/workspace", {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error("暂时无法读取应用数据，请重试。");
    return r.json();
  }
  async post(path, body, c) {
    const boot = await this.boot();
    if (boot.centerId !== c.centerId || boot.principalId !== c.principalId)
      throw new Error("工作空间或登录身份已变化，请重新打开网站。");
    if (this.application) {
      const method =
        path === "/api/browser/desktop/register"
          ? "browser.register"
          : path === "/api/browser/desktop/exchange"
            ? "browser.exchange"
            : null;
      if (!method) throw new Error("不支持这个浏览器操作。");
      return this.application.call(
        method,
        { key: c.key, data: body },
        {
          identityGeneration: boot.csrfToken,
          signal: AbortSignal.timeout(4000),
        },
      );
    }
    const r = await this.request(this.centerURL + path, {
      method: "POST",
      headers: {
        Origin: this.centerURL,
        "X-Morphz-Token": boot.csrfToken,
        // The identical alias supports an older remote center without retrying writes.
        "X-MorphzWork-Token": boot.csrfToken,
        "X-Desktop-Key": c.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error("浏览器与应用的连接失效，请关闭后重新打开。");
    return r.json();
  }
  async open(target) {
    const artifactId = typeof target === "string" ? target : null;
    if (
      artifactId
        ? !/^[a-zA-Z0-9_-]{1,100}$/.test(artifactId)
        : !target ||
          typeof target !== "object" ||
          typeof target.projectId !== "string" ||
          typeof target.url !== "string"
    )
      throw new Error("对象标识无效。");
    this.close();
    const generation = ++this.generation;
    const boot = await this.boot();
    if (generation !== this.generation)
      throw new Error("页面打开已取消或被替换。");
    const artifact = boot.workspace.artifacts.find((a) => a.id === artifactId);
    if (artifactId && (!artifact || artifact.content.kind !== "website"))
      throw new Error("网站对象不存在或无权访问。");
    const projectId = artifact?.projectId ?? target.projectId;
    if (!boot.workspace.projects.some((p) => p.id === projectId))
      throw new Error("工作空间不存在或无权访问。");
    const url = browserURL(artifact?.content.url ?? target.url, this.centerURL);
    const partition = persistentPartition(
      app.getPath("userData"),
      "browser-" +
        createHash("sha256")
          .update(boot.centerId + ":" + boot.principalId)
          .digest("hex"),
    );
    const browserSession = session.fromPartition(partition);
    browserSession.setPermissionRequestHandler((_web, _permission, callback) =>
      callback(false),
    );
    browserSession.setPermissionCheckHandler(() => false);
    if (!browserSession.__morphzSecured) {
      browserSession.__morphzSecured = true;
      browserSession.on("will-download", (e) => e.preventDefault());
      // Third-party documents must not navigate to or request the trusted app.
      browserSession.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel:
            trustedAppURL(details.url) ||
            trustedAppURL(details.url, this.centerURL),
        }),
      );
    }
    const c = {
      view: null,
      partition,
      initialURL: url,
      attaching: false,
      key: randomBytes(32).toString("hex"),
      centerId: boot.centerId,
      principalId: boot.principalId,
      state: {
        pageId: randomUUID(),
        artifactId,
        projectId,
        epoch: randomUUID(),
        url,
        title: artifact?.title ?? "浏览器",
        visible: false,
        granted: false,
      },
      pending: null,
      results: [],
      handled: new Set(),
      busy: false,
      error: "",
    };
    this.current = c;
    try {
      await this.post("/api/browser/desktop/register", c.state, c);
      if (this.current !== c || generation !== this.generation)
        throw new Error("页面打开已取消或被替换。");
    } catch (e) {
      if (this.current === c) this.close();
      throw e;
    }
    return this.state();
  }
  created(contents) {
    if (this.current && contents.getType() === "webview")
      this.guestOwners.set(contents, this.current);
  }
  willAttach(event, preferences, params) {
    const c = this.current;
    // Only the single page already authorized by open() may be embedded. Guest
    // preferences are owned by the host, never by a page or a supplied preload.
    if (
      !c ||
      c.view ||
      c.attaching ||
      params.partition !== c.partition ||
      params.src !== c.initialURL ||
      preferences.preload ||
      params.preload ||
      params.allowpopups
    ) {
      event.preventDefault();
      return;
    }
    Object.assign(preferences, webPreferences, {
      partition: c.partition,
      nodeIntegrationInSubFrames: false,
      navigateOnDragDrop: false,
      additionalArguments: [],
    });
    delete preferences.preload;
    delete preferences.session;
    c.attaching = true;
  }
  didAttach(contents) {
    const c = this.current;
    if (
      !c ||
      !c.attaching ||
      c.view ||
      this.guestOwners.get(contents) !== c ||
      contents.hostWebContents !== this.window.webContents
    ) {
      contents.close();
      return;
    }
    c.attaching = false;
    const view = (c.view = { webContents: contents });
    view.webContents.setWindowOpenHandler(({ url }) => {
      c.error =
        "网站请求打开新窗口。请在地址栏打开目标地址；不会绕过网站的登录限制。";
      return { action: "deny" };
    });
    const checkNavigation = (event, url) => {
      try {
        browserURL(url, this.centerURL);
      } catch {
        event.preventDefault();
        c.error = "已阻止不安全的页面跳转。";
      }
    };
    view.webContents.on("will-navigate", checkNavigation);
    view.webContents.on("will-redirect", checkNavigation);
    view.webContents.on("will-frame-navigate", (details) =>
      checkNavigation(details, details.url),
    );
    view.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame) this.invalidate(c);
    });
    view.webContents.on("did-navigate", (_e, url) => {
      c.state.url = url;
    });
    view.webContents.on("did-navigate-in-page", (_e, url, main) => {
      if (main) c.state.url = url;
    });
    view.webContents.on("page-title-updated", (_e, title) => {
      c.state.title = title.slice(0, 500);
    });
    view.webContents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        !input.isAutoRepeat &&
        !input.isComposing &&
        (process.platform === "darwin" ? input.meta : input.control) &&
        !input.alt &&
        !input.shift &&
        input.key.toLowerCase() === "j" &&
        this.current === c &&
        c.state.visible
      ) {
        event.preventDefault();
        this.window.webContents.focus();
        this.window.webContents.send("browser:input");
        return;
      }
      if (input.type === "keyDown") this.invalidate(c);
      if (input.type === "keyUp") captureSelection();
    });
    view.webContents.on("before-mouse-event", (_e, mouse) => {
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
        this.invalidate(c);
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
        this.window.webContents.send("browser:selection", null);
    });
    let selectionTimer;
    const captureSelection = () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(async () => {
        if (
          this.current !== c ||
          !c.state.visible ||
          view.webContents.isDestroyed()
        )
          return;
        const epoch = c.state.epoch,
          url = c.state.url;
        try {
          const selected =
            await view.webContents.executeJavaScriptInIsolatedWorld(1002, [
              { code: `(${pageSelection.toString()})()` },
            ]);
          if (
            this.current !== c ||
            !c.state.visible ||
            c.state.epoch !== epoch ||
            c.state.url !== url
          )
            return;
          this.window.webContents.send(
            "browser:selection",
            selected && selected.url === url
              ? {
                  ...selected,
                  pageId: c.state.pageId,
                  epoch,
                  projectId: c.state.projectId,
                }
              : null,
          );
        } catch {
          /* A navigation can destroy the isolated world during selection. */
        }
      }, 40);
    };
    view.webContents.on("input-event", (_event, input) => {
      if (input.type === "mouseUp") captureSelection();
    });
    view.webContents.on("destroyed", () => clearTimeout(selectionTimer));
    view.webContents.on("render-process-gone", () => {
      this.invalidate(c);
      c.error = "网页进程已退出，请重新打开。";
    });
    view.webContents.on(
      "did-fail-load",
      (_event, code, _description, _url, main) => {
        if (main && code !== -3 && this.current === c) {
          this.invalidate(c);
          c.error = "网页未能载入，请检查地址或重新载入。";
        }
      },
    );
  }
  load(c, url) {
    if (!c.view) throw new Error("网页尚未准备好，请稍后重试。");
    const generation = (c.navigation = (c.navigation ?? 0) + 1);
    c.error = "";
    c.state.url = url;
    // Navigation must not freeze the host address bar while a site is slow.
    void c.view.webContents.loadURL(url).catch((e) => {
      if (
        this.current === c &&
        c.navigation === generation &&
        e.code !== "ERR_ABORTED"
      ) {
        this.invalidate(c);
        c.error = "网页未能载入，请检查地址或重新载入。";
      }
    });
  }
  require(pageId) {
    const c = this.current;
    if (!c || c.state.pageId !== pageId) throw new Error("网站已关闭。");
    return c;
  }
  invalidate(c) {
    c.state.epoch = randomUUID();
    c.state.granted = false;
    if (c.pending) {
      c.results.push({
        id: c.pending.id,
        status: "rejected",
        result: "人已接管或页面发生变化，旧动作未执行。",
      });
      c.pending = null;
    }
  }
  visibility(pageId, visible) {
    const c = this.require(pageId);
    if (typeof visible !== "boolean") throw new Error("页面可见状态无效。");
    if (!visible && c.state.visible) this.invalidate(c);
    c.state.visible = visible;
    if (!visible) this.window.webContents.send("browser:selection", null);
  }
  async reveal(pageId, request) {
    const c = this.require(pageId);
    if (
      !c.state.visible ||
      !c.view ||
      !request ||
      typeof request.text !== "string" ||
      !request.text.trim() ||
      request.text.length > 30000
    )
      throw new Error("引用的网页暂时不可用。");
    const url = browserURL(request.url, this.centerURL);
    const payload = { text: request.text };
    if (
      request.anchor &&
      Number.isSafeInteger(request.anchor.start) &&
      request.anchor.start >= 0 &&
      Number.isSafeInteger(request.anchor.end) &&
      request.anchor.end > request.anchor.start
    )
      payload.anchor = { start: request.anchor.start, end: request.anchor.end };
    if (c.state.url !== url) await c.view.webContents.loadURL(url);
    if (this.current !== c || !c.state.visible) throw new Error("页面已切换。");
    return c.view.webContents.executeJavaScriptInIsolatedWorld(1002, [
      { code: `(${pageSelection.toString()})(${JSON.stringify(payload)})` },
    ]);
  }
  state() {
    const c = this.current;
    return c
      ? {
          ...c.state,
          surface: { partition: c.partition, src: c.initialURL },
          canGoBack: c.view?.webContents.navigationHistory.canGoBack() ?? false,
          canGoForward:
            c.view?.webContents.navigationHistory.canGoForward() ?? false,
          loading: !c.view || c.view.webContents.isLoading(),
          pending: c.pending
            ? {
                id: c.pending.id,
                label: c.pending.label,
                action: c.pending.action.type,
              }
            : null,
          error: c.error,
        }
      : null;
  }
  async navigate(pageId, value) {
    const c = this.require(pageId);
    const url = browserURL(value, this.centerURL);
    this.invalidate(c);
    this.load(c, url);
    return this.state();
  }
  async control(pageId, action) {
    const c = this.require(pageId);
    if (action === "takeover") this.invalidate(c);
    else if (action === "grant") {
      if (!c.state.visible || !c.view) throw new Error("页面尚不可用。");
      this.invalidate(c);
      c.state.granted = true;
    } else if (action === "back") {
      if (!c.view) throw new Error("页面尚不可用。");
      this.invalidate(c);
      if (c.view.webContents.navigationHistory.canGoBack())
        c.view.webContents.navigationHistory.goBack();
    } else if (action === "forward") {
      if (!c.view) throw new Error("页面尚不可用。");
      this.invalidate(c);
      if (c.view.webContents.navigationHistory.canGoForward())
        c.view.webContents.navigationHistory.goForward();
    } else if (action === "reload") {
      if (!c.view) throw new Error("页面尚不可用。");
      this.invalidate(c);
      c.view.webContents.reload();
    } else if (["approve", "reject"].includes(action)) {
      const r = c.pending;
      if (!r || r.epoch !== c.state.epoch || !c.state.granted)
        throw new Error("待确认操作已过期。");
      c.pending = null;
      if (action === "reject")
        c.results.push({
          id: r.id,
          status: "rejected",
          result: "用户拒绝了操作。",
        });
      else {
        c.busy = true;
        try {
          await this.perform(c, r);
        } finally {
          c.busy = false;
        }
      }
    } else throw new Error("不支持的操作。");
    return this.state();
  }
  async evaluate(c, action) {
    return c.view.webContents.executeJavaScriptInIsolatedWorld(1001, [
      {
        code: `(${pageAction.toString()})(${JSON.stringify(action)},${JSON.stringify(randomUUID())})`,
      },
    ]);
  }
  async perform(c, r) {
    // Center records executing before dispatch; no reply means no retry.
    await this.post(
      "/api/browser/desktop/exchange",
      {
        state: c.state,
        receipts: [{ id: r.id, status: "executing", result: null }],
      },
      c,
    );
    if (
      this.current !== c ||
      r.epoch !== c.state.epoch ||
      !c.state.granted ||
      !c.state.visible
    ) {
      c.results.push({
        id: r.id,
        status: "rejected",
        result: "控制权已变化，动作未执行。",
      });
      return;
    }
    try {
      const result = await this.evaluate(c, r.action);
      c.results.push({
        id: r.id,
        status: "succeeded",
        result: JSON.stringify(result).slice(0, 45000),
      });
    } catch {
      c.results.push({
        id: r.id,
        status: "unknown",
        result: "网页未返回可靠结果。请先重新读取页面核对，不要重复提交。",
      });
    }
  }
  async tick() {
    const c = this.current;
    if (!c || c.busy) return;
    c.busy = true;
    try {
      const results = [...c.results];
      const response = await this.post(
        "/api/browser/desktop/exchange",
        { state: c.state, receipts: results },
        c,
      );
      c.results.splice(0, results.length);
      c.error = "";
      const r = response.requests[0];
      if (
        !r ||
        c.handled.has(r.id) ||
        this.current !== c ||
        r.epoch !== c.state.epoch ||
        !c.state.granted ||
        !c.state.visible
      )
        return;
      c.handled.add(r.id);
      if (r.action.type === "click") {
        try {
          const info = await this.evaluate(c, { ...r.action, type: "inspect" });
          if (r.epoch === c.state.epoch && c.state.granted)
            c.pending = { ...r, label: info.label };
        } catch {
          c.results.push({
            id: r.id,
            status: "rejected",
            result: "目标已变化，请重新读取页面。",
          });
        }
      } else await this.perform(c, r);
    } catch (e) {
      if (this.current === c) {
        this.invalidate(c);
        c.error = e.message;
      }
    } finally {
      c.busy = false;
    }
  }
  close(pageId) {
    const c = this.current;
    if (!pageId || c?.state.pageId === pageId) this.generation++;
    if (!c || (pageId && c.state.pageId !== pageId)) return;
    this.invalidate(c);
    c.state.visible = false;
    void this.post(
      "/api/browser/desktop/exchange",
      { state: c.state, receipts: c.results },
      c,
    ).catch(() => {});
    this.current = null;
    if (c.view && !c.view.webContents.isDestroyed()) c.view.webContents.close();
  }
  stop() {
    clearInterval(this.timer);
    this.close();
  }
}
module.exports = { DesktopBrowser, browserURL };
