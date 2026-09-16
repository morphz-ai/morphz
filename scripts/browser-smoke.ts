import { _electron, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { BrowserBroker } from "../apps/service/src/browser.js";
import { AgentTools } from "../apps/service/src/agent-tools.js";
import { createAppServer } from "../apps/service/src/http.js";
import { localAccess } from "../packages/core/src/model.js";
import { seedLegacyWebsite } from "../tests/legacy-website-fixture.js";

const directory = mkdtempSync(join(tmpdir(), "morphz-browser-test-"));
const workPort = Number(process.env.MORPHZ_APP_BROWSER_TEST_PORT ?? 65426);
const workURL = "http://127.0.0.1:" + workPort;
const store = new WorkspaceStore(join(directory, "workspace.sqlite")),
  broker = new BrowserBroker(store);
let submits = 0;
const site = createServer(async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/submit") {
    for await (const _ of req) {
    }
    submits++;
    res.setHeader(
      "Set-Cookie",
      "fixture_session=sample; HttpOnly; SameSite=Lax; Path=/",
    );
    res.end("<h1>发布完成</h1><p>合成内容已收到。</p><a href='/'>返回</a>");
    return;
  }
  res.end(
    `<!doctype html><meta charset="utf-8"><title>发布测试</title><style>body{font:16px system-ui;max-width:650px;margin:32px;color:#182631}label{display:block;margin:20px 0}input,textarea{display:block;width:95%;padding:10px;font:inherit}button{padding:10px 20px}</style><h1>发布测试</h1><p>只使用合成文字，提交仅发生在本机测试服务器。</p><form method="POST" action="/submit"><label>标题<input name="title"></label><label>正文<textarea name="body" rows="5"></textarea></label><input type="password" aria-label="秘密字段"><button>发布合成内容</button></form>`,
  );
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const siteURL = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
const website = seedLegacyWebsite(
  join(directory, "workspace.sqlite"),
  {
    commandId: randomUUID(),
    operation: {
      type: "create-artifact",
      projectId: "first-project",
      title: "内置浏览器验证",
      content: { kind: "website", url: siteURL, description: "合成测试" },
    },
  },
  localAccess,
).entityId;
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
const tools = new AgentTools(
  store,
  "fixture-token",
  () => ({ projectId: "first-project", access: agent }),
  undefined,
  broker,
);
const server = createAppServer(store, {
  port: workPort,
  webRoot: resolve("dist/web"),
  browser: broker,
  agentTools: tools,
});
await new Promise<void>((r, j) => {
  server.once("error", j);
  server.listen(workPort, "127.0.0.1", r);
});
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
async function call(browser: unknown) {
  const response = await fetch(workURL + "/api/host-tools/call", {
    method: "POST",
    headers: {
      Authorization: "Bearer fixture-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      protocol: 1,
      tool: "host_morphz",
      invocation: {
        job_id: randomUUID(),
        tool_call_id: randomUUID(),
        session_id: "s",
        context_id: "c",
        principal_id: "p",
        agent_id: "a",
        thread_id: "t",
        target_id: "local",
      },
      arguments: { action: "browser", browser },
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function result(requestId: string) {
  let value: any;
  await expect
    .poll(
      async () => {
        value = await call({ requestId });
        return value.status;
      },
      { timeout: 15000 },
    )
    .toMatch(/succeeded|rejected|unknown/);
  return value;
}
try {
  const env = {
    ...process.env,
    MORPHZ_APP_ENV_FILE: "",
    MORPHZ_APP_PROFILE: join(directory, "profile"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: ["apps/desktop/main.cjs", "--center=" + workURL],
    env,
  });
  const ui = await app.firstWindow();
  ui.setDefaultTimeout(20000);
  console.log("Browser test: Electron window ready");
  await ui.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  console.log("Browser test: app loaded");
  await ui.locator(".project-link").filter({ hasText: "我的项目" }).click();
  await ui.getByRole("button", { name: "查看本空间内容", exact: true }).click();
  await ui
    .locator(".artifact-card")
    .filter({ hasText: "内置浏览器验证" })
    .first()
    .click();
  await expect(ui.locator(".object-paper > h1")).toHaveText("内置浏览器验证");
  // Explicitly opening a website object enters its browser without a second
  // launch button. This still does not grant the Agent access.
  await expect(
    ui.getByRole("button", { name: "允许 Agent 协助", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await ui.evaluate(() => window.morphzDesktop!.browser.state()))
          ?.visible,
    )
    .toBe(true);
  assert.deepEqual(await call({}), { pages: [] });
  await ui
    .getByRole("button", { name: "允许 Agent 协助", exact: true })
    .click();
  let page: any;
  await expect
    .poll(async () => {
      page = (await call({})).pages[0];
      return !!page;
    })
    .toBe(true);
  const snapshot = async () => {
    const r = await call({
      pageId: page.pageId,
      epoch: page.epoch,
      action: { type: "snapshot" },
    });
    const done = await result(r.id);
    assert.equal(done.status, "succeeded", done.result);
    return JSON.parse(done.result);
  };
  let view = await snapshot();
  assert.ok(view.text.includes("发布测试"));
  assert.ok(!view.elements.some((e: any) => e.type === "password"));
  const title = view.elements.find((e: any) => e.label === "标题");
  const fill = await call({
    pageId: page.pageId,
    epoch: page.epoch,
    action: {
      type: "fill",
      snapshotId: view.snapshotId,
      ref: title.ref,
      value: "Morphz 本机演示",
    },
  });
  assert.equal((await result(fill.id)).status, "succeeded");
  view = await snapshot();
  const button = view.elements.find((e: any) => e.label === "发布合成内容");
  const click = await call({
    pageId: page.pageId,
    epoch: page.epoch,
    action: { type: "click", snapshotId: view.snapshotId, ref: button.ref },
  });
  await expect(
    ui.getByRole("button", { name: "允许这次点击", exact: true }),
  ).toBeVisible();
  assert.equal(submits, 0);
  await ui.getByRole("button", { name: "我来接管", exact: true }).click();
  assert.equal((await result(click.id)).status, "rejected");
  assert.equal(submits, 0);
  await ui
    .getByRole("button", { name: "允许 Agent 协助", exact: true })
    .click();
  await expect
    .poll(async () => {
      page = (await call({})).pages[0];
      return !!page;
    })
    .toBe(true);
  view = await snapshot();
  const next = await call({
    pageId: page.pageId,
    epoch: page.epoch,
    action: {
      type: "click",
      snapshotId: view.snapshotId,
      ref: view.elements.find((e: any) => e.label === "发布合成内容").ref,
    },
  });
  await ui.getByRole("button", { name: "允许这次点击", exact: true }).click();
  await result(next.id);
  await expect.poll(() => submits).toBe(1);
  assert.deepEqual(await call({}), { pages: [] });
  const isolation = await app.evaluate(({ webContents }) => {
    const c = webContents
      .getAllWebContents()
      .find((c) => c.getURL().includes("/submit"))!;
    const p = c.getLastWebPreferences();
    return {
      node: p.nodeIntegration,
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      preload: p.preload,
      storagePath: c.session.getStoragePath(),
    };
  });
  assert.equal(isolation.node, false);
  assert.equal(isolation.sandbox, true);
  assert.equal(isolation.contextIsolation, true);
  assert.ok(!isolation.preload);
  assert.match(isolation.storagePath!, /morphz-browser-/);
  await ui
    .getByRole("button", { name: "允许 Agent 协助", exact: true })
    .click();
  await expect
    .poll(async () => {
      page = (await call({})).pages[0];
      return !!page;
    })
    .toBe(true);
  view = await snapshot();
  assert.ok(view.text.includes("发布完成"), view.text);
  const image = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.capturePage())
      .toPNG()
      .toString("base64"),
  );
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/desktop-browser.png",
    Buffer.from(image, "base64"),
  );
  // BrowserWindow.capturePage omits the separate native child view; inspect it too.
  const pageImage = await app.evaluate(async ({ webContents }) =>
    (
      await webContents
        .getAllWebContents()
        .find((c) => c.getURL().includes("/submit"))!
        .capturePage()
    )
      .toPNG()
      .toString("base64"),
  );
  writeFileSync(
    "test-results/desktop-browser-page.png",
    Buffer.from(pageImage, "base64"),
  );
  // Browser cookies are isolated from the trusted app and persist across reopening.
  const cookieCounts = await app.evaluate(async ({ session, webContents }) => ({
    browser: (
      await webContents
        .getAllWebContents()
        .find((c) => c.getURL().includes("/submit"))!
        .session.cookies.get({ name: "fixture_session" })
    ).length,
    app: (
      await session
        .fromPartition("persist:morphz-app")
        .cookies.get({ name: "fixture_session" })
    ).length,
  }));
  assert.deepEqual(cookieCounts, { browser: 1, app: 0 });
  await ui.reload();
  assert.equal(
    await ui.evaluate(() => window.morphzDesktop!.browser.state()),
    null,
  );
  // Reload must actively revoke the broker grant, not wait for its 10s lease
  // to expire after the native page has already closed.
  await expect.poll(() => call({}), { timeout: 2000 }).toEqual({ pages: [] });
  await ui.getByRole("button", { name: "打开网站", exact: true }).click();
  await expect
    .poll(async () =>
      app!.evaluate(async ({ webContents }, url) => {
        const page = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === url + "/");
        return page
          ? (await page.session.cookies.get({ name: "fixture_session" })).length
          : 0;
      }, siteURL),
    )
    .toBe(1);
  assert.deepEqual(await call({}), { pages: [] });
  assert.equal(submits, 1);
  // The browser application is a working page, not a pre-created Artifact.
  await ui.getByRole("button", { name: "应用启动台", exact: true }).click();
  const artifactCount = store.snapshot().artifacts.length;
  await ui.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  await expect(ui.locator(".topbar")).toBeHidden();
  await ui.getByRole("textbox", { name: "网站地址" }).fill(siteURL);
  await ui.getByRole("textbox", { name: "网站地址" }).press("Enter");
  await expect
    .poll(
      async () =>
        (await ui.evaluate(() => window.morphzDesktop!.browser.state()))
          ?.visible,
    )
    .toBe(true);
  const originalPage = await ui.evaluate(() =>
    window.morphzDesktop!.browser.state(),
  );
  assert.equal(originalPage!.artifactId, null);
  assert.equal(store.snapshot().artifacts.length, artifactCount);
  await ui
    .getByRole("button", { name: "允许 Agent 协助", exact: true })
    .click();
  await expect
    .poll(async () => {
      page = (await call({})).pages[0];
      return !!page;
    })
    .toBe(true);
  view = await snapshot();
  const draftFill = await call({
    pageId: page.pageId,
    epoch: page.epoch,
    action: {
      type: "fill",
      snapshotId: view.snapshotId,
      ref: view.elements.find((e: any) => e.label === "标题").ref,
      value: "返回后保留的草稿",
    },
  });
  assert.equal((await result(draftFill.id)).status, "succeeded");
  await ui.getByRole("button", { name: "返回工作空间", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await ui.evaluate(() => window.morphzDesktop!.browser.state()))
          ?.visible,
    )
    .toBe(false);
  await expect.poll(async () => (await call({})).pages.length).toBe(0);
  await ui.getByRole("tab", { name: "浏览器", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await ui.evaluate(() => window.morphzDesktop!.browser.state()))
          ?.visible,
    )
    .toBe(true);
  const restoredPage = await ui.evaluate(() =>
    window.morphzDesktop!.browser.state(),
  );
  assert.equal(restoredPage!.pageId, originalPage!.pageId);
  assert.equal(restoredPage!.granted, false);
  const native = await app.evaluate(
    async ({ webContents, BrowserWindow }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url + "/")!;
      const window = BrowserWindow.getAllWindows()[0]!;
      const view = window.contentView.children.find(
        (v) => "webContents" in v && (v as any).webContents.id === contents.id,
      )!;
      return {
        text: await contents.executeJavaScript(
          'document.querySelector("input[name=title]").value',
        ),
        bounds: view.getBounds(),
      };
    },
    siteURL,
  );
  assert.equal(native.text, "返回后保留的草稿");
  assert.ok(native.bounds.y <= 60, JSON.stringify(native.bounds));
  await expect(
    ui.getByRole("complementary", { name: "工作空间导航" }),
  ).toBeVisible();
  assert.ok(native.bounds.x >= 240, JSON.stringify(native.bounds));
  await ui.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  await expect(
    ui.getByRole("button", { name: "显示侧边栏", exact: true }),
  ).toBeVisible();
  await ui.getByRole("button", { name: "显示侧边栏", exact: true }).click();
  await expect(
    ui.getByRole("complementary", { name: "工作空间导航" }),
  ).toBeVisible();
  assert.equal(store.snapshot().artifacts.length, artifactCount);
  console.log(
    "PASS: real Electron embedded page, authenticated Host-tool protocol, snapshot/fill, takeover invalidation, human-approved one-time submit, result verification, cookie and Node isolation.",
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  site.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),
    new Promise<void>((r) => site.close(() => r())),
  ]);
  store.close();
  console.log("Isolated browser fixture:", directory);
}
import "./application-configuration.mjs";
