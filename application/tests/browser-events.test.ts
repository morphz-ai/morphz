import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { browserControlFixture } from "./browser-control-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import type { BrowserWake } from "../packages/core/src/browser.js";
import type { HostInvocation } from "../packages/application/src/agent-tools.js";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { createServer as portProbe } from "node:net";

const require = createRequire(import.meta.url);
const { DesktopBrowser } = require("../apps/desktop/browser.cjs");
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await pause(5);
  }
  assert.ok(check(), "真实事件没有产生预期通知");
}
const route: HostInvocation = {
  context_id: "c",
  session_id: "s",
  job_id: "job",
  tool_call_id: "call",
  principal_id: "p",
  agent_id: "a",
  thread_id: "t",
  target_id: "local",
};
function state(projectId: string) {
  return {
    pageId: randomUUID(),
    artifactId: null,
    projectId,
    epoch: randomUUID(),
    url: "https://example.com/",
    title: "网页",
    visible: true,
    granted: false,
  };
}
function guestFixture() {
  const frames: Array<{ pageId: string; value: any; sequence: number }> = [];
  let trusted = true,
    loading = true,
    requests = 0,
    evaluations = 0;
  const main = Object.assign(new EventEmitter(), {
    getURL: () => (trusted ? "morphz://app/" : "https://untrusted.example/"),
    isDestroyed: () => false,
    send: (channel: string, value: any) => {
      if (channel === "browser:changed") frames.push(value);
    },
  });
  const window = Object.assign(new EventEmitter(), { webContents: main });
  const browser = new DesktopBrowser(window, "morphz://app");
  const c = {
    state: state("project"),
    partition: "persist:owned",
    initialURL: "https://example.com/",
    view: null,
    attaching: true,
    pending: null,
    results: [],
    handled: new Set(),
    busy: false,
    connected: true,
    error: "",
  };
  browser.current = c;
  const guest = Object.assign(new EventEmitter(), {
    hostWebContents: main,
    getType: () => "webview",
    isDestroyed: () => false,
    setWindowOpenHandler: (_handler: unknown) => {},
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    isLoading: () => loading,
    executeJavaScriptInIsolatedWorld: async () => {
      evaluations++;
      return {};
    },
    close: () => guest.emit("destroyed"),
  });
  browser.post = async () => {
    requests++;
    return { requests: [] };
  };
  browser.created(guest);
  browser.didAttach(guest);
  return {
    browser,
    c,
    guest,
    frames,
    setLoading: (value: boolean) => {
      loading = value;
    },
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    get requests() {
      return requests;
    },
    get evaluations() {
      return evaluations;
    },
  };
}
test("宿主guest事件推送加载、导航、标题、失败与关闭，健康空闲零exchange且不采集DOM", async () => {
  const f = guestFixture();
  try {
    await until(() => f.requests > 0);
    assert.equal(f.frames.at(-1)!.value.loading, true);
    f.setLoading(false);
    f.guest.emit("did-stop-loading");
    assert.equal(f.frames.at(-1)!.value.loading, false);
    f.guest.emit("did-navigate", {}, "https://example.com/two");
    f.guest.emit("page-title-updated", {}, "第二页");
    assert.equal(f.frames.at(-1)!.value.url, "https://example.com/two");
    assert.equal(f.frames.at(-1)!.value.title, "第二页");
    f.guest.emit(
      "did-fail-load",
      {},
      -105,
      "DNS failed",
      "https://example.com/two",
      true,
    );
    assert.match(f.frames.at(-1)!.value.error, /未能载入/);
    await pause(10);
    const requests = f.requests,
      frames = f.frames.length;
    await pause(1500);
    assert.equal(f.requests, requests, "700ms旧周期不得产生查询");
    assert.equal(f.frames.length, frames);
    assert.equal(f.evaluations, 0, "状态通知不得读取网页正文");
    f.guest.emit("destroyed");
    assert.equal(f.frames.at(-1)!.value, null);
    assert.equal(f.frames.at(-1)!.pageId, f.c.state.pageId);
  } finally {
    f.browser.stop();
  }
});
test("旧guest事件不能修改新page，未受信任宿主窗口不收到页面push", async () => {
  const f = guestFixture();
  try {
    await pause(5);
    const previous = f.frames.length;
    f.setTrusted(false);
    f.guest.emit("page-title-updated", {}, "秘密标题");
    assert.equal(f.frames.length, previous);
    f.setTrusted(true);
    const replacement = { ...f.c, state: state("project"), view: null };
    f.browser.current = replacement;
    f.guest.emit("did-navigate", {}, "https://evil.example/");
    f.guest.emit("page-title-updated", {}, "旧页面");
    f.guest.emit("destroyed");
    assert.equal(f.browser.current, replacement);
    assert.equal(replacement.state.title, "网页");
    assert.equal(f.frames.length, previous);
  } finally {
    f.browser.current = null;
    f.browser.stop();
  }
});
test("Broker按真实queued唤醒，活动订阅维持lease，关闭撤销旧授权且不自动恢复", async (t) => {
  const f = await browserControlFixture();
  t.after(() => f.close());
  let now = 100_000;
  const broker = f.createBroker(() => now),
    key = "a".repeat(64),
    page = state(f.projectId);
  await broker.register(page, key, localAccess);
  const hints: BrowserWake[] = [];
  let closed = 0;
  const watcher = await broker.observeDesktop(
    { pageId: page.pageId, key },
    localAccess,
    () => {},
    (hint) => hints.push(hint),
    () => closed++,
  );
  await until(() => hints.length === 1);
  assert.deepEqual(hints[0], {
    pageId: page.pageId,
    sequence: 1,
    reason: "resync",
  });
  page.granted = true;
  await broker.exchange({ state: page, receipts: [] }, key, localAccess);
  now += 90_000;
  const receipt = broker.callAuthorized(
    { pageId: page.pageId, epoch: page.epoch, action: { type: "snapshot" } },
    route,
    f.projectId,
    localAccess.principalId,
  ) as { id: string };
  await until(() => hints.length === 2);
  assert.deepEqual(hints[1], {
    pageId: page.pageId,
    sequence: 2,
    reason: "queued",
  });
  assert.equal(
    (await broker.exchange({ state: page, receipts: [] }, key, localAccess))
      .requests[0]!.id,
    receipt.id,
  );
  await pause(30);
  assert.equal(hints.length, 2);
  watcher.close();
  watcher.close();
  assert.equal(closed, 1);
  assert.throws(
    () =>
      broker.callAuthorized(
        {
          pageId: page.pageId,
          epoch: page.epoch,
          action: { type: "snapshot" },
        },
        { ...route, job_id: "later" },
        f.projectId,
        localAccess.principalId,
      ),
    /尚未授权/,
  );
  await assert.rejects(
    broker.observeDesktop(
      { pageId: page.pageId, key: "b".repeat(64) },
      localAccess,
      () => {},
      () => {},
      () => {},
    ),
    /失效/,
  );
});
test("原Host私有Browser订阅保持身份代次，不允许renderer scope带入page credential", async (t) => {
  const f = await browserControlFixture();
  t.after(() => f.close());
  const connection = f.connection,
    boot = (await connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
  const page = state(f.projectId),
    key = "c".repeat(64);
  await connection.call(
    "browser.register",
    { key, data: page },
    { identityGeneration: boot.csrfToken },
  );
  const hints: BrowserWake[] = [];
  let closed = 0;
  const id = randomUUID();
  await connection.observeBrowser(
    id,
    { pageId: page.pageId, key },
    boot.csrfToken,
    (hint) => hints.push(hint),
    () => closed++,
  );
  await until(() => hints.length === 1);
  await assert.rejects(
    connection.observe(
      randomUUID(),
      { kind: "browser", pageId: page.pageId, key },
      boot.csrfToken,
      () => {},
      () => {},
    ),
  );
  const count = hints.length;
  connection.invalidate();
  assert.equal(closed, 1);
  await pause(20);
  assert.equal(hints.length, count);
  await assert.rejects(
    connection.observeBrowser(
      randomUUID(),
      { pageId: page.pageId, key },
      boot.csrfToken,
      () => {},
      () => {},
    ),
    /身份已切换/,
  );
});
test("并发同page观察只有一个lease，失败观察不撤销成功观察控制权", async (t) => {
  const f = await browserControlFixture();
  t.after(() => f.close());
  const broker = f.createBroker(),
    key = "d".repeat(64),
    page = state(f.projectId);
  await broker.register(page, key, localAccess);
  const authority = (broker as any).authority;
  const authorize = authority.authorizeProject.bind(authority);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  authority.authorizeProject = async (...args: any[]) => {
    await held;
    return authorize(...args);
  };
  const attempts = [0, 1].map(() =>
    broker.observeDesktop(
      { pageId: page.pageId, key },
      localAccess,
      () => {},
      () => {},
      () => {},
    ),
  );
  release();
  const settled = await Promise.allSettled(attempts);
  assert.equal(
    settled.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    settled.filter((result) => result.status === "rejected").length,
    1,
  );
  page.granted = true;
  await broker.exchange({ state: page, receipts: [] }, key, localAccess);
  assert.doesNotThrow(() =>
    broker.callAuthorized(
      { pageId: page.pageId, epoch: page.epoch, action: { type: "snapshot" } },
      route,
      f.projectId,
      localAccess.principalId,
    ),
  );
  for (const result of settled)
    if (result.status === "fulfilled") result.value.close();
});
test("真实HTTP Browser通知拒绝坏key、外来page与旧csrf，正常流严格resync后queued且取消清lease", async (t) => {
  const f = await browserControlFixture();
  const options = f.connection.application.options;
  const probe = portProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(f.store, {
    ...options,
    port,
    webRoot: "/unused-browser-api-fixture",
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    server.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  });
  const bootstrap = (await (
    await fetch(origin + "/api/platform/bootstrap")
  ).json()) as { csrfToken: string };
  const key = "e".repeat(64),
    page = state(f.projectId);
  await options.browser!.register(page, key, localAccess);
  const path = origin + "/api/browser/desktop/stream?pageId=";
  for (const [id, credential, csrf] of [
    [page.pageId, "f".repeat(64), bootstrap.csrfToken],
    [randomUUID(), key, bootstrap.csrfToken],
    [page.pageId, key, "old-csrf"],
  ]) {
    const response = await fetch(path + id, {
      headers: { "X-Desktop-Key": credential!, "X-Morphz-Token": csrf! },
    });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
  }
  const remote = new RemoteApplicationConnection(origin, fetch);
  const remoteBoot = (await remote.call("platform.bootstrap")) as {
    csrfToken: string;
  };
  const hints: BrowserWake[] = [];
  let closed = 0;
  const id = randomUUID();
  await remote.observeBrowser(
    id,
    { pageId: page.pageId, key },
    remoteBoot.csrfToken,
    (hint) => hints.push(hint),
    () => closed++,
  );
  await until(() => hints.length === 1);
  assert.equal(hints[0]!.reason, "resync");
  assert.equal(hints[0]!.sequence, 1);
  page.granted = true;
  await options.browser!.exchange(
    { state: page, receipts: [] },
    key,
    localAccess,
  );
  options.browser!.callAuthorized(
    { pageId: page.pageId, epoch: page.epoch, action: { type: "snapshot" } },
    route,
    f.projectId,
    localAccess.principalId,
  );
  await until(() => hints.length === 2);
  assert.equal(hints[1]!.reason, "queued");
  remote.unobserve(id);
  await until(() => !(options.browser as any).desktopWatchers.has(page.pageId));
  assert.equal(
    (options.browser as any).pages.get(page.pageId).state.granted,
    false,
  );
  assert.equal(closed, 0, "主动取消不发迟到关闭frame");
  remote.close();
});
test("远端动作订阅拒绝不合法首帧与空EOF，不把未知连接当健康", async () => {
  for (const first of [
    { sequence: 1, reason: "queued" },
    { sequence: 99, reason: "resync" },
    null,
  ]) {
    const pageId = randomUUID(),
      frames: BrowserWake[] = [];
    let closed = 0;
    const remote = new RemoteApplicationConnection(
      "https://fixture.invalid",
      async (input) => {
        if (String(input).endsWith("/api/platform/bootstrap"))
          return Response.json({ csrfToken: "generation" });
        return new Response(
          first ? `data: ${JSON.stringify({ pageId, ...first })}\n\n` : "",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    await remote.call("platform.bootstrap");
    await remote.observeBrowser(
      randomUUID(),
      { pageId, key: "a".repeat(64) },
      "generation",
      (frame) => frames.push(frame),
      () => closed++,
    );
    await until(() => closed === 1);
    assert.deepEqual(frames, []);
    remote.close();
  }
});
test("native动作通知断开后迟到旧resync不得复活授权，关闭与未ready卸载完整取消", async () => {
  const f = guestFixture();
  let wake!: (hint: BrowserWake) => void,
    close!: () => void,
    cancelled = 0;
  f.browser.application = {
    observeBrowser: async (
      _id: string,
      _scope: unknown,
      _generation: string,
      receive: typeof wake,
      onClose: () => void,
    ) => {
      wake = receive;
      close = onClose;
    },
    unobserve: () => {
      cancelled++;
    },
  };
  f.c.connected = false;
  try {
    await f.browser.observe(f.c);
    wake({ pageId: f.c.state.pageId, sequence: 1, reason: "resync" });
    assert.equal(f.c.connected, true);
    f.c.state.granted = true;
    close();
    const epoch = f.c.state.epoch;
    assert.equal(f.c.connected, false);
    assert.equal(f.c.state.granted, false);
    wake({ pageId: f.c.state.pageId, sequence: 2, reason: "resync" });
    assert.equal(f.c.connected, false);
    assert.equal(f.c.state.epoch, epoch);
    f.browser.close(f.c.state.pageId);
    assert.equal(cancelled, 1);
    const frames = f.frames.length;
    wake({ pageId: f.c.state.pageId, sequence: 3, reason: "queued" });
    assert.equal(f.frames.length, frames);
  } finally {
    f.browser.stop();
  }
});
test("native未ready通知有界握手超时取消并进入恢复，不健康轮询", async () => {
  const f = guestFixture();
  let cancelled = 0;
  f.browser.application = {
    observeBrowser: async () => {},
    unobserve: () => {
      cancelled++;
    },
  };
  f.c.connected = false;
  try {
    await f.browser.observe(f.c);
    assert.equal((f.c as any).observing, true);
    // Exercise the actual registered timeout without a five-second wall delay.
    (f.c as any).handshake._onTimeout();
    assert.equal((f.c as any).observing, false);
    assert.equal(f.c.connected, false);
    assert.equal(cancelled, 1);
    assert.ok((f.c as any).retry);
    f.browser.close(f.c.state.pageId);
    await pause(300);
    assert.equal(f.browser.current, null);
  } finally {
    f.browser.stop();
  }
});
