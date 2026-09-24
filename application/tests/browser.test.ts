import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedLegacyWebsite } from "./legacy-website-fixture.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { BrowserBroker } from "../apps/service/src/browser.js";
import { localAccess } from "../packages/core/src/model.js";
import type { HostInvocation } from "../apps/service/src/agent-tools.js";
const require = createRequire(import.meta.url);
const { browserURL, DesktopBrowser } = require("../apps/desktop/browser.cjs");
const route: HostInvocation = {
  job_id: "job",
  tool_call_id: "call",
  session_id: "s",
  context_id: "c",
  principal_id: "p",
  agent_id: "a",
  thread_id: "t",
  target_id: "local",
};
test("浏览器只允许网站地址，不将第三方页面提升为应用", () => {
  assert.equal(browserURL("https://example.com"), "https://example.com/");
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://127.0.0.1:65420/api/workspace",
    "https://u:p@example.com",
  ])
    assert.throws(() => browserURL(url));
});
test("浏览器控制：授权、版本、接管、超时和未知结果都不能触发重复提交", () => {
  const filename = join(
    mkdtempSync(join(tmpdir(), "morphz-browser-")),
    "workspace.sqlite",
  );
  const store = new WorkspaceStore(filename);
  let now = 100000;
  const broker = new BrowserBroker(store, () => now);
  const scope = {
    projectId: "first-project",
    access: { principalId: "morphz-service", actantId: "morphz-agent" },
  };
  const a = seedLegacyWebsite(
    filename,
    {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "网站",
        content: {
          kind: "website",
          url: "https://example.com",
          description: "",
        },
      },
    },
    localAccess,
  ).entityId;
  let state = {
    pageId: randomUUID(),
    artifactId: a,
    epoch: randomUUID(),
    url: "https://example.com/",
    title: "测试",
    granted: false,
    visible: true,
  };
  const key = "a".repeat(64);
  broker.register(state, key, localAccess);
  const request = () => ({
    pageId: state.pageId,
    epoch: state.epoch,
    action: { type: "click", snapshotId: randomUUID(), ref: "e1" },
  });
  assert.throws(() => broker.call(request(), route, scope), /尚未授权/);
  state = { ...state, granted: true };
  broker.exchange({ state, receipts: [] }, key, localAccess);
  const args = request();
  const r = broker.call(args, route, scope) as { id: string };
  assert.deepEqual(broker.call(args, route, scope), r);
  assert.throws(
    () => broker.exchange({ state, receipts: [] }, "b".repeat(64), localAccess),
    /失效/,
  );
  assert.throws(() =>
    broker.call({ requestId: r.id }, route, { ...scope, projectId: "other" }),
  );
  assert.equal(
    broker.exchange({ state, receipts: [] }, key, localAccess).requests.length,
    1,
  );
  broker.exchange(
    { state, receipts: [{ id: r.id, status: "executing", result: null }] },
    key,
    localAccess,
  );
  state = { ...state, epoch: randomUUID(), granted: false };
  broker.exchange({ state, receipts: [] }, key, localAccess);
  const unknown = broker.call({ requestId: r.id }, route, scope) as {
    status: string;
  };
  assert.equal(unknown.status, "unknown");
  const restart = new BrowserBroker(store, () => now);
  assert.equal(
    (restart.call(args, route, scope) as { status: string }).status,
    "unknown",
  );
  state = { ...state, granted: true };
  broker.exchange({ state, receipts: [] }, key, localAccess);
  assert.throws(
    () => broker.call(request(), { ...route, job_id: "before-refresh" }, scope),
    /重新读取页面/,
  );
  now += 11000;
  assert.throws(
    () => broker.call(request(), { ...route, job_id: "new" }, scope),
    /尚未授权/,
  );
  store.close();
});
test("快速切换或关闭网站会取消尚未完成的打开请求", async () => {
  const browser = new DesktopBrowser({}, "http://127.0.0.1:65420");
  const resolvers: ((value: unknown) => void)[] = [];
  browser.boot = () => new Promise((resolve) => resolvers.push(resolve));
  try {
    const a = browser.open("a"),
      b = browser.open("b");
    resolvers[0]!({});
    await assert.rejects(a, /取消或被替换/);
    browser.close();
    resolvers[1]!({});
    await assert.rejects(b, /取消或被替换/);
  } finally {
    browser.stop();
  }
});
test("浏览器加载状态来自真实网页，未连接、完成和失败不会伪造加载进度", () => {
  const browser = new DesktopBrowser({}, "morphz://app");
  try {
    assert.equal(browser.state(), null);
    browser.current = {
      state: { pageId: "loading-page" },
      partition: "fixture",
      initialURL: "https://example.com/",
      view: null,
      error: "",
    };
    assert.equal(browser.state().loading, true);
    let loading = true;
    browser.current.view = {
      webContents: {
        isLoading: () => loading,
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
        },
      },
    };
    assert.equal(browser.state().loading, true);
    loading = false;
    assert.equal(browser.state().loading, false);
    browser.current.error = "网页未能载入，请检查地址或重新载入。";
    assert.equal(browser.state().loading, false);
    assert.match(browser.state().error, /未能载入/);
  } finally {
    browser.current = null;
    browser.stop();
  }
});
test("网页只接受宿主已批准的单个嵌入，不能附加预加载或继承应用权限", () => {
  const browser = new DesktopBrowser({}, "morphz://app");
  const pending = () => ({
    partition: "persist:fixture-browser",
    initialURL: "https://example.com/",
    view: null,
    attaching: false,
    state: { pageId: "fixture-page" },
  });
  try {
    for (const patch of [
      { src: "morphz://app/" },
      { partition: "persist:morphz-app" },
      { preload: "file:///untrusted-preload.cjs" },
      { allowpopups: true },
    ]) {
      browser.current = pending();
      let prevented = false;
      browser.willAttach(
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        {},
        {
          partition: "persist:fixture-browser",
          src: "https://example.com/",
          ...patch,
        },
      );
      assert.equal(prevented, true);
      assert.equal(browser.current.attaching, false);
    }
    browser.current = pending();
    const preferences: Record<string, unknown> = {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
      additionalArguments: ["--morphz-application-bridge"],
    };
    browser.willAttach(
      { preventDefault: () => assert.fail("valid pending page") },
      preferences,
      {
        partition: "persist:fixture-browser",
        src: "https://example.com/",
      },
    );
    assert.equal(browser.current.attaching, true);
    for (const key of [
      "nodeIntegration",
      "nodeIntegrationInWorker",
      "nodeIntegrationInSubFrames",
      "webviewTag",
      "allowRunningInsecureContent",
    ])
      assert.equal(preferences[key], false, key);
    for (const key of ["contextIsolation", "sandbox", "webSecurity"])
      assert.equal(preferences[key], true, key);
    assert.deepEqual(preferences.additionalArguments, []);
    assert.equal(preferences.preload, undefined);
    let duplicatePrevented = false;
    browser.willAttach(
      {
        preventDefault: () => {
          duplicatePrevented = true;
        },
      },
      {},
      {
        partition: "persist:fixture-browser",
        src: "https://example.com/",
      },
    );
    assert.equal(duplicatePrevented, true);
    let staleClosed = false;
    const stale = {
      getType: () => "webview",
      close: () => {
        staleClosed = true;
      },
    };
    browser.created(stale);
    browser.current = { ...pending(), attaching: true };
    browser.didAttach(stale);
    assert.equal(staleClosed, true);
    assert.equal(browser.current.view, null);
    assert.equal(browser.current.attaching, true);
  } finally {
    browser.current = null;
    browser.stop();
  }
});
test("桌面回执接续在丢回执、对象改版和重启后仍然只创建一次输入", () => {
  const filename = join(
    mkdtempSync(join(tmpdir(), "morphz-browser-")),
    "workspace.sqlite",
  );
  const store = new WorkspaceStore(filename),
    scope = {
      projectId: "first-project",
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    };
  try {
    const content = {
        kind: "website" as const,
        url: "https://example.com/",
        description: "",
      },
      artifactId = seedLegacyWebsite(
        filename,
        {
          commandId: randomUUID(),
          operation: {
            type: "create-artifact",
            projectId: scope.projectId,
            title: "网页",
            content,
          },
        },
        localAccess,
      ).entityId;
    let broker = new BrowserBroker(store);
    const state = {
        pageId: randomUUID(),
        artifactId,
        epoch: randomUUID(),
        url: content.url,
        title: "网页",
        granted: false,
        visible: true,
      },
      key = "c".repeat(64);
    broker.register(state, key, localAccess);
    state.granted = true;
    broker.exchange({ state, receipts: [] }, key, localAccess);
    const r = broker.call(
      {
        pageId: state.pageId,
        epoch: state.epoch,
        action: { type: "snapshot" },
      },
      route,
      scope,
    ) as { id: string };
    broker.exchange(
      {
        state,
        receipts: [
          { id: r.id, status: "executing", result: null },
          { id: r.id, status: "succeeded", result: "页面快照" },
        ],
      },
      key,
      localAccess,
    );
    broker.drain(
      () => false,
      () => assert.fail("尚在工作的会话不重复唤醒"),
    );
    assert.equal(store.snapshot().inputs.length, 0);
    const conversationId = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-conversation",
          projectId: "first-project",
          title: "浏览器原对话",
        },
      },
      localAccess,
    ).entityId;
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "update-conversation",
          conversationId,
          expectedRevision: 1,
          archived: true,
        },
      },
      localAccess,
    );
    assert.throws(
      () =>
        broker.drain(
          () => true,
          () => {
            throw new Error("lost ack");
          },
          (id) => {
            assert.equal(id, route.session_id);
            return conversationId;
          },
        ),
      /lost ack/,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId,
          expectedRevision: 1,
          title: "网页改版",
          content,
        },
      },
      localAccess,
    );
    broker = new BrowserBroker(store);
    let sends = 0;
    broker.drain(
      () => true,
      () => {
        sends++;
      },
    );
    broker.drain(
      () => true,
      () => {
        sends++;
      },
    );
    assert.equal(sends, 1);
    assert.equal(store.snapshot().inputs.length, 1);
    assert.equal(store.snapshot().inputs[0]!.artifactRevision, 1);
    assert.equal(store.snapshot().inputs[0]!.conversationId, conversationId);
  } finally {
    store.close();
  }
});
