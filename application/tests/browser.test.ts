import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { BrowserBroker } from "../apps/service/src/browser.js";
import { browserControlFixture } from "./browser-control-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import type { HostInvocation } from "../apps/service/src/agent-tools.js";
import type {
  AgentToolArguments,
  ToolScope,
} from "../packages/application/src/agent-tools.js";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import type { PlatformAgentDomain } from "../packages/application/src/platform-agent-tools.js";
import type { BrowserReceipt } from "../packages/core/src/browser.js";
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
test("浏览器控制：授权、版本、接管、超时和未知结果都不能触发重复提交", async (t) => {
  const fixture = await browserControlFixture();
  t.after(() => fixture.close());
  let now = 100000;
  const broker = fixture.createBroker(() => now);
  const invoke = (
    args: unknown,
    invocation = route,
    projectId = fixture.projectId,
  ) =>
    broker.callAuthorized(args, invocation, projectId, localAccess.principalId);
  let state = {
    pageId: randomUUID(),
    artifactId: null,
    projectId: fixture.projectId,
    epoch: randomUUID(),
    url: "https://example.com/",
    title: "测试",
    granted: false,
    visible: true,
  };
  const key = "a".repeat(64);
  await broker.register(state, key, localAccess);
  const request = () => ({
    pageId: state.pageId,
    epoch: state.epoch,
    action: { type: "click", snapshotId: randomUUID(), ref: "e1" },
  });
  assert.throws(() => invoke(request()), /尚未授权/);
  state = { ...state, granted: true };
  await broker.exchange({ state, receipts: [] }, key, localAccess);
  const args = request();
  const r = invoke(args) as { id: string };
  assert.equal((await broker.waitForResult(r.id, 1)).status, "queued");
  assert.deepEqual(invoke(args), r);
  await assert.rejects(
    broker.exchange({ state, receipts: [] }, "b".repeat(64), localAccess),
    /失效/,
  );
  assert.throws(() => invoke({ requestId: r.id }, route, "other"));
  assert.equal(
    (await broker.exchange({ state, receipts: [] }, key, localAccess)).requests
      .length,
    1,
  );
  await broker.exchange(
    { state, receipts: [{ id: r.id, status: "executing", result: null }] },
    key,
    localAccess,
  );
  state = { ...state, epoch: randomUUID(), granted: false };
  await broker.exchange({ state, receipts: [] }, key, localAccess);
  const unknown = invoke({ requestId: r.id }) as {
    status: string;
  };
  assert.equal(unknown.status, "unknown");
  const restart = fixture.createBroker(() => now);
  assert.equal(
    (
      restart.callAuthorized(
        args,
        route,
        fixture.projectId,
        localAccess.principalId,
      ) as { status: string }
    ).status,
    "unknown",
  );
  state = { ...state, granted: true };
  await broker.exchange({ state, receipts: [] }, key, localAccess);
  assert.throws(
    () => invoke(request(), { ...route, job_id: "before-refresh" }),
    /重新读取页面/,
  );
  now += 11000;
  assert.throws(
    () => invoke(request(), { ...route, job_id: "new" }),
    /尚未授权/,
  );
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
test("浏览器回执重启后仍可读取，且不会伪造工作区输入", async () => {
  const fixture = await browserControlFixture();
  try {
    let broker = fixture.createBroker();
    const state = {
        pageId: randomUUID(),
        artifactId: null,
        projectId: fixture.projectId,
        epoch: randomUUID(),
        url: "https://example.com/",
        title: "网页",
        granted: false,
        visible: true,
      },
      key = "c".repeat(64);
    await broker.register(state, key, localAccess);
    state.granted = true;
    await broker.exchange({ state, receipts: [] }, key, localAccess);
    const r = broker.callAuthorized(
      {
        pageId: state.pageId,
        epoch: state.epoch,
        action: { type: "snapshot" },
      },
      route,
      fixture.projectId,
      localAccess.principalId,
    ) as { id: string };
    await broker.exchange(
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
    assert.equal(fixture.store.runtimeState(), null);
    state.epoch = randomUUID();
    state.granted = false;
    await broker.exchange({ state, receipts: [] }, key, localAccess);
    await fixture.reopen();
    broker = fixture.createBroker();
    assert.equal(
      (
        broker.callAuthorized(
          { requestId: r.id },
          route,
          fixture.projectId,
          localAccess.principalId,
        ) as { status: string }
      ).status,
      "succeeded",
    );
    assert.equal(fixture.store.runtimeState(), null);
    assert.equal(fixture.store.serviceState("browser-receipts"), null);
    assert.equal(
      (await fixture.client.content({ projectId: fixture.projectId })).items
        .length,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("Host 旧回执一次性迁入关系日志，旧 JSON 状态不再参与读写", () => {
  const filename = join(
    mkdtempSync(join(tmpdir(), "morphz-browser-upgrade-")),
    "workspace.sqlite",
  );
  const receipt: BrowserReceipt = {
    id: randomUUID(),
    pageId: randomUUID(),
    epoch: randomUUID(),
    projectId: "first-project",
    artifactId: null,
    sourceSessionId: "old-session",
    action: { type: "snapshot" },
    status: "succeeded",
    createdAt: new Date().toISOString(),
    result: "旧页面快照",
  };
  const db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE service_state (name TEXT PRIMARY KEY, body TEXT NOT NULL); PRAGMA user_version=17;",
  );
  db.prepare("INSERT INTO service_state(name,body) VALUES(?,?)").run(
    "browser-receipts",
    JSON.stringify([receipt]),
  );
  db.close();
  const store = new WorkspaceStore(filename, { mode: "transport" });
  try {
    assert.deepEqual(
      store.browserControlJournal().read(receipt.id)?.receipt,
      receipt,
    );
    assert.equal(store.serviceState("browser-receipts"), null);
    assert.equal(
      store.browserControlJournal().read(receipt.id)?.ownerPrincipalId,
      null,
    );
  } finally {
    store.close();
  }
  const reopened = new WorkspaceStore(filename, { mode: "transport" });
  try {
    assert.deepEqual(
      reopened.browserControlJournal().read(receipt.id)?.receipt,
      receipt,
    );
  } finally {
    reopened.close();
  }
});

test("正式 Agent 浏览器工具以 Runtime 来源和 Platform 项目授权访问本机页面", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const projectId = "platform-only-project";
  const principalId = localAccess.principalId;
  const broker = new BrowserBroker(store, {
    authorizeProject: async (requested, access) => {
      assert.equal(requested, projectId);
      assert.equal(access.principalId, principalId);
    },
    readWebsite: async () => assert.fail("普通页面不是网站内容对象"),
  });
  const state = {
    pageId: randomUUID(),
    epoch: randomUUID(),
    artifactId: null,
    projectId,
    url: "https://example.com/",
    title: "正式项目浏览器",
    granted: true,
    visible: true,
  };
  const key = "f".repeat(64);
  try {
    assert.equal(store.runtimeState(), null);
    await broker.register(state, key, localAccess);
    await broker.exchange({ state, receipts: [] }, key, localAccess);
    const actorReads: string[] = [];
    const toolsFor = (owner: string) =>
      new PlatformAgentTools({
        authority: {
          withInvocation: async (
            _route: unknown,
            action: (
              actor: unknown,
              source: unknown,
              identity: unknown,
            ) => Promise<unknown>,
          ) =>
            action(
              { credential: "verified-runtime-input" },
              { projectId, inputId: "input-one" },
              { principalId: owner, humanActantId: "human-one" },
            ),
        },
        content: {
          platform: {
            getProject: async (actor: { credential: string }, id: string) => {
              actorReads.push(actor.credential);
              assert.equal(id, projectId);
              return { deleted_at: null };
            },
          },
        },
        browser: broker,
      } as unknown as PlatformAgentDomain);
    const scope = {
      platform: true,
      projectId,
      inputId: "input-one",
    } as ToolScope;
    const tools = toolsFor(principalId);
    assert.equal(
      (
        (await tools.call(route, scope, {
          action: "browser",
          browser: {},
        } as AgentToolArguments)) as { pages: unknown[] }
      ).pages.length,
      1,
    );
    const pending = tools.call(route, scope, {
      action: "browser",
      browser: {
        pageId: state.pageId,
        epoch: state.epoch,
        action: { type: "snapshot" },
      },
    } as AgentToolArguments) as Promise<BrowserReceipt>;
    await new Promise((resolve) => setImmediate(resolve));
    const receipt = store
      .browserControlJournal()
      .firstQueued(state.pageId, state.epoch)!;
    assert.equal(receipt.status, "queued");
    await broker.exchange(
      {
        state,
        receipts: [
          { id: receipt.id, status: "executing", result: null },
          { id: receipt.id, status: "succeeded", result: "当前页面" },
        ],
      },
      key,
      localAccess,
    );
    assert.equal((await pending).result, "当前页面");
    assert.equal(
      (
        (await tools.call(route, scope, {
          action: "browser",
          browser: { requestId: receipt.id },
        } as AgentToolArguments)) as BrowserReceipt
      ).result,
      "当前页面",
    );
    assert.deepEqual(
      await toolsFor("another-human").call(route, scope, {
        action: "browser",
        browser: {},
      } as AgentToolArguments),
      { pages: [] },
    );
    await assert.rejects(
      toolsFor("another-human").call(route, scope, {
        action: "browser",
        browser: { requestId: receipt.id },
      } as AgentToolArguments),
      /不存在/,
    );
    assert.ok(actorReads.every((value) => value === "verified-runtime-input"));
    assert.equal(store.runtimeState(), null);
    assert.equal(store.serviceState("browser-receipts"), null);
  } finally {
    store.close();
  }
});
