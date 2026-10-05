import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import {
  composeLocator,
  composeQuote,
  composeScope,
} from "./fixtures/cognitive-compose-data.js";

type Snapshot = {
  result: { prepared?: true; error?: string };
  before: Record<string, InputDraft>;
  drafts: Record<string, InputDraft>;
  published: Record<string, InputDraft>;
  stored: Record<string, InputDraft>;
  events: unknown[][];
  key: string;
  active: boolean;
  inputBody: string | null;
};
test(
  "ACTUAL Chromium StrictMode draft publication and original private incarnation; controlled Host/locator, no production GUI or SQL claim",
  { timeout: 60000 },
  async (t) => {
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "Required installed browser, no skip/download.",
    );
    const cache = mkdtempSync(
      join(tmpdir(), "morphz-cognitive-compose-cache-"),
    );
    const fixturePath = resolve("tests/fixtures/cognitive-compose-mounted.tsx");
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "isolated-cognitive-compose",
          configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
              if (req.url?.split("?")[0] !== "/__cognitive-compose")
                return next();
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  `<!doctype html><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/@fs${fixturePath}"></script>`,
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
      const port = address.port;
      browser = await chromium.launch({ headless: true, executablePath });
      async function run(action: string): Promise<Snapshot> {
        const context = await browser!.newContext();
        try {
          const page = await context.newPage(),
            errors: string[] = [],
            business: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => {
            if (request.url().includes("/api/")) business.push(request.url());
          });
          await page.goto(`http://127.0.0.1:${port}/__cognitive-compose`);
          await page.waitForFunction(
            () => !!Reflect.get(window, "cognitiveComposeFixture"),
          );
          const snapshot = (await page.evaluate(
            (action) =>
              Reflect.get(window, "cognitiveComposeFixture").run(action),
            action,
          )) as Snapshot;
          assert.deepEqual(errors, []);
          assert.deepEqual(business, []);
          if (action !== "unmounted")
            await page.evaluate(() =>
              Reflect.get(window, "cognitiveComposeFixture").unmount(),
            );
          return snapshot;
        } finally {
          await context.close();
        }
      }
      for (const action of ["latest", "held-latest"] as const)
        await t.test(
          `${action}: actual latest writer/committed layout witness, exact reference and unrelated draft retained`,
          async () => {
            const s = await run(action),
              draft = s.published[s.key]!;
            assert.deepEqual(
              s.result,
              { prepared: true },
              JSON.stringify(s.events),
            );
            assert.equal(
              draft.body,
              "实际最新正文\n保留换行\n请基于原文整理要点",
            );
            assert.equal(s.inputBody, draft.body);
            assert.deepEqual(s.drafts, s.published);
            assert.deepEqual(s.stored, s.published);
            assert.equal(draft.model, "latest-model");
            assert.equal(draft.reasoningEffort, "max");
            assert.deepEqual(draft.attachments, s.before[s.key]!.attachments);
            assert.deepEqual(draft.cognitiveObject, composeLocator());
            assert.deepEqual(draft.cognitiveApplication, {
              connectionId: composeScope().surface.connectionId,
              authority: composeScope().surface.authority,
            });
            assert.deepEqual(s.published["conversation:quotes"]!.textQuotes, [
              composeQuote,
            ]);
            assert.deepEqual(s.published.other, s.before.other);
            assert.deepEqual(
              s.events.filter((e) => e[0] === "prepared"),
              [["prepared", true]],
            );
            assert.ok(
              s.events.some((e) => e[0] === "commit" && e[1] === draft.body),
            );
          },
        );
      for (const action of [
        "retired-reactivated",
        "unmounted",
        "owner-cas-changed",
        "updater-retired",
        "deferred",
        "special-input",
        "different-original",
      ] as const)
        await t.test(
          `${action}: original lease cannot publish late or fake ACK; whole original map stays`,
          async () => {
            const s = await run(action);
            assert.deepEqual(s.result, {
              error: action === "deferred" ? "unavailable" : "conflict",
            });
            assert.deepEqual(s.published, s.before);
            assert.deepEqual(s.stored, s.before);
            if (action === "special-input" || action === "different-original") {
              assert.ok(!Object.hasOwn(s.published, "conversation:quotes"));
              assert.ok(!Object.hasOwn(s.stored, "conversation:quotes"));
            }
            assert.deepEqual(
              s.events.filter((e) => e[0] === "prepared"),
              [],
            );
            if (action !== "unmounted")
              assert.equal(s.inputBody, s.before[s.key]!.body);
          },
        );
      await t.test(
        "missing committed witness refuses ACK even though real writer already published; not rollback",
        async () => {
          const s = await run("no-witness");
          assert.deepEqual(s.result, { error: "unavailable" });
          assert.notDeepEqual(s.published, s.before);
          assert.equal(s.inputBody, s.published[s.key]!.body);
          assert.deepEqual(
            s.events.filter((e) => e[0] === "prepared"),
            [],
          );
        },
      );
      await t.test(
        "actual localStorage failure keeps React publication and original notice; prepared is not durable-save ACK",
        async () => {
          const s = await run("storage-refusal");
          assert.deepEqual(
            s.result,
            { prepared: true },
            JSON.stringify(s.events),
          );
          assert.deepEqual(s.stored, s.before);
          assert.notDeepEqual(s.published, s.before);
          assert.equal(s.inputBody, s.published[s.key]!.body);
          assert.ok(
            s.events.some(
              (e) =>
                e[0] === "notice" && String(e[1]).includes("本地草稿保存失败"),
            ),
          );
          assert.deepEqual(
            s.events.filter((e) => e[0] === "prepared"),
            [["prepared", true]],
          );
        },
      );
    } finally {
      await browser?.close();
      await server.close();
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
