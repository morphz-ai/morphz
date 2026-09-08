const { WebContentsView, session } = require("electron");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { webPreferences, trustedAppURL } = require("./security.cjs");
const { pageAction } = require("./browser-page.cjs");
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
  constructor(window, centerURL, request = fetch) {
    this.window = window;
    this.centerURL = centerURL;
    this.request = request;
    this.current = null;
    this.generation = 0;
    this.timer = setInterval(() => void this.tick(), 700);
  }
  async boot() {
    const r = await this.request(this.centerURL + "/api/workspace", {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error("中心未连接。");
    return r.json();
  }
  async post(path, body, c) {
    const boot = await this.boot();
    if (boot.centerId !== c.centerId || boot.principalId !== c.principalId)
      throw new Error("中心或身份已变化，请重新打开网站。");
    const r = await this.request(this.centerURL + path, {
      method: "POST",
      headers: {
        Origin: this.centerURL,
        "X-MorphzWork-Token": boot.csrfToken,
        "X-Desktop-Key": c.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error("浏览器与中心的连接失效，请关闭后重新打开。");
    return r.json();
  }
  async open(artifactId) {
    if (
      typeof artifactId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(artifactId)
    )
      throw new Error("对象标识无效。");
    this.close();
    const generation = ++this.generation;
    const boot = await this.boot();
    if (generation !== this.generation)
      throw new Error("页面打开已取消或被替换。");
    const artifact = boot.workspace.artifacts.find((a) => a.id === artifactId);
    if (!artifact || artifact.content.kind !== "website")
      throw new Error("网站对象不存在或无权访问。");
    const url = browserURL(artifact.content.url, this.centerURL);
    const partition =
      "persist:morphzwork-browser-" +
      createHash("sha256")
        .update(boot.centerId + ":" + boot.principalId)
        .digest("hex");
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
    const view = new WebContentsView({
      webPreferences: {
        ...webPreferences,
        partition,
        navigateOnDragDrop: false,
      },
    });
    const c = {
      view,
      key: randomBytes(32).toString("hex"),
      centerId: boot.centerId,
      principalId: boot.principalId,
      state: {
        pageId: randomUUID(),
        artifactId,
        epoch: randomUUID(),
        url,
        title: artifact.title,
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
    view.setVisible(false);
    this.window.contentView.addChildView(view);
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
    view.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown") this.invalidate(c);
    });
    view.webContents.on("before-mouse-event", (_e, mouse) => {
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
        this.invalidate(c);
    });
    view.webContents.on("render-process-gone", () => {
      this.invalidate(c);
      c.error = "网页进程已退出，请重新打开。";
    });
    try {
      await this.post("/api/browser/desktop/register", c.state, c);
      await view.webContents.loadURL(url);
    } catch (e) {
      this.invalidate(c);
      c.error = e.message;
    }
    return this.state();
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
  layout(pageId, bounds) {
    const c = this.require(pageId);
    if (!bounds) {
      c.view.setVisible(false);
      if (c.state.visible) this.invalidate(c);
      c.state.visible = false;
      return;
    }
    const [width, height] = this.window.getContentSize();
    if (
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    )
      throw new Error("视图尺寸无效。");
    const x = Math.max(0, Math.round(bounds.x)),
      y = Math.max(105, Math.round(bounds.y));
    c.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(bounds.width))),
      height: Math.max(0, Math.min(height - y, Math.round(bounds.height))),
    });
    c.state.visible = true;
    c.view.setVisible(true);
  }
  state() {
    const c = this.current;
    return c
      ? {
          ...c.state,
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
    await c.view.webContents.loadURL(url);
    return this.state();
  }
  async control(pageId, action) {
    const c = this.require(pageId);
    if (action === "takeover") this.invalidate(c);
    else if (action === "grant") {
      if (!c.state.visible) throw new Error("页面尚不可用。");
      this.invalidate(c);
      c.state.granted = true;
    } else if (action === "back") {
      this.invalidate(c);
      if (c.view.webContents.navigationHistory.canGoBack())
        c.view.webContents.navigationHistory.goBack();
    } else if (action === "reload") {
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
    if (!this.window.isDestroyed())
      this.window.contentView.removeChildView(c.view);
    if (!c.view.webContents.isDestroyed()) c.view.webContents.close();
  }
  stop() {
    clearInterval(this.timer);
    this.close();
  }
}
module.exports = { DesktopBrowser, browserURL };
