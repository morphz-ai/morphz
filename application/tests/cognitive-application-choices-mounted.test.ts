import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import type { CognitiveAppApplicationTarget } from "../packages/core/src/cognitive-app-application-target.js";

test(
  "actual shared cognitive option dialog keeps exact version/connection, no implicit choice and native focus",
  { timeout: 60000 },
  async (t) => {
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert(existsSync(executable), "formal test runner must provide Chromium");
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-application-choices-vite-"),
    );
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const fixture = resolve(
      "tests/fixtures/cognitive-application-choices-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "actual-cognitive-choices-leaf",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__choices") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><link rel="icon" href="data:,"/></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    t.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1120, height: 800 },
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/__choices`);
    const report = () =>
      page.evaluate(() =>
        Reflect.get(window, "cognitiveChoicesFixture").report(),
      ) as Promise<{
        requests: CognitiveAppApplicationTarget[];
        open: boolean;
      }>;
    const dialog = page.getByRole("dialog", { name: "本次输入使用的应用" });

    await t.test(
      "opening does not choose the first connection; GUI/headless facts remain distinct",
      async () => {
        await page
          .getByRole("button", { name: "选择应用", exact: true })
          .click();
        await dialog.waitFor();
        assert.equal((await report()).requests.length, 0);
        assert.equal(
          await dialog.getByRole("button", { pressed: true }).count(),
          0,
        );
        assert.equal(
          await dialog
            .getByText("此应用没有独立界面。", { exact: true })
            .count(),
          1,
        );
        assert.equal(
          await dialog
            .getByText("应用界面尚未开放，仍可用于本次输入。", { exact: true })
            .count(),
          1,
        );
        assert.deepEqual(
          await dialog
            .locator(".cognitive-application-choices header")
            .evaluateAll((headers) =>
              headers.map((header) => ({
                justify: getComputedStyle(header).justifyContent,
                bottom: getComputedStyle(header).marginBottom,
              })),
            ),
          [
            { justify: "flex-start", bottom: "0px" },
            { justify: "flex-start", bottom: "0px" },
          ],
          "new option headers keep their icon and label together rather than inheriting the modal heading layout",
        );
        assert.equal(
          await dialog
            .getByRole("button", {
              name: "使用作者笔记 1.0.0，数据连接 connection-disabled",
              exact: true,
            })
            .isDisabled(),
          true,
        );
      },
    );
    await t.test(
      "explicit non-first connection and version preserve the full Core target and return focus",
      async () => {
        await dialog
          .getByRole("button", {
            name: "使用作者笔记 2.0.0，数据连接 connection-B",
            exact: true,
          })
          .click();
        await dialog.waitFor({ state: "hidden" });
        assert.deepEqual((await report()).requests, [
          {
            connectionId: "connection-B",
            authority: {
              appId: "author.notes",
              version: "2.0.0",
              definitionHash: "2".repeat(64),
              instanceId: "instance-B",
              serviceId: "作者/service-B",
              dataAuthorityId: "原始保存方-B😀",
            },
          },
        ]);
        assert.equal(
          await page
            .getByRole("button", { name: "选择应用", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page
          .getByRole("button", { name: "选择应用", exact: true })
          .click();
        assert.equal(
          await dialog
            .getByRole("button", {
              name: "使用作者笔记 2.0.0，数据连接 connection-B",
              exact: true,
            })
            .getAttribute("aria-pressed"),
          "true",
        );
      },
    );
    await t.test(
      "current permission removal disables all choices without consuming the prior target",
      async () => {
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveChoicesFixture").mode("revoked"),
        );
        await page.waitForFunction(
          () =>
            document.querySelectorAll(
              ".cognitive-application-choices li button:not(:disabled)",
            ).length === 0,
        );
        assert.equal((await report()).requests.length, 1);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(
          await page
            .getByRole("button", { name: "选择应用", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
      },
    );
    await t.test(
      "empty current projection is honest; narrow and 200% dialogs remain keyboard reachable",
      async () => {
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveChoicesFixture").mode("empty"),
        );
        await page
          .getByRole("button", { name: "选择应用", exact: true })
          .click();
        assert.equal(
          await dialog
            .getByText("当前没有可选择的应用，原草稿和应用目标仍保留。", {
              exact: true,
            })
            .count(),
          1,
        );
        for (const zoom of [1, 2]) {
          await page.setViewportSize({ width: 360, height: 640 });
          await page.evaluate((zoom) => {
            document.documentElement.style.zoom = String(zoom);
          }, zoom);
          const box = await dialog.boundingBox();
          assert(
            box &&
              box.x >= -1 &&
              box.y >= -1 &&
              box.x + box.width <= 361 &&
              box.y + box.height <= 641,
          );
          await dialog
            .getByRole("button", { name: "关闭应用选择", exact: true })
            .focus();
          await page.keyboard.press("Tab");
          assert.equal(
            await dialog.evaluate((node) =>
              node.contains(document.activeElement),
            ),
            true,
          );
        }
        assert.equal((await report()).requests.length, 1);
        assert.deepEqual(errors, []);
      },
    );
  },
);
