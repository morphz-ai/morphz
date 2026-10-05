import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer } from "vite";
import { cognitiveNavigationLocation } from "../apps/web/src/host/cognitive-navigation-location.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";

test("local original navigation stores only a detached exact locator and rejects executable/inherited/extra slots", () => {
  const locator = parseCognitiveAppObjectLocator({
    contentId: "content",
    projectId: "project",
    connectionId: "connection",
    authority: {
      appId: "author.notes",
      version: "1.0.0",
      definitionHash: "a".repeat(64),
      instanceId: "instance",
      serviceId: "author/service",
      dataAuthorityId: "author/data",
    },
    object: {
      objectId: "exact object 😀",
      versionRef: "000900719925474099312345:😀\n",
    },
  });
  const raw = {
    kind: "original",
    locator: { ...locator, object: { ...locator.object } },
  };
  const parsed = cognitiveNavigationLocation(raw)!;
  assert(parsed.kind === "original");
  assert.equal(Object.isFrozen(parsed), true);
  assert.notEqual(parsed.locator, raw.locator);
  raw.locator.object.versionRef = "new-head";
  assert.equal(parsed.locator.object.versionRef, locator.object.versionRef);
  assert.deepEqual(Object.keys(parsed), ["kind", "locator"]);
  assert.equal(cognitiveNavigationLocation(null), null);
  assert.equal(cognitiveNavigationLocation(undefined), null);
  let accessed = false;
  const getter = Object.defineProperty({ kind: "original" }, "locator", {
    enumerable: true,
    get() {
      accessed = true;
      return locator;
    },
  });
  for (const invalid of [
    getter,
    Object.create({ kind: "original", locator }),
    { kind: "original", locator, body: "PRIVATE_BODY" },
    { kind: "view", locator },
    { kind: "original", locator, [Symbol("private")]: "PRIVATE" },
    {
      kind: "original",
      locator: {
        ...locator,
        object: { objectId: "exact object 😀", versionRef: 2 },
      },
    },
  ])
    assert.throws(() => cognitiveNavigationLocation(invalid));
  assert.equal(accessed, false);
});

