const { session, app } = require("electron");
const { persistentPartition } = require("./configuration.cjs");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const {
  webPreferences,
  trustedAppURL,
  trustedMainURL,
} = require("./security.cjs");
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
    this.sequence = 0;
    this.lastPublished = "";
    this.onFocus = () => this.recover();
    this.window.on?.("focus", this.onFocus);
  }
  publish(c = this.current, pageId = c?.state.pageId ?? null) {
    if (c && this.current !== c) return;
    const contents = this.window.webContents;
    if (!contents || contents.isDestroyed?.()) return;
    let trusted;
    try {
      trusted = trustedMainURL(contents.getURL(), this.centerURL);
    } catch (error) {
      if (contents.isDestroyed?.()) return;
      throw error;
    }
    if (!trusted) return;
    const value = this.state(false);
    const fingerprint = JSON.stringify([this.generation, value]);
    if (fingerprint === this.lastPublished) return;
    try {
      if (contents.isDestroyed?.()) return;
      contents.send("browser:changed", {
        generation: this.generation,
        sequence: ++this.sequence,
        pageId,
        value,
      });
      this.lastPublished = fingerprint;
    } catch (error) {
      if (!contents.isDestroyed?.()) throw error;
    }
  }
  detachView(c, view) {
    if (this.current !== c || c.view !== view) return;
    // Native guest destruction is not an explicit Human close. Keep the page,
    // partition, URL and identity, but retire this guest's ephemeral authority.
    c.view = null;
    c.attaching = false;
    c.error = "网页视图已退出，请重新打开网站。";
    this.invalidate(c);
  }
  liveView(c) {
    const view = c.view;
    if (view?.webContents.isDestroyed?.()) {
      this.detachView(c, view);
      return null;
    }
    return view;
  }
  requireView(c) {
    const view = this.liveView(c);
    if (!view) throw new Error("网页视图尚不可用，请重新打开网站。");
    return view;
  }
  native(c, view, read) {
    if (this.current !== c || this.liveView(c) !== view)
      throw new Error("网页视图已退出，请重新打开网站。");
    try {
      return read(view.webContents);
    } catch (error) {
      // Only a witnessed native lifetime loss is recoverable here. A live
      // handle's unrelated errors must remain observable, not globally hidden.
      if (!view.webContents.isDestroyed?.()) throw error;
      this.detachView(c, view);
      throw new Error("网页视图已退出，请重新打开网站。", { cause: error });
    }
  }
  changed(c) {
    if (this.current !== c) return;
    this.publish(c);
    c.dirty = true;
    if (c.scheduled) return;
    c.scheduled = true;
    queueMicrotask(() => {
      c.scheduled = false;
      void this.drain(c);
    });
  }
  async drain(c) {
    if (c.drainPromise) return c.drainPromise;
    if (this.current !== c || c.busy || !c.connected) return;
    c.drainPromise = (async () => {
      while (this.current === c && c.dirty && !c.busy && c.connected) {
        c.dirty = false;
        await this.tick();
      }
    })();
    try {
      await c.drainPromise;
    } finally {
      c.drainPromise = null;
    }
  }
  recover() {
    const c = this.current;
    if (!c) return;
    if (!c.connected && !c.observing) void this.observe(c);
    this.changed(c);
  }
  async observe(c) {
    if (this.current !== c || c.observing) return;
    c.observing = true;
    const id = randomUUID();
    c.subscriptionId = id;
    let sequence = 0;
    const disconnected = () => {
      if (this.current !== c || c.subscriptionId !== id || !c.observing) return;
      clearTimeout(c.handshake);
      c.observing = false;
      c.connected = false;
      this.invalidate(c);
      c.error ||= "浏览器协助连接中断，请重新允许协助。";
      this.publish(c);
      // Recovery backoff only while disconnected, never a healthy page poll.
      if ((c.retries = (c.retries ?? 0) + 1) <= 8)
        c.retry = setTimeout(
          () => void this.observe(c),
          Math.min(5000, 250 * 2 ** (c.retries - 1)),
        );
    };
    c.handshake = setTimeout(() => {
      if (this.current !== c || c.subscriptionId !== id || sequence !== 0)
        return;
      this.application?.unobserve(id);
      disconnected();
    }, 5000);
    try {
      if (!this.application?.observeBrowser)
        throw new Error("浏览器动作通知尚未接入，请更新宿主。");
      await this.application.observeBrowser(
        id,
        { pageId: c.state.pageId, key: c.key },
        c.identityGeneration,
        (hint) => {
          if (this.current !== c || c.subscriptionId !== id || !c.observing)
            return;
          if (
            !hint ||
            hint.pageId !== c.state.pageId ||
            !Number.isSafeInteger(hint.sequence) ||
            hint.sequence <= sequence ||
            (sequence === 0 &&
              (hint.sequence !== 1 || hint.reason !== "resync")) ||
            !["queued", "resync"].includes(hint.reason)
          ) {
            this.application.unobserve(id);
            disconnected();
            return;
          }
          sequence = hint.sequence;
          clearTimeout(c.handshake);
          c.connected = true;
          c.retries = 0;
          if (c.error === "浏览器协助连接中断，请重新允许协助。") c.error = "";
          this.changed(c);
        },
        disconnected,
      );
      if (this.current !== c || c.subscriptionId !== id)
        this.application.unobserve(id);
    } catch (error) {
      disconnected();
    }
  }
  async boot() {
    if (this.application)
      return this.application.call("platform.bootstrap", undefined, {
        signal: AbortSignal.timeout(4000),
      });
    const r = await this.request(this.centerURL + "/api/platform/bootstrap", {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error("暂时无法读取应用数据，请重试。");
    return r.json();
  }
  async readPlatform(method, path, params, boot) {
    if (this.application)
      return this.application.call(method, params, {
        identityGeneration: boot.csrfToken,
        signal: AbortSignal.timeout(4000),
      });
    const response = await this.request(this.centerURL + path, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error("内容不存在或无权访问，请重试。");
    return response.json();
  }
  async post(path, body, c) {
    const boot = await this.boot();
    if (
      boot.centerId !== c.centerId ||
      boot.principalId !== c.principalId ||
      (c.identityGeneration && boot.csrfToken !== c.identityGeneration)
    )
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
    const artifact = artifactId
      ? await this.readPlatform(
          "objects.read",
          `/api/platform/objects/${artifactId}`,
          { contentId: artifactId },
          boot,
        )
      : null;
    if (artifactId && artifact?.content?.kind !== "website")
      throw new Error("网站对象不存在或无权访问。");
    const projectId = artifact?.projectId ?? target.projectId;
    const project = await this.readPlatform(
      "projects.get",
      `/api/platform/projects/${projectId}`,
      { projectId },
      boot,
    );
    if (project?.id !== projectId || project.deletedAt)
      throw new Error("项目不存在或无权访问。");
    if (generation !== this.generation)
      throw new Error("页面打开已取消或被替换。");
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
      identityGeneration: boot.csrfToken,
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
      void this.observe(c);
      this.publish(c);
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
      this.liveView(c) ||
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
      this.liveView(c) ||
      contents.isDestroyed?.() ||
      this.guestOwners.get(contents) !== c ||
      contents.hostWebContents !== this.window.webContents
    ) {
      if (!contents.isDestroyed?.()) contents.close();
      return;
    }
    c.attaching = false;
    const view = (c.view = { webContents: contents });
    if (c.error === "网页视图已退出，请重新打开网站。") c.error = "";
    const ownsView = () => this.current === c && this.liveView(c) === view;
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (!ownsView()) return { action: "deny" };
      c.error =
        "网站请求打开新窗口。请在地址栏打开目标地址；不会绕过网站的登录限制。";
      this.changed(c);
      return { action: "deny" };
    });
    const checkNavigation = (event, url) => {
      if (!ownsView()) {
        event.preventDefault();
        return;
      }
      try {
        browserURL(url, this.centerURL);
      } catch {
        event.preventDefault();
        c.error = "已阻止不安全的页面跳转。";
        this.changed(c);
      }
    };
    view.webContents.on("will-navigate", checkNavigation);
    view.webContents.on("will-redirect", checkNavigation);
    view.webContents.on("will-frame-navigate", (details) =>
      checkNavigation(details, details.url),
    );
    view.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && ownsView()) this.invalidate(c);
    });
    view.webContents.on("did-navigate", (_e, url) => {
      if (!ownsView()) return;
      c.state.url = url;
      this.changed(c);
    });
    view.webContents.on("did-navigate-in-page", (_e, url, main) => {
      if (main && ownsView()) {
        c.state.url = url;
        this.changed(c);
      }
    });
    view.webContents.on("page-title-updated", (_e, title) => {
      if (!ownsView()) return;
      c.state.title = title.slice(0, 500);
      this.changed(c);
    });
    for (const event of [
      "did-start-loading",
      "did-stop-loading",
      "did-finish-load",
    ])
      view.webContents.on(event, () => {
        if (ownsView()) this.changed(c);
      });
    view.webContents.on("before-input-event", (event, input) => {
      if (!ownsView()) return;
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
      if (!ownsView()) return;
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
        this.invalidate(c);
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
        this.window.webContents.send("browser:selection", null);
    });
    let selectionTimer;
    const captureSelection = () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(async () => {
        if (!ownsView() || !c.state.visible || view.webContents.isDestroyed())
          return;
        const epoch = c.state.epoch,
          url = c.state.url;
        try {
          const selected =
            await view.webContents.executeJavaScriptInIsolatedWorld(1002, [
              { code: `(${pageSelection.toString()})()` },
            ]);
          if (
            !ownsView() ||
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
      if (input.type === "mouseUp" && ownsView()) captureSelection();
    });
    view.webContents.on("destroyed", () => {
      clearTimeout(selectionTimer);
      this.detachView(c, view);
    });
    view.webContents.on("render-process-gone", () => {
      if (!ownsView()) return;
      this.invalidate(c);
      c.error = "网页进程已退出，请重新打开。";
      this.changed(c);
    });
    view.webContents.on(
      "did-fail-load",
      (_event, code, _description, _url, main) => {
        if (main && code !== -3 && ownsView()) {
          this.invalidate(c);
          c.error = "网页未能载入，请检查地址或重新载入。";
          this.changed(c);
        }
      },
    );
    this.changed(c);
  }
  load(c, url) {
    const view = this.requireView(c);
    const generation = (c.navigation = (c.navigation ?? 0) + 1);
    c.error = "";
    c.state.url = url;
    // Navigation must not freeze the host address bar while a site is slow.
    void this.native(c, view, (contents) => contents.loadURL(url)).catch(
      (e) => {
        if (
          this.current === c &&
          this.liveView(c) === view &&
          c.navigation === generation &&
          e.code !== "ERR_ABORTED"
        ) {
          this.invalidate(c);
          c.error = "网页未能载入，请检查地址或重新载入。";
          this.changed(c);
        }
      },
    );
  }
  require(pageId) {
    const c = this.current;
    if (!c || c.state.pageId !== pageId) throw new Error("网站已关闭。");
    return c;
  }
  invalidate(c) {
    if (this.current !== c) return;
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
    this.changed(c);
  }
  visibility(pageId, visible) {
    const c = this.require(pageId);
    if (typeof visible !== "boolean") throw new Error("页面可见状态无效。");
    if (!visible && c.state.visible) this.invalidate(c);
    c.state.visible = visible;
    if (!visible) this.window.webContents.send("browser:selection", null);
    this.changed(c);
  }
  async reveal(pageId, request) {
    const c = this.require(pageId);
    const view = this.requireView(c);
    if (
      !c.state.visible ||
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
    if (c.state.url !== url)
      await this.native(c, view, (contents) => contents.loadURL(url));
    if (this.current !== c || this.liveView(c) !== view || !c.state.visible)
      throw new Error("页面已切换。");
    return this.native(c, view, (contents) =>
      contents.executeJavaScriptInIsolatedWorld(1002, [
        { code: `(${pageSelection.toString()})(${JSON.stringify(payload)})` },
      ]),
    );
  }
  state(recover = true) {
    const c = this.current;
    if (recover && c?.identityGeneration) this.recover();
    let snapshot = { canGoBack: false, canGoForward: false, loading: false };
    if (c) {
      const view = this.liveView(c);
      if (view) {
        try {
          snapshot = {
            canGoBack: view.webContents.navigationHistory.canGoBack(),
            canGoForward: view.webContents.navigationHistory.canGoForward(),
            loading: view.webContents.isLoading(),
          };
        } catch (error) {
          if (!view.webContents.isDestroyed?.()) throw error;
          this.detachView(c, view);
        }
      } else snapshot.loading = !c.error;
    }
    return c
      ? {
          ...c.state,
          surface: { partition: c.partition, src: c.initialURL },
          ...snapshot,
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
      const view = this.requireView(c);
      if (!c.state.visible || !c.connected)
        throw new Error("页面或协助连接尚不可用。");
      this.invalidate(c);
      if (this.current !== c || this.requireView(c) !== view)
        throw new Error("网页视图已退出，请重新打开网站。");
      c.state.granted = true;
    } else if (action === "back") {
      const view = this.requireView(c);
      this.invalidate(c);
      this.native(c, view, (contents) => {
        if (contents.navigationHistory.canGoBack())
          contents.navigationHistory.goBack();
      });
    } else if (action === "forward") {
      const view = this.requireView(c);
      this.invalidate(c);
      this.native(c, view, (contents) => {
        if (contents.navigationHistory.canGoForward())
          contents.navigationHistory.goForward();
      });
    } else if (action === "reload") {
      const view = this.requireView(c);
      this.invalidate(c);
      this.native(c, view, (contents) => contents.reload());
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
    this.changed(c);
    await this.drain(c);
    return this.state(false);
  }
  async evaluate(c, action) {
    const view = this.requireView(c);
    return this.native(c, view, (contents) =>
      contents.executeJavaScriptInIsolatedWorld(1001, [
        {
          code: `(${pageAction.toString()})(${JSON.stringify(action)},${JSON.stringify(randomUUID())})`,
        },
      ]),
    );
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
        c.connected = false;
        this.invalidate(c);
        c.error = e.message;
        if (c.subscriptionId) this.application?.unobserve(c.subscriptionId);
        c.observing = false;
      }
    } finally {
      c.busy = false;
      this.publish(c);
      if (c.results.length) c.dirty = true;
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
    clearTimeout(c.retry);
    clearTimeout(c.handshake);
    if (c.subscriptionId) this.application?.unobserve(c.subscriptionId);
    this.publish(null, c.state.pageId);
    const contents = c.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      try {
        contents.close();
      } catch (error) {
        if (!contents.isDestroyed()) throw error;
      }
    }
  }
  stop() {
    this.window.removeListener?.("focus", this.onFocus);
    this.close();
  }
}
module.exports = { DesktopBrowser, browserURL };
