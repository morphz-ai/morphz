import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { chromium, expect } from "@playwright/test";

test(
  "real Desktop and Dashboard discussion components preserve main drafts, scope subscriptions, and fit both themes and viewport sizes",
  { timeout: 60000 },
  async (context) => {
    const cache = await mkdtemp(resolve(tmpdir(), "morphz-discussions-ui-"));
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "test entry must prepare a browser",
    );
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(async () => {
      await browser.close();
      await rm(cache, { recursive: true, force: true });
    });
    const screenshots = process.env.MORPHZ_DISCUSSION_REVIEW_DIR;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const geometry: unknown[] = [];
    const desktopCss = [
      ...readFileSync("apps/web/src/main.tsx", "utf8").matchAll(
        /import\s+["'](\.\/[^"']+\.css)["'];/g,
      ),
    ]
      .map(
        (match) =>
          `import ${JSON.stringify(resolve("apps/web/src", match[1]!))};`,
      )
      .join("\n");
    for (const lane of ["desktop", "dashboard"] as const) {
      const fixture = resolve(
        `tests/fixtures/${lane === "desktop" ? "comment" : "dashboard"}-discussions-mounted.tsx`,
      );
      const entry =
        (lane === "desktop"
          ? desktopCss
          : `import ${JSON.stringify(resolve("../dashboard/src/index.css"))};\nimport ${JSON.stringify(resolve("../dashboard/src/App.css"))};`) +
        `\nimport ${JSON.stringify(fixture)};`;
      const output = await build({
        configFile: false,
        root: resolve("apps/web"),
        cacheDir: cache,
        mode: "development",
        resolve: { dedupe: ["react", "react-dom"] },
        define: {
          "process.env.NODE_ENV": JSON.stringify("development"),
          "import.meta.env.DEV": "true",
          "import.meta.env.PROD": "false",
        },
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          lib: {
            entry: "/__discussions.js",
            name: "DiscussionFixture",
            formats: ["iife"],
          },
        },
        plugins: [
          react(),
          {
            name: "discussion-fixture",
            resolveId: (id) =>
              id === "/__discussions.js" ? "\0discussion-fixture" : undefined,
            load: (id) => (id === "\0discussion-fixture" ? entry : undefined),
          },
        ],
        logLevel: "error",
      });
      const outputs = Array.isArray(output) ? output : [output];
      assert.equal(outputs.length, 1);
      const built = outputs[0]!;
      assert("output" in built);
      const javascript = built.output.find((item) => item.type === "chunk")!;
      assert(javascript.type === "chunk");
      const stylesheet = built.output
        .filter(
          (item) => item.type === "asset" && item.fileName.endsWith(".css"),
        )
        .map((item) => (item.type === "asset" ? item.source : ""))
        .join("\n");
      for (const theme of ["light", "dark"])
        for (const width of [1440, 760]) {
          const page = await browser.newPage({
              viewport: { width, height: 900 },
            }),
            errors: string[] = [];
          page.setDefaultTimeout(5000);
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/*", async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/fixture")
              await route.fulfill({
                contentType: "text/html",
                body: '<!doctype html><html lang="zh"><head><meta charset="UTF-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
              });
            else if (path === "/fixture.js")
              await route.fulfill({
                contentType: "text/javascript",
                body: javascript.code,
              });
            else if (path === "/fixture.css")
              await route.fulfill({
                contentType: "text/css",
                body: stylesheet,
              });
            else await route.abort("failed");
          });
          context.after(() => {
            if (errors.length)
              context.diagnostic(
                JSON.stringify({ lane, theme, width, errors }),
              );
          });
          await page.goto(
            `http://${lane === "desktop" ? "localhost" : "fixture.test"}/fixture?theme=${theme}`,
          );
          await expect(page.locator("#source-a")).toBeVisible();
          if (lane === "desktop") {
            await page.locator("#source-a").evaluate((node) => {
              const selection = getSelection()!,
                range = document.createRange();
              range.selectNodeContents(node);
              selection.removeAllRanges();
              selection.addRange(range);
              document.dispatchEvent(new Event("selectionchange"));
            });
            await expect(
              page.getByRole("button", { name: "加入对话", exact: true }),
            ).toBeVisible();
            await page
              .getByRole("button", { name: "讨论", exact: true })
              .click();
          } else
            await page.evaluate(() =>
              Reflect.get(window, "discussionFixture").open("a"),
            );
          const input = page.getByRole("textbox", {
            name: "讨论消息",
            exact: true,
          });
          await expect(input).toBeVisible();
          await input.fill("这段如何保留主线？");
          await input.press("Enter");
          await expect(input).toHaveValue("");
          const first = await page.evaluate(
            () => Reflect.get(window, "discussionFixture").report().active,
          );
          if (lane === "dashboard") {
            await expect
              .poll(() =>
                page.evaluate(
                  () =>
                    Reflect.get(window, "discussionFixture").report()
                      .subscriptions.length,
                ),
              )
              .toBe(2);
            await page.evaluate(
              (id) =>
                Reflect.get(window, "discussionFixture").prefix(
                  id,
                  "TEST 完整前缀",
                ),
              first,
            );
            await expect(
              page.getByText("TEST 完整前缀", { exact: true }),
            ).toBeVisible();
            const reads = await page.evaluate(
              () =>
                Reflect.get(window, "discussionFixture").report().requests
                  .length,
            );
            await page.evaluate(
              (id) =>
                Reflect.get(window, "discussionFixture").prefix(id, " + 增量"),
              first,
            );
            await expect(
              page.getByText("TEST 完整前缀 + 增量", { exact: true }),
            ).toBeVisible();
            assert.equal(
              await page.evaluate(
                () =>
                  Reflect.get(window, "discussionFixture").report().requests
                    .length,
              ),
              reads,
              "healthy deltas do not read history",
            );
          }
          await page
            .getByRole("button", { name: "关闭讨论", exact: true })
            .click();
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  Reflect.get(window, "discussionFixture").report()
                    .subscriptions.length,
              ),
            )
            .toBe(0);
          const count = await page.evaluate(
            () =>
              Reflect.get(window, "discussionFixture").report().requests.length,
          );
          await page.clock.install();
          await page.clock.runFor(30000);
          assert.equal(
            await page.evaluate(
              () =>
                Reflect.get(window, "discussionFixture").report().requests
                  .length,
            ),
            count,
            "closed healthy owner must be silent",
          );
          await page.evaluate(() =>
            Reflect.get(window, "discussionFixture").open("b"),
          );
          await input.fill("第二段独立讨论");
          await input.press("Enter");
          await expect(input).toHaveValue("");
          const second = await page.evaluate(
            () => Reflect.get(window, "discussionFixture").report().active,
          );
          assert.notEqual(first, second);
          if (lane === "dashboard") {
            await page.evaluate(
              (id) =>
                Reflect.get(window, "discussionFixture").prefix(
                  id,
                  " + 关闭期间进展",
                ),
              first,
            );
            await page
              .getByRole("button", { name: "关闭讨论", exact: true })
              .click();
            await page.evaluate(() =>
              Reflect.get(window, "discussionFixture").open("a"),
            );
            await expect(
              page.getByText("TEST 完整前缀 + 增量 + 关闭期间进展", {
                exact: true,
              }),
            ).toBeVisible();
          }
          await page.evaluate(
            (id) => Reflect.get(window, "discussionFixture").finish(id),
            first,
          );
          await page
            .getByRole("button", { name: "关闭讨论", exact: true })
            .click();
          await page.evaluate(() =>
            Reflect.get(window, "discussionFixture").open("a"),
          );
          // Selecting the accepted discussion is a deliberate, exact source read.
          await page.getByRole("button", { name: "讨论", exact: true }).click();
          await page
            .getByRole("button", { name: "这段如何保留主线？", exact: true })
            .click();
          await expect(
            page.getByRole("link", { name: "查看来源" }),
          ).toBeVisible();
          await input.fill("保持层次，继续说明");
          const report = await page.evaluate(() =>
            Reflect.get(window, "discussionFixture").report(),
          );
          assert.equal(report.draft, "TEST：这段主聊天草稿必须保留。");
          assert.equal(report.model, "test-main-model · max");
          const metrics = await page
            .locator(
              lane === "desktop"
                ? ".comment-discussion"
                : ".dashboard-discussion",
            )
            .evaluate((element) => {
              const r = element.getBoundingClientRect(),
                input = element.querySelector("textarea")!,
                style = getComputedStyle(input);
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom,
                viewport: innerWidth,
                fontSize: style.fontSize,
                focused: document.activeElement === input,
                innerOutline: style.outlineStyle,
                lineHeight: style.lineHeight,
                overflow: element.scrollWidth > element.clientWidth,
              };
            });
          assert(
            metrics.x >= 0 &&
              metrics.y >= 0 &&
              metrics.right <= width + 1 &&
              metrics.bottom <= 901,
            JSON.stringify(metrics),
          );
          assert(!metrics.overflow, JSON.stringify(metrics));
          assert.equal(metrics.focused, true);
          assert.equal(
            metrics.innerOutline,
            "none",
            "composer boundary owns the single focus cue",
          );
          geometry.push({ lane, theme, viewportWidth: width, ...metrics });
          assert.deepEqual(errors, []);
          if (screenshots)
            await page.screenshot({
              path: resolve(screenshots, `${lane}-${theme}-${width}.png`),
              fullPage: true,
            });
          await page.close();
        }
    }
    if (screenshots)
      await writeFile(
        resolve(screenshots, "geometry.json"),
        JSON.stringify(geometry, null, 2),
      );
    context.diagnostic(
      JSON.stringify({ components: 2, viewports: geometry.length, geometry }),
    );
  },
);
