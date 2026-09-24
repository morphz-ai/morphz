import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readingOcrModels } from "../dist/service/packages/application/src/reader-ocr.js";

// Production Desktop with isolated, explicitly supplied fixtures only. No Runtime,
// model provider, personal profile or discovered book path is used by this test.
const rounds = Number(process.env.MORPHZ_READER_SOAK_ROUNDS ?? 12);
assert.ok(Number.isInteger(rounds) && rounds >= 4 && rounds <= 200);
const models = process.argv[2];
const pdfPath = resolve(process.argv[3] ?? "tests/fixtures/reader.pdf");
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const evidence = resolve("test-results", basename(fixture));
mkdirSync(evidence, { recursive: true });
const pdfBytes = readFileSync(pdfPath).length;
if (models) {
  const cache = join(fixture, "data", "reader-ocr-models");
  mkdirSync(cache, { recursive: true });
  readingOcrModels.forEach((model, index) =>
    copyFileSync(
      join(models, index ? "small-rec.tar" : "small-det.tar"),
      join(cache, `${model.sha256}.tar`),
    ),
  );
}
const env = {
  ...process.env,
  MORPHZ_APP_ENV_FILE: "",
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page, cdp, poller, pendingPoll;
const samples = [],
  errors = [];
const began = Date.now();
const peaks = {
  mainRss: 0,
  processWorkingSetKiB: 0,
  processCount: 0,
  samples: 0,
};
const nativeMemory = () =>
  app.evaluate(({ app }) => ({
    main: process.memoryUsage(),
    processes: app
      .getAppMetrics()
      .map(({ pid, type, memory }) => ({ pid, type, memory })),
  }));
const save = () =>
  writeFileSync(
    join(fixture, "reader-stability.json"),
    JSON.stringify(
      {
        rounds,
        pdfBytes,
        milliseconds: Date.now() - began,
        peaks,
        samples,
        errors,
      },
      null,
      2,
    ),
  );
async function launch() {
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20_000,
    })
    .toBe(true);
  page = app.windows().find((p) => p.url() === "morphz://app/");
  page.on("pageerror", (error) => errors.push(error.message));
  cdp = await app.context().newCDPSession(page);
  poller = setInterval(() => {
    if (pendingPoll) return;
    pendingPoll = nativeMemory()
      .then((value) => {
        peaks.mainRss = Math.max(peaks.mainRss, value.main.rss);
        peaks.processWorkingSetKiB = Math.max(
          peaks.processWorkingSetKiB,
          value.processes.reduce((sum, p) => sum + p.memory.workingSetSize, 0),
        );
        peaks.processCount = Math.max(
          peaks.processCount,
          value.processes.length,
        );
        peaks.samples++;
      })
      .catch((error) => errors.push(error.message))
      .finally(() => {
        pendingPoll = undefined;
      });
  }, 250);
}
async function close() {
  clearInterval(poller);
  await pendingPoll;
  await app?.close();
}
try {
  await launch();
  const invoke = (method, params) =>
    page.evaluate(
      async ({ method, params }) => {
        const api = window.morphzDesktop.application;
        const boot = await api.invoke({
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
  const mainWindow = () =>
    app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter(
          (w) => w.webContents.getURL() === "morphz://app/ocr.html",
        ).length,
    );
  async function measure(label, elapsedMs) {
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const native = await nativeMemory();
    const value = {
      label,
      elapsedMs,
      atMs: Date.now() - began,
      heap,
      dom,
      workers: page.workers().length,
      ocrWindows: await mainWindow(),
      native,
    };
    samples.push(value);
    save();
    console.log(
      JSON.stringify({
        label,
        elapsedMs,
        heapBytes: heap.usedSize,
        dom,
        workers: value.workers,
        mainRss: native.main.rss,
      }),
    );
  }
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
    name: "TEST 阅读稳定性.pdf",
    mimeType: "application/pdf",
    buffer: readFileSync(pdfPath),
  });
  await expect(page.locator(".reading-app:visible .pdf-page")).toHaveAttribute(
    "aria-busy",
    "false",
    { timeout: 30_000 },
  );
  const boot = await invoke("workspace");
  const book = boot.workspace.artifacts.find(
    (a) => a.title === "TEST 阅读稳定性",
  );
  assert.ok(book);
  let firstSource;
  for (let round = 0; round < rounds; round++) {
    const start = Date.now(),
      pageNumber = (round % book.content.pages.length) + 1;
    await page.getByRole("button", { name: "目录", exact: true }).click();
    await page
      .getByRole("complementary", { name: "阅读目录", exact: true })
      .getByRole("button", { name: `第 ${pageNumber} 页`, exact: true })
      .click();
    const close = page.getByRole("button", {
      name: "关闭阅读侧栏",
      exact: true,
    });
    if (await close.isVisible()) await close.click();
    await expect(
      page.locator(".reading-app:visible .pdf-page"),
    ).toHaveAttribute("aria-busy", "false");
    // Open/close another surface without replacing the book or its reading state.
    await page.getByRole("button", { name: "应用启动台", exact: true }).click();
    await page.getByRole("tab", { name: "阅读", exact: true }).click();
    await expect(
      page.locator(".reading-app:visible .pdf-page"),
    ).toHaveAttribute("aria-label", `PDF 第 ${pageNumber} 页`);
    if (models) {
      const bound = {
        artifactId: book.id,
        revision: book.revision,
        page: pageNumber,
        jobId: crypto.randomUUID(),
      };
      await invoke("reader.ocr", {
        operation: "start",
        ...bound,
        layout: "horizontal",
        force: true,
      });
      if (round % 3 === 2) {
        await expect.poll(mainWindow, { timeout: 20_000 }).toBe(1);
        await invoke("reader.ocr", { operation: "cancel", ...bound });
      }
      let status;
      await expect
        .poll(
          async () => {
            status = await invoke("reader.ocr", {
              operation: "status",
              ...bound,
            });
            return status.state;
          },
          { timeout: 95_000, intervals: [300, 500, 1000] },
        )
        .toBe(round % 3 === 2 ? "cancelled" : "complete");
      await expect.poll(mainWindow).toBe(0);
      if (status.sectionId && !firstSource) {
        firstSource = await invoke("reader.read", {
          artifactId: book.id,
          revision: book.revision,
          sectionId: status.sectionId,
        });
      }
    }
    await measure(`round-${round + 1}`, Date.now() - start);
  }
  if (firstSource) {
    const old = await invoke("reader.read", {
      artifactId: book.id,
      revision: book.revision,
      sectionId: firstSource.id,
    });
    assert.equal(old.text, firstSource.text);
  }
  await page.getByRole("button", { name: "全部读物", exact: true }).click();
  await expect.poll(() => page.workers().length).toBe(0);
  await measure("library", 0);
  // Inspect main-process external buffers separately from renderer JS retention.
  // This attaches only to the isolated test process, never a user's Runtime.
  await app.evaluate(async () => {
    const { Session } = process.getBuiltinModule("node:inspector");
    const inspector = new Session();
    inspector.connect();
    try {
      await new Promise((resolve, reject) =>
        inspector.post("HeapProfiler.collectGarbage", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    } finally {
      inspector.disconnect();
    }
  });
  await measure("library-main-gc", 0);
  await page.reload();
  await expect(page.getByRole("region", { name: "阅读书库" })).toBeVisible();
  await measure("reloaded", 0);
  await page.getByRole("button", { name: /TEST 阅读稳定性/ }).click();
  const lastPage = ((rounds - 1) % book.content.pages.length) + 1;
  await expect(page.locator(".reading-app:visible .pdf-page")).toHaveAttribute(
    "aria-label",
    `PDF 第 ${lastPage} 页`,
  );
  await close();
  await launch();
  await expect(page.locator(".reading-app:visible .pdf-page")).toHaveAttribute(
    "aria-label",
    `PDF 第 ${lastPage} 页`,
    { timeout: 30_000 },
  );
  if (firstSource) {
    const restored = await invoke("reader.read", {
      artifactId: book.id,
      revision: book.revision,
      sectionId: firstSource.id,
    });
    assert.equal(restored.text, firstSource.text);
  }
  await measure("restarted", 0);
  assert.deepEqual(errors, []);
  // A warm-up allowance, not a benchmark guarantee across machines. Gross
  // retained growth and orphaned PDF/OCR workers must still fail in CI.
  const warm = samples[2],
    end = samples[rounds - 1];
  assert.ok(
    end.heap.usedSize - warm.heap.usedSize < 32 * 1024 * 1024,
    "Reader retained JS heap grows after warm-up",
  );
  assert.ok(
    end.dom.nodes - warm.dom.nodes < 1500,
    "Reader retains detached DOM across pages",
  );
  const released = samples.find((sample) => sample.label === "library-main-gc");
  assert.ok(
    released.native.main.external - warm.native.main.external <
      64 * 1024 * 1024,
    "Reader retains native PDF/model buffers after OCR sandboxes close",
  );
  assert.ok(
    samples.every((s) => s.ocrWindows === 0),
    "An OCR sandbox survived its job",
  );
  console.log(
    JSON.stringify({
      ok: true,
      fixture,
      evidence,
      rounds,
      milliseconds: Date.now() - began,
      peaks,
      paidCalls: 0,
    }),
  );
} catch (error) {
  errors.push(error.stack ?? String(error));
  await page
    ?.screenshot({ path: join(fixture, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await close();
  save();
  // Playwright can reset test-results when another suite starts. Keep the live
  // journal outside it, then publish only the report (never the fixture store).
  mkdirSync(evidence, { recursive: true });
  copyFileSync(
    join(fixture, "reader-stability.json"),
    join(evidence, "reader-stability.json"),
  );
  if (errors.length) {
    try {
      copyFileSync(
        join(fixture, "failure.png"),
        join(evidence, "reader-stability-failure.png"),
      );
    } catch {}
  }
  console.log(`Stability evidence: ${join(evidence, "reader-stability.json")}`);
}
