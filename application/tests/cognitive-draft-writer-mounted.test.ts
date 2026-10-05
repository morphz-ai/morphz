import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";

// Mounted isolated browser + real public scoped draft writer, not full App,
// Human/author policy, application resource execution or Runtime acceptance.
type Snapshot = {
  drafts: Record<string, InputDraft>;
  stored: Record<string, InputDraft>;
  events: unknown[][];
  rendered: number;
  key: string;
};
test(
  "mounted actual public draft writer pins first edits with original App writer bodies",
  { timeout: 45000 },
  async (context) => {
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "Required installed isolated test browser; no App/Runtime capability claim",
    );
    const cache = mkdtempSync(
      join(tmpdir(), "morphz-cognitive-draft-writer-cache-"),
    );
    const fixturePath = resolve(
      "tests/fixtures/cognitive-draft-writer-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "bounded-cognitive-draft-writer",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__cognitive-draft-writer")
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
      browser = await chromium.launch({ headless: true, executablePath });
      const url = `http://127.0.0.1:${address.port}/__cognitive-draft-writer`;
      async function run(action: string): Promise<Snapshot> {
        const isolated = await browser!.newContext();
        try {
          await isolated.addInitScript(() =>
            sessionStorage.setItem(
              "morphz:window",
              "cognitive-writer-test-window",
            ),
          );
          const page = await isolated.newPage(),
            errors: string[] = [],
            business: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => {
            if (request.url().includes("/api/")) business.push(request.url());
          });
          await page.goto(url);
          await page.waitForFunction(
            () => !!Reflect.get(window, "cognitiveDraftWriterFixture"),
          );
          const original = await page
            .locator("#original-input")
            .elementHandle();
          assert.ok(original);
          const record = (await page.evaluate(
            (action) =>
              Reflect.get(window, "cognitiveDraftWriterFixture").run(action),
            action,
          )) as { returned: null; snapshot: Snapshot };
          assert.equal(
            record.returned,
            null,
            "void writer deliberately does not issue a preparation ACK",
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(business, []);
          assert.equal(
            await original.evaluate(
              (node) => node === document.querySelector("#original-input"),
            ),
            true,
          );
          await page.evaluate(() =>
            Reflect.get(window, "cognitiveDraftWriterFixture").unmount(),
          );
          assert.equal(
            await original.evaluate((node) => node.isConnected),
            false,
          );
          return record.snapshot;
        } finally {
          await isolated.close();
        }
      }
      await context.test(
        "queued first V1 edit then V2 reopening still publishes whole V1 and latest settings",
        async () => {
          const s = await run("first-and-reopen"),
            draft = s.drafts[s.key]!;
          assert.equal(draft.body, "V1 text\nV2 continued");
          assert.equal(draft.model, "user-model");
          assert.equal(draft.reasoningEffort, "max");
          assert.equal(draft.cognitiveObject?.object.versionRef, "opaque:V1");
          assert.deepEqual(s.stored, s.drafts);
          assert.deepEqual(
            s.events.filter((e) => e[0] === "error"),
            [],
          );
          assert.ok(s.rendered >= 2);
        },
      );
      await context.test(
        "first real attachment edit pins the exact original",
        async () => {
          const s = await run("attachment");
          assert.equal(
            s.drafts[s.key]?.cognitiveObject?.object.versionRef,
            "opaque:V1",
          );
          assert.equal(s.drafts[s.key]?.attachments?.length, 1);
          assert.deepEqual(s.stored, s.drafts);
        },
      );
      await context.test(
        "identity refusal retains saved V1 and publishes an explicit error without success ACK",
        async () => {
          const s = await run("refuse");
          assert.equal(s.drafts[s.key]?.body, "saved V1");
          assert.equal(
            s.drafts[s.key]?.cognitiveObject?.object.versionRef,
            "opaque:V1",
          );
          assert.ok(s.events.some((e) => e[0] === "error"));
          assert.deepEqual(s.stored, s.drafts);
          assert.equal(
            s.events.some((e) => e[0] === "ack"),
            false,
          );
        },
      );
      await context.test(
        "send cleanup leaves no stale locator while preserving the latest choice",
        async () => {
          const s = await run("cleanup");
          assert.equal(s.drafts[s.key]?.body, "");
          assert.equal(s.drafts[s.key]?.cognitiveObject, undefined);
          assert.equal(s.drafts[s.key]?.model, "choice");
          // Exact existing localStorage JSON serialization removes only
          // optional undefined values from the ordinary cleanup result.
          assert.deepEqual(s.stored, JSON.parse(JSON.stringify(s.drafts)));
        },
      );
      await context.test(
        "actual storage refusal keeps React draft with original storage notice, not a persistence ACK",
        async () => {
          const s = await run("storage-failure");
          assert.equal(s.drafts[s.key]?.body, "kept in React");
          assert.equal(
            s.drafts[s.key]?.cognitiveObject?.object.versionRef,
            "opaque:V1",
          );
          assert.deepEqual(s.stored, {});
          assert.ok(
            s.events.some(
              (e) =>
                e[0] === "notice" &&
                e[1] === "本地草稿保存失败，请不要刷新页面。",
            ),
          );
        },
      );
      await context.test(
        "unchanged original origin guards block both retired writer bodies",
        async () => {
          const s = await run("retired");
          assert.deepEqual(s.drafts, {});
          assert.deepEqual(s.stored, {});
          assert.deepEqual(s.events, []);
        },
      );
      await context.test(
        "noncognitive ordinary input retains numeric builtin source unchanged",
        async () => {
          const s = await run("ordinary");
          assert.equal(s.drafts["conversation:legacy"]?.revision, 2);
          assert.equal(
            s.drafts["conversation:legacy"]?.selection,
            "old builtin",
          );
          assert.equal(
            s.drafts["conversation:legacy"]?.cognitiveObject,
            undefined,
          );
          assert.deepEqual(s.stored, s.drafts);
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
