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

// Actual production useWorkspace/management/typed facade/preload cancellation
// are mounted together. Only logical replies/events are controlled: these are
// not SQL/HPA, native IPC, real business writes or management-card UI evidence.
type Method =
  "describeRegistered" | "install" | "grant" | "connect" | "connectionState";
type Run = {
  method: Method | "login" | "logout";
  state: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: { message: string; code?: string };
};
type Snapshot = {
  mounted: boolean;
  boot: { centerId: string; principalId: string; csrfToken: string } | null;
  catalog: Pick<CognitiveAppCatalogDto, "versions" | "connections">;
  error: string;
  online: boolean;
  requests: ApplicationInvocation[];
  unknown: string[];
  cancelled: string[];
  held: Array<{ index: number; label: string; id: string; settled: boolean }>;
  managementHeld: Array<{
    index: number;
    label: string;
    id: string;
    settled: boolean;
  }>;
  managementRuns: Run[];
  trace: unknown[];
  unsentBytes: string;
  storedDraft: string | null;
};
const logical = {
  describeRegistered: "cognitive-apps.describe",
  install: "cognitive-apps.install",
  grant: "cognitive-apps.grant",
  connect: "cognitive-apps.connect",
  connectionState: "cognitive-apps.connection-state",
} as const;
const app = { appId: "example.notes", version: "1.0.0" };
const hash = "a".repeat(64);
const params: Record<Method, unknown> = {
  describeRegistered: {
    mode: "registered-management",
    ...app,
    expectedDefinitionHash: hash,
  },
  install: {
    mode: "register-installed",
    commandId: "register-mount",
    ...app,
    definitionHash: hash,
  },
  grant: { ...app, expectedRevision: 0, state: "active" },
  connect: {
    ...app,
    expectedDefinitionHash: hash,
    expectedGrantRevision: 1,
    connectionId: "connection-management",
    expectedRevision: 0,
    serviceId: "author/management-service",
    dataAuthorityId: "author/management-data",
  },
  connectionState: {
    ...app,
    expectedDefinitionHash: hash,
    expectedGrantRevision: 1,
    connectionId: "connection-management",
    expectedRevision: 1,
    state: "disabled",
  },
};
const catalogReads = (r: Snapshot) =>
  r.requests.filter((x) => x.method === "cognitive-apps.list");
const calls = (r: Snapshot, method: Method) =>
  r.requests.filter((x) => x.method === logical[method]);
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
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await report(page);
    if (condition(value)) return value;
    if (Date.now() >= deadline)
      assert.fail(
        "actual management owner condition timed out: " + JSON.stringify(value),
      );
    await page.waitForTimeout(20);
  }
}
function safe(
  r: Snapshot,
  errors: string[],
  external: string[],
  allowed: string[] = [],
) {
  assert.deepEqual(r.unknown, [], JSON.stringify(r));
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], "no real business HTTP endpoint is allowed");
  assert.equal(
    r.storedDraft,
    r.unsentBytes,
    "management must preserve every unsent draft byte",
  );
  const readMethods = new Set([
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
    ...allowed,
  ]);
  assert.deepEqual(
    r.requests.filter((x) => !readMethods.has(x.method)),
    [],
    "only explicitly requested management operations may occur, never grant/send/launch as a side effect",
  );
}
function ack(r: Snapshot, index = 0, refreshed = true) {
  const run = r.managementRuns[index]!;
  assert.equal(run.state, "fulfilled", JSON.stringify(run));
  assert.ok(run.value && typeof run.value === "object");
  const result = run.value as {
    value: Record<string, unknown>;
    refreshed: boolean;
  };
  assert.equal(result.refreshed, refreshed);
  assert.equal(result.value.appId, app.appId);
  return result.value;
}
function retired(r: Snapshot, index = 0) {
  const run = r.managementRuns[index]!;
  assert.equal(run.state, "rejected", JSON.stringify(run));
  assert.equal(run.error?.code, "cancelled", JSON.stringify(run));
  assert.equal(
    "value" in run,
    false,
    "retired actual public Promise discloses no private ACK or definition",
  );
}

