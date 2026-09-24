import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const env = {
  ...process.env,
  MORPHZ_APP_ENV_FILE: "",
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
async function launch() {
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  page = app.windows().find((p) => p.url() === "morphz://app/");
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
}
try {
  await launch();
  const before = await page.evaluate(async () => {
    const api = window.morphzDesktop.application;
    const boot = (
      await api.invoke({ id: crypto.randomUUID(), method: "workspace" })
    ).value;
    const projectId = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    ).id;
    const owner = sessionStorage.getItem("morphz:window");
    const prefix = `morphz:${boot.centerId}:${boot.principalId}:`;
    const key = prefix + `draft:${owner}:inputs`;
    const quotes = Array.from({ length: 4 }, (_, i) => ({
      id: crypto.randomUUID(),
      text: `TEST 待发引用 ${i + 1}`,
      comment: "",
      source: {
        kind: "message",
        projectId,
        title: "TEST Morphz",
        messageId: `input:fixture-${i}`,
        inputId: null,
        conversationId: projectId,
        createdAt: new Date().toISOString(),
      },
    }));
    const raw = JSON.stringify({
      [projectId + ":quotes"]: {
        body: "",
        selection: "",
        revision: null,
        textQuotes: quotes,
      },
    });
    localStorage.setItem(key, raw);
    return { key, raw, owner };
  });
  await page.reload();
  await expect(page.locator(".text-quote-chip")).toHaveCount(4);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), before.key),
    before.raw,
  );
  // Reproduce an existing profile's old HTTP-origin draft alongside the current
  // quotes-only window. Old-origin data must not retarget the current window.
  await app.evaluate(async ({ BrowserWindow, session }, key) => {
    const partition = session.fromPartition("persist:morphz-app");
    const { emptyPage } = globalThis.__fixturePreferences;
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: partition,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const prefix = key.slice(0, key.indexOf("draft:")),
      owner = "12345678-1234-4234-9234-123456789abc";
    partition.protocol.handle("http", () => emptyPage());
    try {
      await window.loadURL("http://127.0.0.1:65419/");
      await window.webContents.executeJavaScript(
        `localStorage.setItem(${JSON.stringify(prefix + "desktop:last-window")},${JSON.stringify(owner)});localStorage.setItem(${JSON.stringify(prefix + `draft:${owner}:inputs`)},${JSON.stringify(JSON.stringify({ old: { body: "TEST 旧窗口未发送内容" } }))});`,
      );
    } finally {
      window.destroy();
      partition.protocol.unhandle("http");
    }
  }, before.key);
  await app.close();
  await launch();
  await expect(page.locator(".text-quote-chip")).toHaveCount(4);
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), before.key),
    before.raw,
  );
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("morphz:window")),
    before.owner,
  );
  await page.evaluate((key) => localStorage.setItem(key, "{}"), before.key);
  await page.reload();
  await expect(page.locator(".text-quote-chip")).toHaveCount(0);
  await app.close();
  await launch();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("morphz:window")),
    before.owner,
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), before.key),
    "{}",
  );
  console.log(
    JSON.stringify({
      ok: true,
      fixture,
      quotes: 4,
      reloaded: true,
      restarted: true,
      oldOriginDoesNotRetarget: true,
    }),
  );
} catch (error) {
  if (page)
    writeFileSync(
      join(fixture, "draft-state.json"),
      JSON.stringify(
        await page.evaluate(() => Object.entries(localStorage)),
        null,
        2,
      ),
    );
  throw error;
} finally {
  await app?.close();
}
