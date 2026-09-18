import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Automated fixture only. Never attaches to the installed/user Desktop, sends a
// model request, starts an HTTP application host or changes a production profile.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(
  process.env.MORPHZ_SCRIPT_SMOKE_ARTIFACT_ROOT ||
    join(homedir(), ".morphz", "artifacts"),
);
mkdirSync(artifactRoot, { recursive: true });
const output = mkdtempSync(join(artifactRoot, "script-studio-desktop-"));
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
mkdirSync(join(fixture, "home"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (path) => ({
  path: relative(root, path),
  sha256: sha256(readFileSync(path)),
});
function distFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? distFiles(path) : [path];
  });
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      typeof value === "string" &&
      !/^(MORPHZ_|MORPHZ_WORK_|DOUBAO_|OPENAI_|ANTHROPIC_|ELECTRON_RUN_AS_NODE$)/.test(
        key,
      ),
  ),
);
Object.assign(env, {
  HOME: join(fixture, "home"),
  XDG_CONFIG_HOME: join(fixture, "config"),
  XDG_DATA_HOME: join(fixture, "xdg-data"),
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  MORPHZ_APP_ENV_FILE: "",
});
const result = {
  entry: "tests/fixtures/production-desktop-entry.cjs -> apps/desktop/main.cjs",
  output,
  fixture,
  checks: [],
  screenshots: [],
  unverified: [
    "user's current Desktop or production Runtime installation",
    "real model writing quality (no model is called in this test)",
    "OS title-bar hit testing and native save-picker visual interaction (picker selections are deterministic fixtures)",
    "Microsoft Word visual/print rendering and partner acceptance",
  ],
};
let desktop;
let child;
let page;
let failure;
const errors = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const editor = () => page.getByLabel("剧本正文", { exact: true });
const checked = (text) => result.checks.push(text);
async function snapshot() {
  return page.evaluate(async () => {
    const reply = await window.morphzDesktop.application.invoke({
      id: crypto.randomUUID(),
      method: "workspace",
    });
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    return reply.value;
  });
}
async function currentPage() {
  await expect
    .poll(
      () => desktop.windows().some((item) => item.url() === "morphz://app/"),
      {
        timeout: 20000,
      },
    )
    .toBe(true);
  page = desktop.windows().find((item) => item.url() === "morphz://app/");
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".app")).toBeVisible();
}
async function launchStudio() {
  await button("应用启动台").click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "剧本工作室 1.0.0" })
    .click();
  await expect(
    page.getByRole("region", { name: "剧本工作区", exact: true }),
  ).toBeVisible();
}
async function createItem(title, kind = "episode") {
  const labels = {
    episode: "新建一集",
    scene: "添加分场",
    outline: "新建全剧大纲",
    character: "添加角色",
    setting: "添加设定",
    source: "添加参考资料",
  };
  await button("添加剧本内容").click();
  await page
    .getByRole("group", { name: "添加剧本内容菜单", exact: true })
    .getByRole("button", { name: labels[kind], exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: labels[kind], exact: true });
  await expect(dialog.getByLabel("条目类型", { exact: true })).toHaveValue(
    kind,
  );
  await dialog.getByLabel("条目标题", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "创建条目", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("文稿标题", { exact: true })).toHaveValue(title);
}
async function saveText(text) {
  await editor().fill(text);
  await button("保存文稿").click();
  await expect(button("保存文稿")).toBeDisabled();
  await expect(page.locator(".script-edit-status")).toContainText("已保存 v");
}
async function openInput() {
  const input = page.getByLabel("AI 输入内容");
  const reopen = page.getByRole("button", { name: /向 Morphz 输入/ });
  await expect(async () => {
    if (await reopen.isVisible()) await reopen.click({ timeout: 1000 });
    await input.focus({ timeout: 1000 });
    await expect(input).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 5000 });
}
async function capture(name) {
  // DOM assertions may complete before Chromium paints the updated save status.
  // Wait for a painted frame before asking Electron for its native surface.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const capture = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (item) => item.webContents.getURL() === "morphz://app/",
    );
    const image = await window.webContents.capturePage();
    return {
      png: image.toPNG().toString("base64"),
      size: image.getSize(),
      bounds: window.getContentBounds(),
      zoom: window.webContents.getZoomFactor(),
    };
  });
  const bytes = Buffer.from(capture.png, "base64");
  const path = join(output, name);
  writeFileSync(path, bytes);
  const { png: _png, ...geometry } = capture;
  result.screenshots.push({ path, sha256: sha256(bytes), ...geometry });
}
async function focusOwnWindow() {
  // DOM clicks do not necessarily activate an Electron application on macOS.
  // Establish the real foreground precondition; never stub isFocused or bypass
  // the production native-save gate.
  // Address only this fixture's exact child PID. Electron's app.focus may not
  // activate a second instance of the same bundle on macOS. Ask AppKit to
  // activate that running instance; this does not fake focus or touch user data.
  if (process.platform === "darwin") {
    assert.ok(child?.pid && child.exitCode === null && !child.killed);
    const activation = execFileSync(
      "/usr/bin/swift",
      [
        "-e",
        `import AppKit
let pid = pid_t(CommandLine.arguments[1])!
guard let target = NSRunningApplication(processIdentifier: pid), !target.isTerminated else { fatalError("Missing isolated Electron child") }
let accepted = target.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
print("pid=\\(pid) accepted=\\(accepted) active=\\(target.isActive)")`,
        String(child.pid),
      ],
      { encoding: "utf8", timeout: 10000, maxBuffer: 32768 },
    );
    (result.nativeActivations ??= []).push(activation.trim());
  }
  // Activation is asynchronous. Remain bounded and retain diagnostics if denied.
  // Only the real BrowserWindow focus state can satisfy the production gate.
  await expect(async () => {
    const focus = await desktop.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (item) => item.webContents.getURL() === "morphz://app/",
      );
      if (!window) throw new Error("Missing isolated test window");
      if (window.isMinimized()) window.restore();
      window.show();
      app.focus({ steal: true });
      window.focus();
      return {
        id: window.id,
        focused: window.isFocused(),
        visible: window.isVisible(),
        focusable: window.isFocusable(),
        minimized: window.isMinimized(),
        focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      };
    });
    (result.focusAttempts ??= []).push(focus);
    expect(
      focus.focused,
      "isolated Electron window must really own focus",
    ).toBe(true);
  }).toPass({ timeout: 8000, intervals: [100, 250, 500] });
}
try {
  result.artifacts = [
    ...distFiles(join(root, "dist")),
    join(root, "apps/desktop/main.cjs"),
    join(root, "apps/desktop/preload.cjs"),
    join(root, "apps/desktop/script-export.cjs"),
    join(root, "tests/fixtures/production-desktop-entry.cjs"),
    fileURLToPath(import.meta.url),
  ]
    .sort()
    .map(fingerprint);
  desktop = await _electron.launch({
    cwd: root,
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
    timeout: 20000,
  });
  child = desktop.process();
  child.stdout?.on("data", (data) => process.stdout.write(data));
  child.stderr?.on("data", (data) => process.stderr.write(data));
  await currentPage();
  result.pid = child.pid;
  result.profile = await desktop.evaluate(({ app }) => app.getPath("userData"));
  assert.equal(resolve(result.profile), resolve(fixture, "profile"));
  const initial = await snapshot();
  assert.equal(initial.runtime.configured, false);
  assert.equal(initial.workspace.scriptProductions.length, 0);
  result.centerId = initial.centerId;
  const bridge = await page.evaluate(async () => ({
    secure: isSecureContext,
    node: typeof window.require,
    noHTTP: (await fetch("/api/workspace")).status,
    sql: await window.morphzDesktop.application.invoke({
      id: crypto.randomUUID(),
      method: "sql",
      params: "select",
    }),
  }));
  assert.equal(bridge.secure, true);
  assert.equal(bridge.node, "undefined");
  assert.equal(bridge.noHTTP, 404);
  assert.equal(bridge.sql.ok, false);
  checked(
    "production main.cjs, isolated profile/center, secure restricted preload; fixture forbids TCP application listen",
  );
  await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (item) => item.webContents.getURL() === "morphz://app/",
    );
    window.setSize(1440, 960);
    window.webContents.setZoomFactor(1);
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await launchStudio();
  await expect(page.getByText("从一部剧开始", { exact: true })).toBeVisible();
  await button("手动新建剧本").click();
  const create = page.getByRole("dialog", {
    name: "手动新建剧本",
    exact: true,
  });
  await create
    .getByLabel("剧本名称", { exact: true })
    .fill("TEST 正式入口剧本验收 · 非客户资料");
  await create.getByRole("button", { name: "创建", exact: true }).click();
  await expect(create).toBeHidden();
  await createItem("第一集 · 合成雨夜");
  const savedText =
    "TEST 合成原创场景，不是合作方材料。\n雨夜，林舟推开车站的门，读到母亲留下的信。";
  await saveText(savedText);
  const first = (await snapshot()).workspace.scriptProductions[0];
  result.productionId = first.id;
  result.itemId = first.items[0].id;
  await page.reload();
  await expect(editor()).toHaveValue(savedText);
  const dirtyText = savedText + "\nTEST 待保存：他决定天亮前回家。";
  await editor().fill(dirtyText);
  await page.reload();
  await expect(editor()).toHaveValue(dirtyText);
  await button("关闭应用 剧本工作室").click();
  await launchStudio();
  await expect(editor()).toHaveValue(dirtyText);
  assert.equal((await snapshot()).workspace.scriptProductions.length, 1);
  await button("保存文稿").click();
  await expect(button("保存文稿")).toBeDisabled();
  checked(
    "empty launcher, Human creation, SQLite text save, dirty reload and closed-application restoration",
  );

  await button("项目规范与交付模板").click();
  const settings = page.getByRole("dialog", {
    name: "项目规范与交付模板",
    exact: true,
  });
  await settings
    .getByLabel("资料权利与使用范围", { exact: true })
    .fill("TEST 仅限本隔离合成资料，不是客户授权；本测试不调用模型。");
  await settings
    .getByLabel("我确认本项目所选资料允许交给当前模型服务处理", { exact: true })
    .check();
  await settings.getByRole("button", { name: "保存规范", exact: true }).click();
  await expect(settings).toBeHidden();
  const beforeCompose = (await snapshot()).workspace;
  await button("生成候选").click();
  await page
    .getByRole("dialog", { name: "准备生成候选请求", exact: true })
    .getByRole("button", { name: "准备到输入框", exact: true })
    .click();
  await expect(page.getByTestId("script-input-reference")).toContainText(
    "第一集 · 合成雨夜",
  );
  assert.deepEqual((await snapshot()).workspace.inputs, beforeCompose.inputs);
  await createItem("TEST 内部切换大纲", "outline");
  await openInput();
  await expect(page.getByTestId("script-input-reference")).toContainText(
    "第一集 · 合成雨夜",
  );
  const afterCompose = (await snapshot()).workspace;
  assert.deepEqual(afterCompose.inputs, beforeCompose.inputs);
  assert.deepEqual(afterCompose.conversations, beforeCompose.conversations);
  await expect(
    page.getByRole("region", { name: "剧本工作区", exact: true }),
  ).toBeVisible();
  checked(
    "compose is an unsent draft; internal selection preserves original target, app and conversations",
  );
  await page
    .getByRole("navigation", { name: "剧本目录", exact: true })
    .getByRole("button", { name: /第一集 · 合成雨夜/ })
    .click();
  await expect(editor()).toHaveValue(dirtyText);
  await capture("editing.png");

  await page.getByRole("tab", { name: /审阅 0/ }).click();
  await page.getByLabel("审阅引用", { exact: true }).fill("母亲留下的信");
  await page
    .getByLabel("审阅意见", { exact: true })
    .fill("TEST 人工核对返乡动机。");
  await button("添加意见").click();
  await expect(page.locator(".script-review")).toContainText(
    "TEST 人工核对返乡动机。",
  );
  await button("记录解决方式").click();
  const resolution = page.getByRole("dialog", {
    name: "解决审阅意见",
    exact: true,
  });
  await resolution
    .getByLabel("决定说明", { exact: true })
    .fill("TEST 已核对信件与回家决定的因果关系。");
  await resolution.getByRole("button", { name: "确认", exact: true }).click();
  await expect(resolution).toBeHidden();
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await button("提交审阅").click();
  await button("批准此版本").click();
  const approval = page.getByRole("dialog", {
    name: "批准此版本",
    exact: true,
  });
  await approval
    .getByLabel("决定说明", { exact: true })
    .fill("TEST 仅验证人工批准路径。");
  await approval.getByRole("button", { name: "确认", exact: true }).click();
  await expect(approval).toBeHidden();
  await button("锁稿").click();
  await expect(editor()).toHaveAttribute("readonly", "");
  await expect(button("生成候选")).toBeDisabled();
  const docxPath = join(output, "synthetic-desktop-script.docx");
  // Only the OS picker response is stubbed in this isolated process. IPC, main
  // origin/access checks, immutable receipt reconstruction and filesystem writes
  // remain production code. This is not manual native-dialog acceptance.
  await desktop.evaluate(({ dialog, BrowserWindow }, destination) => {
    globalThis.__scriptSaveFixture = { mode: "cancel", calls: 0, destination };
    dialog.showSaveDialog = async (parent, options) => {
      const state = globalThis.__scriptSaveFixture;
      state.calls++;
      state.parentMatches =
        parent ===
        BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "morphz://app/",
        );
      state.options = options;
      if (state.mode === "cancel") return { canceled: true };
      if (state.mode === "fail")
        throw new Error("TEST save destination unavailable");
      return { canceled: false, filePath: state.destination };
    };
  }, docxPath);
  await page.evaluate(() => {
    window.__scriptFocusTrace = [];
    document.addEventListener("focusin", (event) => {
      const element = event.target;
      window.__scriptFocusTrace.push({
        tag: element.tagName,
        label: element.getAttribute("aria-label"),
        text: element.textContent?.slice(0, 80),
      });
    });
  });
  await focusOwnWindow();
  await button("导出 Word").click();
  await expect(page.locator(".script-export-status")).toContainText(
    "已取消保存",
  );
  assert.equal(existsSync(docxPath), false);
  await expect(button("导出 Word")).toBeEnabled();
  result.cancelFocus = await page.evaluate(() => ({
    documentFocused: document.hasFocus(),
    active: document.activeElement?.outerHTML.slice(0, 500),
    trace: window.__scriptFocusTrace,
  }));
  console.log("CANCEL_FOCUS", JSON.stringify(result.cancelFocus));
  await expect(button("导出 Word")).toBeFocused();
  const cancelled = (await snapshot()).workspace.scriptProductions.find(
    (value) => value.id === first.id,
  );
  assert.equal(cancelled.exports.length, 1);
  const exportId = cancelled.exports[0].id;
  result.exportId = exportId;
  const beforeInvalidCalls = await desktop.evaluate(
    () => globalThis.__scriptSaveFixture.calls,
  );
  const invalid = await page.evaluate(
    async (scope) => {
      try {
        await window.morphzDesktop.scriptExports.save({
          ...scope,
          filePath: "/TEST-not-allowed.docx",
        });
        return "unexpected-success";
      } catch (error) {
        return String(error);
      }
    },
    {
      centerId: initial.centerId,
      principalId: initial.principalId,
      productionId: first.id,
      exportId,
    },
  );
  assert.match(invalid, /导出请求无效/);
  assert.equal(
    await desktop.evaluate(() => globalThis.__scriptSaveFixture.calls),
    beforeInvalidCalls,
  );
  await page
    .getByRole("navigation", { name: "剧本目录", exact: true })
    .getByRole("button", { name: "概览", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "继续创作", exact: true }),
  ).toBeVisible();
  await page.getByText("导出历史（1）", { exact: true }).click();
  const retrySave = page.getByRole("button", {
    name: `重新下载 ${exportId.slice(0, 8)}`,
    exact: true,
  });
  await desktop.evaluate(() => {
    globalThis.__scriptSaveFixture.mode = "fail";
  });
  await focusOwnWindow();
  await retrySave.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "TEST save destination unavailable" }),
  ).toBeVisible();
  await expect(page.locator(".script-export-status")).toHaveCount(0);
  assert.equal(existsSync(docxPath), false);
  await expect(retrySave).toBeFocused();
  await desktop.evaluate(() => {
    globalThis.__scriptSaveFixture.mode = "save";
  });
  await focusOwnWindow();
  await retrySave.click();
  await expect(page.locator(".script-export-status")).toContainText(
    "Word 已保存：synthetic-desktop-script.docx",
  );
  await expect(retrySave).toBeFocused();
  const picker = await desktop.evaluate(() => globalThis.__scriptSaveFixture);
  assert.equal(picker.calls, 3);
  assert.equal(picker.parentMatches, true);
  assert.deepEqual(picker.options.filters, [
    { name: "Word 文档", extensions: ["docx"] },
  ]);
  result.nativeSave = {
    cancelled: true,
    failureSurfaced: true,
    sameReceiptRetried: true,
    pickerStubbed: true,
  };
  checked(
    "restricted native save IPC: cancelled and failed attempts do not report saved; history retry writes exact receipt without new export",
  );
  const bytes = readFileSync(docxPath);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(bytes.includes(Buffer.from("word/document.xml")));
  assert.ok(bytes.includes(Buffer.from("他决定天亮前回家")));
  result.docx = { path: docxPath, bytes: bytes.length, sha256: sha256(bytes) };

  // Inject only a post-publication cleanup failure in our own Electron process.
  // Main-process authorization, the actual link/write and renderer receipt stay real.
  const warningPath = join(output, "synthetic-desktop-script-warning.docx");
  await desktop.evaluate(
    (_, target) => {
      // Playwright evaluates this in its main-process utility context, which
      // has no dynamic-import callback. Builtins stay in this isolated test
      // process; no Node capability is exposed through the renderer bridge.
      const fs = process.getBuiltinModule("fs");
      const path = process.getBuiltinModule("path");
      const originalUnlink = fs.unlinkSync;
      globalThis.__scriptRestoreUnlink = () => {
        fs.unlinkSync = originalUnlink;
      };
      fs.unlinkSync = (filename) => {
        if (
          path.dirname(String(filename)) === target.directory &&
          path.basename(String(filename)).startsWith(".morphz-script-")
        )
          throw new Error("TEST post-publication cleanup denied");
        return originalUnlink(filename);
      };
      globalThis.__scriptSaveFixture.destination = target.destination;
    },
    { directory: output, destination: warningPath },
  );
  try {
    await focusOwnWindow();
    await retrySave.click();
    await expect(page.locator(".script-export-status")).toContainText(
      "Word 已保存：synthetic-desktop-script-warning.docx",
    );
    await expect(page.locator(".script-export-status")).toContainText(
      "临时文件清理失败",
    );
    await expect(page.locator(".script-export-status")).toContainText(
      "无需重复导出",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(retrySave).toBeFocused();
    assert.deepEqual(readFileSync(warningPath), bytes);
    const staging = readdirSync(output).filter((name) =>
      name.startsWith(".morphz-script-"),
    );
    assert.equal(staging.length, 1);
    assert.deepEqual(readFileSync(join(output, staging[0])), bytes);
    await capture("saved-with-cleanup-warning.png");
    result.nativeSave.cleanupWarning = true;
    result.warningDocx = {
      path: warningPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
    rmSync(join(output, staging[0]));
    checked(
      "post-publication cleanup fault: actual file retained, saved warning visible, no false failure or new export receipt; fixture staging removed",
    );
  } finally {
    await desktop.evaluate(() => {
      globalThis.__scriptRestoreUnlink?.();
      delete globalThis.__scriptRestoreUnlink;
    });
  }
  const locked = (await snapshot()).workspace.scriptProductions.find(
    (item) => item.id === first.id,
  );
  assert.equal(
    locked.items.find((item) => item.id === result.itemId).status,
    "locked",
  );
  assert.equal(locked.exports.length, 1);
  assert.equal(locked.exports[0].items[0].itemId, result.itemId);
  checked(
    "Human review resolution, approval and lock; production main process saved OOXML with exact exported item",
  );
  await page
    .getByRole("navigation", { name: "剧本目录", exact: true })
    .getByRole("button", { name: /第一集 · 合成雨夜/ })
    .click();
  await capture("locked-export.png");
  // The native saver must not relax the existing blanket browser-download gate.
  await desktop.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (value) => value.webContents.getURL() === "morphz://app/",
    ).webContents;
    globalThis.__scriptBlockedDownload = null;
    contents.session.once("will-download", (event, item) => {
      globalThis.__scriptBlockedDownload = event.defaultPrevented === true;
      if (!event.defaultPrevented) item.cancel();
    });
    contents.downloadURL("data:text/plain,TEST-forbidden-browser-download");
  });
  await expect
    .poll(() => desktop.evaluate(() => globalThis.__scriptBlockedDownload))
    .toBe(true);
  checked("existing browser-download blocking remains enabled");
  await page.reload();
  await expect(editor()).toHaveValue(dirtyText);
  await expect(editor()).toHaveAttribute("readonly", "");
  assert.equal((await snapshot()).centerId, initial.centerId);
  assert.deepEqual(
    (await snapshot()).workspace.inputs,
    initial.workspace.inputs,
  );
  if (process.platform === "darwin") {
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((item) => item.webContents.getURL() === "morphz://app/")
        .close(),
    );
    await expect.poll(() => desktop.windows().length).toBe(0);
    await desktop.evaluate(({ app }) => app.emit("activate"));
    await currentPage();
    await expect(editor()).toHaveValue(dirtyText);
    await expect(editor()).toHaveAttribute("readonly", "");
    assert.equal((await snapshot()).centerId, initial.centerId);
    checked(
      "macOS close/activate retains same center, locked document and unsent draft without replay",
    );
  }
  assert.deepEqual(errors, []);
  checked("no page errors and zero submitted model inputs");
} catch (error) {
  failure = error;
  result.error = String(error.stack || error);
  if (page && !page.isClosed()) {
    try {
      await capture("failure.png");
    } catch (captureError) {
      result.captureError = String(captureError);
    }
  }
} finally {
  try {
    if (desktop) {
      await desktop.close();
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        "own Electron process must terminate",
      );
      result.electronExit = { code: child.exitCode, signal: child.signalCode };
    }
    rmSync(fixture, { recursive: true, force: true });
    assert.equal(existsSync(fixture), false);
    result.cleanup =
      "passed: own Electron closed and temporary fixture removed";
  } catch (error) {
    result.cleanup = String(error.stack || error);
    failure ||= error;
  }
  result.status = failure ? "failed" : "passed";
  result.pageErrors = errors;
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: result.status,
        output,
        checks: result.checks,
        cleanup: result.cleanup,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(
  "PASS: production Script Studio Desktop workflow and teardown (synthetic data, no model)",
);