test(
  "actual mounted management owner fences reads and identity, retains own write ACK through access refresh; controlled transport only",
  { timeout: 180000 },
  async (t) => {
    const executablePath =
      process.env.MORPHZ_TEST_BROWSER_EXECUTABLE || chromium.executablePath();
    assert.ok(
      existsSync(executablePath),
      "formal entry must provide the real test browser, not skip",
    );
    const cacheDir = await mkdtemp(
      resolve(tmpdir(), "morphz-cognitive-management-owner-"),
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
          name: "actual-management-owner-fixture",
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url?.split("?")[0] !== "/__management-owner")
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
    const url = `http://127.0.0.1:${address.port}/__management-owner?mode=ready`;
    const browser = await chromium.launch({ headless: true, executablePath });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [],
      external: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) external.push(r.url());
    });
    async function load() {
      errors.length = 0;
      external.length = 0;
      await page.goto(url);
      await page.waitForFunction(
        () => !!Reflect.get(window, "cognitiveCatalogOwnerFixture"),
      );
      return wait(
        page,
        (r) => r.boot !== null && r.online && r.catalog.versions.length === 3,
      );
    }
    async function start(method: Method, label: string, hold = true) {
      await action(page, "queueManagement", method, label, hold);
      await action(page, "startManagement", method, params[method]);
      return wait(page, (r) =>
        hold
          ? r.managementHeld.length === 1
          : r.managementRuns[0]?.state !== "pending",
      );
    }

    await t.test(
      "StrictMode and idle never install/grant/connect/describe implicitly; exact local draft bytes remain",
      async () => {
        let r = await load();
        assert.deepEqual(r.managementRuns, []);
        const count = r.requests.length;
        await page.waitForTimeout(5200);
        r = await report(page);
        assert.equal(
          r.requests.length,
          count,
          "healthy owner does not poll or run management commands",
        );
        safe(r, errors, external);
      },
    );
    for (const method of Object.keys(logical) as Method[]) {
      await t.test(
        `explicit public ${method} uses exactly one strict logical request and existing DTO`,
        async () => {
          await load();
          let r = await start(method, "basic-" + method, false);
          assert.equal(calls(r, method).length, 1);
          assert.deepEqual(calls(r, method)[0]!.params, params[method]);
          assert.equal(
            calls(r, method)[0]!.identityGeneration,
            "catalog-session-A",
          );
          if (method === "describeRegistered") {
            const run = r.managementRuns[0]!;
            assert.equal(run.state, "fulfilled");
            const value = run.value as {
              mode: string;
              definition: { title: string };
              definitionHash: string;
              grant: null;
            };
            assert.equal(value.mode, "registered-management");
            assert.equal(
              value.definition.title,
              "PRIVATE_DEFINITION_basic-describeRegistered",
            );
            assert.equal(value.definitionHash, hash);
            assert.equal(value.grant, null);
            assert.equal(
              catalogReads(r).length,
              3,
              "preview does not perform a mutation refresh",
            );
          } else ack(r);
          r = await report(page);
          safe(r, errors, external, [logical[method]]);
        },
      );
    }

    for (const method of ["grant", "connect"] as const) {
      await t.test(
        `own ${method} survives accessChanged clearing projection and keeps ACK while refresh is pending`,
        async () => {
          await load();
          let r = await start(method, "own-" + method);
          const id = r.managementHeld[0]!.id;
          await action(page, "queueHold", "own-write-refresh");
          await action(page, "invalidate", true);
          r = await wait(page, (r) => r.held.length === 1 && r.boot === null);
          assert.deepEqual(r.catalog, { versions: [], connections: [] });
          assert.equal(r.managementRuns[0]!.state, "pending");
          assert.equal(
            r.cancelled.includes(id),
            false,
            "own permission notification is not an identity change",
          );
          await action(page, "settleManagement", 0);
          r = await report(page);
          assert.equal(
            r.managementRuns[0]!.state,
            "pending",
            "write ACK awaits bounded existing refresh drain",
          );
          await action(page, "settle", 0);
          r = await wait(page, (r) => r.managementRuns[0]!.state !== "pending");
          const value = ack(r);
          assert.equal(value.state, "active");
          assert.equal(
            calls(r, method).length,
            1,
            "refresh cannot reissue a committed write",
          );
          safe(r, errors, external, [logical[method]]);
        },
      );
    }

    await t.test(
      "access invalidation cancels held registered description; ignored late private definition cannot disclose",
      async () => {
        await load();
        let r = await start("describeRegistered", "retired-private");
        const id = r.managementHeld[0]!.id;
        await action(page, "queueHold", "new-access");
        await action(page, "invalidate", true);
        r = await wait(
          page,
          (r) =>
            r.held.length === 1 && r.managementRuns[0]!.state === "rejected",
        );
        assert.ok(r.cancelled.includes(id));
        retired(r);
        await action(page, "settleManagement", 0);
        await action(page, "settle", 0);
        await page.waitForTimeout(100);
        r = await report(page);
        retired(r);
        assert.equal(
          JSON.stringify(r.managementRuns).includes("PRIVATE_DEFINITION_"),
          false,
        );
        assert.equal(calls(r, "describeRegistered").length, 1);
        safe(r, errors, external, [logical.describeRegistered]);
      },
    );

    await t.test(
      "parsed write ACK followed by failed catalog refresh remains acknowledged with refreshed:false, never repeated",
      async () => {
        await load();
        await start("grant", "ack-refresh-failed");
        // Changed catalog revision forces the existing refresh to reach the real
        // facade rather than accidentally satisfying this test from its cache.
        await action(page, "queueHold", "changed-before-ack");
        await action(page, "invalidate", false);
        await wait(page, (r) => r.held.length === 1);
        await action(page, "settle", 0);
        await wait(page, (r) => r.catalog.versions.length === 1);
        // Retire cache with an access event; reject its replacement before ACK.
        await action(page, "queueFailure");
        await action(page, "invalidate", true);
        await wait(page, (r) =>
          r.error.includes("CONTROLLED_CATALOG_READ_FAILED"),
        );
        await action(page, "queueFailure");
        await action(page, "settleManagement", 0);
        const r = await wait(
          page,
          (r) => r.managementRuns[0]!.state !== "pending",
        );
        ack(r, 0, false);
        assert.equal(calls(r, "grant").length, 1);
        safe(r, errors, external, [logical.grant]);
      },
    );

    for (const status of [401, 403] as const) {
      await t.test(
        `refresh ${status} ${status === 401 ? "retires identity and prevents late write disclosure" : "retires protected reads, not own write identity"}`,
        async () => {
          await load();
          let r = await start("grant", "status-" + status);
          const id = r.managementHeld[0]!.id;
          await action(page, "queueHold", "status-catalog");
          await action(page, "invalidate", false);
          await wait(page, (r) => r.held.length === 1);
          await action(page, "denyCatalogWithStatus", 0, status);
          r = await wait(page, (r) =>
            r.error.includes("CONTROLLED_ACCESS_" + status),
          );
          if (status === 401) {
            r = await wait(
              page,
              (r) => r.managementRuns[0]!.state === "rejected",
            );
            assert.ok(r.cancelled.includes(id));
            retired(r);
          } else {
            assert.equal(r.managementRuns[0]!.state, "pending");
            assert.equal(r.cancelled.includes(id), false);
            await action(page, "queueFailure");
          }
          await action(page, "settleManagement", 0);
          r = await wait(page, (r) => r.managementRuns[0]!.state !== "pending");
          if (status === 401) retired(r);
          else ack(r, 0, false);
          assert.equal(calls(r, "grant").length, 1);
          safe(r, errors, external, [logical.grant]);
        },
      );
    }

    for (const [field, value] of [
      ["centerId", "22222222-2222-4222-8222-222222222222"],
      ["principalId", "human-B"],
      ["csrfToken", "management-session-B"],
    ] as const) {
      await t.test(
        `bootstrap ${field} replacement cancels an old write even before new catalog can publish`,
        async () => {
          await load();
          let r = await start("connect", "old-" + field);
          const id = r.managementHeld[0]!.id;
          await action(page, "queueHold", "new-" + field.toLowerCase());
          await action(page, "changeIdentity", field, value);
          await action(page, "refresh");
          r = await wait(
            page,
            (r) =>
              r.held.length === 1 && r.managementRuns[0]!.state === "rejected",
          );
          assert.equal(r.boot, null);
          assert.ok(r.cancelled.includes(id));
          retired(r);
          await action(page, "settle", 0);
          await wait(page, (r) => r.boot?.[field] === value);
          await action(page, "settleManagement", 0);
          await page.waitForTimeout(100);
          r = await report(page);
          retired(r);
          assert.equal(r.boot![field], value);
          assert.equal(calls(r, "connect").length, 1);
          safe(r, errors, external, [logical.connect]);
        },
      );
    }
    await t.test(
      "a write already acknowledged by transport cannot disclose its value after identity changes during the actual refresh drain",
      async () => {
        await load();
        await start("grant", "acked-before-retirement");
        await action(page, "queueHold", "old-acked-refresh");
        await action(page, "invalidate", false);
        await wait(page, (r) => r.held.length === 1);
        await action(page, "settleManagement", 0);
        let r = await report(page);
        assert.equal(r.managementHeld[0]!.settled, true);
        assert.equal(r.managementRuns[0]!.state, "pending");
        await action(page, "changeIdentity", "principalId", "human-B");
        await action(page, "queueHold", "new-acked-refresh");
        await action(page, "settle", 0);
        r = await wait(
          page,
          (r) =>
            r.held.length === 2 && r.managementRuns[0]!.state === "rejected",
        );
        retired(r);
        await action(page, "settle", 1);
        r = await wait(page, (r) => r.boot?.principalId === "human-B");
        retired(r);
        assert.equal(calls(r, "grant").length, 1);
        safe(r, errors, external, [logical.grant]);
      },
    );
    for (const transition of ["login", "logout", "unmount"] as const) {
      await t.test(
        `actual public ${transition} retires the old write; late ACK cannot refresh, replay or return private value`,
        async () => {
          await load();
          let r = await start("grant", "old-" + transition);
          const id = r.managementHeld[0]!.id;
          await action(page, transition);
          r = await wait(
            page,
            (r) =>
              r.managementRuns[0]!.state === "rejected" &&
              (transition === "unmount"
                ? !r.mounted
                : r.managementRuns[1]!.state !== "pending"),
          );
          assert.ok(r.cancelled.includes(id));
          retired(r);
          const count = r.requests.length,
            commits = r.trace.length;
          await action(page, "settleManagement", 0);
          await page.waitForTimeout(100);
          r = await report(page);
          retired(r);
          assert.equal(
            r.requests.length,
            count,
            "retired late ACK does not begin any new RPC",
          );
          if (transition === "unmount") assert.equal(r.trace.length, commits);
          else assert.equal(r.managementRuns[1]!.state, "fulfilled");
          assert.equal(calls(r, "grant").length, 1);
          safe(r, errors, external, [
            logical.grant,
            ...(transition === "unmount" ? [] : [transition]),
          ]);
        },
      );
    }
  },
);
