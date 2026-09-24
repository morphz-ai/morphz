import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const env = {
  ...process.env,
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  MORPHZ_APP_ENV_FILE: "",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    args: [
      process.argv.includes("--production")
        ? "tests/fixtures/production-desktop-entry.cjs"
        : "tests/fixtures/embedded-desktop-entry.cjs",
    ],
    env,
  });
  // Preference recovery may briefly create a hidden, inert reader window.
  await expect
    .poll(() => app.windows().some((page) => page.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  const page = app.windows().find((page) => page.url() === "morphz://app/");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  await expect(
    page.getByRole("region", { name: "认知应用工作空间" }),
  ).toBeVisible();
  assert.equal(page.url(), "morphz://app/");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  const state = await page.evaluate(async () => {
    const bridge = window.morphzDesktop.application;
    const boot = await bridge.invoke({
      id: crypto.randomUUID(),
      method: "workspace",
    });
    if (!boot.ok) throw new Error(JSON.stringify(boot));
    const command = {
      commandId: crypto.randomUUID(),
      operation: { type: "create-project", title: "内嵌 Electron 隔离验收" },
    };
    const first = await bridge.invoke({
      id: crypto.randomUUID(),
      method: "command",
      identityGeneration: boot.value.csrfToken,
      params: command,
    });
    const duplicate = await bridge.invoke({
      id: crypto.randomUUID(),
      method: "command",
      identityGeneration: boot.value.csrfToken,
      params: command,
    });
    const forbidden = await bridge.invoke({
      id: crypto.randomUUID(),
      method: "sql",
      params: "select",
    });
    const noHTTP = await fetch("/api/workspace");
    localStorage.setItem("fixture-recovery", "retained");
    return {
      centerId: boot.value.centerId,
      principalId: boot.value.principalId,
      first,
      duplicate,
      forbidden,
      noHTTP: noHTTP.status,
      secure: isSecureContext,
    };
  });
  assert.ok(state.secure);
  assert.equal(state.first.ok, true);
  assert.deepEqual(state.first, state.duplicate);
  assert.equal(state.forbidden.ok, false);
  assert.equal(state.noHTTP, 404);
  if (process.argv.includes("--production")) {
    const recovery = await app.evaluate(
      async ({ BrowserWindow, session }, path) => {
        const { collectLegacyPreferences, restorePreferences, emptyPage } =
          globalThis.__fixturePreferences;
        const appSession = session.fromPartition("persist:morphz-app");
        const identity = {
          centerId: "fixture-center",
          principalId: "fixture-human",
        };
        const prefix = "morphzwork:fixture-center:fixture-human:";
        const owner = "12345678-1234-4234-9234-123456789abc";
        const pending = JSON.stringify({
          commandId: "same-command",
          attachment: "same-attachment",
        });
        const original = new BrowserWindow({
          show: false,
          webPreferences: {
            session: appSession,
            sandbox: true,
            nodeIntegration: false,
          },
        });
        appSession.protocol.handle("http", () => emptyPage());
        try {
          await original.loadURL("http://127.0.0.1:65510/");
          await original.webContents.executeJavaScript(
            `localStorage.setItem(${JSON.stringify(prefix + "desktop:last-window")}, ${JSON.stringify(owner)}); localStorage.setItem(${JSON.stringify(prefix + "pending:message")}, ${JSON.stringify(pending)}); localStorage.setItem('morphzwork:other:other:draft', 'private-other');`,
          );
        } finally {
          original.destroy();
          appSession.protocol.unhandle("http");
        }
        const seed = await collectLegacyPreferences(
          BrowserWindow,
          appSession,
          ["http://127.0.0.1:65510"],
          identity,
        );
        const target = new BrowserWindow({
          show: false,
          webPreferences: {
            session: appSession,
            sandbox: true,
            nodeIntegration: false,
          },
        });
        try {
          await restorePreferences(target, seed);
          return await target.webContents.executeJavaScript(
            `({pending: localStorage.getItem(${JSON.stringify(seed.prefix + "pending:message")}), owner: sessionStorage.getItem('morphz:window'), other: localStorage.getItem('morphzwork:other:other:draft')})`,
          );
        } finally {
          target.destroy();
        }
      },
      join(process.cwd(), "apps/desktop/preferences.cjs"),
    );
    assert.deepEqual(recovery, {
      pending: JSON.stringify({
        commandId: "same-command",
        attachment: "same-attachment",
      }),
      owner: "12345678-1234-4234-9234-123456789abc",
      other: null,
    });
  }
  await expect(
    page.getByRole("button", { name: "内嵌 Electron 隔离验收", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "内嵌 Electron 隔离验收", exact: true })
    .click();
  // Retained pre-migration PDF compatibility; no new UI import entry.
  const imported = await page.evaluate(
    async ({ projectId, data }) => {
      const bridge = window.morphzDesktop.application;
      const boot = await bridge.invoke({
        id: crypto.randomUUID(),
        method: "workspace",
      });
      return bridge.invoke({
        id: crypto.randomUUID(),
        method: "pdf.import",
        identityGeneration: boot.value.csrfToken,
        params: {
          commandId: crypto.randomUUID(),
          projectId,
          relativePath: "reader.pdf",
          data: new Uint8Array(data),
        },
      });
    },
    {
      projectId: state.first.value.entityId,
      data: [...readFileSync("tests/fixtures/reader.pdf")],
    },
  );
  assert.equal(imported.ok, true, JSON.stringify(imported));
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "查看项目内容", exact: true }).click();
  await page.locator(".artifact-card").filter({ hasText: "reader" }).click();
  const reader = page.locator(".reading-app:visible");
  await expect(reader.locator(".pdf-text-layer")).toContainText("DESIGN NOTES");
  await expect(reader.locator(".pdf-text-layer")).toContainText("合成测试资料");
  await reader.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(reader.locator(".pdf-text-layer")).toContainText(
    "durable butterfly",
  );
  assert.ok(
    await reader
      .locator(".pdf-page canvas")
      .evaluate((canvas) => canvas.width > 300),
  );
  if (process.argv.includes("--production")) {
    const source = join(fixture, "embedded-native-source.md");
    writeFileSync(source, "Embedded source revision one");
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, source);
    const projectId = state.first.value.entityId;
    const grant = await page.evaluate(
      (projectId) => window.morphzDesktop.files.choose(projectId, "file"),
      projectId,
    );
    assert.equal(grant.text, "Embedded source revision one");
    writeFileSync(source, "Embedded source revision two");
    const refreshed = await page.evaluate(
      ({ projectId, grantId }) =>
        window.morphzDesktop.files.read({ projectId, grantId, path: "" }),
      { projectId, grantId: grant.reference.grantId },
    );
    assert.equal(refreshed.text, "Embedded source revision two");
    const sourceState = await page.evaluate(async () => {
      const result = await window.morphzDesktop.application.invoke({
        id: crypto.randomUUID(),
        method: "workspace",
      });
      return result.value.workspace.artifacts.filter(
        (item) => item.source?.mode === "linked",
      ).length;
    });
    assert.equal(
      sourceState,
      0,
      "Original file is not imported or synchronized",
    );
    await page.evaluate(
      ({ projectId, grantId }) =>
        window.morphzDesktop.files.revoke({ projectId, grantId }),
      { projectId, grantId: grant.reference.grantId },
    );
    // An isolated guest receives a synthetic page in its own session;
    // no application HTTP service or external network is involved.
    const partition =
      "persist:morphz-browser-" +
      createHash("sha256")
        .update(state.centerId + ":" + state.principalId)
        .digest("hex");
    await app.evaluate(({ session }, partition) => {
      session
        .fromPartition(partition)
        .protocol.handle(
          "https",
          () =>
            new Response(
              "<!doctype html><title>Embedded native browser</title><p>Isolated website</p>",
              { headers: { "Content-Type": "text/html" } },
            ),
        );
    }, partition);
    const browser = await page.evaluate(async (projectId) => {
      const browser = window.morphzDesktop.browser;
      const opened = await browser.open({
        projectId,
        url: "https://embedded-fixture.invalid/",
      });
      const guest = document.createElement("webview");
      guest.id = "embedded-browser-fixture";
      guest.setAttribute("partition", opened.surface.partition);
      guest.setAttribute("src", opened.surface.src);
      guest.style.cssText =
        "position:fixed;left:350px;top:150px;width:600px;height:350px;z-index:100";
      document.body.append(guest);
      await browser.visibility(opened.pageId, true);
      return opened;
    }, projectId);
    assert.equal(browser.granted, false);
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.morphzDesktop.browser.state())?.title,
        ),
      )
      .toBe("Embedded native browser");
    const websiteIsolation = await app.evaluate(async ({ webContents }) => {
      const site = webContents
        .getAllWebContents()
        .find((web) => web.getURL() === "https://embedded-fixture.invalid/");
      return site.executeJavaScript(
        "({node: typeof require, bridge: typeof window.morphzDesktop})",
      );
    });
    assert.deepEqual(websiteIsolation, {
      node: "undefined",
      bridge: "undefined",
    });
    await page.evaluate(async (id) => {
      await window.morphzDesktop.browser.close(id);
      document.getElementById("embedded-browser-fixture")?.remove();
    }, browser.pageId);
  }
  const manifest = JSON.parse(
    readFileSync("examples/applications/scratchpad.json", "utf8"),
  );
  manifest.id = "test.embedded-isolation";
  manifest.title = "内嵌沙箱验收";
  manifest.permissions = ["artifacts.read"];
  await page.evaluate(async (manifest) => {
    const bridge = window.morphzDesktop.application;
    const boot = await bridge.invoke({
      id: crypto.randomUUID(),
      method: "workspace",
    });
    if (!boot.ok) throw new Error(JSON.stringify(boot));
    const command = async (operation) => {
      const reply = await bridge.invoke({
        id: crypto.randomUUID(),
        method: "command",
        identityGeneration: boot.value.csrfToken,
        params: { commandId: crypto.randomUUID(), operation },
      });
      if (!reply.ok) throw new Error(JSON.stringify(reply));
      return reply.value;
    };
    await command({ type: "install-application", manifest });
    await command({
      type: "launch-application",
      workspaceId: boot.value.workspace.projects.find((p) => p.kind === "desk")
        .id,
      applicationId: manifest.id,
      applicationVersion: manifest.version,
    });
  }, manifest);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("tab", { name: "内嵌沙箱验收" }).click();
  const frame = page.frameLocator('iframe[title="内嵌沙箱验收应用界面"]');
  await expect(frame.locator("#status")).toContainText("已连接");
  assert.deepEqual(
    await frame.locator("body").evaluate(async () => {
      let parentBlocked = false,
        networkBlocked = false;
      try {
        void parent.document.body;
      } catch {
        parentBlocked = true;
      }
      try {
        await fetch("/api/workspace");
      } catch {
        networkBlocked = true;
      }
      return {
        parentBlocked,
        networkBlocked,
        node: typeof window.require,
        desktop: typeof window.morphzDesktop,
      };
    }),
    {
      parentBlocked: true,
      networkBlocked: true,
      node: "undefined",
      desktop: "undefined",
    },
  );
  await frame.locator("#note").fill("越权写入不应成功");
  await frame.getByRole("button", { name: "保存为文档" }).click();
  await expect(frame.locator("#status")).toContainText("权限");
  await page.reload();
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  const restored = await page.evaluate(async () => {
    const reply = await window.morphzDesktop.application.invoke({
      id: crypto.randomUUID(),
      method: "workspace",
    });
    return { reply, storage: localStorage.getItem("fixture-recovery") };
  });
  assert.equal(restored.reply.ok, true);
  assert.equal(restored.reply.value.centerId, state.centerId);
  assert.equal(restored.storage, "retained");
  assert.deepEqual(errors, []);
  if (process.argv.includes("--production") && process.platform === "darwin") {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect.poll(() => app.windows().length).toBe(0);
    await app.evaluate(({ app }) => app.emit("activate"));
    await expect
      .poll(() =>
        app.windows().some((window) => window.url() === "morphz://app/"),
      )
      .toBe(true);
    const reopened = app
      .windows()
      .find((window) => window.url() === "morphz://app/");
    await expect(reopened.locator(".wordmark")).toHaveText("Morphz");
    assert.equal(
      await reopened.evaluate(() => localStorage.getItem("fixture-recovery")),
      "retained",
    );
  }
  console.log(
    "Embedded Electron: bundled morphz:// UI, secure preload, direct SQLite, idempotent receipt, retained PDF compatibility/render, native in-place file read without sync, isolated native browser, sandbox iframe, reload storage and close/activate lifecycle passed; no TCP listener.",
  );
} finally {
  await app?.close();
  rmSync(fixture, { recursive: true, force: true });
}
