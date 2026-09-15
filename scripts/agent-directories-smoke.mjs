import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Actual production entry, native bridge and application store. Substitute only
// the OS picker result, never grant validation or input persistence.
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const repo = join(fixture, "example-repo");
mkdirSync(repo);
writeFileSync(join(repo, "main.ts"), "export const original = 1;\n");
const env = {
  ...process.env,
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  MORPHZ_APP_ENV_FILE: "",
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
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
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".wordmark")).toHaveText("Morphz");
  const boot = () =>
    page.evaluate(async () => {
      const result = await window.morphzDesktop.application.invoke({
        id: crypto.randomUUID(),
        method: "workspace",
      });
      if (!result.ok) throw Error(JSON.stringify(result));
      return result.value;
    });
  // A native picker must also survive blur in an unpinned work surface. The
  // dedicated dialogue canvas never auto-collapses and cannot cover this bug.
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const input = page.getByLabel("AI 输入内容");
  if (!(await input.isVisible()))
    await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await input.fill("TEST 原生目录取消保留草稿，不发送");
  const directoryButton = page.getByRole("button", {
    name: "授权 Agent 读写目录",
    exact: true,
  });
  const unchanged = await boot();
  for (const outcome of ["cancel", "error"]) {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        new Promise((resolve, reject) => {
          globalThis.__directoryPickerResult = { resolve, reject };
        });
    });
    await directoryButton.click();
    await expect(directoryButton).toBeDisabled();
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => false,
      });
      window.dispatchEvent(new Event("blur"));
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(done)),
    );
    await expect(input).toHaveValue("TEST 原生目录取消保留草稿，不发送");
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hasFocus");
      window.dispatchEvent(new Event("focus"));
    });
    await app.evaluate((_, outcome) => {
      const picker = globalThis.__directoryPickerResult;
      if (outcome === "cancel")
        picker.resolve({ canceled: true, filePaths: [] });
      else picker.reject(new Error("TEST 原生选择器失败"));
      delete globalThis.__directoryPickerResult;
    }, outcome);
    await expect(directoryButton).toBeEnabled();
    await expect(directoryButton).toBeFocused();
    await expect(input).toHaveValue("TEST 原生目录取消保留草稿，不发送");
    assert.deepEqual((await boot()).workspace, unchanged.workspace);
  }
  // Revocation removes a focused chip. Exercise it on the unpinned work page,
  // not only on the persistent dialogue canvas where lost focus is masked.
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [repo],
    });
  }, repo);
  await directoryButton.click();
  const revokeWorkGrant = page.getByRole("button", {
    name: "撤销 example-repo 的读写权限",
    exact: true,
  });
  await expect(revokeWorkGrant).toBeEnabled();
  await revokeWorkGrant.click();
  await expect(revokeWorkGrant).toHaveCount(0);
  try {
    await expect(directoryButton).toBeFocused();
  } catch (error) {
    console.log(
      "Revocation focus",
      await page.evaluate(() => ({
        hasFocus: document.hasFocus(),
        active: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute("aria-label"),
        mode: document
          .querySelector(".primary-panel")
          ?.getAttribute("data-interaction"),
      })),
    );
    throw error;
  }
  await expect(input).toHaveValue("TEST 原生目录取消保留草稿，不发送");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const before = await boot();
  assert.equal(before.capabilities.agentDirectories, true);
  await input.fill("原对话未发送草稿");
  await page.getByRole("button", { name: "工作空间选项", exact: true }).click();
  for (const name of ["打开文件", "打开文件夹", "资料导入与来源"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await page.keyboard.press("Escape");
  await input.focus();
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (
        options.buttonLabel !== "允许读写" ||
        options.message !== "允许此对话中的 Agent 读写文本文件，可随时撤销。"
      )
        throw Error("Missing explicit directory permission");
      return { canceled: false, filePaths: [repo] };
    };
  }, repo);
  await page
    .getByRole("button", { name: "授权 Agent 读写目录", exact: true })
    .click();
  await expect(page.getByLabel("此对话的目录读写权限")).toContainText(
    "example-repo",
  );
  await expect(input).toHaveValue("原对话未发送草稿");
  await expect(page.locator(".local-file-view")).toHaveCount(0);
  assert.deepEqual((await boot()).workspace, before.workspace);
  await page.reload();
  await expect(page.getByLabel("此对话的目录读写权限")).toContainText(
    "example-repo",
  );
  await expect(input).toHaveValue("原对话未发送草稿");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(page.getByLabel("此对话的目录读写权限")).toHaveCount(0);
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page.getByLabel("此对话的目录读写权限")).toContainText(
    "example-repo",
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "morphz://app/",
    );
    window.setSize(760, 540);
    window.webContents.setZoomFactor(1);
  });
  await expect(
    page.getByRole("button", { name: "撤销 example-repo 的读写权限" }),
  ).toBeInViewport();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "morphz://app/",
    );
    window.setSize(1380, 920);
    window.webContents.setZoomFactor(2);
  });
  await expect
    .poll(() => page.evaluate(() => innerWidth))
    .toBeLessThanOrEqual(690);
  const grantBox = await page.getByLabel("此对话的目录读写权限").boundingBox();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert.ok(
    grantBox.x >= 0 && grantBox.x + grantBox.width <= viewport.width + 1,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  // Electron CDP screenshots crop at non-default zoom; use the compositor,
  // matching the existing desktop zoom regression workflow.
  const zoomImage = await app.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === "morphz://app/")
        .capturePage()
    )
      .toPNG()
      .toString("base64"),
  );
  writeFileSync(
    "test-results/agent-directories-200percent.png",
    Buffer.from(zoomImage, "base64"),
  );
  await expect(
    page.getByRole("button", { name: "撤销 example-repo 的读写权限" }),
  ).toBeInViewport();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "morphz://app/",
    );
    window.webContents.setZoomFactor(1);
    window.setSize(1152, 768);
  });
  await input.fill("TEST 目录权限输入，不调用模型");
  await page.getByRole("button", { name: "保存输入", exact: true }).click();
  await expect
    .poll(async () => (await boot()).workspace.inputs.length)
    .toBe(before.workspace.inputs.length + 1);
  const sent = (await boot()).workspace.inputs.at(-1);
  assert.equal(sent.directories.length, 1);
  assert.equal(sent.directories[0].path, realpathSync(repo));
  assert.equal(sent.localFile, undefined);
  assert.equal(sent.attachments, undefined);
  await expect(page.getByLabel("此对话的目录读写权限")).toContainText(
    "example-repo",
  );
  await input.fill("撤销时仍保留的草稿");
  await page
    .getByRole("button", { name: "撤销 example-repo 的读写权限" })
    .click();
  await expect(page.getByLabel("此对话的目录读写权限")).toHaveCount(0);
  await expect(input).toHaveValue("撤销时仍保留的草稿");
  await page.reload();
  await expect(input).toHaveValue("撤销时仍保留的草稿");
  await expect(page.getByLabel("此对话的目录读写权限")).toHaveCount(0);
  const after = await boot();
  assert.deepEqual(after.workspace.artifacts, before.workspace.artifacts);
  assert.deepEqual(after.workspace.annotations, before.workspace.annotations);
  assert.equal(
    readFileSync(join(repo, "main.ts"), "utf8"),
    "export const original = 1;\n",
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(fixture, "profile/local-file-references.json"), "utf8"),
    ).grants.length,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS production Electron: explicit read-write directory grant; no file viewer/import/index/autosend; conversation/workspace scope; persisted permissions and drafts; revoke.",
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: "test-results/agent-directories-failure.png" })
      .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  rmSync(fixture, { recursive: true, force: true });
}
