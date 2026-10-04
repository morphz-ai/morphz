import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createServer } from "vite";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";

// Default=current semantics; explicit migration mode
// adds the raw fixed-old command lane with full bounded records, no ID cleaning.
type Result = { ok: true } | { ok: false; error: string };
type Snapshot = {
  drafts: Record<string, InputDraft>;
  stored: Record<string, InputDraft>;
  events: unknown[][];
  rendered: number;
  active: string;
  connected: boolean;
};
const equivalent =
  process.env.MORPHZ_TEST_APPLICATION_COMPOSE_EQUIVALENCE === "1";
test(
  "real scoped draft writer preserves preparation ACK and publication in StrictMode",
  { timeout: 45000 },
  async (context) => {
    const executable =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "Required installed test browser; no Runtime/native App capability claimed",
    );
    const cache = mkdtempSync(
      join(tmpdir(), "morphz-compose-preparation-cache-"),
    );
    const fixturePath = resolve(
      "tests/fixtures/application-compose-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "bounded-compose-preparation",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__compose-preparation")
                return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/@fs${fixturePath}"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
      logLevel: "error",
    });
    let browser: Browser | undefined;
    try {
      await server.listen();
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({
        headless: true,
        executablePath: executable,
      });
      const url = `http://127.0.0.1:${address.port}/__compose-preparation`;
      async function runCase(action: string, script = false) {
        const records: {
          result: Result;
          immediateSnapshot: Snapshot;
          snapshot: Snapshot;
        }[] = [];
        for (const lane of equivalent ? ["fixed", "current"] : ["current"]) {
          const isolated = await browser!.newContext();
          try {
            await isolated.addInitScript(() =>
              sessionStorage.setItem(
                "morphz:window",
                "compose-preparation-window",
              ),
            );
            const page: Page = await isolated.newPage(),
              errors: string[] = [],
              business: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("request", (request) => {
              if (request.url().includes("/api/")) business.push(request.url());
            });
            await page.goto(url + "?lane=" + lane);
            await page.waitForFunction(
              () => !!Reflect.get(window, "applicationComposeFixture"),
            );
            if (script)
              await page.evaluate(() =>
                Reflect.get(window, "applicationComposeFixture").run(
                  "clear-for-script",
                ),
              );
            const originalHandle = await page
              .locator("#original-input")
              .elementHandle();
            assert.ok(originalHandle);
            const record = (await page.evaluate(
              (action) =>
                Reflect.get(window, "applicationComposeFixture").run(action),
              action,
            )) as { result: Result; snapshot: Snapshot };
            const immediateSnapshot = record.snapshot;
            // Only the artifact branch promises publication inside flushSync.
            // Plain/script keep their original queued writer. Preserve the full
            // ACK observation, then wait for the actual DOM commit separately.
            if (action === "captured-plain" || action === "script-captured") {
              const body =
                action === "captured-plain"
                  ? "原渲染正文\nplain-append"
                  : "script-request";
              await page.waitForFunction(
                (body) =>
                  document.querySelector("#state")?.textContent === body,
                body,
              );
              record.snapshot = (await page.evaluate(() =>
                Reflect.get(window, "applicationComposeFixture").snapshot(),
              )) as Snapshot;
            }
            assert.equal(
              await originalHandle.evaluate(
                (node) => node === document.querySelector("#original-input"),
              ),
              true,
              "same DOM node, not merely connected replacement",
            );
            assert.deepEqual(errors, []);
            assert.deepEqual(business, []);
            records.push({ ...record, immediateSnapshot });
            await page.evaluate(() =>
              Reflect.get(window, "applicationComposeFixture").unmount(),
            );
            assert.equal(
              await originalHandle.evaluate((node) => node.isConnected),
              false,
            );
          } finally {
            await isolated.close();
          }
        }
        if (equivalent)
          assert.deepEqual(
            records[1],
            records[0],
            "entire old/current ordered record",
          );
        return records.at(-1)!;
      }
      await context.test(
        "queued latest artifact text/settings and quotes are published before success ACK",
        async () => {
          const { result, snapshot } = await runCase("latest-artifact");
          assert.deepEqual(result, { ok: true });
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.body,
            "排队的最新正文\nartifact-append",
          );
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.model,
            "new-route",
          );
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.reasoningEffort,
            "max",
          );
          assert.equal(
            snapshot.drafts["conversation:quotes"]!.textQuotes?.length,
            1,
          );
          assert.deepEqual(snapshot.stored, snapshot.drafts);
          assert.equal(snapshot.active, "original-input");
          assert.deepEqual(snapshot.events.at(-1), ["ack", { ok: true }]);
        },
      );
      for (const action of ["dedicated-refusal", "limit-refusal"])
        await context.test(
          action + " real executed updater produces a refusal and no reveal",
          async () => {
            const { result, snapshot } = await runCase(action);
            assert.equal(result.ok, false);
            assert.equal(
              snapshot.events.some(
                (event) => event[0] === "prefer" || event[0] === "showInput",
              ),
              false,
            );
            assert.deepEqual(snapshot.stored, snapshot.drafts);
            assert.equal(
              snapshot.drafts["conversation:artifact"]!.body,
              action === "dedicated-refusal"
                ? "专用请求原文"
                : "x".repeat(30000),
            );
          },
        );
      await context.test(
        "plain append deliberately consumes captured render, preserving quote map",
        async () => {
          const { result, snapshot } = await runCase("captured-plain");
          assert.deepEqual(result, { ok: true });
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.body,
            "原渲染正文\nplain-append",
          );
          assert.equal(
            snapshot.drafts["conversation:quotes"]!.textQuotes?.length,
            1,
          );
        },
      );
      await context.test(
        "script captured conflict semantics do not become artifact latest guards",
        async () => {
          const { result, snapshot } = await runCase("script-captured", true);
          assert.deepEqual(result, { ok: true });
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.body,
            "script-request",
          );
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.annotation,
            undefined,
          );
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.scriptGeneration
              ?.productionId,
            "script-one",
          );
        },
      );
      await context.test(
        "original storage failure notice retains prepared React state and true ACK",
        async () => {
          const { result, snapshot } = await runCase("storage-failure");
          assert.deepEqual(result, { ok: true });
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.body,
            "原渲染正文\nartifact-append",
          );
          assert.equal(
            snapshot.stored["conversation:artifact"]!.body,
            "原渲染正文",
          );
          assert.ok(
            snapshot.events.some(
              (event) =>
                event[0] === "notice" &&
                event[1] === "本地草稿保存失败，请不要刷新页面。",
            ),
          );
        },
      );
      await context.test(
        "borrowed replacement origin port retirement remains outside preparation policy",
        async () => {
          const { result, snapshot } = await runCase("retired-replace-port");
          assert.deepEqual(result, { ok: true });
          assert.equal(
            snapshot.drafts["conversation:artifact"]!.body,
            "原渲染正文",
          );
          assert.equal(
            snapshot.events.some((event) => event[0] === "storage"),
            false,
          );
        },
      );
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          await server.close();
        } finally {
          rmSync(cache, { recursive: true, force: true });
        }
      }
    }
  },
);
