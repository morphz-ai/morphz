import { openSettings } from "./settings-test-helpers.mjs";
import { _electron, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
const port = Number(process.env.MORPHZ_APP_DESKTOP_TEST_PORT ?? 65419);
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
const dir = mkdtempSync(join(tmpdir(), "morphz-desktop-test-"));
const service = spawn(
  process.execPath,
  ["dist/service/apps/service/src/main.js"],
  {
    env: {
      ...process.env,
      MORPHZ_APP_PORT: String(port),
      MORPHZ_APP_DATA_DIR: join(dir, "data"),
      MORPHZ_APP_ENV_FILE: "",
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
  const env = { ...process.env, MORPHZ_APP_PROFILE: join(dir, "profile") };
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
  // Exercise the real preload and main-process gate, but do not launch a user's
  // browser during the isolated test.
  await app.evaluate(({ shell }) => {
    globalThis.__auditOpenedURLs = [];
    shell.openExternal = async (url) => {
      globalThis.__auditOpenedURLs.push(url);
    };
  });
  await window.evaluate(async () => {
    await window.morphzDesktop.openExternal("https://example.com/audit");
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:secret@example.com",
    ]) {
      let rejected = false;
      try {
        await window.morphzDesktop.openExternal(url);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Unsafe external link accepted");
    }
  });
  assert.deepEqual(await app.evaluate(() => globalThis.__auditOpenedURLs), [
    "https://example.com/audit",
  ]);
  await window
    .getByRole("button", { name: "查看本空间内容", exact: true })
    .click();
  await window
    .getByRole("button", { name: "关闭应用 内容", exact: true })
    .click();
  await expect(
    window.getByRole("button", { name: "查看本空间内容", exact: true }),
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
  const desktop = await window.evaluate(async () => {
    const result = await window.morphzDesktop.application.invoke({
      id: crypto.randomUUID(),
      method: "workspace",
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
  });
  assert.equal(desktop.centerId, web.centerId);
  assert.equal(desktop.principalId, web.principalId);
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
  await window.locator(".composer-media-tools").hover();
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
  await openSettings(window, "外观");
  await window.getByRole("button", { name: "亮色", exact: true }).click();
  await window.getByRole("button", { name: "电光青", exact: true }).click();
  await window.keyboard.press("Escape");
  await window.screenshot({ path: "test-results/desktop-light.png" });

  const appearance = window.getByRole("button", {
    name: "外观设置",
    exact: true,
  });
  const appearanceBox = await appearance.boundingBox();
  await window.mouse.click(
    appearanceBox.x + appearanceBox.width / 2,
    appearanceBox.y + appearanceBox.height / 2,
  );
  const quickAppearance = window.getByRole("group", {
    name: "外观设置面板",
    exact: true,
  });
  await expect(quickAppearance).toBeVisible();
  await quickAppearance
    .getByRole("button", { name: "暗色", exact: true })
    .click();
  await quickAppearance
    .getByRole("button", { name: "更多外观设置", exact: true })
    .click();
  const settings = window.getByRole("dialog", { name: "设置", exact: true });
  await expect(
    settings.getByRole("button", { name: "暗色", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await settings.getByLabel("阅读字号").selectOption("large");
  await settings.getByLabel("动画效果").selectOption("reduce");
  await expect(settings).toHaveCSS("animation-name", "none");
  await openSettings(window, "输入");
  await settings.getByLabel("发送快捷键").selectOption("mod-enter");
  await window.keyboard.press("Escape");
  await desktopInput.fill("TEST 本机发送偏好，不发送");
  await desktopInput.press("Enter");
  await expect(desktopInput).toHaveValue("TEST 本机发送偏好，不发送\n");
  await window.reload();
  const inputEntry = window.getByRole("button", { name: /向 Morphz 输入/ });
  await expect(desktopInput.or(inputEntry)).toBeVisible();
  if (await inputEntry.isVisible()) await inputEntry.click();
  await expect(desktopInput).toHaveValue("TEST 本机发送偏好，不发送\n");
  await openSettings(window, "输入");
  await expect(settings.getByLabel("发送快捷键")).toHaveValue("mod-enter");
  await settings.getByLabel("发送快捷键").selectOption("enter");
  await openSettings(window, "外观");
  await expect(settings.getByLabel("阅读字号")).toHaveValue("large");
  await settings.getByLabel("阅读字号").selectOption("standard");
  await settings.getByLabel("动画效果").selectOption("system");
  await settings.getByRole("button", { name: "亮色", exact: true }).click();
  await window.keyboard.press("Escape");
  await desktopInput.fill("");
  console.log(
    "PASS: native appearance quick menu, shared settings, reading/motion choices and multiline-send preference persist without sending a message.",
  );

  // Remote centers must not gain local file access or restart retired sync.
  // The embedded production test covers authorized original-file access.
  await window.getByLabel("工作空间选项").click();
  await expect(
    window.getByRole("button", { name: "资料导入与来源", exact: true }),
  ).toHaveCount(0);
  await window.keyboard.press("Escape");
  await assert.rejects(
    window.evaluate(() =>
      window.morphzDesktop.sources.choose("first-project", "directory"),
    ),
    /已停用/,
  );
  await assert.rejects(
    window.evaluate(() =>
      window.morphzDesktop.sources.control(
        "11111111-1111-4111-8111-111111111111",
        "refresh",
      ),
    ),
    /已停用/,
  );
  await assert.rejects(
    window.evaluate(() =>
      window.morphzDesktop.files.choose("first-project", "file"),
    ),
    /本机文件打开参数无效/,
  );
  const afterSource = await (await fetch(`${origin}/api/workspace`)).json();
  assert.deepEqual(
    afterSource.workspace.artifacts,
    desktop.workspace.artifacts,
  );
  assert.equal(
    await window.evaluate(() => typeof window.morphzDesktop.sources.readPath),
    "undefined",
  );
  await window
    .getByLabel("应用包文件")
    .setInputFiles("examples/applications/scratchpad.json");
  await window.getByRole("button", { name: "允许并安装" }).click();
  await window
    .getByRole("button", { name: "工作便笺 1.1.1", exact: true })
    .click();
  const application = window.frameLocator('iframe[title="工作便笺应用界面"]');
  await expect(application.locator("#status")).toContainText("已连接");
  await application.locator("#note").fill("真实桌面的独立认知应用");
  await application.getByRole("button", { name: "保存便笺状态" }).click();
  await expect(application.locator("#status")).toContainText("已保存");
  await application.getByRole("button", { name: "保存为文档" }).click();
  await expect(application.locator("#status")).toContainText(
    "文档已保存到工作空间",
  );
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
    window.getByRole("button", { name: "设置", exact: true }),
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
    .getByRole("dialog", { name: "搜索资料" })
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
  await expect(
    notifications.getByRole("group", { name: "提醒范围" }),
  ).toBeHidden();
  await notifications
    .getByRole("button", { name: "通知设置", exact: true })
    .click();
  const preferences = window.getByRole("dialog", { name: "设置", exact: true });
  const notificationBounds = await preferences.boundingBox();
  assert.ok(
    notificationBounds.x >= 0 &&
      notificationBounds.x + notificationBounds.width <= viewport.width,
  );
  assert.ok(
    notificationBounds.y >= 0 &&
      notificationBounds.y + notificationBounds.height <= viewport.height,
  );
  await expect(
    preferences.getByRole("radio", { name: "全部提醒" }),
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
  await window.getByLabel("项目名称", { exact: true }).fill("原生多对话验收");
  await window.getByRole("button", { name: "创建", exact: true }).click();
  await window
    .getByRole("button", { name: "查看本空间内容", exact: true })
    .click();
  await window
    .getByLabel("新建项目对话：原生多对话验收", { exact: true })
    .click();
  const projectChats = window.getByRole("group", {
    name: "原生多对话验收的会话",
    exact: true,
  });
  await expect(projectChats.locator(".conversation-choice")).toHaveCount(0);
  await window.getByLabel("AI 输入内容").fill("第二对话草稿，不发送");
  await expect(
    projectChats.getByLabel("继续草稿：对话 1", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    window.getByLabel("关闭应用 内容", { exact: true }),
  ).toBeVisible();
  await projectChats.getByLabel("草稿操作：对话 1", { exact: true }).click();
  await window.getByLabel("丢弃草稿：对话 1", { exact: true }).click();
  await expect(
    projectChats.getByLabel("继续草稿：对话 1", { exact: true }),
  ).toHaveCount(0);
  await projectChats
    .getByRole("button", { name: "已丢弃草稿 · 1", exact: true })
    .click();
  await projectChats.getByLabel("恢复草稿：对话 1", { exact: true }).click();
  if (!(await window.getByLabel("AI 输入内容").isVisible()))
    await window.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await expect(window.getByLabel("AI 输入内容")).toHaveValue(
    "第二对话草稿，不发送",
  );
  await expect(projectChats).toBeVisible();
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
    "PASS: native fixed global dialogue, project-local unsent drafts, preserved application, discard/restore and independent drafts.",
  );
  // The global content view reuses actual objects without launching a library
  // application or moving their workspace/conversation ownership.
  const beforeContent = await (await fetch(`${origin}/api/workspace`)).json();
  await nav.getByRole("button", { name: "内容", exact: true }).click();
  await expect(window).toHaveTitle("内容 — Morphz");
  await expect(window.getByLabel("内容范围", { exact: true })).toHaveValue(
    "all",
  );
  await expect(
    window.getByRole("tablist", { name: "已打开的应用" }),
  ).toHaveCount(0);
  const catalog = window.getByRole("region", { name: "全部内容", exact: true });
  await expect(catalog.locator(".artifact-card").first()).toBeVisible();
  for (const width of [1200, 760]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 820),
      width,
    );
    await window.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const image = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    writeFileSync(
      `test-results/desktop-content-${width}.png`,
      Buffer.from(image, "base64"),
    );
    assert.equal(
      await window.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  await catalog.locator(".artifact-card").first().click();
  await expect(window.locator(".breadcrumb")).toContainText("内容");
  await expect(window.locator(".object-paper")).toBeVisible();
  await window
    .locator(".breadcrumb")
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await expect(catalog.locator(".artifact-card").first()).toBeVisible();
  const afterContent = await (await fetch(`${origin}/api/workspace`)).json();
  assert.deepEqual(
    afterContent.workspace.applicationInstances,
    beforeContent.workspace.applicationInstances,
  );
  assert.deepEqual(
    afterContent.workspace.artifacts,
    beforeContent.workspace.artifacts,
  );
  assert.deepEqual(
    afterContent.workspace.inputs,
    beforeContent.workspace.inputs,
  );
  assert.deepEqual(
    afterContent.workspace.conversations,
    beforeContent.workspace.conversations,
  );
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  console.log(
    "PASS: native global content catalog, narrow layout, object opening/return and unchanged ownership, inputs and Sessions.",
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
import "./application-configuration.mjs";
