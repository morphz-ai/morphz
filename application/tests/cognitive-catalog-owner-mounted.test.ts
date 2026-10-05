import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";
import { createServer } from "vite";
import type { ApplicationInvocation } from "../packages/core/src/application-api.js";
import type { CognitiveAppCatalogDto } from "../packages/core/src/cognitive-app-api.js";

type Catalog = Pick<CognitiveAppCatalogDto, "versions" | "connections">;
type Identity = { centerId: string; principalId: string; csrfToken: string };
type Snapshot = {
  mounted: boolean;
  boot: Identity | null;
  catalog: Catalog;
  error: string;
  online: boolean;
  renderedCatalog: string | null;
  renderedError: string | null;
  requests: ApplicationInvocation[];
  unknown: string[];
  cancelled: string[];
  held: Array<{ index: number; label: string; id: string; settled: boolean }>;
  trace: Array<{
    identity: Identity | null;
    catalog: { versions: string[]; connections: string[] };
  }>;
  subscribers: number;
  unsentBytes: string;
  storedDraft: string | null;
  draftStorageKey: string;
};
const empty: Catalog = { versions: [], connections: [] };
const initialVersions = ["example.one", "example.two", "example.three"];
const initialConnections = ["connection-one", "connection-two"];
async function report(page: Page): Promise<Snapshot> {
  await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 0)));
  return page.evaluate(() =>
    Reflect.get(window, "cognitiveCatalogOwnerFixture").report(),
  );
}
async function action(page: Page, name: string, ...args: unknown[]) {
  await page.evaluate(
    ({ name, args }) =>
      Reflect.get(window, "cognitiveCatalogOwnerFixture")[name](...args),
    { name, args },
  );
  return report(page);
}
async function wait(page: Page, condition: (value: Snapshot) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await report(page);
    if (condition(value)) return value;
    if (Date.now() >= deadline)
      assert.fail(
        "mounted production owner condition timed out: " +
          JSON.stringify(value),
      );
    await page.waitForTimeout(20);
  }
}
const catalogCalls = (r: Snapshot) =>
  r.requests.filter((x) => x.method === "cognitive-apps.list");
function assertInitial(r: Snapshot) {
  assert.deepEqual(
    r.catalog.versions.map((v) => v.appId),
    initialVersions,
  );
  assert.deepEqual(
    r.catalog.connections.map((c) => c.connectionId),
    initialConnections,
  );
  assert.equal(r.renderedCatalog, JSON.stringify(r.catalog));
  assert.ok(r.catalog.versions.every((v) => v.ui === null && v.grant === null));
  assert.ok(
    r.catalog.versions.every(
      (v) => v.registeredAt === "2026-10-05T00:00:00.000Z",
    ),
  );
  assert.equal(r.catalog.versions[0]!.title, "声明 one 😀");
  assert.equal(
    r.catalog.versions[0]!.iconImage,
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mXcAAAAASUVORK5CYII=",
    "owner must preserve complete author image bytes, not project an icon enum",
  );
}
function assertSafe(r: Snapshot, errors: string[], external: string[]) {
  assert.deepEqual(r.unknown, [], JSON.stringify(r));
  assert.deepEqual(errors, []);
  assert.deepEqual(
    external,
    [],
    "logical mounted transport must not write/fetch business endpoints",
  );
  assert.equal(
    r.storedDraft,
    r.unsentBytes,
    "owner invalidation must preserve exact unsent local bytes",
  );
  const reads = new Set([
    "platform.bootstrap",
    "spaces.ensure",
    "app-views.list",
    "apps.list",
    "tasks.counts",
    "content.counts",
    "content.list",
    "content.deliveries",
    "projects.list",
    "conversations.navigation",
    "runtime.navigation",
    "conversations.history",
    "tasks.order",
    "cognitive-apps.list",
  ]);
  assert.deepEqual(
    r.requests.filter((x) => !reads.has(x.method)),
    [],
    "directory reads never grant, send, start Session or read author bytes",
  );
  for (const entry of r.trace)
    if (!entry.identity)
      assert.deepEqual(
        entry.catalog,
        empty,
        "retired/initial owner must publish no protected catalog",
      );
}

