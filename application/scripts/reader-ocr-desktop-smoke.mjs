import { _electron, expect } from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readingOcrModels } from "../dist/service/packages/application/src/reader-ocr.js";

// Isolated fixtures only. Books/models are explicitly supplied, never read from user data.
const models = process.argv[2];
const scanManifest = process.argv[3];
if (!models)
  throw new Error(
    "Usage: node scripts/reader-ocr-desktop-smoke.mjs /absolute/model-fixture-directory [scan-manifest.json]",
  );
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const cache = join(fixture, "data", "reader-ocr-models");
mkdirSync(cache, { recursive: true });
readingOcrModels.forEach((model, i) =>
  copyFileSync(
    join(models, i === 0 ? "small-det.tar" : "small-rec.tar"),
    join(cache, `${model.sha256}.tar`),
  ),
);
const env = {
  ...process.env,
  MORPHZ_APP_ENV_FILE: "",
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  app.on("window", (candidate) => {
    candidate.on("console", (message) => {
      if (message.type() === "error")
        console.error("OCR fixture renderer:", message.text().slice(0, 800));
    });
    candidate.on("pageerror", (error) =>
      console.error(
        "OCR fixture error:",
        (error.stack ?? error.message).slice(0, 1600),
      ),
    );
  });
  app.process().stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    if (/Error|CSP|refused|Preload/i.test(text))
      console.error(text.slice(0, 1500));
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  page = app.windows().find((p) => p.url() === "morphz://app/");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bridge = async (method, params) =>
    page.evaluate(
      async ({ method, params }) => {
        const api = window.morphzDesktop.application,
          boot = await api.invoke({
            id: crypto.randomUUID(),
            method: "workspace",
          });
        const result = await api.invoke({
          id: crypto.randomUUID(),
          method,
          params,
          identityGeneration: boot.value.csrfToken,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      },
      { method, params },
    );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page
    .getByRole("region", { name: "应用", exact: true })
    .getByRole("button", { name: "阅读 1.0.0" })
    .click();
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入读物", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name: "TEST OCR 本地识别.pdf",
    mimeType: "application/pdf",
    buffer: readFileSync(resolve("tests/fixtures/reader.pdf")),
  });
  await expect(
    page.locator(".reading-app:visible .pdf-text-layer"),
  ).toContainText("DESIGN NOTES");
  await page.getByText("扫描文字识别", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "识别这一页", exact: true }),
  ).toBeEnabled();
  const started = Date.now();
  await page.getByRole("button", { name: "识别这一页", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /正在识别|准备本地/ }),
  ).toBeVisible();
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/ocr.html"))
    .toBe(true);
  const sandbox = app
    .windows()
    .find((p) => p.url() === "morphz://app/ocr.html");
  const isolation = await sandbox.evaluate(async () => ({
    mainApi: typeof window.morphzDesktop,
    node: typeof window.require,
    applicationRead: (await fetch("morphz://app/api/workspace")).status,
    externalNetwork: await fetch(
      "https://example.invalid/morphz-ocr-isolation-test",
    ).then(
      () => "allowed",
      () => "denied",
    ),
  }));
  assert.deepEqual(isolation, {
    mainApi: "undefined",
    node: "undefined",
    applicationRead: 403,
    externalNetwork: "denied",
  });
  await expect(page.locator(".reader-ocr-compare .reader-text")).toContainText(
    /DESIGN\s*NOTES/,
    { timeout: 90000 },
  );
  const boot = await bridge("workspace");
  const book = boot.workspace.artifacts.find(
    (a) => a.title === "TEST OCR 本地识别",
  );
  const bound = { artifactId: book.id, revision: book.revision, page: 1 };
  const status = await bridge("reader.ocr", { operation: "status", ...bound });
  assert.ok(status.sectionId);
  const section = await bridge("reader.read", {
    artifactId: book.id,
    revision: book.revision,
    sectionId: status.sectionId,
  });
  assert.ok(section.ocr.items.length);
  assert.equal(section.book.format, "pdf-ocr");
  await page.getByText("OCR 识别文本 · 校对与版式", { exact: true }).click();
  await page.getByText("校对识别文字", { exact: true }).click();
  await page
    .getByLabel("校对后的文字", { exact: true })
    .fill("DESIGN NOTES — 校对测试");
  await page.getByRole("button", { name: "保存校对版本", exact: true }).click();
  await expect(page.locator(".reader-ocr-compare .reader-text")).toContainText(
    "校对测试",
  );
  const next = await bridge("reader.ocr", { operation: "status", ...bound });
  assert.notEqual(next.sectionId, status.sectionId);
  const old = await bridge("reader.read", {
    artifactId: book.id,
    revision: book.revision,
    sectionId: status.sectionId,
  });
  assert.equal(old.text, section.text);
  await expect(page.locator(".reader-ocr-original canvas")).toBeVisible();
  await expect(page.locator(".reader-ocr-original .pdf-page")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(
    page.locator(".reader-ocr-original .pdf-text-layer"),
  ).toContainText("DESIGN NOTES");
  await page.getByRole("button", { name: "书签与批注", exact: true }).click();
  await page.getByRole("button", { name: "保存当前位置", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "书签 · 第 1 页 · OCR",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await page.screenshot({ path: join(fixture, "reader-ocr-desktop.png") });
  await page.reload();
  await expect(page.locator(".reader-ocr-compare .reader-text")).toContainText(
    "校对测试",
  );
  const matrix = [];
  if (scanManifest) {
    const sample = JSON.parse(readFileSync(scanManifest, "utf8"));
    assert.ok(sample.title.startsWith("TEST "));
    assert.ok(sample.source && sample.pages.length);
    const pdf = readFileSync(resolve(dirname(scanManifest), sample.pdf));
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    if (sample.sha256) assert.equal(sha256, sample.sha256);
    writeFileSync(
      join(fixture, "scan-provenance.json"),
      JSON.stringify({ ...sample, sha256 }, null, 2),
    );
    await page.getByRole("button", { name: "全部读物", exact: true }).click();
    const scanPicker = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入读物", exact: true }).click();
    await (
      await scanPicker
    ).setFiles({
      name: `${sample.title}.pdf`,
      mimeType: "application/pdf",
      buffer: pdf,
    });
    await expect(
      page.getByText("扫描页没有文字层 · 可在本机识别", { exact: true }),
    ).toBeVisible();
    const imported = await bridge("workspace");
    const scan = imported.workspace.artifacts.find(
      (a) => a.title === sample.title,
    );
    const normalized = (text) => text.replace(/\s/g, "");
    function distance(a, b) {
      let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++)
          row[j] = Math.min(
            row[j - 1] + 1,
            prev[j] + 1,
            prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0),
          );
        prev = row;
      }
      return prev[b.length];
    }
    for (const expectedPage of sample.pages) {
      assert.ok(Number.isInteger(expectedPage.page) && expectedPage.page > 0);
      await page.getByRole("button", { name: "目录", exact: true }).click();
      await page
        .getByRole("complementary", { name: "阅读目录", exact: true })
        .getByRole("button", {
          name: `第 ${expectedPage.page} 页`,
          exact: true,
        })
        .click();
      const close = page.getByRole("button", {
        name: "关闭阅读侧栏",
        exact: true,
      });
      if (await close.isVisible()) await close.click();
      await page
        .getByLabel("OCR 阅读顺序", { exact: true })
        .selectOption(expectedPage.layout);
      await expect(
        page.getByRole("button", { name: "识别这一页", exact: true }),
      ).toBeEnabled();
      const began = Date.now();
      await page
        .getByRole("button", { name: "识别这一页", exact: true })
        .click();
      await expect(
        page.locator(".reader-ocr-compare .reader-text"),
      ).toBeVisible({ timeout: 90000 });
      const state = await bridge("reader.ocr", {
        operation: "status",
        artifactId: scan.id,
        revision: 1,
        page: expectedPage.page,
      });
      const recognized = await bridge("reader.read", {
        artifactId: scan.id,
        revision: 1,
        sectionId: state.sectionId,
      });
      assert.equal(recognized.ocr.layout, expectedPage.layout);
      const truth = Array.from(normalized(expectedPage.lines.join("\n"))),
        actual = Array.from(normalized(recognized.text));
      const edits = distance(truth, actual);
      matrix.push({
        page: expectedPage.page,
        layout: expectedPage.layout,
        milliseconds: Date.now() - began,
        expected: expectedPage.lines,
        recognized: recognized.ocr.items.map((i) => i.text),
        edits,
        characters: truth.length,
        accuracyAsserted: Number.isInteger(expectedPage.maxEdits),
      });
      if (Number.isInteger(expectedPage.maxEdits))
        assert.ok(
          edits <= expectedPage.maxEdits,
          `OCR page ${expectedPage.page}: ${edits} edits exceed ${expectedPage.maxEdits}`,
        );
      await expect(page.locator(".reader-ocr-original canvas")).toBeVisible();
      await expect(
        page.locator(".reader-ocr-original .pdf-page"),
      ).toHaveAttribute("aria-busy", "false");
      await page.screenshot({
        path: join(fixture, `scan-page-${expectedPage.page}.png`),
      });
    }
    writeFileSync(
      join(fixture, "ocr-matrix.json"),
      JSON.stringify(matrix, null, 2),
    );
    await page.getByText("OCR 识别文本 · 校对与版式", { exact: true }).click();
    await page
      .getByRole("button", { name: "重新识别这一页", exact: true })
      .click();
    await page.getByRole("button", { name: "取消识别", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "重新识别这一页", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("status").filter({ hasText: "已取消识别" }),
    ).toBeVisible();
    await expect(
      page.locator(".reader-ocr-compare .reader-text"),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("阅读主题", { exact: true }).selectOption("night");
  await page.getByRole("button", { name: "关闭阅读侧栏", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "morphz://app/",
    );
    main.webContents.setZoomFactor(2);
  });
  await expect
    .poll(() =>
      page
        .locator(".reading-app:visible")
        .evaluate((e) => e.scrollWidth - e.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.locator(".reader-ocr-original .pdf-page")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const settings = await page
    .getByRole("button", { name: "阅读设置", exact: true })
    .boundingBox();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert.ok(
    settings &&
      settings.x >= 0 &&
      settings.x + settings.width <= viewport.width &&
      settings.y + settings.height <= viewport.height,
  );
  // Playwright's cached viewport clips Electron screenshots after native zoom.
  // Capture the actual composited window, not a stale CSS-sized crop.
  const zoomCapture = await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "morphz://app/",
    );
    return (await main.webContents.capturePage()).toPNG().toString("base64");
  });
  writeFileSync(
    join(fixture, "reader-ocr-zoom-200.png"),
    Buffer.from(zoomCapture, "base64"),
  );
  assert.deepEqual(errors, []);
  const report = {
    ok: true,
    fixture,
    milliseconds: Date.now() - started,
    recognizedLines: section.ocr.items.length,
    sourceVersionPreserved: true,
    restored: true,
    isolation,
    matrix,
  };
  writeFileSync(
    join(fixture, "ocr-result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await page
    ?.screenshot({ path: join(fixture, "ocr-failure.png") })
    .catch(() => {});
  writeFileSync(
    join(fixture, "ocr-failure.json"),
    JSON.stringify({ error: error.stack ?? String(error) }, null, 2),
  );
  throw error;
} finally {
  await app?.close();
  const evidence = resolve("test-results", basename(fixture));
  mkdirSync(evidence, { recursive: true });
  for (const name of readdirSync(fixture))
    if (
      /^(reader-ocr-.*\.png|scan-page-\d+\.png|ocr-(matrix|result|failure)\.json|ocr-failure\.png|scan-provenance\.json)$/.test(
        name,
      )
    )
      copyFileSync(join(fixture, name), join(evidence, name));
}
