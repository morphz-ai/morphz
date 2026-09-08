import { _electron, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
try {
  await fetch("http://127.0.0.1:65419/api/health", {
    signal: AbortSignal.timeout(500),
  });
  throw new Error(
    "65419 is already in use; the desktop smoke test requires a free development port.",
  );
} catch (e) {
  if (e.message.includes("already in use")) throw e;
}
const dir = mkdtempSync(join(tmpdir(), "morphzwork-desktop-test-"));
const service = spawn(
  process.execPath,
  ["dist/service/apps/service/src/main.js"],
  {
    env: {
      ...process.env,
      MORPHZWORK_PORT: "65419",
      MORPHZWORK_DATA_DIR: join(dir, "data"),
      MORPHZWORK_ENV_FILE: "",
    },
    stdio: "pipe",
  },
);
let app;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:65419/api/health");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, "service did not start");
  const env = { ...process.env, MORPHZWORK_TEST_PROFILE: join(dir, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: ["apps/desktop/main.cjs", "--development"],
    env,
  });
  const window = await app.firstWindow();
  await window.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await expect(window.locator(".wordmark")).toHaveText("Morphz");
  await expect(window).toHaveTitle("工作台 — Morphz");
  const identity = await app.evaluate(({ app }) => ({
    name: app.getName(),
    userData: app.getPath("userData"),
  }));
  assert.equal(identity.name, "Morphz");
  assert.equal(identity.userData, join(dir, "profile"));
  assert.equal(await window.evaluate(() => typeof window.require), "undefined");
  const security = await app.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration,
      contextIsolation: p.contextIsolation,
    };
  });
  assert.deepEqual(security, {
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
  });
  await window.getByLabel("AI 输入内容").fill("桌面快捷键检查");
  await window.getByLabel("AI 输入内容").press("Control+j");
  assert.equal(await window.getByLabel("AI 输入内容").isVisible(), false);
  await window.keyboard.press("Control+j");
  assert.equal(
    await window.getByLabel("AI 输入内容").inputValue(),
    "桌面快捷键检查",
  );
  const web = await (
    await fetch("http://127.0.0.1:65419/api/workspace")
  ).json();
  const desktop = await window.evaluate(
    async () => await (await fetch("/api/workspace")).json(),
  );
  assert.equal(desktop.workspace.id, web.workspace.id);
  assert.equal(desktop.workspace.revision, web.workspace.revision);
  await window.getByLabel("AI 输入内容").fill("");
  await window.getByRole("button", { name: "外观设置", exact: true }).click();
  await window.getByRole("button", { name: "亮色", exact: true }).click();
  await window.getByRole("button", { name: "电光青", exact: true }).click();
  await window.screenshot({ path: "test-results/desktop-light.png" });
  await window.getByRole("button", { name: "外观设置", exact: true }).click();
  const sourceDir = join(dir, "source-fixture");
  mkdirSync(sourceDir);
  writeFileSync(
    join(sourceDir, "native-source.md"),
    "Initial native source text",
  );
  // The OS chooser result is deterministic in this isolated test; the real main
  // process, preload boundary, filesystem and center synchronization all run.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, sourceDir);
  await window.getByLabel("工作空间选项").click();
  await window.getByRole("button", { name: "导入资料", exact: true }).click();
  const importer = window.getByRole("dialog", { name: "导入资料" });
  await importer.getByRole("button", { name: "连接来源", exact: true }).click();
  await importer.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(importer.getByText(/尚未读取内容/)).toBeVisible();
  await importer
    .getByRole("button", { name: "开始只读同步", exact: true })
    .click();
  await expect(
    importer.getByRole("button", { name: "暂停同步", exact: true }),
  ).toBeEnabled();
  await importer.screenshot({ path: "test-results/desktop-sources.png" });
  await importer.getByRole("button", { name: "暂停同步", exact: true }).click();
  writeFileSync(
    join(sourceDir, "native-source.md"),
    "Updated native source text",
  );
  await importer.getByRole("button", { name: "恢复同步", exact: true }).click();
  await expect(
    importer.getByRole("button", { name: "暂停同步", exact: true }),
  ).toBeEnabled();
  const synced = await window.evaluate(
    async () => (await (await fetch("/api/workspace")).json()).workspace,
  );
  assert.equal(synced.artifacts[0].revision, 2);
  assert.equal(
    synced.artifacts[0].content.markdown,
    "Updated native source text",
  );
  assert.equal(synced.artifacts[0].source.mode, "linked");
  await importer
    .getByRole("button", { name: "关闭资料导入", exact: true })
    .click();
  assert.equal(
    await window.evaluate(() => typeof window.morphzDesktop.sources.readPath),
    "undefined",
  );
  await window
    .getByLabel("应用包文件")
    .setInputFiles("examples/applications/scratchpad.json");
  await window.getByRole("button", { name: "允许并安装" }).click();
  await window.getByRole("listitem", { name: "工作便笺 1.0.0" }).dblclick();
  const application = window.frameLocator('iframe[title="工作便笺应用界面"]');
  await expect(application.locator("#status")).toContainText("已连接");
  await application.locator("#note").fill("真实桌面的独立认知应用");
  await application.getByRole("button", { name: "保存便笺状态" }).click();
  await expect(application.locator("#status")).toContainText("已保存");
  assert.deepEqual(
    await application.locator("body").evaluate(() => ({
      node: typeof window.require,
      desktop: typeof window.morphzDesktop,
    })),
    { node: "undefined", desktop: "undefined" },
  );
  await window.reload();
  await expect(application.locator("#note")).toHaveValue(
    "真实桌面的独立认知应用",
  );
  await window.screenshot({ path: "test-results/desktop-application.png" });
  await window.getByRole("button", { name: "应用启动台", exact: true }).click();
  console.log(
    "PASS: real Electron installs and launches an independent application, saves state, restores after reload, and exposes neither Node nor desktop IPC to its frame.",
  );
  if (process.platform === "darwin") {
    assert.equal(
      await window.locator(".app").getAttribute("data-desktop"),
      "mac",
    );
    assert.equal(
      await window
        .locator(".topbar")
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("-webkit-app-region"),
        ),
      "drag",
    );
    assert.equal(
      await window
        .locator(".sidebar-toggle")
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("-webkit-app-region"),
        ),
      "no-drag",
    );
  }
  await window.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  assert.equal(await window.locator(".sidebar").isVisible(), false);
  await window.getByRole("button", { name: "显示侧边栏", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(760, 540),
  );
  assert.equal(await window.getByLabel("AI 输入内容").isVisible(), true);
  const composerBounds = await window.locator(".composer").boundingBox();
  assert.ok(
    composerBounds.y >= 0 && composerBounds.y + composerBounds.height <= 540,
  );
  await window.screenshot({ path: "test-results/desktop-minimum.png" });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1380, 920);
    w.webContents.setZoomFactor(2);
  });
  await expect
    .poll(() => window.evaluate(() => innerWidth))
    .toBeLessThanOrEqual(690);
  await window.getByLabel("AI 输入内容").press("Control+k");
  await expect(window.getByLabel("全文搜索")).toBeFocused();
  const searchBounds = await window
    .getByRole("dialog", { name: "搜索工作空间" })
    .boundingBox();
  const viewport = await window.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert.ok(
    searchBounds.x >= 0 &&
      searchBounds.x + searchBounds.width <= viewport.width,
  );
  assert.ok(
    searchBounds.y >= 0 &&
      searchBounds.y + searchBounds.height <= viewport.height,
  );
  // Electron's CDP screenshot can crop at non-default zoom; capture the native compositor.
  const zoomImage = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  writeFileSync(
    "test-results/desktop-zoom-200.png",
    Buffer.from(zoomImage, "base64"),
  );
  await window.keyboard.press("Escape");
  await expect(window.getByLabel("AI 输入内容")).toBeFocused();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  console.log(
    "PASS: real Electron launch, shared center, isolated renderer, no Node exposure, composer shortcuts.",
  );
  if (process.platform === "darwin") {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      )
      .toBe(0);
    const reopened = app.waitForEvent("window");
    await app.evaluate(({ app }) => {
      app.emit("second-instance");
      app.emit("second-instance");
    });
    const restored = await reopened;
    await restored
      .getByRole("heading", { name: "工作台", exact: true })
      .waitFor();
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
    console.log(
      "PASS: closing the macOS window then reopening via duplicate launch restores exactly one window.",
    );
  }
  await app.close();
  app = undefined;
  assert.equal((await fetch("http://127.0.0.1:65419/api/health")).ok, true);
  console.log(
    "PASS: normal desktop quit leaves the independent center available.",
  );
} finally {
  if (app) await app.close();
  service.kill("SIGTERM");
  await new Promise((r) => service.once("exit", r));
  rmSync(dir, { recursive: true });
}