async function action(page: Page, name: string, ...args: unknown[]) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      (async () => {
        await page.evaluate(
          ({ name, args }) =>
            Reflect.get(window, "cognitiveOriginalFixture")[name](...args),
          { name, args },
        );
        // Let real effect/Promise publication finish, not a mocked renderer.
        await page.evaluate(
          () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        );
        return page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalFixture").report(),
        );
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("mounted fixture action timed out: " + name)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

test(
  "mounted React original lifecycle with controlled current-Human ports, not SQL/HPA/network acceptance",
  { timeout: 60_000 },
  async (t) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert(
      existsSync(executable || chromium.executablePath()),
      "formal test entry must prepare real Chromium",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-cognitive-original-vite-"),
    );
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const fixture = resolve("tests/fixtures/cognitive-original-mounted.tsx");
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "controlled-human-original-mounted",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__original") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url!,
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
      executablePath: executable || undefined,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [];
    const remoteRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("untrusted.example"))
        remoteRequests.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${address.port}/__original`);
    await page.waitForSelector("#state");

    await t.test(
      "identity change synchronously clears an already-ready result with identical locator and epoch",
      async () => {
        let report = await action(page, "reset");
        assert.equal(report.pending.length, 1);
        report = await action(page, "settle", 0);
        assert.equal(report.state.body.text, "PINNED_V1_PRIVATE");
        report = await action(page, "config", {
          identity: {
            centerId: "center",
            principalId: "other",
            csrfToken: "other-session",
          },
        });
        assert.equal(report.state.body, undefined);
        assert.equal(report.state.blocked, true);
        const changed = report.commits.filter(
          (row: any) => row.scope.principalId === "other",
        );
        assert(
          changed.every((row: any) => row.body === undefined),
          "no render commit may expose prior Human body",
        );
      },
    );

    await t.test(
      "an authorized read cannot be adopted by another Human at the same future navigation epoch",
      async () => {
        await action(page, "reset", { location: null });
        await action(page, "explicitRead");
        await action(page, "settle", 0);
        assert.equal(
          await page.evaluate(
            () =>
              Reflect.get(window, "cognitiveOriginalFixture").explicitStatus()
                .value,
          ),
          true,
        );
        await action(page, "config", {
          identity: {
            centerId: "new-center",
            principalId: "other",
            csrfToken: "other-session",
          },
        });
        await action(page, "adopt", 2, true);
        const first = await page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalFixture").locator(),
        );
        const report = await action(page, "config", {
          epoch: 2,
          location: { kind: "original", locator: first },
        });
        assert.equal(report.state.body, undefined);
        assert.equal(report.state.blocked, true);
      },
    );

    await t.test(
      "opaque version stays exact; navigation and stale body resolution never restore an old incarnation",
      async () => {
        let report = await action(page, "reset");
        const first = await page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalFixture").locator(),
        );
        report = await action(page, "settle", 0, "V1_OLD_READ");
        assert.equal(report.state.version, first.object.versionRef);
        assert(report.dom.toolbar.includes(first.object.versionRef));
        const second = await page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalFixture").latest(),
        );
        report = await action(page, "config", { location: second, epoch: 2 });
        assert.equal(report.state.body, undefined);
        assert.equal(
          report.pending[0].aborted,
          true,
          "navigation cleanup retires the previous read signal",
        );
        report = await action(page, "config", {
          location: { kind: "original", locator: first },
          epoch: 1,
        });
        assert.equal(
          report.state.body,
          undefined,
          "returning to identical numeric epoch does not revive an old result",
        );
        report = await action(page, "settle", 1, "V2_TOO_LATE");
        assert.equal(report.state.body, undefined);
        report = await action(page, "settle", 2, "V1_FRESH_READ");
        assert.equal(report.state.body.text, "V1_FRESH_READ");
        assert(
          report.reads
            .filter((r: any) => r.method === "cognitive-apps.read-object")
            .every(
              (r: any) => typeof r.parameters.object.versionRef === "string",
            ),
        );
      },
    );

    await t.test(
      "scope tuple cannot collide and current-Human gate hides ready text synchronously",
      async () => {
        await action(page, "reset", {
          identity: { centerId: "a:b", principalId: "c", csrfToken: "d" },
        });
        await action(page, "settle", 0, "COLLISION_PRIVATE");
        let report = await action(page, "config", {
          identity: { centerId: "a", principalId: "b:c", csrfToken: "d" },
        });
        assert.equal(report.state.body, undefined);
        report = await action(page, "settle", 1, "NEW_HUMAN_BODY");
        assert.equal(report.state.body.text, "NEW_HUMAN_BODY");
        report = await action(page, "config", { valid: false });
        assert.equal(report.state.body, undefined);
        assert.equal(report.state.blocked, true);
      },
    );

    await t.test(
      "explicit authorized open adopts only a branded same-Human result into the existing navigation epoch without a second read",
      async () => {
        await action(page, "reset", { location: null });
        await action(page, "explicitRead");
        await action(page, "settle", 0, "ONE_EXPLICIT_READ");
        const first = await page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalFixture").locator(),
        );
        await action(page, "adopt", 2);
        let report = await action(page, "config", {
          epoch: 2,
          location: { kind: "original", locator: first },
        });
        assert.equal(report.state.body.text, "ONE_EXPLICIT_READ");
        assert.equal(
          report.pending.length,
          1,
          "authorized open does not repeat author original reads",
        );
        report = await action(page, "retry");
        assert.equal(report.state.body, undefined);
        assert.equal(report.pending.length, 2);
        await action(page, "settle", 1, "FRESH_AFTER_RETRY");
        report = await action(page, "forgedAdopt", 2);
        assert.equal(
          report.state.body.text,
          "FRESH_AFTER_RETRY",
          "plain copied body is not an authorized read proof",
        );
      },
    );

    await t.test(
      "cleanup aborts reads; late read cannot remount private text or be adopted",
      async () => {
        let report = await action(page, "reset");
        report = await action(page, "mount", false);
        assert.equal(report.state, null);
        assert.equal(report.pending[0].aborted, true);
        await action(page, "settle", 0, "UNMOUNT_TOO_LATE");
        report = await action(page, "mount", true);
        assert.equal(report.state.body, undefined);
        assert.equal(report.pending.length, 2);
        await action(page, "reset", { location: null });
        await action(page, "explicitRead");
        report = await action(page, "mount", false);
        assert.equal(report.pending[0].aborted, true);
        await action(page, "settle", 0, "EXPLICIT_UNMOUNT_TOO_LATE");
        assert.match(
          await page.evaluate(
            () =>
              Reflect.get(window, "cognitiveOriginalFixture").explicitStatus()
                .error,
          ),
          /取消|范围/,
        );
      },
    );

    await t.test(
      "caller cancellation settles an explicit open even when the controlled transport ignores abort; a pre-cancelled open makes zero calls",
      async () => {
        await action(page, "reset", { location: null });
        await action(page, "explicitRead");
        let report = await action(page, "cancelExplicit");
        assert.equal(report.pending[0].aborted, true);
        assert.match(
          await page.evaluate(
            () =>
              Reflect.get(window, "cognitiveOriginalFixture").explicitStatus()
                .error,
          ),
          /取消|超时/,
        );
        await action(page, "settle", 0, "CANCEL_TOO_LATE");
        assert.equal(
          await page.evaluate(
            () =>
              Reflect.get(window, "cognitiveOriginalFixture").explicitStatus()
                .value,
          ),
          false,
        );
        await action(page, "reset", { location: null });
        report = await action(page, "explicitReadAlreadyCancelled");
        assert.equal(report.reads.length, 0);
        assert.equal(report.pending.length, 0);
        assert.match(
          await page.evaluate(
            () =>
              Reflect.get(window, "cognitiveOriginalFixture").explicitStatus()
                .error,
          ),
          /取消|超时/,
        );
      },
    );

    await t.test(
      "late explicit read after center, principal or login-generation changes yields no adoptable value",
      async () => {
        for (const identity of [
          {
            centerId: "other-center",
            principalId: "human",
            csrfToken: "session",
          },
          {
            centerId: "center",
            principalId: "other-human",
            csrfToken: "session",
          },
          {
            centerId: "center",
            principalId: "human",
            csrfToken: "rotated-session",
          },
        ]) {
          await action(page, "reset", { location: null });
          await action(page, "explicitRead");
          await action(page, "config", { identity });
          await action(page, "settle", 0, "IDENTITY_TOO_LATE");
          const value = await page.evaluate(() =>
            Reflect.get(window, "cognitiveOriginalFixture").explicitStatus(),
          );
          assert.equal(value.value, false);
          assert.match(value.error, /范围|取消/);
        }
      },
    );

    await t.test(
      "returning to a prior Human scope does not revive an earlier explicit read proof",
      async () => {
        await action(page, "reset", { location: null });
        await action(page, "explicitRead");
        await action(page, "settle", 0, "PRIOR_SCOPE_PRIVATE");
        await action(page, "config", {
          identity: {
            centerId: "other",
            principalId: "human",
            csrfToken: "other-session",
          },
        });
        await action(page, "config", {
          identity: {
            centerId: "center",
            principalId: "human",
            csrfToken: "session",
          },
        });
        await action(page, "adopt", 2, true);
        const first = await page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalFixture").locator(),
        );
        const report = await action(page, "config", {
          epoch: 2,
          location: { kind: "original", locator: first },
        });
        assert.equal(report.state.body, undefined);
        assert.equal(
          report.pending.length,
          2,
          "returning scope must perform its own current-Human read",
        );
      },
    );

    await t.test(
      "monotonic deadline rejects a late body even if a busy browser has not fired its deadline timer",
      async () => {
        await action(page, "reset");
        await action(page, "elapseWithoutTimer", 30_001);
        let report = await action(
          page,
          "settle",
          0,
          "AFTER_MONOTONIC_DEADLINE",
        );
        assert.equal(report.state.body, undefined);
        assert.match(report.state.message, /超时/);
        assert.equal(report.pending[0].aborted, true);
        await action(page, "reset", { location: null });
        await action(page, "explicitRead");
        await action(page, "elapseWithoutTimer", 30_001);
        report = await action(
          page,
          "settle",
          0,
          "EXPLICIT_AFTER_MONOTONIC_DEADLINE",
        );
        assert.equal(report.pending[0].aborted, true);
        const value = await page.evaluate(() =>
          Reflect.get(window, "cognitiveOriginalFixture").explicitStatus(),
        );
        assert.equal(value.value, false);
        assert.match(value.error, /超时/);
      },
    );

    await t.test(
      "30-second deadline aborts; a retry is explicit and late success cannot erase the error",
      async () => {
        let report = await action(page, "reset");
        assert(
          report.timers.some((timer: any) => timer.live && timer.ms === 30_000),
        );
        report = await action(page, "deadline");
        assert.equal(report.pending[0].aborted, true);
        assert.match(report.state.message, /超时/);
        report = await action(page, "settle", 0, "AFTER_TIMEOUT_PRIVATE");
        assert.equal(report.state.body, undefined);
        assert.match(report.state.message, /超时/);
        const before = report.pending.length;
        await new Promise((resolve) => setTimeout(resolve, 15));
        report = await action(page, "report");
        assert.equal(
          report.pending.length,
          before,
          "no background poll or automatic retry",
        );
        report = await action(page, "retry");
        assert.equal(report.pending.length, before + 1);
        report = await action(page, "settle", 1, "RETRY_EXACT_VERSION");
        assert.equal(report.state.body.text, "RETRY_EXACT_VERSION");
        await action(page, "reset", { location: null });
        await action(page, "explicitRead");
        await action(page, "deadline");
        assert.match(
          await page.evaluate(
            () =>
              Reflect.get(window, "cognitiveOriginalFixture").explicitStatus()
                .error,
          ),
          /取消|超时/,
        );
      },
    );

    await t.test(
      "malformed/restored locations cannot authorize reads; read denial stays visible and recoverable",
      async () => {
        let report = await action(page, "reset", {
          location: {
            kind: "original",
            locator: { fabricated: "not a grant" },
          },
        });
        assert.equal(report.pending.length, 0);
        assert.equal(report.reads.length, 0);
        assert.match(report.state.message, /无效/);
        report = await action(page, "reset");
        report = await action(page, "fail", 0, "原件许可已撤销");
        assert.equal(report.state.body, undefined);
        assert.match(report.dom.text, /许可已撤销/);
        assert.match(report.dom.toolbar, /重试/);
      },
    );

    await t.test(
      "readonly renderer preserves Markdown line breaks, safely displays text/JSON and never fetches external images",
      async () => {
        await action(page, "reset");
        let report = await action(
          page,
          "settle",
          0,
          "第一行\n第二行\n\n![remote](https://untrusted.example/image.png)\n\n<script>window.originalInjected=true</script>",
        );
        assert.equal(report.dom.lineBreaks, 1);
        assert.equal(report.dom.images, 0);
        assert.equal(report.dom.scripts, 0);
        assert.equal(report.dom.ran, null);
        assert.equal(report.dom.inputs, 0);
        assert.equal(report.dom.artifactQuotes, 0);
        assert.match(report.dom.text, /查看外部图片/);
        await action(page, "reset");
        report = await action(
          page,
          "settle",
          0,
          '<img src="https://untrusted.example/text.png" onerror="window.originalInjected=true">\n原始换行',
          "text",
        );
        assert.match(report.dom.rendered, /&lt;img/);
        assert.match(report.dom.text, /\n原始换行/);
        assert.equal(report.dom.images, 0);
        await action(page, "reset");
        report = await action(
          page,
          "settle",
          0,
          '{"html":"<script>window.originalInjected=true</script>","lines":"第一行\\n第二行"}',
          "json",
        );
        assert.match(report.dom.rendered, /&lt;script/);
        assert.equal(report.dom.scripts, 0);
        assert.equal(report.dom.ran, null);
        assert.deepEqual(remoteRequests, []);
      },
    );
    assert.deepEqual(errors, []);
  },
);
