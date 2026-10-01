import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  BrowserBroker,
  platformBrowserPageAuthority,
} from "../packages/application/src/browser.js";
import { createAppServer } from "../apps/service/src/http.js";
import { assertNoLegacyBusinessTables } from "../tests/host-transport-invariant.js";
import { localAccess } from "../packages/core/src/model.js";

const directory = mkdtempSync(join(tmpdir(), "morphz-browser-test-"));
const port = Number(process.env.MORPHZ_APP_BROWSER_TEST_PORT ?? 65426);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const centerURL = `http://127.0.0.1:${port}`;
const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
const domains = await openApplicationDomainsHost(directory, store);
const broker = new BrowserBroker(store, platformBrowserPageAuthority(domains));
const center = createAppServer(store, {
  port,
  webRoot: resolve("dist/web"),
  browser: broker,
  bookmarkDomain: domains.browser,
  platformWork: domains.work,
  platformDocuments: domains.content,
  platformScripts: domains.content,
  platformReader: domains.reader,
  messageAttachments: domains.messageAttachments,
  images: domains.images,
  uiPackages: domains.uiPackages,
  notifications: domains.notifications,
  platformTaskRuns: domains.taskRuns(),
});
const site = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>合成网页</title><h1>浏览器验收页</h1>");
});
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    site.once("error", reject);
    site.listen(0, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    center.once("error", reject);
    center.listen(port, "127.0.0.1", resolve);
  });
  const siteURL = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  const env = {
    ...process.env,
    MORPHZ_APP_ENV_FILE: "",
    MORPHZ_APP_PROFILE: join(directory, "profile"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: ["apps/desktop/main.cjs", `--center=${centerURL}`],
    env,
  });
  const ui = await app.firstWindow();
  ui.setDefaultTimeout(20_000);
  await expect(
    ui.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
  await ui.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  await ui.getByRole("textbox", { name: "网站地址" }).fill(siteURL);
  await ui.getByRole("textbox", { name: "网站地址" }).press("Enter");
  await expect
    .poll(async () => {
      const state = await ui.evaluate(() =>
        window.morphzDesktop!.browser.state(),
      );
      return state?.visible && state.url === siteURL ? state : null;
    })
    .not.toBeNull();
  const page = await ui.evaluate(() => window.morphzDesktop!.browser.state());
  assert.ok(page);
  assert.equal(page.artifactId, null);
  const authorized = await domains.work.authority.withSession(
    localAccess,
    () => {},
    (actor) =>
      domains.work.service.getProject(actor, { projectId: page.projectId }),
  );
  assert.equal(authorized.id, page.projectId);
  assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));
  await expect
    .poll(() =>
      app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((contents) => contents.getURL() === url),
        siteURL,
      ),
    )
    .toBe(true);
  const isolation = await app.evaluate(({ webContents }, url) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === url)!;
    const preferences = guest.getLastWebPreferences();
    return {
      nodeIntegration: preferences.nodeIntegration,
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      preload: preferences.preload,
      storagePath: guest.session.getStoragePath(),
    };
  }, siteURL);
  assert.equal(isolation.nodeIntegration, false);
  assert.equal(isolation.sandbox, true);
  assert.equal(isolation.contextIsolation, true);
  assert.ok(!isolation.preload);
  assert.match(isolation.storagePath!, /morphz-browser-/);
  await ui.getByRole("button", { name: "允许 Agent 协助" }).click();
  await expect
    .poll(
      async () =>
        (await ui.evaluate(() => window.morphzDesktop!.browser.state()))
          ?.granted,
    )
    .toBe(true);
  await ui.getByRole("button", { name: "我来接管" }).click();
  await expect
    .poll(
      async () =>
        (await ui.evaluate(() => window.morphzDesktop!.browser.state()))
          ?.granted,
    )
    .toBe(false);
  await ui.reload();
  assert.equal(
    await ui.evaluate(() => window.morphzDesktop!.browser.state()),
    null,
  );
  console.log(
    "PASS: Platform-only Browser opens a real isolated page and revokes control",
  );
} finally {
  await app?.close();
  center.closeStreams();
  if (center.listening)
    await new Promise<void>((resolve) => center.close(() => resolve()));
  if (site.listening)
    await new Promise<void>((resolve) => site.close(() => resolve()));
  await domains.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
