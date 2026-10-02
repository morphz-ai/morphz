import { test, expect, type Page, type Route } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { OcrConsumerHarness } from "./fixtures/reader-ocr-controls.js";
import type {
  ReaderOcrRequest,
  ReaderOcrStatus,
} from "../packages/core/src/reader-ocr.js";

let server: ViteDevServer, origin: string;
// An ephemeral, automated fixture only. It never binds the designated App/HMR
// ports, creates a user profile, or opens a manual-test desktop window.
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("./fixtures/", import.meta.url)),
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await server?.close();
});

const sectionId = `page-1-ocr-${"a".repeat(64)}`;
const idle = (): ReaderOcrStatus => ({
  available: true,
  installed: true,
  downloadBytes: 0,
  state: "idle",
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function fixture(page: Page) {
  const states = new Map<string, ReaderOcrStatus>();
  const requests: { request: ReaderOcrRequest; generation: string }[] = [];
  let intercept:
    ((route: Route, request: ReaderOcrRequest) => Promise<boolean>) | undefined;
  const key = (request: ReaderOcrRequest) =>
    JSON.stringify([request.artifactId, request.revision, request.page]);
  await page.route("**/TEST/reader-ocr", async (route) => {
    const request = route.request().postDataJSON() as ReaderOcrRequest;
    requests.push({
      request,
      generation: route.request().headers()["x-test-generation"] ?? "",
    });
    if (await intercept?.(route, request)) return;
    const binding = key(request);
    if (request.operation === "start")
      states.set(binding, {
        ...idle(),
        state: "recognizing",
        jobId: request.jobId,
      });
    if (request.operation === "cancel")
      states.set(binding, {
        ...idle(),
        state: "cancelled",
        jobId: request.jobId,
      });
    await route.fulfill({ json: states.get(binding) ?? idle() });
  });
  await page.goto(origin + "/reader-ocr-controls.html");
  const controls = page.locator(".reader-ocr-controls");
  await expect(
    controls.getByRole("button", { name: "识别这一页", exact: true }),
  ).toBeEnabled();
  const reads = () =>
    requests.filter((entry) => entry.request.operation === "status").length;
  return {
    controls,
    requests,
    states,
    key,
    reads,
    intercept(value: typeof intercept) {
      intercept = value;
    },
    notify: () => page.evaluate(() => window.ocrHarness.notify()),
    snapshot: (): Promise<ReturnType<OcrConsumerHarness["snapshot"]>> =>
      page.evaluate(() => window.ocrHarness.snapshot()),
  };
}

test("mounted OCR controls: idle and recognizing make no interval status calls, workspace event re-reads once, owned completion opens once", async ({
  page,
}) => {
  const x = await fixture(page);
  await page.waitForTimeout(100);
  const before = x.reads();
  await page.waitForTimeout(3300);
  expect(x.reads()).toBe(before);
  await x.controls
    .getByRole("button", { name: "识别这一页", exact: true })
    .click();
  await expect(x.controls.getByRole("status")).toHaveText("正在识别这一页…");
  await page.waitForTimeout(100);
  const recognizing = x.reads();
  await page.waitForTimeout(3300);
  expect(x.reads()).toBe(recognizing);
  const start = x.requests.find(
    (entry) => entry.request.operation === "start",
  )!.request;
  expect(start.operation).toBe("start");
  if (start.operation !== "start") throw new Error("missing start request");
  x.states.set(x.key(start), {
    ...idle(),
    state: "complete",
    sectionId,
    jobId: start.jobId,
  });
  await x.notify();
  await expect
    .poll(async () => (await x.snapshot()).opened)
    .toEqual([sectionId]);
  expect(x.reads()).toBe(recognizing + 1);
  await x.notify();
  await expect.poll(x.reads).toBe(recognizing + 2);
  await page.waitForTimeout(100);
  expect((await x.snapshot()).opened).toEqual([sectionId]);
  expect(
    x.requests.filter((entry) => entry.request.operation === "start"),
  ).toHaveLength(1);
  expect(
    x.requests.filter((entry) => entry.request.operation === "cancel"),
  ).toHaveLength(0);
});

test("a late old-book status cannot open an OCR section under the new scope", async ({
  page,
}) => {
  const x = await fixture(page);
  await x.controls
    .getByRole("button", { name: "识别这一页", exact: true })
    .click();
  await expect(x.controls.getByRole("status")).toHaveText("正在识别这一页…");
  const start = x.requests.find(
    (entry) => entry.request.operation === "start",
  )!.request;
  if (start.operation !== "start") throw new Error("missing start request");
  const held = gate();
  let started = false;
  x.intercept(async (route, request) => {
    if (
      request.operation === "status" &&
      request.artifactId === "TEST-book-one"
    ) {
      started = true;
      await held.promise;
      await route
        .fulfill({
          json: { ...idle(), state: "complete", jobId: start.jobId, sectionId },
        })
        .catch(() => {});
      return true;
    }
    return false;
  });
  try {
    await x.notify();
    await expect.poll(() => started).toBe(true);
    await page.evaluate(() => window.ocrHarness.bind("TEST-book-two", 2, 2));
    await expect(
      x.controls.getByRole("button", { name: "识别这一页", exact: true }),
    ).toBeEnabled();
    held.release();
    await page.waitForTimeout(150);
    expect((await x.snapshot()).opened).toEqual([]);
    expect((await x.snapshot()).aborted).toContain(
      JSON.stringify(["TEST-book-one", 1, 1]),
    );
    const statusReads = x.requests.filter(
      (entry) => entry.request.operation === "status",
    );
    expect(statusReads.at(-1)!.request).toMatchObject({
      artifactId: "TEST-book-two",
      revision: 2,
      page: 2,
    });
  } finally {
    held.release();
  }
});

test("late old-identity start completion cannot navigate, and the new generation retains usable OCR controls", async ({
  page,
}) => {
  const x = await fixture(page);
  const held = gate();
  let started = false;
  x.intercept(async (route, request) => {
    if (request.operation === "start") {
      started = true;
      await held.promise;
      await route.fulfill({
        json: { ...idle(), state: "complete", jobId: request.jobId, sectionId },
      });
      return true;
    }
    return false;
  });
  try {
    await x.controls
      .getByRole("button", { name: "识别这一页", exact: true })
      .click();
    await expect.poll(() => started).toBe(true);
    await page.evaluate(() => window.ocrHarness.identity("generation-two"));
    held.release();
    await page.waitForTimeout(180);
    expect((await x.snapshot()).opened).toEqual([]);
    expect(
      x.requests.some(
        (entry) =>
          entry.request.operation === "status" &&
          entry.generation === "generation-two",
      ),
    ).toBe(true);
    await expect(
      x.controls.getByRole("button", { name: "识别这一页", exact: true }),
    ).toBeEnabled();
  } finally {
    held.release();
  }
});
