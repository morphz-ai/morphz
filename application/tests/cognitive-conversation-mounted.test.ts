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
      "new reading defaults to all authorized exchanges without changing the original work scope",
      async () => {
        assert.equal(
          await page
            .getByRole("button", { name: "全部交流", exact: true })
            .getAttribute("aria-pressed"),
          "true",
        );
        assert.equal(
          await page
            .getByRole("button", { name: "当前作品", exact: true })
            .getAttribute("aria-pressed"),
          "false",
        );
        for (const id of [
          "input-V1",
          "input-V2",
          "input-B",
          "input-foreign",
          "input-ordinary",
        ])
          assert.equal(
            await page.locator(`[data-message-id="${id}"]`).count(),
            1,
          );
        assert.equal(
          await page.locator("#composer").inputValue(),
          "Unsent draft",
        );
      },
    );
    await context.test(
      "whole identity focus includes old and new versions, not a foreign author or ordinary input",
      async () => {
        await page
          .getByRole("button", { name: "当前作品", exact: true })
          .click();
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
      "direct history choices expose the current scope, are idempotent and keep one Session and draft",
      async () => {
        const scope = page.getByRole("group", {
          name: "交流范围",
          exact: true,
        });
        const current = scope.getByRole("button", {
          name: "当前作品",
          exact: true,
        });
        const all = scope.getByRole("button", {
          name: "全部交流",
          exact: true,
        });
        assert.equal(await scope.getByRole("button").count(), 2);
        assert.equal(await current.getAttribute("aria-pressed"), "true");
        assert.equal(await all.getAttribute("aria-pressed"), "false");
        await current.click();
        assert.equal(await current.getAttribute("aria-pressed"), "true");
        await page
          .getByRole("button", { name: "全部交流", exact: true })
          .click();
        assert.equal(await all.getAttribute("aria-pressed"), "true");
        assert.equal(await current.getAttribute("aria-pressed"), "false");
        assert.equal(
          await page.locator('[data-message-id="input-foreign"]').count(),
          1,
        );
        await all.press("Enter");
        assert.equal(await all.getAttribute("aria-pressed"), "true");
        await current.press("Space");
        assert.equal(await current.getAttribute("aria-pressed"), "true");
        assert.equal(
          await page.locator('[data-message-id="input-foreign"]').count(),
          0,
        );
        assert.equal(await page.getByRole("menu").count(), 0);
        assert.equal(
          await page.locator("#composer").inputValue(),
          "Unsent draft",
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
          await page
            .getByRole("button", { name: "全部交流", exact: true })
            .getAttribute("aria-pressed"),
          "true",
        );
        await page
          .getByRole("button", { name: "当前作品", exact: true })
          .click();
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
        await page
          .getByRole("button", { name: "当前作品", exact: true })
          .click();
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
    await context.test(
      "the filter appears for readable public progress and unowned replies, but stays absent without other visible exchanges",
      async () => {
        const history = (extra?: "reply" | "progress") =>
          page.evaluate(
            (extra) =>
              Reflect.get(window, "cognitiveConversationFixture").history(
                true,
                extra,
              ),
            extra,
          );
        await history();
        assert.equal(
          await page
            .getByRole("group", { name: "交流范围", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.locator('[data-message-id="input-V1"]').count(),
          1,
        );
        await history("progress");
        assert.equal(
          await page
            .getByRole("group", { name: "交流范围", exact: true })
            .count(),
          1,
        );
        await page
          .getByRole("button", { name: "全部交流", exact: true })
          .click();
        assert.equal(
          await page.locator('[data-message-id="unattributed"]').count(),
          1,
          "public progress remains readable instead of disappearing after handoff",
        );
        await page
          .getByRole("button", { name: "当前作品", exact: true })
          .click();
        assert.equal(
          await page.locator('[data-message-id="unattributed"]').count(),
          0,
          "explicit current-work filtering still excludes unowned progress",
        );
        await history("reply");
        await page
          .getByRole("button", { name: "全部交流", exact: true })
          .click();
        assert.equal(
          await page.locator('[data-message-id="unattributed"]').count(),
          1,
        );
        await page
          .getByRole("button", { name: "当前作品", exact: true })
          .click();
        assert.equal(
          await page.locator('[data-message-id="unattributed"]').count(),
          0,
        );
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveConversationFixture").history(false),
        );
      },
    );
    await context.test(
      "builtin objects and application focus have truthful direct scopes, reset on navigation and do not create another conversation",
      async () => {
        for (const [kind, label] of [
          ["artifact", "当前作品"],
          ["application", "当前应用"],
        ] as const) {
          await page.evaluate(
            (kind) =>
              Reflect.get(window, "cognitiveConversationFixture").kind(kind),
            kind,
          );
          await settle();
          const current = page.getByRole("button", {
            name: label,
            exact: true,
          });
          assert.equal(await current.getAttribute("aria-pressed"), "false");
          assert.equal(
            await page
              .getByRole("button", { name: "全部交流", exact: true })
              .getAttribute("aria-pressed"),
            "true",
          );
          assert.equal(
            await page.locator('[data-message-id="input-B"]').count(),
            1,
          );
          await page
            .getByRole("button", { name: "全部交流", exact: true })
            .click();
          assert.equal(
            await page.locator('[data-message-id="input-B"]').count(),
            1,
          );
          await current.click();
          assert.equal(
            await page.locator('[data-message-id="input-B"]').count(),
            0,
          );
          assert.equal(
            await page.locator("#composer").inputValue(),
            "Unsent draft",
          );
          assert.equal(
            await originalNode.evaluate(
              (node) => node === document.querySelector(".conversation"),
            ),
            true,
          );
        }
        await page.evaluate(() =>
          Reflect.get(window, "cognitiveConversationFixture").kind("none"),
        );
        await settle();
        assert.equal(
          await page
            .getByRole("group", { name: "交流范围", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page.locator('[data-message-id="input-B"]').count(),
          1,
        );
        assert.equal(
          (await report()).events.some((event) => event[0] === "builtin-open"),
          false,
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
