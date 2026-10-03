import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";

if (process.env.MORPHZ_TEST_BROWSER_EXECUTABLE)
  test.use({
    launchOptions: {
      executablePath: process.env.MORPHZ_TEST_BROWSER_EXECUTABLE,
    },
  });

let server: ViteDevServer, origin: string, cacheDir: string;

test.beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "morphz-task-markdown-css-"));
  // Playwright transforms imported JSX for its own component protocol. Render
  // in the real tsx/React process so this is actual production SSR, not that shim.
  const { stdout: markup } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("./fixtures/task-summary-markdown.ts", import.meta.url),
      ),
    ],
    { cwd: fileURLToPath(new URL("../", import.meta.url)) },
  );
  const html = `<!doctype html><html lang="zh-CN" data-appearance="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TEST 实际 Markdown 组件与样式</title>${["styles", "ui", "visual-system"].map((file) => `<link rel="stylesheet" href="/apps/web/src/${file}.css?direct">`).join("")}</head><body>${markup}</body></html>`;
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir,
    plugins: [
      {
        name: "task-markdown-ssr-fixture",
        configureServer(preview) {
          preview.middlewares.use((request, response, next) => {
            if (request.url !== "/task-summary-markdown-preview") return next();
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(html);
          });
        },
      },
    ],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

// This exercises actual SSR components and production CSS, not the original
// Electron window. CSS zoom tests reflow; they are not OS/Desktop zoom evidence.
for (const setting of [
  { width: 1440, zoom: 1 },
  { width: 320, zoom: 1 },
  { width: 390, zoom: 1 },
  { width: 390, zoom: 2 },
]) {
  test(`实际组件宽表内滚动 ${setting.width}px / CSS ${setting.zoom * 100}%`, async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin)
        return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.setViewportSize({ width: setting.width, height: 844 });
    await page.goto(origin + "/task-summary-markdown-preview");
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom);
    }, setting.zoom);
    const measurements = [];
    for (const surface of ["task-wide", "shared-wide"]) {
      const section = page.getByRole("region", { name: surface, exact: true });
      const table = section.getByRole("region", { name: "表格", exact: true });
      await expect(table).toHaveAttribute("tabindex", "0");
      const measured = await table.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
        right: element.getBoundingClientRect().right,
        parentRight: element.parentElement!.getBoundingClientRect().right,
      }));
      expect(measured.clientWidth).toBeGreaterThan(0);
      expect(measured.scrollWidth).toBeGreaterThan(measured.clientWidth);
      expect(measured.overflowX).toBe("auto");
      expect(measured.right).toBeLessThanOrEqual(measured.parentRight + 1);
      measurements.push({ surface, ...measured });
      await table.focus();
      await expect(table).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => table.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    }
    const normal = page
      .getByRole("region", { name: "task-ordinary", exact: true })
      .getByRole("region", { name: "表格", exact: true });
    await expect(normal.locator("td")).toHaveCount(2);
    const normalWidths = await normal.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(normalWidths.scroll).toBeLessThanOrEqual(normalWidths.client + 1);
    const boxes = page
      .getByRole("region", { name: "task-checklist", exact: true })
      .getByRole("checkbox");
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
    for (const box of await boxes.all()) await expect(box).toBeDisabled();
    const pageWidths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(pageWidths.scroll).toBeLessThanOrEqual(pageWidths.client + 1);
    expect(externalRequests).toEqual([]);
    console.log(
      JSON.stringify({ ...setting, pageWidths, normalWidths, measurements }),
    );
  });
}
