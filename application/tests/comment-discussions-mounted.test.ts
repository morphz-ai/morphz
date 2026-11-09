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
              hasTouch: width === 760,
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
          const panel = page.getByRole("region", { name: "讨论", exact: true });
          const dotsClass =
            lane === "desktop" ? ".response-dots" : ".stream-typing";
          const dots = panel.locator(dotsClass);
          await expect(
            panel.getByText(
              lane === "desktop" ? "等待模型输出…" : "等待模型求值",
              { exact: true },
            ),
          ).toBeVisible();
          await expect(dots).toBeVisible();
          const paint = (node: Element) => {
            const dot = getComputedStyle(node.firstElementChild!);
            const label = getComputedStyle(node.nextElementSibling!);
            return [
              dot.animationName,
              dot.animationDuration,
              dot.backgroundColor,
              label.fontSize,
              label.color,
            ];
          };
          const motion = await dots.evaluate(paint);
          assert.notEqual(motion[0], "none");
          assert.deepEqual(
            motion,
            await page.locator(`#main-waiting ${dotsClass}`).evaluate(paint),
          );
          if (lane === "desktop")
            await expect(panel.locator(".response-elapsed")).toBeVisible();
          await page.emulateMedia({ reducedMotion: "reduce" });
          await expect(dots.locator(":scope > *").first()).toHaveCSS(
            "animation-name",
            "none",
          );
          await page.emulateMedia({ reducedMotion: "no-preference" });
          const beforePhase = await page.evaluate(
            () =>
              Reflect.get(window, "discussionFixture").report().requests.length,
          );
          await page.evaluate(
            (id) =>
              Reflect.get(window, "discussionFixture").phase(id, "reasoning"),
            first,
          );
          await expect(
            panel.getByText(lane === "desktop" ? "正在思考…" : "正在思考", {
              exact: true,
            }),
          ).toBeVisible();
          assert.equal(
            await page.evaluate(
              () =>
                Reflect.get(window, "discussionFixture").report().requests
                  .length,
            ),
            beforePhase,
            "a phase transition never fetches history",
          );
          if (screenshots)
            await page.screenshot({
              path: resolve(
                screenshots,
                `${lane}-${theme}-${width}-waiting.png`,
              ),
              fullPage: true,
            });
          {
            await expect
              .poll(() =>
                page.evaluate(
                  () =>
                    Reflect.get(window, "discussionFixture").report()
                      .subscriptions.length,
                ),
              )
              .toBe(lane === "dashboard" ? 2 : 1);
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
            if (lane === "desktop") {
              await expect(dots).toHaveCount(0);
              await expect(
                panel
                  .locator("[data-stream-active=true] .stream-text-reveal")
                  .first(),
              ).toBeVisible();
            } else {
              const stream = panel.locator(".stream-caret");
              await expect(stream).toHaveCount(1);
              assert.equal(
                await stream.evaluate(
                  (node) =>
                    getComputedStyle(node.previousElementSibling!, "::after")
                      .width,
                ),
                "2px",
                "the shared caret sits at the end of the visible text line",
              );
              await expect(dots).toHaveCount(1);
            }
            if (screenshots)
              await page.screenshot({
                path: resolve(
                  screenshots,
                  `${lane}-${theme}-${width}-streaming.png`,
                ),
                fullPage: true,
              });
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
          if (lane === "dashboard") {
            const sharedStyles = await page.evaluate(() => {
              const reference = document.querySelector("#source-b")!,
                message = document.querySelector(
                  ".dashboard-discussion .message-row.user .message-body",
                )!,
                referenceField = document.querySelector("#main-draft")!,
                field = document.querySelector(
                  ".dashboard-discussion textarea",
                )!;
              return {
                reference: [
                  getComputedStyle(reference).fontFamily,
                  getComputedStyle(reference).fontSize,
                  getComputedStyle(reference).lineHeight,
                  getComputedStyle(reference).backgroundColor,
                  getComputedStyle(reference).borderRadius,
                  getComputedStyle(reference).padding,
                ],
                message: [
                  getComputedStyle(message).fontFamily,
                  getComputedStyle(message).fontSize,
                  getComputedStyle(message).lineHeight,
                  getComputedStyle(message).backgroundColor,
                  getComputedStyle(message).borderRadius,
                  getComputedStyle(message).padding,
                ],
                referenceField: [
                  getComputedStyle(referenceField).fontFamily,
                  getComputedStyle(referenceField).fontSize,
                  getComputedStyle(referenceField).lineHeight,
                  getComputedStyle(referenceField).color,
                  getComputedStyle(referenceField).backgroundColor,
                ],
                field: [
                  getComputedStyle(field).fontFamily,
                  getComputedStyle(field).fontSize,
                  getComputedStyle(field).lineHeight,
                  getComputedStyle(field).color,
                  getComputedStyle(field).backgroundColor,
                ],
              };
            });
            assert.deepEqual(
              sharedStyles.message,
              sharedStyles.reference,
              "discussion messages share the main chat recipe",
            );
            assert.deepEqual(
              sharedStyles.field,
              sharedStyles.referenceField,
              "discussion input shares the main composer recipe",
            );
          }
          await expect(page.locator(".discussion-source-mark")).toHaveCount(1);
          const markerHit = await page
            .locator(".discussion-source-mark")
            .evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return {
                width: rect.width,
                height: rect.height,
                coarse: matchMedia("(pointer: coarse)").matches,
              };
            });
          assert.equal(
            markerHit.coarse,
            width === 760,
            "narrow captures exercise actual coarse-pointer CSS",
          );
          assert.ok(
            markerHit.width >= (markerHit.coarse ? 44 : 24) &&
              markerHit.height >= (markerHit.coarse ? 44 : 24),
            JSON.stringify(markerHit),
          );
          if (markerHit.coarse) {
            const controls = await page
              .locator(
                lane === "desktop"
                  ? ".comment-discussion button"
                  : ".dashboard-discussion button",
              )
              .evaluateAll((buttons) =>
                buttons.map((button) => {
                  const rect = button.getBoundingClientRect();
                  return {
                    name:
                      button.getAttribute("aria-label") || button.textContent,
                    width: rect.width,
                    height: rect.height,
                  };
                }),
              );
            assert.ok(
              controls.every(
                (control) => control.width >= 44 && control.height >= 44,
              ),
              JSON.stringify({ lane, theme, width, controls }),
            );
          }
          await expect(page.locator("#source-a")).toHaveAttribute(
            "data-discussion-marked",
            "true",
          );
          await expect
            .poll(() =>
              page.evaluate(() =>
                Array.from(CSS.highlights.values())
                  .flatMap((highlight) =>
                    Array.from(highlight).map((range) => range.toString()),
                  )
                  .includes("每个评论都可以独立运行，并在原处继续追问。"),
              ),
            )
            .toBe(true);
          await expect(
            page.getByRole("button", { name: "新建讨论", exact: true }),
          ).toHaveCount(0);
          await page.getByRole("button", { name: "讨论", exact: true }).click();
          await expect(
            page.getByRole("button", { name: "新建讨论", exact: true }),
          ).toBeVisible();
          await page
            .getByRole("heading", { name: "让讨论留在内容旁", exact: true })
            .click();
          await expect(input).toHaveCount(0);
          await expect(page.locator(".discussion-source-mark")).toHaveCount(1);
          await page.locator(".discussion-source-mark").click();
          await expect(input).toBeVisible();
          await expect(
            page.getByText("这段如何保留主线？", { exact: true }),
          ).toBeVisible();
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
            Reflect.get(window, "discussionFixture").connection(false),
          );
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  Reflect.get(window, "discussionFixture").report().connected,
              ),
            )
            .toBe(false);
          await page.evaluate(() =>
            Reflect.get(window, "discussionFixture").connection(true),
          );
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  Reflect.get(window, "discussionFixture").report().requests
                    .length,
              ),
            )
            .toBe(count + 2);
          await expect(page.locator(".discussion-source-mark")).toHaveCount(1);
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
          await expect(dots).toHaveCount(1);
          await page.evaluate(
            (id) =>
              Reflect.get(window, "discussionFixture").phase(id, "settled"),
            second,
          );
          await expect(dots).toHaveCount(0);
          await expect(page.locator(".discussion-source-mark")).toHaveCount(2);
          const markRects = await page
            .locator(".discussion-source-mark")
            .evaluateAll((elements) =>
              elements.map((element) => {
                const r = element.getBoundingClientRect();
                return {
                  left: r.left,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                };
              }),
            );
          const [markA, markB] = markRects;
          assert.ok(
            markA &&
              markB &&
              !(
                Math.min(markA.right, markB.right) >
                  Math.max(markA.left, markB.left) &&
                Math.min(markA.bottom, markB.bottom) >
                  Math.max(markA.top, markB.top)
              ),
            JSON.stringify({ lane, theme, width, markRects }),
          );
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
          await page
            .getByRole("button", { name: "关闭讨论", exact: true })
            .click();
          if (screenshots)
            await page.screenshot({
              path: resolve(
                screenshots,
                `${lane}-${theme}-${width}-closed.png`,
              ),
              fullPage: true,
            });
          await page.reload();
          await expect(page.locator(".discussion-source-mark")).toHaveCount(2);
          await expect(page.locator("#source-a")).toHaveAttribute(
            "data-discussion-marked",
            "true",
          );
          const afterReload = await page.evaluate(
            () => Reflect.get(window, "discussionFixture").report().requests,
          );
          assert.equal(
            afterReload.filter(
              (request: any) =>
                request.method === "discussions.history" ||
                request.method === "discussions.read" ||
                request.path?.includes("/timeline"),
            ).length,
            0,
            "restoring source marks never preloads discussion bodies",
          );
          assert.equal(
            afterReload.filter(
              (request: any) =>
                request.method === "discussions.list" ||
                request.path?.includes("/discussions?"),
            ).length,
            2,
            "one metadata page per visible source; no directory drain",
          );
          await page.locator(".discussion-source-mark").first().click();
          await expect(
            page.getByRole("link", { name: "查看来源" }),
          ).toBeVisible();
          await expect(input).toHaveValue("保持层次，继续说明");
          assert.equal(
            await page.locator("#main-draft").inputValue(),
            "TEST：这段主聊天草稿必须保留。",
          );
          await page.evaluate(
            (id) => Reflect.get(window, "discussionFixture").long(id),
            first,
          );
          for (const zoom of [1, 2]) {
            await page.evaluate((zoom) => {
              const host =
                document.querySelector<HTMLElement>(".app,.page-shell")!;
              host.style.zoom = String(zoom);
              const source = document.querySelector<HTMLElement>("#source-a")!;
              Object.assign(source.style, {
                position: "fixed",
                left: "32px",
                top: `${Math.min(420, innerHeight / zoom - 200)}px`,
                width: `${Math.min(330, innerWidth / zoom - 64)}px`,
              });
            }, zoom);
            let lastLayout: unknown;
            await expect
              .poll(
                async () =>
                  (lastLayout = await page
                    .locator(
                      lane === "desktop"
                        ? ".comment-discussion"
                        : ".dashboard-discussion",
                    )
                    .evaluate((panel) => {
                      const sourceRange = document.createRange();
                      sourceRange.selectNodeContents(
                        document.querySelector("#source-a")!,
                      );
                      const r = panel.getBoundingClientRect(),
                        source = sourceRange.getBoundingClientRect(),
                        composer = document
                          .querySelector("[data-text-popover-blocker]")!
                          .getBoundingClientRect();
                      const body = panel.querySelector(".discussion-messages")!;
                      const clear =
                        r.width > 100 &&
                        r.height > 100 &&
                        (r.right <= source.left + 0.5 ||
                          r.left >= source.right - 0.5 ||
                          r.bottom <= source.top + 0.5 ||
                          r.top >= source.bottom - 0.5) &&
                        (r.right <= composer.left + 0.5 ||
                          r.left >= composer.right - 0.5 ||
                          r.bottom <= composer.top + 0.5 ||
                          r.top >= composer.bottom - 0.5) &&
                        r.left >= 0 &&
                        r.right <= innerWidth + 1 &&
                        r.top >= 0 &&
                        r.bottom <= innerHeight + 1 &&
                        body.scrollHeight > body.clientHeight &&
                        body.clientHeight >=
                          2 *
                            Number.parseFloat(
                              getComputedStyle(
                                body.querySelector(".message-body") ??
                                  body.querySelector(".discussion-message")!,
                              ).lineHeight,
                            );
                      return {
                        clear,
                        coarse: matchMedia("(pointer: coarse)").matches,
                        controls: Array.from(
                          panel.querySelectorAll("button"),
                        ).map((button) => ({
                          name:
                            button.getAttribute("aria-label") ||
                            button.textContent,
                          width: button.getBoundingClientRect().width,
                          height: button.getBoundingClientRect().height,
                        })),
                        panel: r.toJSON(),
                        source: source.toJSON(),
                        composer: composer.toJSON(),
                        scrollHeight: body.scrollHeight,
                        clientHeight: body.clientHeight,
                        placement: (panel as HTMLElement).dataset.textPlacement,
                      };
                    })),
              )
              .toMatchObject({ clear: true })
              .catch(async (error) => {
                context.diagnostic(
                  JSON.stringify({ lane, theme, width, zoom, lastLayout }),
                );
                if (screenshots)
                  await page.screenshot({
                    path: resolve(
                      screenshots,
                      `${lane}-${theme}-${width}-long-${zoom}x-failure.png`,
                    ),
                  });
                throw error;
              });
            const targetLayout = lastLayout as {
              coarse: boolean;
              controls: { width: number; height: number }[];
            };
            assert.equal(
              targetLayout.coarse,
              width === 760,
              JSON.stringify({ lane, theme, width, zoom, lastLayout }),
            );
            if (targetLayout.coarse)
              assert.ok(
                targetLayout.controls.every(
                  (control) =>
                    control.width >= 44 * zoom && control.height >= 44 * zoom,
                ),
                JSON.stringify({ lane, theme, width, zoom, lastLayout }),
              );
            geometry.push({
              lane,
              theme,
              viewportWidth: width,
              zoom,
              ...(lastLayout as object),
            });
            if (screenshots)
              await page.screenshot({
                path: resolve(
                  screenshots,
                  `${lane}-${theme}-${width}-long-${zoom}x.png`,
                ),
                // The fixture itself becomes taller under CSS zoom. Keep the
                //2x capture at the real viewport instead of changing device
                //metrics for a full-page screenshot midway through hit testing.
                fullPage: zoom === 1,
              });
          }
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