test(
  "mounted actual useWorkspace cognitive catalog owner with controlled cancellable preload; not SQL/HPA, App selection or native acceptance",
  { timeout: 120_000 },
  async (t) => {
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "formal test entry must prepare the real isolated test browser; no skip fallback",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-cognitive-catalog-owner-"),
    );
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const fixture = resolve(
      "tests/fixtures/cognitive-catalog-owner-mounted.tsx",
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir,
      plugins: [
        react(),
        {
          name: "actual-cognitive-catalog-owner-fixture",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__catalog-owner")
                return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`,
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
      logLevel: "error",
    });
    await server.listen();
    t.after(() => server.close());
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const serverURL = `http://127.0.0.1:${address.port}/__catalog-owner`;
    const browser = await chromium.launch({ headless: true, executablePath });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        external.push(request.url());
    });
    async function load(held = false) {
      errors.length = 0;
      external.length = 0;
      await page.goto(serverURL + "?mode=" + (held ? "held" : "ready"));
      await page.waitForFunction(
        () => !!Reflect.get(window, "cognitiveCatalogOwnerFixture"),
      );
      return wait(page, (r) =>
        held
          ? r.held.length === 1
          : r.boot !== null &&
            r.online === true &&
            r.catalog.versions.length === 3,
      );
    }

    await t.test(
      "initial pending owner is empty; StrictMode setup coalesces before actual bootstrap and the real drain still completes",
      async () => {
        let r = await load(true);
        assert.deepEqual(r.catalog, empty);
        assert.equal(r.boot, null);
        // The real drain begins in a microtask after StrictMode's synchronous
        // setup/cleanup/setup. No fictitious first RPC is required to cancel.
        assert.equal(
          r.requests.filter((x) => x.method === "platform.bootstrap").length,
          1,
        );
        assert.equal(catalogCalls(r).length, 1);
        assert.deepEqual(r.cancelled, []);
        r = await action(page, "settle", 0);
        r = await wait(
          page,
          (r) => r.boot !== null && r.catalog.versions.length === 1,
        );
        assert.equal(r.catalog.versions[0]!.appId, "example.initial-held");
        assertSafe(r, errors, external);
      },
    );

    await t.test(
      "short pages continue via the common checkpoint; one stream EOF does not restart, same revision refresh reuses cache and idle does not poll",
      async () => {
        let r = await load();
        assertInitial(r);
        const calls = catalogCalls(r);
        assert.equal(calls.length, 3, JSON.stringify(r));
        const params = calls.map((x) => x.params as Record<string, unknown>);
        assert.ok(
          params.every((p) => Number.isInteger(p.limit) && Number(p.limit) > 3),
          "one emitted row is a true short page, not requested EOF",
        );
        assert.equal(params[0]!.versionsAfter, undefined);
        assert.equal(params[0]!.connectionsAfter, undefined);
        assert.ok(
          params[1]!.versionsAfter === "versions-checkpoint-one" ||
            params[1]!.connectionsAfter === "connections-checkpoint-one",
        );
        assert.equal(params[2]!.versionsAfter, "versions-checkpoint-two");
        assert.equal(params[2]!.connectionsAfter, undefined);
        const before = r.requests.length;
        r = await action(page, "refreshAndWait");
        r = await action(page, "refreshAndWait");
        assert.ok(
          r.requests.length > before,
          "explicit refresh actually reached production owner",
        );
        assert.equal(
          catalogCalls(r).length,
          3,
          "unchanged cache must not reload either cognitive stream",
        );
        assertInitial(r);
        const idleRequests = r.requests.length;
        await page.waitForTimeout(5_200);
        r = await report(page);
        assert.equal(
          r.requests.length,
          idleRequests,
          "healthy owner adds no periodic directory reads",
        );
        assertSafe(r, errors, external);
      },
    );

    await t.test(
      "accessChanged aborts a held read, clears old directory before replacement, failed new read stays empty and ignored late cancel cannot publish",
      async () => {
        await load();
        await action(page, "queueHold", "retired-access");
        await action(page, "invalidate", false);
        let r = await wait(page, (r) => r.held.length === 1);
        assertInitial(r);
        const retired = r.held[0]!.id;
        await action(page, "queueHold", "replacement-access");
        await action(page, "invalidate", true);
        r = await wait(page, (r) => r.held.length === 2);
        assert.ok(r.cancelled.includes(retired), JSON.stringify(r));
        assert.deepEqual(r.catalog, empty);
        r = await action(page, "fail", 1);
        r = await wait(page, (r) =>
          r.error.includes("CONTROLLED_CATALOG_READ_FAILED"),
        );
        assert.deepEqual(r.catalog, empty);
        assert.equal(r.renderedCatalog, JSON.stringify(empty));
        await action(page, "settle", 0);
        await page.waitForTimeout(100);
        r = await report(page);
        assert.deepEqual(r.catalog, empty);
        assert.ok(
          r.trace.every(
            (x) => !x.catalog.versions.includes("example.retired-access"),
          ),
          "late private data must never flash into a mounted commit",
        );
        r = await action(page, "refreshAndWait");
        r = await wait(
          page,
          (r) => r.online === true && r.catalog.versions.length === 3,
        );
        assertInitial(r);
        assertSafe(r, errors, external);
      },
    );

    for (const [field, value] of [
      ["centerId", "22222222-2222-4222-8222-222222222222"],
      ["principalId", "human-B"],
      ["csrfToken", "catalog-session-B"],
    ] as const) {
      const suffix = field.toLowerCase();
      await t.test(
        `bootstrap ${field} retirement without a fabricated access event clears old catalog while the newly scoped read remains usable`,
        async () => {
          await load();
          await action(page, "queueHold", "new-" + suffix);
          await action(page, "changeIdentity", field, value);
          await action(page, "refresh");
          let r = await wait(page, (r) => r.held.length === 1);
          assert.deepEqual(r.catalog, empty);
          assert.equal(r.boot, null);
          const pending = r.held[0]!;
          assert.equal(
            r.cancelled.includes(pending.id),
            false,
            "discovering new identity must not abort its own replacement read",
          );
          const call = catalogCalls(r).at(-1)!;
          assert.equal(
            call.identityGeneration,
            field === "csrfToken" ? value : "catalog-session-A",
          );
          await action(page, "settle", 0);
          r = await wait(
            page,
            (r) => r.boot !== null && r.catalog.versions.length === 1,
          );
          assert.equal(r.boot![field], value);
          assert.equal(r.catalog.versions[0]!.appId, "example.new-" + suffix);
          assertSafe(r, errors, external);
        },
      );
      await t.test(
        `pending ${field} change aborts the old read and never reattaches its late page to the replacement identity`,
        async () => {
          await load();
          await action(page, "queueHold", "retired-" + suffix);
          await action(page, "invalidate", false);
          let r = await wait(page, (r) => r.held.length === 1);
          const retired = r.held[0]!.id;
          await action(page, "queueHold", "replacement-" + suffix);
          await action(page, "changeIdentity", field, value);
          await action(page, "invalidate", true);
          r = await wait(page, (r) => r.held.length === 2);
          assert.ok(r.cancelled.includes(retired));
          assert.deepEqual(r.catalog, empty);
          await action(page, "settle", 1);
          r = await wait(
            page,
            (r) => r.boot !== null && r.catalog.versions.length === 1,
          );
          assert.equal(r.boot![field], value);
          await action(page, "settle", 0);
          await page.waitForTimeout(100);
          r = await report(page);
          assert.equal(r.boot![field], value);
          assert.equal(
            r.catalog.versions[0]!.appId,
            "example.replacement-" + suffix,
          );
          assert.ok(
            r.trace.every(
              (x) => !x.catalog.versions.includes("example.retired-" + suffix),
            ),
          );
          assertSafe(r, errors, external);
        },
      );
    }

    await t.test(
      "parallel directory failure settles refresh but cancels still-held cognitive page; late page with continuation cannot issue a second request",
      async () => {
        await load();
        await action(page, "queueHold", "parallel-orphan");
        await action(page, "failNextContentCounts");
        await action(page, "invalidate", false);
        let r = await wait(
          page,
          (r) =>
            r.held.length === 1 &&
            r.error.includes("CONTROLLED_PARALLEL_READ_FAILED"),
        );
        assert.ok(
          r.cancelled.includes(r.held[0]!.id),
          "a rejected parallel read cannot detach the outstanding cognitive request from owner cancellation",
        );
        await action(page, "unmount");
        const requests = (await report(page)).requests.length;
        await action(page, "settleWithContinuation", 0);
        await page.waitForTimeout(100);
        r = await report(page);
        assert.equal(
          r.requests.length,
          requests,
          "abandoned first page must not request its continuation after failure/unmount",
        );
        assertSafe(r, errors, external);
      },
    );

    await t.test(
      "actual cleanup cancels held read and queued refresh, removes subscription; ignored late continuation cannot start new RPC or change unsent bytes",
      async () => {
        await load();
        await action(page, "queueHold", "unmounted-late");
        await action(page, "invalidate", false);
        let r = await wait(page, (r) => r.held.length === 1);
        const id = r.held[0]!.id;
        await action(page, "refresh");
        r = await action(page, "unmount");
        assert.equal(r.mounted, false);
        assert.ok(r.cancelled.includes(id));
        assert.equal(r.subscribers, 0);
        const commits = r.trace.length;
        const requests = r.requests.length;
        await action(page, "settleWithContinuation", 0);
        await page.waitForTimeout(100);
        r = await report(page);
        assert.equal(r.trace.length, commits);
        assert.equal(
          r.requests.length,
          requests,
          "a queued production drain cannot begin new RPC after effect cleanup",
        );
        assert.ok(
          r.trace.every(
            (x) => !x.catalog.versions.includes("example.unmounted-late"),
          ),
        );
        assertSafe(r, errors, external);
      },
    );
  },
);
