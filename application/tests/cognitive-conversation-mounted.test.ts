import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test(
  "mounted complete Conversation retains exact opaque opens and separates original reading scopes",
  { timeout: 45000 },
  async (context) => {
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "Required prepared isolated browser, never a silent skip",
    );
    const cache = mkdtempSync(join(tmpdir(), "morphz-cognitive-conversation-"));
    const fixture = resolve(
      "tests/fixtures/cognitive-conversation-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      logLevel: "error",
      plugins: [
        react(),
        {
          name: "cognitive-conversation-only",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__cognitive-conversation") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><link rel="icon" href="data:,"><style>body{margin:0;font:14px/20px sans-serif}.conversation{height:240px;overflow:auto;scroll-behavior:auto}.conversation-message{min-height:80px;padding:8px}.conversation p{margin:0 0 8px}header{height:28px}</style></head><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    context.after(async () => {
      await server.close();
      rmSync(cache, { recursive: true, force: true });
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch({ headless: true, executablePath });
    context.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [],
      business: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/api/")) business.push(request.url());
    });
    await page.goto(
      `http://127.0.0.1:${address.port}/__cognitive-conversation`,
    );
    await page.waitForFunction(
      () => !!Reflect.get(window, "cognitiveConversationFixture"),
    );
    const originalNode = await page.locator(".conversation").elementHandle();
    assert.ok(originalNode);
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
    const report = () =>
      page.evaluate(() =>
        Reflect.get(window, "cognitiveConversationFixture").report(),
      ) as Promise<{
        positions: [string, { top: number }][];
        keys: string[];
        top: number;
        events: unknown[][];
      }>;
    await context.test(
      "whole identity focus includes old and new versions, not a foreign author or ordinary input",
      async () => {
        for (const id of ["input-V1", "input-V2"])
          assert.equal(
            await page.locator(`[data-message-id="${id}"]`).count(),
            1,
          );
        for (const id of ["input-B", "input-foreign", "input-ordinary"])
          assert.equal(
            await page.locator(`[data-message-id="${id}"]`).count(),
            0,
          );
        assert.equal(await page.locator(".message-object-link").count(), 2);
        await page
          .locator('[data-message-id="input-V1"] .message-object-link')
          .click();
        const opened = (await report()).events.filter(
          (event) => event[0] === "open",
        );
        assert.equal(opened.length, 1);
        const source = opened[0]![1] as {
          authority: { dataAuthorityId: string };
          object: { objectId: string; versionRef: string };
        };
        assert.equal(source.authority.dataAuthorityId, "authority-one");
        assert.equal(source.object.objectId, "opaque:对象-A");
        assert.equal(source.object.versionRef, "release/版本#001");
      },
    );
    await context.test(
      "all-history toggle is available for cognitive originals and returns to the original focus",
      async () => {
        await page
          .getByRole("button", { name: "查看全部交流", exact: true })
          .click();
        await page
          .getByRole("button", { name: "仅看当前原件的交流", exact: true })
          .waitFor();
        assert.equal(
          await page.locator('[data-message-id="input-foreign"]').count(),
          1,
        );
        await page
          .getByRole("button", { name: "仅看当前原件的交流", exact: true })
          .click();
        assert.equal(
          await page.locator('[data-message-id="input-foreign"]').count(),
          0,
        );
      },
    );
    await context.test(
      "same Session and renderer preserve separate caller-owned scroll positions per complete object identity",
      async () => {
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveConversationFixture").scroll(70),
        );
        await settle();
        const before = await report();
        assert.equal(before.top, 70);
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveConversationFixture").select("B"),
        );
        await settle();
        assert.equal(
          await page.locator('[data-message-id="input-B"]').count(),
          1,
        );
        assert.equal(
          await page.locator('[data-message-id="input-V1"]').count(),
          0,
        );
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveConversationFixture").scroll(35),
        );
        await settle();
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveConversationFixture").select("A"),
        );
        await settle();
        const after = await report();
        assert.equal(after.top, 70);
        assert.equal(
          after.positions.find(([key]) => key === after.keys[0])?.[1].top,
          70,
        );
        assert.equal(
          after.positions.find(([key]) => key === after.keys[1])?.[1].top,
          35,
        );
        assert.notEqual(after.keys[0], after.keys[1]);
        assert.equal(
          after.keys[0],
          after.keys[2],
          "opaque version is not an object identity",
        );
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveConversationFixture").select("V2"),
        );
        await settle();
        assert.equal((await report()).top, 70);
        assert.equal(
          await originalNode.evaluate(
            (node) => node === document.querySelector(".conversation"),
          ),
          true,
        );
        assert.equal(
          await page.locator("#composer").inputValue(),
          "Unsent draft",
        );
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      business,
      [],
      "reading and navigation must not send inputs or invoke author operations",
    );
  },
);
