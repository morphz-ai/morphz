import { _electron, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
const port = Number(process.env.MORPHZWORK_DESKTOP_TEST_PORT ?? 65419);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
try {
  await fetch(`${origin}/api/health`, {
    signal: AbortSignal.timeout(500),
  });
  throw new Error(
    `${port} is already in use; the desktop smoke test requires a free development port.`,
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
      MORPHZWORK_PORT: String(port),
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
      const r = await fetch(`${origin}/api/health`);
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
    args: ["apps/desktop/main.cjs", `--center=${origin}`],
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
  await window.getByRole("button", { name: "资料 1.0.0", exact: true }).click();
  await window
    .getByRole("button", { name: "关闭应用 资料", exact: true })
    .click();
  await expect(
    window.getByRole("button", { name: "资料 1.0.0", exact: true }),
  ).toBeVisible();
  await expect(window.locator(".statusbar")).toHaveCount(0);
  await window.getByLabel("AI 输入内容").fill("桌面快捷键检查");
  await window.getByLabel("AI 输入内容").press("Control+j");
  assert.equal(await window.getByLabel("AI 输入内容").isVisible(), false);
  await window.keyboard.press("Control+j");
  assert.equal(
    await window.getByLabel("AI 输入内容").inputValue(),
    "桌面快捷键检查",
  );
  const web = await (await fetch(`${origin}/api/workspace`)).json();
  const desktop = await window.evaluate(
    async () => await (await fetch("/api/workspace")).json(),
  );
  assert.equal(desktop.workspace.id, web.workspace.id);
  assert.equal(desktop.workspace.revision, web.workspace.revision);
  const desktopInput = window.getByLabel("AI 输入内容");
  await desktopInput.fill("原生输入区验收，不发送");
  await expect(window.locator(".conversation")).toBeVisible();
  await window
    .getByRole("main", { name: "主工作区" })
    .click({ position: { x: 640, y: 160 } });
  await expect(desktopInput).toHaveCount(0);
  await window.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await expect(desktopInput).toBeFocused();
  await expect(desktopInput).toHaveValue("原生输入区验收，不发送");
  await window.getByLabel("更多输入选项", { exact: true }).click();
  await window.getByLabel("固定输入框", { exact: true }).click();
  await window
    .getByRole("main", { name: "主工作区" })
    .click({ position: { x: 640, y: 160 } });
  await expect(desktopInput).toBeVisible();
  await expect(window.getByLabel("取消固定输入框")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await desktopInput.fill("");
  console.log(
    "PASS: native composer focus expands history, outside clicks collapse, pin keeps it open, and drafts survive.",
  );
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
  await window
    .getByRole("button", { name: "工作便笺 1.0.0", exact: true })
    .click();
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
  const appBounds = await window
    .locator(".cognitive-application-frame")
    .boundingBox();
  const barBounds = await window.locator(".topbar").boundingBox();
  assert.equal(barBounds.height, 48);
  assert.equal(appBounds.y, barBounds.y + barBounds.height);
  await expect(
    window.locator(".topbar").getByRole("tab", { name: "工作便笺" }),
  ).toBeVisible();
  await expect(
    window.locator(".sidebar-header").getByLabel("外观设置", { exact: true }),
  ).toBeVisible();
  await expect(
    window.locator(".sidebar-header .notification-trigger"),
  ).toBeVisible();
  await expect(window.locator(".topbar .input-toggle")).toHaveCount(0);
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
    const upperEdge = await window.locator(".topbar").evaluate((el) => {
      const style = getComputedStyle(el, "::before");
      return {
        region: style.getPropertyValue("-webkit-app-region"),
        height: style.height,
      };
    });
    assert.deepEqual(upperEdge, { region: "drag", height: "6px" });
    const navigation = window.getByRole("navigation", { name: "主导航" });
    for (const name of ["项目", "事项"]) {
      await navigation
        .getByRole("button", { name: new RegExp(`^${name}`) })
        .click();
      await expect(window.locator(".toolbar-title button")).toHaveCount(0);
      assert.notEqual(
        await window
          .locator(".page-toolbar-slot")
          .evaluate((el) =>
            getComputedStyle(el).getPropertyValue("-webkit-app-region"),
          ),
        "no-drag",
        "Toolbar whitespace must remain draggable, not a full-width no-drag container.",
      );
      const regions = await window
        .locator(
          ".topbar button, .topbar input, .topbar select, .topbar summary",
        )
        .evaluateAll((elements) =>
          elements
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) =>
              getComputedStyle(el).getPropertyValue("-webkit-app-region"),
            ),
        );
      assert.ok(
        regions.length > 0 && regions.every((region) => region === "no-drag"),
      );
    }
    await navigation
      .getByRole("button", { name: "工作台", exact: true })
      .click();
    await window
      .getByRole("button", { name: "应用启动台", exact: true })
      .click();
    console.log(
      "PASS: native upper-edge drag regions preserve clickable controls and draggable page-header whitespace.",
    );
  }
  const sidebarBounds = await window.locator(".sidebar").boundingBox();
  const toggleBounds = await window.locator(".sidebar-toggle").boundingBox();
  assert.ok(
    Math.abs(
      sidebarBounds.x +
        sidebarBounds.width -
        toggleBounds.x -
        toggleBounds.width -
        16,
    ) < 1,
  );
  assert.ok(
    Math.abs(
      toggleBounds.y +
        toggleBounds.height / 2 -
        barBounds.y -
        barBounds.height / 2,
    ) < 1,
  );
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
  const contentBounds = await window.locator(".workspace").boundingBox();
  assert.ok(
    Math.abs(
      searchBounds.x +
        searchBounds.width / 2 -
        contentBounds.x -
        contentBounds.width / 2,
    ) < 1,
  );
  assert.ok(searchBounds.x >= contentBounds.x + 12);
  assert.ok(
    searchBounds.x >= 0 &&
      searchBounds.x + searchBounds.width <= viewport.width,
  );
  assert.ok(
    searchBounds.y >= 0 &&
      searchBounds.y + searchBounds.height <= viewport.height,
  );
  // Electron's CDP screenshot can crop at non-default zoom; capture the native compositor.
  await window.bringToFront();
  await window.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
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
  await window.getByRole("button", { name: "通知", exact: true }).click();
  const notifications = window.getByRole("dialog", {
    name: "通知",
    exact: true,
  });
  await expect(
    notifications.getByRole("heading", { name: "通知", exact: true }),
  ).toBeFocused();
  const notificationBounds = await notifications.boundingBox();
  assert.ok(
    notificationBounds.x >= 0 &&
      notificationBounds.x + notificationBounds.width <= viewport.width,
  );
  assert.ok(
    notificationBounds.y >= 0 &&
      notificationBounds.y + notificationBounds.height <= viewport.height,
  );
  await expect(
    notifications.getByRole("radio", { name: "仅高优先级" }),
  ).toBeVisible();
  await window.bringToFront();
  await window.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const notificationImage = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  writeFileSync(
    "test-results/desktop-notifications-zoom-200.png",
    Buffer.from(notificationImage, "base64"),
  );
  await window.keyboard.press("Escape");
  await expect(
    window.getByRole("button", { name: "通知", exact: true }),
  ).toBeFocused();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  console.log(
    "PASS: real Electron launch, shared center, isolated renderer, no Node exposure, composer shortcuts.",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1200, 820),
  );
  const nav = window.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("button").first()).toHaveText("对话");
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await expect(window).toHaveTitle("对话 — Morphz");
  if (!(await window.getByLabel("AI 输入内容").isVisible()))
    await window.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await window.getByLabel("AI 输入内容").fill("原生全局对话草稿，不发送");
  await expect(window.locator(".conversation")).toBeVisible();
  await window.getByRole("button", { name: "新建项目", exact: true }).click();
  await window.getByLabel("新对象标题", { exact: true }).fill("原生多对话验收");
  await window.getByRole("button", { name: "创建", exact: true }).click();
  await window.getByRole("button", { name: "资料 1.0.0", exact: true }).click();
  await window.getByLabel("项目对话", { exact: true }).click();
  await window.getByLabel("新建项目对话").click();
  await expect(window.getByLabel("项目对话", { exact: true })).toHaveText(
    "对话 2",
  );
  await expect(
    window.getByLabel("关闭应用 资料", { exact: true }),
  ).toBeVisible();
  await window.getByLabel("AI 输入内容").fill("第二对话草稿，不发送");
  await window.getByLabel("项目对话", { exact: true }).click();
  await window.getByLabel("归档：对话 2", { exact: true }).click();
  await expect(window.getByLabel("AI 输入内容")).toHaveCount(0);
  await window.getByRole("button", { name: "恢复对话", exact: true }).click();
  if (!(await window.getByLabel("AI 输入内容").isVisible()))
    await window.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await expect(window.getByLabel("AI 输入内容")).toHaveValue(
    "第二对话草稿，不发送",
  );
  await window.getByLabel("项目对话", { exact: true }).click();
  await expect(
    window.getByLabel("项目对话列表", { exact: true }),
  ).toBeVisible();
  await window.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const conversationImage = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  writeFileSync(
    "test-results/desktop-conversations.png",
    Buffer.from(conversationImage, "base64"),
  );
  await window.keyboard.press("Escape");
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  if (!(await window.getByLabel("AI 输入内容").isVisible()))
    await window.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await expect(window.getByLabel("AI 输入内容")).toHaveValue(
    "原生全局对话草稿，不发送",
  );
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  console.log(
    "PASS: native fixed global dialogue, project conversations, preserved application, archive/restore and independent drafts.",
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
  assert.equal((await fetch(`${origin}/api/health`)).ok, true);
  console.log(
    "PASS: normal desktop quit leaves the independent center available.",
  );
} finally {
  if (app) await app.close();
  service.kill("SIGTERM");
  await new Promise((r) => service.once("exit", r));
  rmSync(dir, { recursive: true });
}
